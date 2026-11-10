from datetime import datetime

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import clock
from ..db import get_db
from ..models import Application, AuditLog, Campaign, Creative, User
from ..schemas import AuditOut, Page
from ..security import require
from ..services.eligibility import effective_status
from .deps import Pagination, paginate

router = APIRouter(prefix="/api/v1/admin", tags=["audit & overview"])


@router.get("/audit", response_model=Page[AuditOut])
def list_audit(action: str | None = None, resource_type: str | None = None, application_id: str | None = None, placement_id: str | None = None,
               campaign_id: str | None = None, actor: str | None = None, outcome: str | None = None, since: datetime | None = None,
               until: datetime | None = None, p: Pagination = Depends(), _: User = Depends(require("viewer")), db: Session = Depends(get_db)):
    stmt = select(AuditLog).order_by(AuditLog.id.desc())
    if action:
        stmt = stmt.where(AuditLog.action.like(action.replace("*", "%")))
    for col, val in ((AuditLog.resource_type, resource_type), (AuditLog.application_id, application_id), (AuditLog.placement_id, placement_id),
                     (AuditLog.campaign_id, campaign_id), (AuditLog.outcome, outcome)):
        if val:
            stmt = stmt.where(col == val)
    if actor:
        stmt = stmt.where(AuditLog.actor_email.ilike(f"%{actor}%"))
    if since:
        stmt = stmt.where(AuditLog.created_at >= since)
    if until:
        stmt = stmt.where(AuditLog.created_at <= until)
    return paginate(db, stmt, p, AuditOut.model_validate)


@router.get("/overview")
def overview(_: User = Depends(require("viewer")), db: Session = Depends(get_db)):
    now = clock.now()
    campaigns = db.scalars(select(Campaign)).all()
    by_status: dict[str, int] = {}
    for c in campaigns:
        s = effective_status(c, now)
        by_status[s] = by_status.get(s, 0) + 1
    recent = lambda q: [AuditOut.model_validate(r) for r in db.scalars(q).all()]  # noqa: E731
    return {
        "applications": db.scalar(select(func.count()).select_from(Application)) or 0,
        "campaigns_by_status": by_status,
        "active_campaigns": by_status.get("active", 0),
        "pending_campaign_approvals": by_status.get("pending_approval", 0),
        "pending_creative_approvals": db.scalar(select(func.count()).select_from(Creative).where(Creative.approval_status == "pending")) or 0,
        "available_creatives": db.scalar(select(func.count()).select_from(Creative).where(Creative.approval_status == "approved", Creative.is_active.is_(True))) or 0,
        "recent_assignment_changes": recent(select(AuditLog).where(AuditLog.action.like("assignment.%") | AuditLog.action.like("bulk.%") | (AuditLog.action == "placement.restore_fallback")).order_by(AuditLog.id.desc()).limit(8)),
        "recent_activity": recent(select(AuditLog).order_by(AuditLog.id.desc()).limit(12)),
    }
