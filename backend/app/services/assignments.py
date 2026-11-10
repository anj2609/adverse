"""Putting creatives into placements: single, direct (one-click), bulk, and rolling it back."""
from dataclasses import dataclass, field
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import clock
from ..errors import ApiError, conflict, not_found
from ..models import Application, Assignment, BulkOperation, Campaign, Creative, Placement
from . import audit
from .compat import compat_problems
from .eligibility import effective_status, load_entries, rank, resolve

LIVEISH = ("pending_approval", "approved", "paused")  # campaigns that count when looking for clashes
MIN_T = datetime(1970, 1, 1, tzinfo=timezone.utc)
MAX_T = datetime(9999, 1, 1, tzinfo=timezone.utc)


def overlaps(s1, e1, s2, e2) -> bool:
    return (s1 or MIN_T) < (e2 or MAX_T) and (s2 or MIN_T) < (e1 or MAX_T)


def find_conflicts(db: Session, placement: Placement, start, end, priority: int, exclude_campaign_id: str | None = None,
                   ignore_assignment_ids: set[str] | None = None) -> list[dict]:
    """Other campaigns that want this placement at the same time with the same priority: nobody could win fairly."""
    now = clock.now()
    rows = db.execute(select(Assignment, Campaign).join(Campaign, Campaign.id == Assignment.campaign_id).where(
        Assignment.placement_id == placement.id, Assignment.status == "active",
        Campaign.status.in_(LIVEISH), Campaign.priority == priority)).all()
    out = []
    for a, c in rows:
        if c.id == exclude_campaign_id or a.id in (ignore_assignment_ids or set()):
            continue
        if c.end_time and c.end_time <= now:
            continue  # already over, can't clash with anything going forward
        if overlaps(start, end, c.start_time, c.end_time):
            out.append({"campaign_id": c.id, "campaign_name": c.name, "placement_id": placement.placement_key, "priority": c.priority})
    return out


def assignability_errors(app_id: str, placement: Placement, creative: Creative) -> list[dict]:
    errs: list[dict] = []
    if placement.application_id != app_id:
        return [{"code": "wrong_application", "message": "This placement belongs to a different application"}]
    if not placement.is_active:
        errs.append({"code": "placement_inactive", "message": "This placement is switched off"})
    if creative.approval_status == "rejected":
        errs.append({"code": "creative_rejected", "message": "This creative was rejected"})
    if not creative.is_active:
        errs.append({"code": "creative_inactive", "message": "This creative is deactivated"})
    return errs + compat_problems(placement, creative)


def _audit(db, actor, action, a: Assignment, *, bulk_id=None, **detail):
    audit.record(db, actor, action, "assignment", a.id, application_id=a.application_id, placement_id=a.placement_id,
                 campaign_id=a.campaign_id, bulk_operation_id=bulk_id or a.bulk_operation_id,
                 detail={"creative_id": a.creative_id, **detail})


def add_assignment(db: Session, actor: str, campaign: Campaign, placement: Placement, creative: Creative, *, bulk_id: str | None = None,
                   replaced: Assignment | None = None) -> tuple[Assignment, str]:
    """Returns (assignment, outcome) where outcome is created | replaced | unchanged."""
    if campaign.status in ("rejected", "expired"):
        raise conflict("campaign_not_editable", f"A {campaign.status} campaign can't take new assignments")
    errs = assignability_errors(campaign.application_id, placement, creative)
    if errs:
        raise ApiError(422, "incompatible", "That creative can't be used in this placement", errs)
    if campaign.status in LIVEISH:
        clashes = find_conflicts(db, placement, campaign.start_time, campaign.end_time, campaign.priority, campaign.id)
        if clashes:
            raise conflict("assignment_conflict", "Another campaign with the same priority already wants this placement at the same time", clashes)
    existing = db.scalar(select(Assignment).where(Assignment.campaign_id == campaign.id, Assignment.placement_id == placement.id,
                                                  Assignment.status == "active"))
    if existing:
        if existing.creative_id == creative.id:
            return existing, "unchanged"
        _audit(db, actor, "assignment.replace", existing, placement_key=placement.placement_key, from_creative=existing.creative_id,
               to_creative=creative.id, campaign=campaign.name)
        existing.previous_creative_id, existing.creative_id = existing.creative_id, creative.id
        return existing, "replaced"
    a = Assignment(application_id=campaign.application_id, campaign_id=campaign.id, placement_id=placement.id, creative_id=creative.id,
                   created_by=actor, bulk_operation_id=bulk_id, replaced_assignment_id=replaced.id if replaced else None)
    db.add(a)
    db.flush()
    _audit(db, actor, "assignment.create", a, placement_key=placement.placement_key, creative=creative.name, campaign=campaign.name,
           replaced_assignment_id=replaced.id if replaced else None)
    return a, "created"


def remove_assignment(db: Session, actor: str, a: Assignment, reason: str = "removed") -> None:
    if a.status != "active":
        raise conflict("not_active", "That assignment is already removed")
    a.status, a.removed_reason, a.removed_at, a.removed_by = "removed", reason, clock.now(), actor
    db.flush()
    placement = db.get(Placement, a.placement_id)
    _audit(db, actor, "assignment.remove" if reason == "removed" else f"assignment.{reason}", a,
           placement_key=placement.placement_key if placement else None, reason=reason)
    campaign = db.get(Campaign, a.campaign_id)
    if campaign and campaign.is_direct and reason != "replaced" and campaign.status not in ("expired", "rejected"):
        if not db.scalar(select(Assignment.id).where(Assignment.campaign_id == campaign.id, Assignment.status == "active").limit(1)):
            campaign.status = "expired"  # a one-click campaign with nothing left in it has nothing to do
            audit.record(db, actor, "campaign.expire", "campaign", campaign.id, application_id=campaign.application_id,
                         campaign_id=campaign.id, detail={"reason": "last assignment removed"})


# ---------- direct and bulk assignment ----------
@dataclass
class PlanItem:
    placement: Placement | None
    key: str
    errors: list[dict] = field(default_factory=list)
    warnings: list[dict] = field(default_factory=list)
    replaces: Assignment | None = None
    current_creative_id: str | None = None
    becomes_effective: bool | None = None


def plan_bulk(db: Session, app: Application, placement_keys_or_ids: list[str], creative: Creative, *, campaign: Campaign | None,
              start, end, priority: int) -> list[PlanItem]:
    now = clock.now()
    items: list[PlanItem] = []
    seen: set[str] = set()
    for ref in placement_keys_or_ids:
        p = db.scalar(select(Placement).where(Placement.application_id == app.id, (Placement.id == ref) | (Placement.placement_key == ref)))
        if p is None:
            items.append(PlanItem(None, ref, [{"code": "not_found", "message": "No such placement in this application"}]))
            continue
        if p.id in seen:
            items.append(PlanItem(p, p.placement_key, [{"code": "duplicate", "message": "Listed more than once"}]))
            continue
        seen.add(p.id)
        item = PlanItem(p, p.placement_key)
        item.errors += assignability_errors(app.id, p, creative)
        entries = load_entries(db, app.id, [p.id])
        winner, _ = resolve(entries, now)
        item.current_creative_id = winner.creative.id if winner else None
        replaced_ids: set[str] = set()
        if campaign is None:  # direct: supersedes the placement's existing direct assignment
            old = next((e.assignment for e in entries if e.campaign.is_direct), None)
            if old:
                item.replaces = old
                replaced_ids.add(old.id)
        camp_start, camp_end, camp_priority, camp_id = (campaign.start_time, campaign.end_time, campaign.priority, campaign.id) if campaign else (start, end, priority, None)
        clashes = find_conflicts(db, p, camp_start, camp_end, camp_priority, camp_id, replaced_ids)
        if clashes:
            item.errors.append({"code": "assignment_conflict", "message": "Same priority and overlapping dates as: " + ", ".join(c["campaign_name"] for c in clashes), "campaigns": clashes})
        # only campaigns that can still serve while this one runs: same rules as clashes, just a higher priority
        rivals = [e for e in entries if e.campaign.priority > camp_priority and e.assignment.id not in replaced_ids and e.campaign.id != camp_id
                  and e.campaign.status in LIVEISH and not (e.campaign.end_time and e.campaign.end_time <= now)
                  and overlaps(camp_start, camp_end, e.campaign.start_time, e.campaign.end_time)]
        if rivals:
            top = max(rivals, key=rank)
            state = effective_status(top.campaign, now)
            item.warnings.append({"code": "outranked", "campaign_id": top.campaign.id,
                                  "message": f"A higher-priority campaign ({top.campaign.name}) will keep showing instead" if state == "active"
                                  else f"A higher-priority campaign ({top.campaign.name}, {state.replace('_', ' ')}) takes precedence whenever it runs"})
        items.append(item)
    return items


def _result(i: PlanItem, status: str, assignment_id: str | None = None) -> dict:
    return {"placement_id": i.key, "status": status, "assignment_id": assignment_id, "errors": i.errors, "warnings": i.warnings,
            "replaces_assignment_id": i.replaces.id if i.replaces else None, "previous_creative_id": i.current_creative_id}


def preview_bulk(db: Session, app: Application, placement_refs, creative, *, campaign, start, end, priority) -> list[dict]:
    return [_result(i, "ok" if not i.errors else "invalid") for i in plan_bulk(db, app, placement_refs, creative, campaign=campaign, start=start, end=end, priority=priority)]


def bulk_assign(db: Session, actor: str, app: Application, placement_refs: list[str], creative: Creative, *, campaign: Campaign | None, start, end,
                priority: int, mode: str, name: str | None, timezone_name: str = "UTC") -> BulkOperation:
    """Validate every placement first; apply nothing if any fails (all_or_nothing) or only the valid ones (partial).
    Writes happen after validation in one transaction, so a failure can never leave half an assignment behind."""
    plan = plan_bulk(db, app, placement_refs, creative, campaign=campaign, start=start, end=end, priority=priority)
    bad = [i for i in plan if i.errors]
    op = BulkOperation(application_id=app.id, creative_id=creative.id, campaign_id=campaign.id if campaign else None, mode=mode, created_by=actor)
    db.add(op)
    db.flush()
    if not plan or (bad and (mode == "all_or_nothing" or len(bad) == len(plan))):
        op.status, op.results = "failed", [_result(i, "failed" if i.errors else "not_applied") for i in plan]
        audit.record(db, actor, "bulk.assign", "bulk_operation", op.id, application_id=app.id, bulk_operation_id=op.id, outcome="failure",
                     detail={"creative": creative.name, "failed": len(bad), "requested": len(plan)})
        db.commit()  # keep the record of the attempt even though nothing was applied
        raise ApiError(422, "bulk_validation_failed", "Nothing was changed: some placements can't take this creative", op.results)
    target = campaign
    if target is None:
        target = Campaign(application_id=app.id, name=name or f"Direct: {creative.name}", advertiser=creative.advertiser, start_time=start, end_time=end,
                          timezone=timezone_name, status="approved", priority=priority, is_direct=True, created_by=actor,
                          description="Created from the creative workspace")
        db.add(target)
        db.flush()
        audit.record(db, actor, "campaign.create", "campaign", target.id, application_id=app.id, campaign_id=target.id,
                     bulk_operation_id=op.id, detail={"direct": True, "name": target.name})
    results = []
    for i in plan:
        if i.errors:
            results.append(_result(i, "skipped"))
            continue
        if i.replaces:
            remove_assignment(db, actor, i.replaces, "replaced")
        a, outcome = add_assignment(db, actor, target, i.placement, creative, bulk_id=op.id, replaced=i.replaces)
        results.append(_result(i, outcome, a.id))
    op.results = results
    op.status = "partial" if bad else "applied"
    op.campaign_id = target.id
    audit.record(db, actor, "bulk.assign", "bulk_operation", op.id, application_id=app.id, campaign_id=target.id, bulk_operation_id=op.id,
                 detail={"creative": creative.name, "applied": len(plan) - len(bad), "skipped": len(bad), "mode": mode})
    return op


# ---------- restore fallback and rollback ----------
def restore_fallback(db: Session, actor: str, placement: Placement) -> list[str]:
    """Show the original asset again: remove whatever is showing (or waiting behind what's showing) right now."""
    now = clock.now()
    entries = load_entries(db, placement.application_id, [placement.id])
    _, states = resolve(entries, now)
    removed = []
    for e in entries:
        if states[e.assignment.id] in ("eligible", "overridden"):
            remove_assignment(db, actor, e.assignment, "removed")
            removed.append(e.assignment.id)
    audit.record(db, actor, "placement.restore_fallback", "placement", placement.id, application_id=placement.application_id,
                 placement_id=placement.id, detail={"placement_key": placement.placement_key, "removed_assignments": removed})
    return removed


def rollback_assignment(db: Session, actor: str, a: Assignment) -> str:
    if a.status != "active":
        raise conflict("not_rollbackable", "Only a live assignment can be rolled back; this one was already removed")
    if a.previous_creative_id and not a.replaced_assignment_id:  # it replaced another creative inside the same campaign: swap back
        restored, a.creative_id, a.previous_creative_id = a.creative_id, a.previous_creative_id, None
        _audit(db, actor, "assignment.rollback", a, restored_creative=a.creative_id, undone_creative=restored)
        return "restored_previous_creative"
    remove_assignment(db, actor, a, "rolled_back")
    if a.replaced_assignment_id:
        old = db.get(Assignment, a.replaced_assignment_id)
        if old and old.status == "removed" and old.removed_reason == "replaced":
            old.status, old.removed_reason, old.removed_at, old.removed_by = "active", None, None, None
            db.flush()
            _audit(db, actor, "assignment.rollback", old, restored_assignment=old.id)
            return "restored_replaced_assignment"
    return "removed"


def rollback_bulk(db: Session, actor: str, op: BulkOperation) -> BulkOperation:
    if op.status == "rolled_back":
        raise conflict("already_rolled_back", "This operation was already rolled back")
    if op.status == "failed":
        raise conflict("not_rollbackable", "Nothing was applied, so there is nothing to roll back")
    results = []
    for a in db.scalars(select(Assignment).where(Assignment.bulk_operation_id == op.id).order_by(Assignment.created_at)).all():
        placement = db.get(Placement, a.placement_id)
        if a.status == "active":
            results.append({"placement_id": placement.placement_key, "assignment_id": a.id, "status": rollback_assignment(db, actor, a)})
        else:
            results.append({"placement_id": placement.placement_key, "assignment_id": a.id, "status": "skipped", "note": "Already removed since"})
    op.status, op.rolled_back_at, op.rolled_back_by = "rolled_back", clock.now(), actor
    audit.record(db, actor, "bulk.rollback", "bulk_operation", op.id, application_id=op.application_id, bulk_operation_id=op.id,
                 detail={"results": results})
    return op


def get_or_404(db: Session, model, id_: str, label: str):
    obj = db.get(model, id_)
    if obj is None:
        raise not_found(label)
    return obj
