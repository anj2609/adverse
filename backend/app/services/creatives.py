from sqlalchemy import select
from sqlalchemy.orm import Session

from ..errors import conflict
from ..models import ApprovalRecord, Assignment, Campaign, Creative, Placement
from . import audit
from .images import store_image


def upload(db: Session, actor: str, data: bytes, meta: dict, *, family: Creative | None = None) -> Creative:
    img = store_image(data, "creatives")
    version = 1
    kwargs = {}
    if family:
        latest = db.scalar(select(Creative.version).where(Creative.family_id == family.family_id).order_by(Creative.version.desc()).limit(1))
        version, kwargs["family_id"] = (latest or 0) + 1, family.family_id
    c = Creative(**kwargs, version=version, storage_key=img.storage_key, thumbnail_key=img.thumbnail_key, file_format=img.file_format,
                 width=img.width, height=img.height, file_size=img.file_size, has_transparency=img.has_transparency, sha256=img.sha256,
                 uploaded_by=actor, **meta)
    db.add(c)
    db.flush()
    audit.record(db, actor, "creative.new_version" if family else "creative.upload", "creative", c.id,
                 detail={"name": c.name, "version": c.version, "size": f"{c.width}×{c.height}", "format": c.file_format})
    return c


def decide(db: Session, actor: str, c: Creative, decision: str, reason: str | None = None) -> Creative:
    if c.approval_status == decision:
        raise conflict("no_change", f"This creative is already {decision}")
    c.approval_status = decision
    db.add(ApprovalRecord(subject_type="creative", subject_id=c.id, decision=decision, reason=reason, decided_by=actor))
    audit.record(db, actor, f"creative.{'approve' if decision == 'approved' else 'reject'}", "creative", c.id,
                 detail={"name": c.name, "reason": reason})
    return c


def set_active(db: Session, actor: str, c: Creative, active: bool) -> Creative:
    c.is_active = active
    audit.record(db, actor, "creative.activate" if active else "creative.deactivate", "creative", c.id, detail={"name": c.name})
    return c


def usage(db: Session, c: Creative) -> list[dict]:
    rows = db.execute(select(Assignment, Campaign, Placement).join(Campaign, Campaign.id == Assignment.campaign_id)
                      .join(Placement, Placement.id == Assignment.placement_id)
                      .where(Assignment.creative_id == c.id).order_by(Assignment.created_at.desc())).all()
    return [{"assignment_id": a.id, "assignment_status": a.status, "removed_reason": a.removed_reason, "campaign_id": camp.id,
             "campaign_name": camp.name, "campaign_status": camp.status, "application_id": a.application_id, "placement_id": p.id,
             "placement_key": p.placement_key, "placement_name": p.name, "assigned_at": a.created_at, "removed_at": a.removed_at} for a, camp, p in rows]


def application_ids_using(db: Session, c: Creative) -> list[str]:
    return list(db.scalars(select(Assignment.application_id).where(Assignment.creative_id == c.id, Assignment.status == "active").distinct()).all())
