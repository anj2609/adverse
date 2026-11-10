from fastapi import APIRouter, Depends, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import clock
from ..db import get_db
from ..errors import bad_request, conflict, not_found
from ..models import Assignment, BulkOperation, Campaign, Placement, User
from ..schemas import (AssignmentIn, AssignmentOut, BulkAssignIn, DirectAssignIn, BulkOperationOut, CampaignIn, CampaignOut, CampaignUpdate, Page, RejectIn)
from ..security import require
from ..services import assignments as asg
from ..services import campaigns as svc
from ..services.eligibility import load_entries, resolve
from .deps import (Pagination, campaign_out, get_app, get_campaign, get_creative, get_placement, paginate, touch)

router = APIRouter(prefix="/api/v1/admin", tags=["campaigns & assignments"])


# ---------- campaigns ----------
@router.post("/campaigns", response_model=CampaignOut, status_code=201)
def create_campaign(body: CampaignIn, user: User = Depends(require("editor")), db: Session = Depends(get_db)):
    app = get_app(db, body.application_id)
    c = svc.create(db, user.email, app.id, body.model_dump(exclude={"application_id"}))
    db.commit()
    return campaign_out(db, c)


@router.get("/campaigns", response_model=Page[CampaignOut])
def list_campaigns(application_id: str | None = None, status: str | None = None, advertiser: str | None = None, q: str | None = None,
                   p: Pagination = Depends(), _: User = Depends(require("viewer")), db: Session = Depends(get_db)):
    stmt = select(Campaign).order_by(Campaign.created_at.desc())
    if application_id:
        stmt = stmt.where(Campaign.application_id == get_app(db, application_id).id)
    if advertiser:
        stmt = stmt.where(Campaign.advertiser == advertiser)
    if q:
        stmt = stmt.where(Campaign.name.ilike(f"%{q}%"))
    if status and status not in ("scheduled", "active"):
        stmt = stmt.where(Campaign.status == status)
    if status in ("scheduled", "active", "expired"):  # time-derived states: filter after applying the clock
        from ..services.eligibility import effective_status
        now = clock.now()
        rows = [c for c in db.scalars(stmt.where(Campaign.status.in_(("approved", "paused", "expired")))).all() if effective_status(c, now) == status]
        page = rows[(p.page - 1) * p.page_size: p.page * p.page_size]
        return {"items": [campaign_out(db, c) for c in page], "total": len(rows), "page": p.page, "page_size": p.page_size}
    return paginate(db, stmt, p, lambda c: campaign_out(db, c))


@router.get("/campaigns/{campaign_id}")
def get_one(campaign_id: str, request: Request, _: User = Depends(require("viewer")), db: Session = Depends(get_db)):
    from .deps import creative_out
    c = get_campaign(db, campaign_id)
    now = clock.now()
    entries = load_entries(db, c.application_id)
    states = {}
    for pid in {e.placement.id for e in entries}:
        _, s = resolve([e for e in entries if e.placement.id == pid], now)
        states.update(s)
    mine = [e for e in entries if e.campaign.id == c.id]
    return {"campaign": campaign_out(db, c, len(mine)),
            "assignments": [{"id": e.assignment.id, "placement": {"id": e.placement.id, "placement_key": e.placement.placement_key, "name": e.placement.name},
                             "creative": creative_out(e.creative, request), "state": states.get(e.assignment.id), "created_at": e.assignment.created_at}
                            for e in sorted(mine, key=lambda e: e.placement.placement_key)]}


@router.patch("/campaigns/{campaign_id}", response_model=CampaignOut)
def update_campaign(campaign_id: str, body: CampaignUpdate, user: User = Depends(require("editor")), db: Session = Depends(get_db)):
    c = get_campaign(db, campaign_id)
    svc.update(db, user.email, c, body.model_dump(exclude_unset=True))
    touch(db, c.application_id)
    db.commit()
    return campaign_out(db, c)


def _transition(name: str, role: str, needs_reason: bool = False):
    fn = getattr(svc, name)

    def handler(campaign_id: str, body: RejectIn | None = None, user: User = Depends(require(role)), db: Session = Depends(get_db)):
        c = get_campaign(db, campaign_id)
        if needs_reason:
            if body is None:
                raise bad_request("reason_required", "Say why it is rejected")
            fn(db, user.email, c, body.reason)
        else:
            fn(db, user.email, c)
        touch(db, c.application_id)
        db.commit()
        return campaign_out(db, c)
    return handler


for _name, _role, _body in (("submit", "editor", False), ("approve", "admin", False), ("reject", "admin", True),
                            ("pause", "admin", False), ("resume", "admin", False), ("expire", "admin", False)):
    router.post(f"/campaigns/{{campaign_id}}/{_name}", response_model=CampaignOut, name=f"campaign_{_name}")(_transition(_name, _role, _body))


# ---------- assignments ----------
@router.post("/campaigns/{campaign_id}/assignments", response_model=AssignmentOut, status_code=201)
def add_assignment(campaign_id: str, body: AssignmentIn, user: User = Depends(require("editor")), db: Session = Depends(get_db)):
    """Put a creative into one placement of a campaign. Assigning a different creative to a placement the campaign
    already covers replaces it (and can be rolled back)."""
    c = get_campaign(db, campaign_id)
    placement = db.scalar(select(Placement).where(Placement.application_id == c.application_id,
                                                  (Placement.id == body.placement_id) | (Placement.placement_key == body.placement_id)))
    if placement is None:
        raise not_found("Placement in this campaign's application")
    a, _ = asg.add_assignment(db, user.email, c, placement, get_creative(db, body.creative_id))
    touch(db, c.application_id)
    db.commit()
    return AssignmentOut.model_validate(a)


@router.delete("/assignments/{assignment_id}", response_model=AssignmentOut)
def remove_assignment(assignment_id: str, user: User = Depends(require("editor")), db: Session = Depends(get_db)):
    a = asg.get_or_404(db, Assignment, assignment_id, "Assignment")
    asg.remove_assignment(db, user.email, a)
    touch(db, a.application_id)
    db.commit()
    return AssignmentOut.model_validate(a)


@router.post("/assignments/{assignment_id}/rollback")
def rollback_assignment(assignment_id: str, user: User = Depends(require("admin")), db: Session = Depends(get_db)):
    a = asg.get_or_404(db, Assignment, assignment_id, "Assignment")
    outcome = asg.rollback_assignment(db, user.email, a)
    touch(db, a.application_id)
    db.commit()
    return {"assignment_id": a.id, "outcome": outcome}


# ---------- direct + bulk ----------
def _bulk_args(db: Session, app, body: BulkAssignIn):
    creative = get_creative(db, body.creative_id)
    campaign = None
    if body.campaign_id:
        campaign = get_campaign(db, body.campaign_id)
        if campaign.application_id != app.id:
            raise conflict("wrong_application", "That campaign belongs to a different application")
    svc.check_timezone(body.timezone)  # stored on the direct campaign even when the times already carry an offset
    start, end = svc.to_utc(body.start_time, body.timezone), svc.to_utc(body.end_time, body.timezone)
    svc.check_window(start, end)
    return creative, campaign, start, end


@router.post("/applications/{app_id}/assignments/preview")
def preview_bulk(app_id: str, body: BulkAssignIn, _: User = Depends(require("viewer")), db: Session = Depends(get_db)):
    """Dry run: per placement, would this work, what would it replace, and would it actually be the one showing?"""
    app = get_app(db, app_id)
    creative, campaign, start, end = _bulk_args(db, app, body)
    results = asg.preview_bulk(db, app, body.placement_ids, creative, campaign=campaign, start=start, end=end, priority=body.priority)
    return {"valid": all(not r["errors"] for r in results), "results": results}


@router.post("/applications/{app_id}/assignments/bulk", response_model=BulkOperationOut, status_code=201)
def bulk_assign(app_id: str, body: BulkAssignIn, user: User = Depends(require("admin")), db: Session = Depends(get_db)):
    """Assign one creative to many placements. Validates every placement first. all_or_nothing (default) changes
    nothing if any placement fails; partial applies the valid ones. Per-placement results are in the response."""
    app = get_app(db, app_id)
    creative, campaign, start, end = _bulk_args(db, app, body)
    op = asg.bulk_assign(db, user.email, app, body.placement_ids, creative, campaign=campaign, start=start, end=end, priority=body.priority,
                         mode=body.mode, name=body.name, timezone_name=body.timezone)
    touch(db, app.id)
    db.commit()
    return BulkOperationOut.model_validate(op)


@router.post("/placements/{placement_id}/assign", response_model=BulkOperationOut, status_code=201)
def assign_to_placement(placement_id: str, body: DirectAssignIn, user: User = Depends(require("admin")), db: Session = Depends(get_db)):
    """One-click replacement for a single placement: the same engine as bulk, for one placement."""
    p = get_placement(db, placement_id)
    app = get_app(db, p.application_id)
    body = BulkAssignIn(placement_ids=[p.id], **body.model_dump())
    creative, campaign, start, end = _bulk_args(db, app, body)
    op = asg.bulk_assign(db, user.email, app, body.placement_ids, creative, campaign=campaign, start=start, end=end, priority=body.priority,
                         mode="all_or_nothing", name=body.name, timezone_name=body.timezone)
    touch(db, app.id)
    db.commit()
    return BulkOperationOut.model_validate(op)


@router.get("/bulk-operations/{operation_id}", response_model=BulkOperationOut)
def get_bulk(operation_id: str, _: User = Depends(require("viewer")), db: Session = Depends(get_db)):
    return BulkOperationOut.model_validate(asg.get_or_404(db, BulkOperation, operation_id, "Bulk operation"))


@router.get("/applications/{app_id}/bulk-operations", response_model=Page[BulkOperationOut])
def list_bulk(app_id: str, p: Pagination = Depends(), _: User = Depends(require("viewer")), db: Session = Depends(get_db)):
    app = get_app(db, app_id)
    return paginate(db, select(BulkOperation).where(BulkOperation.application_id == app.id).order_by(BulkOperation.created_at.desc()), p,
                    BulkOperationOut.model_validate)


@router.post("/bulk-operations/{operation_id}/rollback", response_model=BulkOperationOut)
def rollback_bulk(operation_id: str, user: User = Depends(require("admin")), db: Session = Depends(get_db)):
    op = asg.get_or_404(db, BulkOperation, operation_id, "Bulk operation")
    asg.rollback_bulk(db, user.email, op)
    touch(db, op.application_id)
    db.commit()
    return BulkOperationOut.model_validate(op)
