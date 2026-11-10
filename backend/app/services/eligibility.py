"""The single source of truth for "what may be shown where, right now".

Precedence rule (documented in the README): for one placement, among assignments that are eligible at this
moment, the winner is the one whose campaign has the highest priority; ties go to the campaign that started most
recently (no start time counts as the earliest), then to the newest assignment, then to the lowest assignment id.
Two live-ish campaigns with the *same* priority and overlapping dates on one placement are rejected up front
(see assignments.find_conflicts), so ties are only a safety net, never a silent overwrite.
"""
from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Assignment, Campaign, Creative, Placement
from .compat import compat_problems

EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)


def effective_status(c: Campaign, now: datetime) -> str:
    """Stored workflow state combined with the clock: draft, pending_approval, rejected, scheduled, active, paused, expired."""
    if c.status in ("approved", "paused"):
        if c.end_time and now >= c.end_time:
            return "expired"
        if c.status == "paused":
            return "paused"
        if c.start_time and now < c.start_time:
            return "scheduled"
        return "active"
    return c.status


@dataclass
class Entry:
    assignment: Assignment
    campaign: Campaign
    creative: Creative
    placement: Placement


def load_entries(db: Session, application_id: str | None = None, placement_ids: list[str] | None = None) -> list[Entry]:
    q = (select(Assignment, Campaign, Creative, Placement)
         .join(Campaign, Campaign.id == Assignment.campaign_id)
         .join(Creative, Creative.id == Assignment.creative_id)
         .join(Placement, Placement.id == Assignment.placement_id)
         .where(Assignment.status == "active"))
    if application_id:
        q = q.where(Assignment.application_id == application_id)
    if placement_ids is not None:
        q = q.where(Assignment.placement_id.in_(placement_ids))
    return [Entry(*row) for row in db.execute(q).all()]


def entry_state(e: Entry, now: datetime) -> str:
    if not e.placement.is_active:
        return "placement_inactive"
    status = effective_status(e.campaign, now)
    if status != "active":
        return f"campaign_{status}"
    if e.creative.approval_status == "rejected":
        return "creative_rejected"
    if e.creative.approval_status != "approved":
        return "creative_pending"
    if not e.creative.is_active:
        return "creative_inactive"
    if compat_problems(e.placement, e.creative):
        return "incompatible"
    return "eligible"


def rank(e: Entry) -> tuple:
    return (e.campaign.priority, e.campaign.start_time or EPOCH, e.assignment.created_at, tuple(-ord(c) for c in e.assignment.id))


def resolve(entries: list[Entry], now: datetime) -> tuple[Entry | None, dict[str, str]]:
    """(winner, state per assignment id) for the entries of one placement."""
    states = {e.assignment.id: entry_state(e, now) for e in entries}
    eligible = [e for e in entries if states[e.assignment.id] == "eligible"]
    winner = max(eligible, key=rank) if eligible else None
    for e in eligible:
        if e is not winner:
            states[e.assignment.id] = "overridden"
    return winner, states


def placement_status(winner: Entry | None, states: list[str]) -> str:
    """The one label a placement card shows."""
    if winner:
        return "active"
    for label, wanted in (("scheduled", {"campaign_scheduled"}),
                          ("pending", {"campaign_pending_approval", "campaign_draft", "creative_pending"}),
                          ("rejected", {"creative_rejected", "campaign_rejected"}),
                          ("expired", {"campaign_expired", "creative_inactive"})):
        if wanted & set(states):
            return label
    return "fallback"
