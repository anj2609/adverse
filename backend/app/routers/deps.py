from dataclasses import dataclass

from fastapi import Depends, Query, Request
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import clock
from ..config import get_settings
from ..errors import not_found
from ..models import Application, Campaign, Creative, Placement
from ..schemas import ApplicationOut, CampaignOut, CreativeOut, PlacementOut
from ..services import registry
from ..services.eligibility import effective_status
from ..services.runtime import refresh_version


@dataclass
class Pagination:
    page: int = Query(1, ge=1)
    page_size: int = Query(25, ge=1, le=100)


def base_url(request: Request) -> str:
    return (get_settings().public_base_url or str(request.base_url)).rstrip("/")


def paginate(db: Session, stmt, p: Pagination, mapper=lambda x: x) -> dict:
    total = db.scalar(select(func.count()).select_from(stmt.order_by(None).subquery())) or 0
    rows = db.scalars(stmt.limit(p.page_size).offset((p.page - 1) * p.page_size)).all()
    return {"items": [mapper(r) for r in rows], "total": total, "page": p.page, "page_size": p.page_size}


def get_app(db: Session, ref: str) -> Application:
    app = db.scalar(select(Application).where((Application.id == ref) | (Application.app_key == ref)))
    if app is None:
        raise not_found("Application")
    return app


def get_placement(db: Session, ref: str) -> Placement:
    p = db.get(Placement, ref)
    if p is None:
        raise not_found("Placement")
    return p


def get_creative(db: Session, ref: str) -> Creative:
    c = db.get(Creative, ref)
    if c is None:
        raise not_found("Creative")
    return c


def get_campaign(db: Session, ref: str) -> Campaign:
    c = db.get(Campaign, ref)
    if c is None:
        raise not_found("Campaign")
    return c


def touch(db: Session, *application_ids: str) -> None:
    """Re-evaluate what each application would be told; moves its config version only if the answer changed."""
    now = clock.now()
    for app_id in set(application_ids):
        app = db.get(Application, app_id)
        if app:
            refresh_version(db, app, now)


def application_out(db: Session, app: Application, counts: tuple[int, int] | None = None) -> ApplicationOut:
    out = ApplicationOut.model_validate(app)
    out.integration_status = registry.integration_status(app)
    out.ads_enabled = app.integration_enabled
    out.runtime_key_required = get_settings().runtime_require_key
    total, active = counts or registry.application_counts(db, [app.id])[app.id]
    out.placement_count, out.active_placement_count = total, active
    return out


def placement_out(p: Placement, request: Request) -> PlacementOut:
    out = PlacementOut.model_validate(p)
    key = (p.fallback or {}).get("storage_key")
    # a photo from a web address is previewed from that address by the admin's own browser; AdForge never fetches it
    out.fallback_preview_url = p.asset_path if p.integration == "remote" else (f"{base_url(request)}/media/{key}" if key else None)
    return out


def creative_out(c: Creative, request: Request) -> CreativeOut:
    out = CreativeOut.model_validate(c)
    out.url, out.thumbnail_url = f"{base_url(request)}/media/{c.storage_key}", f"{base_url(request)}/media/{c.thumbnail_key}"
    return out


def campaign_out(db: Session, c: Campaign, count: int | None = None) -> CampaignOut:
    from ..models import Assignment
    out = CampaignOut.model_validate(c)
    out.effective_status = effective_status(c, clock.now())
    out.assignment_count = count if count is not None else db.scalar(
        select(func.count()).select_from(Assignment).where(Assignment.campaign_id == c.id, Assignment.status == "active")) or 0
    return out
