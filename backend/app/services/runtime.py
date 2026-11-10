"""Builds what an integrated app is told to show, and keeps the application's config version honest.

The version only moves when the effective output moves: an assignment changes, a campaign starts or ends on its
own, a creative is approved or deactivated, a placement's rules change. Asking twice returns the same version."""
import hashlib
import json
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Application, Campaign, Placement
from . import audit
from .eligibility import effective_status, load_entries, resolve

SCHEMA_VERSION = 1


def _render(p: Placement) -> dict:
    r = p.render or {}
    return {
        "aspect_ratio": p.aspect_ratio, "fit": r.get("fit", "contain"), "alignment": r.get("alignment", "center"),
        "background_color": r.get("background_color"), "rendering_mode": r.get("rendering_mode", "image"),
        "max_width": r.get("max_width"), "max_height": r.get("max_height"), "corner_radius": r.get("corner_radius"),
        "requires_transparency": p.requires_transparency, "ad_position": r.get("ad_position", "bottom_right"), "ad_size": r.get("ad_size", 0.3), "ad_area": r.get("ad_area", "whole"),
        "ad_x": r.get("ad_x", 0.5), "ad_y": r.get("ad_y", 0.5), "ad_radius": r.get("ad_radius", 0),
    }


def build_core(db: Session, app: Application, now: datetime) -> dict:
    """Everything the config says, independent of the host name or the clock."""
    placements = db.scalars(select(Placement).where(Placement.application_id == app.id, Placement.is_active.is_(True))
                            .order_by(Placement.placement_key)).all()
    by_placement: dict[str, list] = {}
    for e in load_entries(db, app.id):
        by_placement.setdefault(e.placement.id, []).append(e)
    out, boundaries = [], []
    for p in placements:
        entries = by_placement.get(p.id, [])
        winner, _ = resolve(entries, now) if app.integration_enabled else (None, {})  # ads stopped app-wide: nothing is eligible
        creative = None
        if winner:
            c, camp = winner.creative, winner.campaign
            creative = {
                "creative_id": c.id, "version": c.version, "storage_key": c.storage_key, "thumbnail_key": c.thumbnail_key,
                "width": c.width, "height": c.height, "format": c.file_format, "sha256": c.sha256,
                "has_transparency": c.has_transparency, "advertiser": c.advertiser, "product_name": c.product_name,
                "destination_url": c.destination_url, "campaign_id": camp.id, "campaign_status": effective_status(camp, now),
                "valid_from": camp.start_time.isoformat() if camp.start_time else None,
                "valid_until": camp.end_time.isoformat() if camp.end_time else None,
            }
        item = {"placement_id": p.placement_key, "integration": p.integration, "render": _render(p),
                "fallback": {"kind": (p.fallback or {}).get("kind", "bundled_asset"), "ref": (p.fallback or {}).get("ref")},
                "creative": creative}
        if p.integration in ("asset", "remote"):
            item["asset_path"] = p.asset_path  # the bundled path or the web address the app loads
        if p.integration == "asset":
            item["asset_keys"] = [v["path"] for v in p.variants or [] if v.get("path")] or [p.asset_path]
        out.append(item)
        for e in entries:
            if e.campaign.status == "approved":
                boundaries += [t for t in (e.campaign.start_time, e.campaign.end_time) if t and t > now]
    return {"placements": out, "ads_enabled": app.integration_enabled, "next_change_at": min(boundaries) if boundaries else None}


def _hash(core: dict) -> str:
    return hashlib.sha256(json.dumps([core["placements"], core["ads_enabled"]], sort_keys=True, default=str).encode()).hexdigest()


def refresh_version(db: Session, app: Application, now: datetime) -> bool:
    """Bump the application's config version if (and only if) what it would be told has changed."""
    locked = db.scalar(select(Application).where(Application.id == app.id).with_for_update())  # one bump per change under concurrency
    app = locked or app
    digest = _hash(build_core(db, app, now))
    if app.config_snapshot_hash == digest:
        return False
    if app.config_snapshot_hash is not None:
        app.config_version += 1
    app.config_snapshot_hash = digest
    return True


def render_payload(core: dict, app: Application, base_url: str, now: datetime, ttl: int, max_stale: int = 6 * 3600) -> dict:
    base = base_url.rstrip("/")
    placements = []
    for p in core["placements"]:
        item = dict(p)
        if p["creative"]:
            c = dict(p["creative"])
            c["url"] = f"{base}/media/{c.pop('storage_key')}"
            c["thumbnail_url"] = f"{base}/media/{c.pop('thumbnail_key')}"
            item["creative"] = c
        placements.append(item)
    nxt = core["next_change_at"]
    wait = max(1, int((nxt - now).total_seconds())) if nxt else None
    return {
        "schema_version": SCHEMA_VERSION, "application_id": app.app_key, "config_version": app.config_version,
        "server_time": now.isoformat(), "ttl_seconds": min(ttl, wait) if wait else ttl,
        "next_change_at": nxt.isoformat() if nxt else None, "ads_enabled": core["ads_enabled"], "max_stale_seconds": max_stale,
        "placements": placements,
    }


def reconcile_application(db: Session, app: Application, now: datetime) -> None:
    """Notice campaigns that started or ended on their own, record them, and move the version if the output moved."""
    for c in db.scalars(select(Campaign).where(Campaign.application_id == app.id)).all():
        eff = effective_status(c, now)
        if c.last_effective_status != eff:
            if c.last_effective_status is not None:
                audit.record(db, "system", f"campaign.{eff}", "campaign", c.id, application_id=app.id, campaign_id=c.id,
                             detail={"from": c.last_effective_status, "to": eff, "automatic": True, "name": c.name})
            c.last_effective_status = eff
    refresh_version(db, app, now)


def reconcile_all(db: Session, now: datetime) -> None:
    for app in db.scalars(select(Application)).all():
        reconcile_application(db, app, now)
    db.commit()
