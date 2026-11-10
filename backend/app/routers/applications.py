import json

from fastapi import APIRouter, Depends, File, Query, Request, UploadFile
from fastapi.responses import StreamingResponse
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session
from starlette.background import BackgroundTask
from starlette.concurrency import run_in_threadpool

from .. import clock
from ..config import get_settings
from ..db import get_db
from ..errors import bad_request, not_found
from ..models import Application, Assignment, AssetScan, AuditLog, Campaign, Placement, User
from ..schemas import (ApplicationCreated, ApplicationIn, ApplicationOut, ApplicationUpdate, AssetScanOut, AuditOut, IntegrationIn, Page,
                       PlacementIn, PlacementOut, PlacementUpdate, SlotsIn)
from ..security import require
from ..services import assignments as asg
from ..services import audit, connect, images, registry, scanner, slots
from ..services.eligibility import effective_status, load_entries, placement_status, resolve
from ..services.runtime import build_core, render_payload
from .deps import (Pagination, application_out, base_url, creative_out, get_app, get_placement, paginate, placement_out, touch)

router = APIRouter(prefix="/api/v1/admin", tags=["applications & placements"])


@router.post("/applications", response_model=ApplicationCreated, status_code=201)
def create_application(body: ApplicationIn, user: User = Depends(require("admin")), db: Session = Depends(get_db)):
    app, key = registry.create_application(db, user.email, body.model_dump())
    touch(db, app.id)
    db.commit()
    return ApplicationCreated(**application_out(db, app).model_dump(), runtime_key=key)


@router.get("/applications", response_model=Page[ApplicationOut])
def list_applications(q: str | None = None, p: Pagination = Depends(), _: User = Depends(require("viewer")), db: Session = Depends(get_db)):
    stmt = select(registry.Application).order_by(registry.Application.name)
    if q:
        like = f"%{q}%"
        stmt = stmt.where(registry.Application.name.ilike(like) | registry.Application.app_key.ilike(like))
    page = paginate(db, stmt, p)
    counts = registry.application_counts(db, [a.id for a in page["items"]])
    page["items"] = [application_out(db, a, counts[a.id]) for a in page["items"]]
    return page


@router.get("/applications/{app_id}", response_model=ApplicationOut)
def get_application(app_id: str, _: User = Depends(require("viewer")), db: Session = Depends(get_db)):
    return application_out(db, get_app(db, app_id))


@router.patch("/applications/{app_id}", response_model=ApplicationOut)
def update_application(app_id: str, body: ApplicationUpdate, user: User = Depends(require("editor")), db: Session = Depends(get_db)):
    app = get_app(db, app_id)
    data = body.model_dump(exclude_unset=True, exclude_none=True)
    for k, v in data.items():
        setattr(app, k, v)
    audit.record(db, user.email, "application.update", "application", app.id, application_id=app.id, detail={"changed": sorted(data)})
    db.commit()
    return application_out(db, app)


@router.put("/applications/{app_id}/integration", response_model=ApplicationOut)
def set_integration(app_id: str, body: IntegrationIn, user: User = Depends(require("admin")), db: Session = Depends(get_db)):
    """Stop (or resume) every ad in this application at once. Stopped: the runtime config says `ads_enabled: false` with
    no creatives, so a running app drops its ads on its next fetch (within about a second for an app that is waiting
    for changes). Assignments and campaigns are left as they are, so resuming brings back exactly what was showing."""
    app = get_app(db, app_id)
    if app.integration_enabled != body.enabled:
        app.integration_enabled = body.enabled
        audit.record(db, user.email, "application.ads_" + ("resumed" if body.enabled else "stopped"), "application", app.id, application_id=app.id)
        touch(db, app.id)
    db.commit()
    return application_out(db, app)


@router.delete("/applications/{app_id}")
def delete_application(app_id: str, confirm: str = Query(..., description="The application's ID again, to confirm"),
                       user: User = Depends(require("admin")), db: Session = Depends(get_db)):
    """Delete an application and everything that belongs to it: its ad slots, scans, campaigns and the ads put on its
    pictures. Ads in the library are kept (other apps may use them). Copies of the app already installed stop showing
    ads at their next check (about a second if open), because the app no longer exists. Its history stays in the audit log."""
    app = get_app(db, app_id)
    if confirm != app.app_key:
        raise bad_request("confirm_mismatch", f"Type the application ID ({app.app_key}) to confirm")
    count = lambda model, *where: db.scalar(select(func.count()).select_from(model).where(model.application_id == app.id, *where)) or 0  # noqa: E731
    removed = {"ad_slots": count(Placement), "scans": count(AssetScan), "campaigns": count(Campaign),
               "ads_on_pictures": count(Assignment, Assignment.status == "active")}
    audit.record(db, user.email, "application.delete", "application", app.id, application_id=app.id,
                 detail={"app_key": app.app_key, "name": app.name, **removed})
    db.execute(delete(Application).where(Application.id == app.id))  # the database removes what belongs to it
    db.commit()
    return {"deleted": app.app_key, **removed}


@router.post("/applications/{app_id}/rotate-key", response_model=ApplicationCreated)
def rotate_key(app_id: str, user: User = Depends(require("admin")), db: Session = Depends(get_db)):
    app = get_app(db, app_id)
    key = registry.rotate_key(db, user.email, app)
    db.commit()
    return ApplicationCreated(**application_out(db, app).model_dump(), runtime_key=key)


# ---------- scanning an app's project zip ----------
def _scan_out(scan: AssetScan, request: Request, db: Session, with_assets: bool = True) -> AssetScanOut:
    out = AssetScanOut.model_validate(scan)
    if not with_assets:
        out.assets = []
        return out
    slots_by_path = {p.asset_path: p for p in db.scalars(select(Placement).where(Placement.application_id == scan.application_id,
                                                                                 Placement.asset_path.is_not(None)))}
    media = f"{base_url(request)}/media/"
    assets = []
    for a in scan.assets:
        item = {k: v for k, v in a.items() if k not in ("preview_key", "preview_thumb_key")}
        item["preview_url"] = media + a["preview_key"] if a.get("preview_key") else (a["path"] if a.get("remote") else None)
        item["thumbnail_url"] = media + a["preview_thumb_key"] if a.get("preview_thumb_key") else (a["path"] if a.get("remote") else None)
        slot = slots_by_path.get(a["path"])
        item["slot"] = {"placement_id": slot.id, "placement_key": slot.placement_key, "is_active": slot.is_active} if slot else None
        assets.append(item)
    out.assets = assets
    return out


@router.post("/applications/{app_id}/scans", response_model=AssetScanOut, status_code=201)
async def scan_application(app_id: str, request: Request, file: UploadFile = File(..., description="The app's Flutter project as a .zip"),
                           user: User = Depends(require("editor")), db: Session = Depends(get_db)):
    """Find every picture the app bundles (PNG, JPEG, WebP declared in pubspec.yaml), its resolutions, whether it is a
    cut-out, and where the code uses it. The zip is read in place and never stored; only previews and findings are kept.
    Nothing changes in the app until you turn pictures into ad slots."""
    app = get_app(db, app_id)
    limit = get_settings().max_scan_bytes
    if file.size is not None and file.size > limit:
        raise bad_request("zip_too_big", f"The zip is larger than {limit // (1024 * 1024)} MB. Zip just the project: lib, assets and pubspec.yaml")
    result = await run_in_threadpool(scanner.scan_zip, file.file, file.filename or "app.zip")
    scan = slots.save_scan(db, user.email, app, result)
    # pictures that are already ad slots follow the newer version of the app by themselves (sizes, previews)
    existing = set(db.scalars(select(Placement.asset_path).where(Placement.application_id == app.id, Placement.asset_path.is_not(None))))
    refresh = [a["path"] for a in scan.assets if a.get("replaceable") and a["path"] in existing]
    if refresh:
        slots.create_slots(db, user.email, app, scan, refresh)
        touch(db, app.id)
    db.commit()
    return _scan_out(scan, request, db)


@router.post("/applications/{app_id}/ready-zip", response_class=StreamingResponse,
             responses={200: {"content": {"application/zip": {}}, "description": "The project zip with AdForge added"}})
async def app_ready_for_ads(app_id: str, request: Request, file: UploadFile = File(..., description="The app's Flutter project as a .zip"),
                            user: User = Depends(require("editor")), db: Session = Depends(get_db)):
    """The app's own project, with AdForge added so its developer only builds and publishes it: AdForge's files in
    lib/adforge/, this server's address and the app's ID in lib/adforge/connection.dart, AdForge's packages in pubspec.yaml,
    and runApp(...) wrapped once. Nothing else changes. Neither the upload nor the result is kept on the server.
    The header X-AdForge-Report says what was changed."""
    app = get_app(db, app_id)
    limit = get_settings().max_scan_bytes
    if file.size is not None and file.size > limit:
        raise bad_request("zip_too_big", f"The zip is larger than {limit // (1024 * 1024)} MB")
    out, package, report = await run_in_threadpool(connect.make_ready, file.file, app.app_key, base_url(request))
    audit.record(db, user.email, "application.ready_zip", "application", app.id, application_id=app.id,
                 detail={"file_name": file.filename, "main_file": report["main_file"], "packages_added": report["packages_added"]})
    db.commit()
    headers = {"Content-Disposition": f'attachment; filename="{package}-ready-for-ads.zip"', "X-AdForge-Report": json.dumps(report)}
    return StreamingResponse(iter(lambda: out.read(1024 * 1024), b""), media_type="application/zip", headers=headers, background=BackgroundTask(out.close))


@router.get("/applications/{app_id}/scans", response_model=list[AssetScanOut])
def list_scans(app_id: str, request: Request, _: User = Depends(require("viewer")), db: Session = Depends(get_db)):
    """Earlier scans of this app, newest first (summaries only; open one for its pictures)."""
    app = get_app(db, app_id)
    scans = db.scalars(select(AssetScan).where(AssetScan.application_id == app.id).order_by(AssetScan.created_at.desc()).limit(20)).all()
    return [_scan_out(s, request, db, with_assets=False) for s in scans]


def _get_scan(db: Session, scan_id: str) -> AssetScan:
    scan = db.get(AssetScan, scan_id)
    if scan is None:
        raise not_found("Scan")
    return scan


@router.get("/scans/{scan_id}", response_model=AssetScanOut)
def get_scan(scan_id: str, request: Request, _: User = Depends(require("viewer")), db: Session = Depends(get_db)):
    return _scan_out(_get_scan(db, scan_id), request, db)


@router.post("/scans/{scan_id}/slots")
def create_slots(scan_id: str, body: SlotsIn, user: User = Depends(require("editor")), db: Session = Depends(get_db)):
    """Turn chosen pictures into ad slots. Each one can then take an ad like any placement; the ad is fitted to the
    original's exact pixels for every resolution the app ships, so the app's layout never moves."""
    scan = _get_scan(db, scan_id)
    app = get_app(db, scan.application_id)
    results = slots.create_slots(db, user.email, app, scan, body.paths)
    touch(db, app.id)
    db.commit()
    return {"results": results, "created": sum(r["status"] == "created" for r in results), "updated": sum(r["status"] == "updated" for r in results)}


# ---------- placements ----------
@router.post("/applications/{app_id}/placements", response_model=PlacementOut, status_code=201)
def create_placement(app_id: str, body: PlacementIn, request: Request, user: User = Depends(require("editor")), db: Session = Depends(get_db)):
    app = get_app(db, app_id)
    p = registry.create_placement(db, user.email, app, body.model_dump())
    touch(db, app.id)
    db.commit()
    return placement_out(p, request)


@router.post("/applications/{app_id}/placements/import", response_model=list[PlacementOut], status_code=201)
def import_placements(app_id: str, body: list[PlacementIn], request: Request, user: User = Depends(require("editor")), db: Session = Depends(get_db)):
    """Register a whole placement registry at once (what an app's integration exports). All or nothing."""
    app = get_app(db, app_id)
    keys = [b.placement_key for b in body]
    if len(keys) != len(set(keys)):
        raise bad_request("duplicate_keys", "The same placement key appears twice in the import")
    made = [registry.create_placement(db, user.email, app, b.model_dump()) for b in body]
    touch(db, app.id)
    db.commit()
    return [placement_out(p, request) for p in made]


@router.get("/applications/{app_id}/placements", response_model=list[PlacementOut])
def list_placements(app_id: str, request: Request, include_inactive: bool = True, _: User = Depends(require("viewer")), db: Session = Depends(get_db)):
    app = get_app(db, app_id)
    stmt = select(Placement).where(Placement.application_id == app.id).order_by(Placement.placement_key)
    if not include_inactive:
        stmt = stmt.where(Placement.is_active.is_(True))
    return [placement_out(p, request) for p in db.scalars(stmt).all()]


@router.get("/placements/{placement_id}", response_model=PlacementOut)
def get_placement_(placement_id: str, request: Request, _: User = Depends(require("viewer")), db: Session = Depends(get_db)):
    return placement_out(get_placement(db, placement_id), request)


@router.patch("/placements/{placement_id}", response_model=PlacementOut)
def update_placement(placement_id: str, body: PlacementUpdate, request: Request, user: User = Depends(require("editor")), db: Session = Depends(get_db)):
    p = get_placement(db, placement_id)
    data = body.model_dump(exclude_unset=True)
    data = {k: v for k, v in data.items() if v is not None or k in ("aspect_ratio", "min_width", "min_height")}
    registry.update_placement(db, user.email, p, data)
    touch(db, p.application_id)
    db.commit()
    return placement_out(p, request)


@router.put("/placements/{placement_id}/fallback-preview", response_model=PlacementOut)
async def set_fallback_preview(placement_id: str, request: Request, file: UploadFile = File(...), user: User = Depends(require("editor")),
                               db: Session = Depends(get_db)):
    """A picture of the app's own default asset so the dashboard can show original vs replacement.
    Stored apart from creatives; the app's real asset is never touched."""
    p = get_placement(db, placement_id)
    stored = images.store_image(await file.read(get_settings().max_upload_bytes + 1), "fallbacks")
    p.fallback = {**(p.fallback or {}), "storage_key": stored.storage_key, "width": stored.width, "height": stored.height}
    audit.record(db, user.email, "placement.fallback_preview", "placement", p.id, application_id=p.application_id, placement_id=p.id)
    db.commit()
    return placement_out(p, request)


@router.get("/placements/{placement_id}/history", response_model=Page[AuditOut])
def placement_history(placement_id: str, p: Pagination = Depends(), _: User = Depends(require("viewer")), db: Session = Depends(get_db)):
    get_placement(db, placement_id)
    return paginate(db, select(AuditLog).where(AuditLog.placement_id == placement_id).order_by(AuditLog.id.desc()), p, AuditOut.model_validate)


@router.post("/placements/{placement_id}/restore-fallback")
def restore_fallback(placement_id: str, user: User = Depends(require("admin")), db: Session = Depends(get_db)):
    """Show the app's own asset again by removing whatever creative is showing (or waiting behind it)."""
    p = get_placement(db, placement_id)
    removed = asg.restore_fallback(db, user.email, p)
    touch(db, p.application_id)
    db.commit()
    return {"placement_id": p.placement_key, "removed_assignments": removed}


# ---------- views for the dashboard ----------
@router.get("/applications/{app_id}/workspace")
def workspace(app_id: str, request: Request, _: User = Depends(require("viewer")), db: Session = Depends(get_db)):
    """Every placement with its original asset, what is showing now, and everything queued behind it."""
    app = get_app(db, app_id)
    now = clock.now()
    by_p: dict[str, list] = {}
    for e in load_entries(db, app.id):
        by_p.setdefault(e.placement.id, []).append(e)
    cards = []
    for p in db.scalars(select(Placement).where(Placement.application_id == app.id).order_by(Placement.placement_key)).all():
        entries = by_p.get(p.id, [])
        winner, states = resolve(entries, now)
        summary = lambda e: {  # noqa: E731
            "assignment_id": e.assignment.id, "state": states[e.assignment.id], "creative": creative_out(e.creative, request),
            "campaign": {"id": e.campaign.id, "name": e.campaign.name, "status": effective_status(e.campaign, now), "priority": e.campaign.priority,
                         "start_time": e.campaign.start_time, "end_time": e.campaign.end_time, "is_direct": e.campaign.is_direct}}
        cards.append({"placement": placement_out(p, request), "status": placement_status(winner, list(states.values())),
                      "effective": summary(winner) if winner else None,
                      "assignments": [summary(e) for e in sorted(entries, key=lambda e: e.assignment.created_at, reverse=True)]})
    return {"application": application_out(db, app), "placements": cards}


@router.get("/applications/{app_id}/runtime-preview")
def runtime_preview(app_id: str, request: Request, _: User = Depends(require("viewer")), db: Session = Depends(get_db)):
    """Exactly the document the runtime API would hand this application right now, plus the evidence of what the
    real app last received. A preview is not proof the app got it: `last_seen_*` is."""
    app = get_app(db, app_id)
    now = clock.now()
    s = get_settings()
    return {"config": render_payload(build_core(db, app, now), app, base_url(request), now, s.runtime_ttl_seconds, s.runtime_max_stale_seconds),
            "last_seen_at": app.last_seen_at, "last_seen_version": app.last_seen_version,
            "app_is_up_to_date": app.last_seen_version == app.config_version}
