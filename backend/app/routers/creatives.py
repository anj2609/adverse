from fastapi import APIRouter, Depends, File, Form, Query, Request, UploadFile
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import get_db
from ..errors import bad_request
from ..models import ASSET_TYPES, Creative, Placement, User
from ..schemas import CreativeOut, CreativeUpdate, Page, RejectIn, check_url
from ..security import require
from ..services import audit, creatives as svc
from ..services.compat import compat_problems
from .deps import Pagination, creative_out, get_creative, get_placement, paginate, touch

router = APIRouter(prefix="/api/v1/admin/creatives", tags=["creatives"])


async def _read(file: UploadFile) -> bytes:
    return await file.read(get_settings().max_upload_bytes + 1)  # one byte over the limit is enough to refuse it


def _meta(name, description, advertiser, product_name, asset_type, destination_url) -> dict:
    if asset_type not in ASSET_TYPES:
        raise bad_request("bad_asset_type", f"asset_type must be one of: {', '.join(ASSET_TYPES)}")
    try:
        url = check_url(destination_url)
    except ValueError as e:
        raise bad_request("bad_url", str(e))
    if not name.strip() or not advertiser.strip():
        raise bad_request("missing_fields", "name and advertiser are required")
    return {"name": name.strip()[:160], "description": description, "advertiser": advertiser.strip()[:120],
            "product_name": product_name, "asset_type": asset_type, "destination_url": url}


@router.post("", response_model=CreativeOut, status_code=201)
async def upload(request: Request, file: UploadFile = File(...), name: str = Form(...), advertiser: str = Form(...), asset_type: str = Form(...),
                 description: str | None = Form(None), product_name: str | None = Form(None), destination_url: str | None = Form(None),
                 user: User = Depends(require("editor")), db: Session = Depends(get_db)):
    c = svc.upload(db, user.email, await _read(file), _meta(name, description, advertiser, product_name, asset_type, destination_url))
    db.commit()
    return creative_out(c, request)


@router.get("", response_model=Page[CreativeOut])
def list_creatives(request: Request, q: str | None = None, asset_type: str | None = None, advertiser: str | None = None,
                   approval_status: str | None = None, is_active: bool | None = None, compatible_with: str | None = Query(None, description="placement id"),
                   latest_only: bool = False, p: Pagination = Depends(), _: User = Depends(require("viewer")), db: Session = Depends(get_db)):
    stmt = select(Creative).order_by(Creative.created_at.desc())
    if q:
        like = f"%{q}%"
        stmt = stmt.where(Creative.name.ilike(like) | Creative.advertiser.ilike(like) | Creative.product_name.ilike(like))
    for col, val in ((Creative.asset_type, asset_type), (Creative.advertiser, advertiser), (Creative.approval_status, approval_status), (Creative.is_active, is_active)):
        if val is not None:
            stmt = stmt.where(col == val)
    if latest_only:
        newest = select(Creative.family_id, func.max(Creative.version).label("v")).group_by(Creative.family_id).subquery()
        stmt = stmt.join(newest, (newest.c.family_id == Creative.family_id) & (newest.c.v == Creative.version))
    if compatible_with:
        placement = get_placement(db, compatible_with)
        rows = [c for c in db.scalars(stmt).all() if not compat_problems(placement, c)]
        total = len(rows)
        rows = rows[(p.page - 1) * p.page_size: p.page * p.page_size]
        return {"items": [creative_out(c, request) for c in rows], "total": total, "page": p.page, "page_size": p.page_size}
    return paginate(db, stmt, p, lambda c: creative_out(c, request))


@router.get("/{creative_id}", response_model=CreativeOut)
def get_one(creative_id: str, request: Request, _: User = Depends(require("viewer")), db: Session = Depends(get_db)):
    return creative_out(get_creative(db, creative_id), request)


@router.patch("/{creative_id}", response_model=CreativeOut)
def update(creative_id: str, body: CreativeUpdate, request: Request, user: User = Depends(require("editor")), db: Session = Depends(get_db)):
    c = get_creative(db, creative_id)
    data = body.model_dump(exclude_unset=True)
    for k, v in data.items():
        setattr(c, k, v)
    audit.record(db, user.email, "creative.update", "creative", c.id, detail={"changed": sorted(data)})
    touch(db, *svc.application_ids_using(db, c))
    db.commit()
    return creative_out(c, request)


def _decide(decision: str):
    def handler(creative_id: str, request: Request, body: RejectIn | None = None, user: User = Depends(require("admin")), db: Session = Depends(get_db)):
        c = get_creative(db, creative_id)
        if decision == "rejected" and body is None:
            raise bad_request("reason_required", "Say why the creative is rejected")
        svc.decide(db, user.email, c, decision, body.reason if body else None)
        touch(db, *svc.application_ids_using(db, c))
        db.commit()
        return creative_out(c, request)
    return handler


router.post("/{creative_id}/approve", response_model=CreativeOut)(_decide("approved"))
router.post("/{creative_id}/reject", response_model=CreativeOut)(_decide("rejected"))


@router.post("/{creative_id}/deactivate", response_model=CreativeOut)
def deactivate(creative_id: str, request: Request, user: User = Depends(require("editor")), db: Session = Depends(get_db)):
    c = svc.set_active(db, user.email, get_creative(db, creative_id), False)
    touch(db, *svc.application_ids_using(db, c))
    db.commit()
    return creative_out(c, request)


@router.post("/{creative_id}/activate", response_model=CreativeOut)
def activate(creative_id: str, request: Request, user: User = Depends(require("editor")), db: Session = Depends(get_db)):
    c = svc.set_active(db, user.email, get_creative(db, creative_id), True)
    touch(db, *svc.application_ids_using(db, c))
    db.commit()
    return creative_out(c, request)


@router.post("/{creative_id}/versions", response_model=CreativeOut, status_code=201)
async def new_version(creative_id: str, request: Request, file: UploadFile = File(...), name: str | None = Form(None),
                      user: User = Depends(require("editor")), db: Session = Depends(get_db)):
    """A new file for the same creative. It starts pending approval; existing assignments keep using the old version
    until someone reassigns, so a replacement is never live by accident."""
    base = get_creative(db, creative_id)
    meta = {"name": name or base.name, "description": base.description, "advertiser": base.advertiser, "product_name": base.product_name,
            "asset_type": base.asset_type, "destination_url": base.destination_url}
    c = svc.upload(db, user.email, await _read(file), meta, family=base)
    db.commit()
    return creative_out(c, request)


@router.get("/{creative_id}/usage")
def usage(creative_id: str, _: User = Depends(require("viewer")), db: Session = Depends(get_db)):
    return svc.usage(db, get_creative(db, creative_id))
