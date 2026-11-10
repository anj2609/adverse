import pytest
from sqlalchemy.exc import IntegrityError

from app.db import SessionLocal
from app.models import Placement


def test_auth_required_and_roles(client, api, editor, viewer):
    assert client.get("/api/v1/admin/applications").status_code == 401
    assert client.post("/api/v1/auth/login", json={"email": "admin@test.dev", "password": "wrong"}).status_code == 401
    body = {"app_key": "cookwise", "name": "CookWise"}
    assert client.post("/api/v1/admin/applications", headers=viewer, json=body).status_code == 403
    assert client.post("/api/v1/admin/applications", headers=editor, json=body).status_code == 403  # registering apps is admin-only
    assert client.get("/api/v1/admin/applications", headers=viewer).status_code == 200  # viewers can look


def test_register_application_and_list(client, api, admin):
    app = api.app("focusflow", "FocusFlow", placements=[])
    assert app["runtime_key"].startswith("afk_") and app["integration_status"] == "awaiting_connection"
    assert client.post("/api/v1/admin/applications", headers=admin, json={"app_key": "focusflow", "name": "again"}).json()["error"]["code"] == "application_exists"
    got = client.get(f"/api/v1/admin/applications/{app['id']}", headers=admin).json()
    assert "runtime_key" not in got and got["runtime_key_prefix"] == app["runtime_key"][:10]  # the key is only ever shown once
    for i in range(3):
        api.app(f"app-number-{i}", f"App {i}", placements=[])
    page = client.get("/api/v1/admin/applications?page=2&page_size=2", headers=admin).json()
    assert page["total"] == 4 and len(page["items"]) == 2 and page["page"] == 2
    assert client.post("/api/v1/admin/applications", headers=admin, json={"app_key": "Bad Key!", "name": "x"}).status_code == 422


def test_placement_registration_and_uniqueness(client, api, admin):
    app = api.app("focusflow", placements=[])
    spec = api.placement_spec("home.coffee_cup")
    assert client.post(f"/api/v1/admin/applications/{app['id']}/placements", headers=admin, json=spec).status_code == 201
    dup = client.post(f"/api/v1/admin/applications/{app['id']}/placements", headers=admin, json=spec)
    assert dup.status_code == 409 and dup.json()["error"]["code"] == "placement_exists"
    # the same key in a different application is fine
    other = api.app("cookwise", "CookWise", placements=[spec])
    assert other["placements"]["home.coffee_cup"]
    # and the database enforces it even if the API check were bypassed
    with SessionLocal() as db:
        db.add(Placement(application_id=app["id"], placement_key="home.coffee_cup", name="dup", supported_asset_types=["banner"]))
        with pytest.raises(IntegrityError):
            db.commit()
    bad = {**spec, "placement_key": "x.y", "supported_asset_types": ["meme"]}
    assert client.post(f"/api/v1/admin/applications/{app['id']}/placements", headers=admin, json=bad).status_code == 422


def test_import_is_all_or_nothing(client, api, admin):
    app = api.app("focusflow", placements=[api.placement_spec("home.coffee_cup")])
    batch = [api.placement_spec("home.desk_lamp"), api.placement_spec("home.coffee_cup")]  # second one already exists
    assert client.post(f"/api/v1/admin/applications/{app['id']}/placements/import", headers=admin, json=batch).status_code == 409
    keys = [p["placement_key"] for p in client.get(f"/api/v1/admin/applications/{app['id']}/placements", headers=admin).json()]
    assert keys == ["home.coffee_cup"]


def test_deactivated_placement_is_not_in_runtime(client, api, admin):
    app = api.app("focusflow", placements=[api.placement_spec("home.coffee_cup"), api.placement_spec("home.desk_lamp")])
    assert len(api.runtime(app).json()["placements"]) == 2
    client.patch(f"/api/v1/admin/placements/{app['placements']['home.desk_lamp']}", headers=admin, json={"is_active": False})
    assert [p["placement_id"] for p in api.runtime(app).json()["placements"]] == ["home.coffee_cup"]


def test_deleting_an_application_removes_what_belongs_to_it_and_keeps_the_ads_library(client, api, admin, editor):
    from sqlalchemy import func, select

    from app.db import SessionLocal
    from app.models import Assignment, Campaign, Placement
    app = api.app()
    cid = api.creative()
    api.assign(app["placements"]["home.coffee_cup"], cid)
    assert api.slot(app, "home.coffee_cup")["creative"]
    url = f"/api/v1/admin/applications/{app['id']}"
    assert client.delete(f"{url}?confirm=focusflow", headers=editor).status_code == 403  # admins only
    wrong = client.delete(f"{url}?confirm=focus", headers=admin)
    assert wrong.status_code == 400 and wrong.json()["error"]["code"] == "confirm_mismatch"
    r = client.delete(f"{url}?confirm=focusflow", headers=admin)
    assert r.status_code == 200 and r.json() == {"deleted": "focusflow", "ad_slots": 1, "scans": 0, "campaigns": 1, "ads_on_pictures": 1}
    assert client.get(url, headers=admin).status_code == 404
    assert api.runtime(app).status_code == 404  # installed copies are told the app is gone
    with SessionLocal() as db:
        for model in (Placement, Campaign, Assignment):
            assert db.scalar(select(func.count()).select_from(model).where(model.application_id == app["id"])) == 0
    assert client.get(f"/api/v1/admin/creatives/{cid}", headers=admin).status_code == 200  # the ads library is kept
    history = client.get("/api/v1/admin/audit", headers=admin, params={"application_id": app["id"]}).json()["items"]
    assert history[0]["action"] == "application.delete" and history[0]["detail"]["ad_slots"] == 1
    assert api.app()["app_key"] == "focusflow"  # the ID can be registered again
