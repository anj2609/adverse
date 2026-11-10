"""Turning what a project-zip scan found into asset slots: placements whose ad the AdForge asset bundle swaps in
wherever the app loads that picture. Nothing in the app changes per slot; it only has to use the asset bundle once."""
import posixpath
import re

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..models import ASSET_TYPES, Application, AssetScan, Placement
from . import audit, registry

# Ads sit on top of the app's own picture, so any kind of ad can go on any picture; an admin can narrow it per slot.
ALL_TYPES = list(ASSET_TYPES)
ON_TOP = {"ad_position": "bottom_right", "ad_size": 0.3}


def save_scan(db: Session, actor: str, app: Application, result: dict) -> AssetScan:
    scan = AssetScan(application_id=app.id, file_name=result["file_name"][:255], project_name=(result.get("project_name") or None),
                     summary=result["summary"], assets=result["assets"], warnings=result["warnings"], created_by=actor)
    db.add(scan)
    db.flush()
    audit.record(db, actor, "application.scan", "application", app.id, application_id=app.id,
                 detail={"scan_id": scan.id, "file_name": scan.file_name, **result["summary"]})
    return scan


def slot_key(path: str, taken: set[str]) -> str:
    """assets/images/coffee_cup.png -> asset.images.coffee_cup (unique within the application)."""
    stem = posixpath.splitext(path.removeprefix("assets/"))[0].lower().replace("/", ".")
    key = ("asset." + re.sub(r"[^a-z0-9._-]+", "_", stem).strip("._-"))[:110].rstrip("._-")
    candidate, n = key, 2
    while candidate in taken:
        candidate, n = f"{key}-{n}", n + 1
    return candidate


def _remote_slot(app: Application, a: dict, taken: set[str]) -> dict:
    """A photo the app loads from a web address. Any ad fits: the app sizes and crops that photo itself."""
    base = re.sub(r"[^a-z0-9]+", "_", a["name"].lower()).strip("_")[:100] or "photo"
    key, n = f"web.{base}", 2
    while key in taken:
        key, n = f"web.{base}-{n}", n + 1
    use = a["usages"][0] if a.get("usages") else {}
    where = f", used in {use['file']}:{use['line']}" if use.get("file") else ""
    return {"placement_key": key, "name": a["name"][:1].upper() + a["name"][1:], "description": f"Photo the app loads from {a['host']}{where}.",
            "supported_asset_types": ALL_TYPES, "supported_formats": ["png", "jpeg", "webp"], "aspect_ratio": None,
            "max_file_size_bytes": get_settings().max_upload_bytes, "requires_transparency": False,
            # apps nearly always crop photos to fit a box: keep the ad in the part that stays visible
            "render": {"fit": "cover", "alignment": "center", "rendering_mode": "image", **ON_TOP, "ad_area": "safe"}, "fallback": {"kind": "remote_url", "ref": a["path"]},
            "integration": "remote", "asset_path": a["path"], "variants": []}


def _title(path: str) -> str:
    return re.sub(r"[_\-]+", " ", posixpath.splitext(posixpath.basename(path))[0]).strip().capitalize() or path


def create_slots(db: Session, actor: str, app: Application, scan: AssetScan, paths: list[str]) -> list[dict]:
    """One result per requested path: created, updated (already a slot: refreshed from this scan), or why not."""
    found = {a["path"]: a for a in scan.assets}
    existing = {p.asset_path: p for p in db.scalars(select(Placement).where(Placement.application_id == app.id, Placement.asset_path.is_not(None)))}
    taken = set(db.scalars(select(Placement.placement_key).where(Placement.application_id == app.id)))
    results = []
    for path in dict.fromkeys(paths):
        a = found.get(path)
        if a is None:
            results.append({"path": path, "status": "not_found", "reason": "Not in this scan"})
            continue
        if a.get("remote"):
            if path in existing:
                p = existing[path]
                results.append({"path": path, "status": "updated", "placement_id": p.id, "placement_key": p.placement_key})
                continue
            p = registry.create_placement(db, actor, app, _remote_slot(app, a, taken))
            taken.add(p.placement_key)
            results.append({"path": path, "status": "created", "placement_id": p.id, "placement_key": p.placement_key})
            continue
        if not a.get("replaceable") or not a.get("variants"):
            results.append({"path": path, "status": "not_replaceable", "reason": a.get("reason") or "This picture can't be swapped"})
            continue
        fallback = {"kind": "bundled_asset", "ref": path, "storage_key": a["preview_key"], "width": a["width"], "height": a["height"]}
        ratio = round(a["width"] / a["height"], 4)
        p = existing.get(path)
        if p is not None:  # the app shipped a new version of this picture: follow its sizes, keep the admin's choices
            p.variants, p.fallback, p.aspect_ratio = a["variants"], {**(p.fallback or {}), **fallback}, ratio
            audit.record(db, actor, "placement.update", "placement", p.id, application_id=app.id, placement_id=p.id,
                         detail={"placement_key": p.placement_key, "changed": ["variants", "fallback"], "scan_id": scan.id})
            results.append({"path": path, "status": "updated", "placement_id": p.id, "placement_key": p.placement_key})
            continue
        use = (a.get("usages") or [{}])[0]
        where = f", used in {use['file']}:{use['line']}" if use.get("file") else ", not referenced in lib/ (it may be loaded by name)"
        key = slot_key(path, taken)
        taken.add(key)
        p = registry.create_placement(db, actor, app, {
            "placement_key": key, "name": _title(path), "description": f"The app's own picture {path}{where}.",
            "supported_asset_types": ALL_TYPES, "supported_formats": ["png", "jpeg", "webp"],
            "aspect_ratio": ratio, "aspect_tolerance": 0.05, "max_file_size_bytes": get_settings().max_upload_bytes,
            "requires_transparency": False, "render": {"fit": "contain", "alignment": "center", "rendering_mode": "image", **ON_TOP},
            "fallback": fallback, "integration": "asset", "asset_path": path, "variants": a["variants"]})
        results.append({"path": path, "status": "created", "placement_id": p.id, "placement_key": p.placement_key})
    return results
