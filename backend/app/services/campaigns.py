"""Campaign workflow: draft -> pending approval -> approved -> (scheduled | active) -> expired, with pause and reject."""
from datetime import datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import clock
from ..errors import ApiError, bad_request, conflict
from ..models import ApprovalRecord, Assignment, Campaign, Placement
from . import audit
from .assignments import LIVEISH, assignability_errors, find_conflicts
from .eligibility import effective_status


def to_utc(value: datetime | None, tz_name: str) -> datetime | None:
    """Times typed without a zone are read in the campaign's own time zone, then stored as UTC."""
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=check_timezone(tz_name))
    return value.astimezone(ZoneInfo("UTC"))


def check_timezone(name: str) -> ZoneInfo:
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        raise bad_request("bad_timezone", f"'{name}' is not a known time zone (use names like Europe/Paris or UTC)")


def check_window(start, end) -> None:
    if start and end and end <= start:
        raise bad_request("bad_window", "The end time must be after the start time")


def _rec(db, c: Campaign, decision: str, actor: str, reason: str | None = None):
    db.add(ApprovalRecord(subject_type="campaign", subject_id=c.id, decision=decision, reason=reason, decided_by=actor))


def _log(db, actor: str, action: str, c: Campaign, **detail):
    audit.record(db, actor, action, "campaign", c.id, application_id=c.application_id, campaign_id=c.id, detail={"name": c.name, **detail})


def active_assignments(db: Session, c: Campaign) -> list[Assignment]:
    return list(db.scalars(select(Assignment).where(Assignment.campaign_id == c.id, Assignment.status == "active")).all())


def check_ready(db: Session, c: Campaign, *, require_approved_creatives: bool) -> None:
    """Everything that must hold before a campaign may become live-ish."""
    assignments = active_assignments(db, c)
    if not assignments:
        raise conflict("no_assignments", "Add at least one creative assignment first")
    problems, clashes, unapproved = [], [], []
    for a in assignments:
        p = db.get(Placement, a.placement_id)
        errs = assignability_errors(c.application_id, p, a.creative)
        if errs:
            problems.append({"placement_id": p.placement_key, "errors": errs})
        if require_approved_creatives and a.creative.approval_status != "approved":
            unapproved.append({"placement_id": p.placement_key, "creative": a.creative.name, "status": a.creative.approval_status})
        clashes += find_conflicts(db, p, c.start_time, c.end_time, c.priority, c.id)
    if problems:
        raise ApiError(422, "incompatible", "Some assignments no longer fit their placements", problems)
    if unapproved:
        raise conflict("creative_not_approved", "Every creative in the campaign must be approved first", unapproved)
    if clashes:
        raise conflict("assignment_conflict", "Another campaign with the same priority already wants these placements at the same time", clashes)


def create(db: Session, actor: str, application_id: str, data: dict) -> Campaign:
    tz = data.get("timezone") or "UTC"
    check_timezone(tz)
    start, end = to_utc(data.get("start_time"), tz), to_utc(data.get("end_time"), tz)
    check_window(start, end)
    c = Campaign(application_id=application_id, name=data["name"], description=data.get("description"), advertiser=data["advertiser"],
                 start_time=start, end_time=end, timezone=tz, priority=data.get("priority", 5), created_by=actor)
    db.add(c)
    db.flush()
    _log(db, actor, "campaign.create", c)
    return c


def update(db: Session, actor: str, c: Campaign, data: dict) -> Campaign:
    if c.status == "expired":
        raise conflict("campaign_not_editable", "An expired campaign can't be edited")
    before = {"start": c.start_time, "end": c.end_time, "priority": c.priority}
    tz = data.get("timezone", c.timezone)
    check_timezone(tz)
    c.timezone = tz
    for field in ("name", "description", "advertiser", "priority"):
        if field in data and data[field] is not None:
            setattr(c, field, data[field])
    if "start_time" in data:
        c.start_time = to_utc(data["start_time"], tz)
    if "end_time" in data:
        c.end_time = to_utc(data["end_time"], tz)
    check_window(c.start_time, c.end_time)
    if c.status in LIVEISH and before != {"start": c.start_time, "end": c.end_time, "priority": c.priority}:
        check_ready(db, c, require_approved_creatives=False)  # changing dates or priority of a live campaign must not create a clash
    _log(db, actor, "campaign.update", c, changed=sorted(k for k in data), schedule_changed=before != {"start": c.start_time, "end": c.end_time, "priority": c.priority})
    return c


def _expect(c: Campaign, *allowed: str) -> None:
    if c.status not in allowed:
        raise conflict("bad_transition", f"A {c.status.replace('_', ' ')} campaign can't do that (needs: {', '.join(a.replace('_', ' ') for a in allowed)})")


def submit(db: Session, actor: str, c: Campaign) -> Campaign:
    _expect(c, "draft", "rejected")
    check_ready(db, c, require_approved_creatives=False)
    c.status = "pending_approval"
    _rec(db, c, "submitted", actor)
    _log(db, actor, "campaign.submit", c)
    return c


def approve(db: Session, actor: str, c: Campaign) -> Campaign:
    _expect(c, "pending_approval")
    check_ready(db, c, require_approved_creatives=True)
    c.status = "approved"
    _rec(db, c, "approved", actor)
    _log(db, actor, "campaign.approve", c)
    return c


def reject(db: Session, actor: str, c: Campaign, reason: str) -> Campaign:
    _expect(c, "pending_approval")
    c.status = "rejected"
    _rec(db, c, "rejected", actor, reason)
    _log(db, actor, "campaign.reject", c, reason=reason)
    return c


def pause(db: Session, actor: str, c: Campaign) -> Campaign:
    _expect(c, "approved")
    if effective_status(c, clock.now()) == "expired":
        raise conflict("bad_transition", "This campaign has already ended")
    c.status = "paused"
    _log(db, actor, "campaign.pause", c)
    return c


def resume(db: Session, actor: str, c: Campaign) -> Campaign:
    _expect(c, "paused")
    check_ready(db, c, require_approved_creatives=True)
    c.status = "approved"
    _log(db, actor, "campaign.resume", c)
    return c


def expire(db: Session, actor: str, c: Campaign) -> Campaign:
    if c.status == "expired":
        raise conflict("bad_transition", "Already expired")
    c.status = "expired"
    _log(db, actor, "campaign.expire", c, manual=True)
    return c
