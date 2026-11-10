"""Applications and placements."""
from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import clock
from ..errors import conflict
from ..models import Application, Placement
from ..security import new_runtime_key
from . import audit


def integration_status(app: Application) -> str:
    """Whether the app is talking to AdForge. Independent of the ads switch: a stopped app keeps fetching (and is told "no ads")."""
    if app.last_seen_at is None:
        return "awaiting_connection"
    return "connected" if clock.now() - app.last_seen_at < timedelta(hours=24) else "stale"


def create_application(db: Session, actor: str, data: dict) -> tuple[Application, str]:
    if db.scalar(select(Application.id).where(Application.app_key == data["app_key"])):
        raise conflict("application_exists", f"An application with ID '{data['app_key']}' is already registered")
    key, digest, prefix = new_runtime_key()
    app = Application(**data, runtime_key_hash=digest, runtime_key_prefix=prefix)
    db.add(app)
    db.flush()
    audit.record(db, actor, "application.create", "application", app.id, application_id=app.id, detail={"app_key": app.app_key, "name": app.name})
    return app, key


def rotate_key(db: Session, actor: str, app: Application) -> str:
    key, digest, prefix = new_runtime_key()
    app.runtime_key_hash, app.runtime_key_prefix = digest, prefix
    audit.record(db, actor, "application.key_rotated", "application", app.id, application_id=app.id)
    return key


def application_counts(db: Session, app_ids: list[str]) -> dict[str, tuple[int, int]]:
    counts = {i: [0, 0] for i in app_ids}
    for aid, active in db.execute(select(Placement.application_id, Placement.is_active).where(Placement.application_id.in_(app_ids))).all():
        counts[aid][0] += 1
        counts[aid][1] += 1 if active else 0
    return {k: (v[0], v[1]) for k, v in counts.items()}


def create_placement(db: Session, actor: str, app: Application, data: dict) -> Placement:
    if db.scalar(select(Placement.id).where(Placement.application_id == app.id, Placement.placement_key == data["placement_key"])):
        raise conflict("placement_exists", f"'{data['placement_key']}' is already registered in {app.name}")
    p = Placement(application_id=app.id, **data)
    db.add(p)
    db.flush()
    audit.record(db, actor, "placement.create", "placement", p.id, application_id=app.id, placement_id=p.id,
                 detail={"placement_key": p.placement_key, "name": p.name})
    return p


def update_placement(db: Session, actor: str, p: Placement, data: dict) -> Placement:
    before = {k: getattr(p, k) for k in data}
    for k, v in data.items():
        setattr(p, k, v)
    audit.record(db, actor, "placement.update" if "is_active" not in data or len(data) > 1 else
                 ("placement.activate" if p.is_active else "placement.deactivate"), "placement", p.id, application_id=p.application_id,
                 placement_id=p.id, detail={"placement_key": p.placement_key, "changed": sorted(data), "before": before})
    return p
