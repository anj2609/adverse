import io
import os
import tempfile
from datetime import datetime, timezone

import pytest
from PIL import Image

# Configure before the app is imported: the settings are read once.
os.environ["DATABASE_URL"] = os.environ.get("TEST_DATABASE_URL", "postgresql+psycopg://postgres@localhost:5432/adforge_test")
os.environ["STORAGE_PATH"] = tempfile.mkdtemp(prefix="adforge-test-storage-")
os.environ["RATE_LIMIT_RUNTIME_PER_MIN"] = "0"
os.environ["RATE_LIMIT_LOGIN_PER_MIN"] = "0"
os.environ["SECRET_KEY"] = "test-secret-test-secret-test-secret-1234"
os.environ["ADMIN_PASSWORD"] = "test-password"

from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import text  # noqa: E402

from app import clock  # noqa: E402
from app.db import Base, SessionLocal, engine  # noqa: E402
from app.main import create_app  # noqa: E402
from app.models import User  # noqa: E402
from app.security import hash_password, login_limiter, runtime_limiter  # noqa: E402

T0 = datetime(2030, 1, 1, 12, 0, tzinfo=timezone.utc)


@pytest.fixture(scope="session", autouse=True)
def _schema():
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    yield


@pytest.fixture(autouse=True)
def _clean():
    clock.freeze(T0)
    login_limiter.reset()
    runtime_limiter.reset()
    with engine.begin() as conn:
        names = ", ".join(t.name for t in Base.metadata.sorted_tables)
        conn.execute(text(f"TRUNCATE {names} RESTART IDENTITY CASCADE") if engine.dialect.name == "postgresql" else text("SELECT 1"))
        if engine.dialect.name != "postgresql":
            for t in reversed(Base.metadata.sorted_tables):
                conn.execute(t.delete())
    with SessionLocal() as db:
        for role in ("admin", "editor", "viewer"):
            db.add(User(email=f"{role}@test.dev", name=role.title(), role=role, password_hash=hash_password("pw")))
        db.commit()
    yield
    clock.freeze(None)


@pytest.fixture
def client():
    return TestClient(create_app())


def _login(client, role):
    r = client.post("/api/v1/auth/login", json={"email": f"{role}@test.dev", "password": "pw"})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


@pytest.fixture
def admin(client):
    return _login(client, "admin")


@pytest.fixture
def editor(client):
    return _login(client, "editor")


@pytest.fixture
def viewer(client):
    return _login(client, "viewer")


def png(w=400, h=400, color=(200, 80, 40), alpha=False, fmt="PNG") -> bytes:
    mode = "RGBA" if alpha else "RGB"
    img = Image.new(mode, (w, h), color + ((0,) if alpha else ()))
    if alpha:  # transparent corners, opaque centre
        img.paste(Image.new("RGBA", (w // 2, h // 2), color + (255,)), (w // 4, h // 4))
    out = io.BytesIO()
    img.save(out, fmt)
    return out.getvalue()


class Api:
    """Small helpers so tests read like the workflow they check."""

    def __init__(self, client, admin):
        self.c, self.h = client, admin

    def app(self, key="focusflow", name="FocusFlow", placements=None):
        r = self.c.post("/api/v1/admin/applications", headers=self.h, json={"app_key": key, "name": name, "category": "Productivity"})
        assert r.status_code == 201, r.text
        app = r.json()
        ids = {}
        for p in placements if placements is not None else [self.placement_spec("home.coffee_cup")]:
            r = self.c.post(f"/api/v1/admin/applications/{app['id']}/placements", headers=self.h, json=p)
            assert r.status_code == 201, r.text
            ids[p["placement_key"]] = r.json()["id"]
        return {**app, "placements": ids}

    @staticmethod
    def placement_spec(key, types=("product_image",), aspect=1.0, transparency=True, **extra):
        return {"placement_key": key, "name": key.split(".")[-1].replace("_", " ").title(), "supported_asset_types": list(types),
                "aspect_ratio": aspect, "requires_transparency": transparency, "min_width": 100, "min_height": 100,
                "fallback": {"kind": "bundled_asset", "ref": f"assets/{key.split('.')[-1]}.png"}, **extra}

    def creative(self, name="BrewCo Cup", w=400, h=400, asset_type="product_image", alpha=True, approve=True, advertiser="BrewCo", **kw):
        r = self.c.post("/api/v1/admin/creatives", headers=self.h, files={"file": (f"{name}.png", png(w, h, alpha=alpha), "image/png")},
                        data={"name": name, "advertiser": advertiser, "asset_type": asset_type, **kw})
        assert r.status_code == 201, r.text
        cid = r.json()["id"]
        if approve:
            assert self.c.post(f"/api/v1/admin/creatives/{cid}/approve", headers=self.h).status_code == 200
        return cid

    def assign(self, placement_id, creative_id, **kw):
        return self.c.post(f"/api/v1/admin/placements/{placement_id}/assign", headers=self.h, json={"creative_id": creative_id, **kw})

    def runtime(self, app, etag=None, key=None):
        headers = {"X-AdForge-Key": key or app["runtime_key"], **({"If-None-Match": etag} if etag else {})}
        return self.c.get(f"/api/v1/runtime/{app['app_key']}/config", headers=headers)

    def slot(self, app, placement_key, **kw):
        r = self.runtime(app, **kw)
        assert r.status_code == 200, r.text
        return next(p for p in r.json()["placements"] if p["placement_id"] == placement_key)


@pytest.fixture
def api(client, admin):
    return Api(client, admin)


def at(**kw):
    from datetime import timedelta
    return T0 + timedelta(**kw)
