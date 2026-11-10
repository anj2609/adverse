import json

import pytest

from app import clock
from app.config import get_settings
from app.security import runtime_limiter
from conftest import at
from test_campaigns import add, new_campaign, step


def test_config_schema_and_fallback_reference(client, api):
    app = api.app(placements=[api.placement_spec("home.coffee_cup", render={"fit": "cover", "background_color": "#FFF8E7", "corner_radius": 12})])
    body = api.runtime(app).json()
    assert body["schema_version"] == 1 and body["application_id"] == "focusflow" and body["config_version"] >= 1
    p = body["placements"][0]
    assert p["creative"] is None and p["fallback"] == {"kind": "bundled_asset", "ref": "assets/coffee_cup.png"}
    assert p["render"]["fit"] == "cover" and p["render"]["background_color"] == "#FFF8E7" and p["render"]["aspect_ratio"] == 1.0
    assert p["render"]["requires_transparency"] is True and p["render"]["alignment"] == "center"  # defaults are filled in


def test_active_creative_details(client, api):
    app = api.app()
    cid = api.creative("Branded cup", product_name="Morning Blend", destination_url="https://brewco.example/blend")
    api.assign(app["placements"]["home.coffee_cup"], cid)
    c = api.slot(app, "home.coffee_cup")["creative"]
    assert c["creative_id"] == cid and c["url"].startswith("http") and c["url"].endswith(".png") and c["sha256"] and c["width"] == 400
    assert c["advertiser"] == "BrewCo" and c["product_name"] == "Morning Blend" and c["destination_url"] == "https://brewco.example/blend"
    assert client.get(c["url"].replace("http://testserver", "")).status_code == 200


def test_runtime_never_leaks_admin_data(client, api):
    app = api.app()
    api.assign(app["placements"]["home.coffee_cup"], api.creative(description="internal note: client is difficult"))
    text = api.runtime(app).text
    for secret in ("runtime_key", "afk_", "approval_status", "uploaded_by", "admin@test.dev", "internal note", "created_by", "password", "priority", app["id"]):
        assert secret not in text, secret


@pytest.fixture
def keys_required(monkeypatch):
    monkeypatch.setattr(get_settings(), "runtime_require_key", True)


def test_by_default_an_app_needs_only_its_id(client, api, admin):
    a = api.app("focusflow")
    b = api.app("cookwise", "CookWise", placements=[api.placement_spec("home.milk_carton")])
    r = client.get("/api/v1/runtime/focusflow/config")  # no key, no special header
    assert r.status_code == 200 and [p["placement_id"] for p in r.json()["placements"]] == ["home.coffee_cup"]  # this app's config only
    assert [p["placement_id"] for p in client.get("/api/v1/runtime/cookwise/config").json()["placements"]] == ["home.milk_carton"]
    unknown = client.get("/api/v1/runtime/does-not-exist/config")
    assert unknown.status_code == 404 and unknown.json()["error"]["code"] == "unknown_application"
    assert client.get("/api/v1/admin/applications").status_code == 401  # knowing an app ID gives no admin access
    assert client.get(f"/api/v1/admin/applications/{a['id']}", headers=admin).json()["runtime_key_required"] is False
    assert b["runtime_key"]  # still issued, in case the server is later set to require keys


def test_with_keys_required_authentication_is_application_scoped(client, api, admin, keys_required):
    a = api.app("focusflow")
    assert client.get(f"/api/v1/admin/applications/{a['id']}", headers=admin).json()["runtime_key_required"] is True
    b = api.app("cookwise", "CookWise", placements=[api.placement_spec("home.milk_carton")])
    assert api.runtime(a).status_code == 200
    assert api.runtime(a, key=b["runtime_key"]).status_code == 401  # another app's key
    assert api.runtime(a, key="afk_nonsense").status_code == 401
    assert client.get(f"/api/v1/runtime/{a['app_key']}/config").status_code == 401  # no key at all
    unknown = client.get("/api/v1/runtime/does-not-exist/config", headers={"X-AdForge-Key": a["runtime_key"]})
    assert unknown.status_code == 401 and unknown.json() == api.runtime(a, key="afk_nonsense").json()  # can't probe which IDs exist
    assert client.get("/api/v1/admin/applications", headers={"Authorization": f"Bearer {a['runtime_key']}"}).status_code == 401  # runtime key is not admin


def test_runtime_returns_only_this_applications_creatives(client, api):
    a = api.app("focusflow")
    b = api.app("cookwise", "CookWise", placements=[api.placement_spec("home.milk_carton")])
    api.assign(b["placements"]["home.milk_carton"], api.creative("Milk"))
    assert api.slot(a, "home.coffee_cup")["creative"] is None
    assert [p["placement_id"] for p in api.runtime(a).json()["placements"]] == ["home.coffee_cup"]
    assert api.slot(b, "home.milk_carton")["creative"]["advertiser"] == "BrewCo"


def test_version_etag_and_304(client, api, admin):
    app = api.app()
    pid = app["placements"]["home.coffee_cup"]
    r1 = api.runtime(app)
    v1, etag = r1.json()["config_version"], r1.headers["etag"]
    assert api.runtime(app).json()["config_version"] == v1  # asking again doesn't move it
    again = api.runtime(app, etag=etag)
    assert again.status_code == 304 and again.content == b"" and again.headers["etag"] == etag
    api.assign(pid, api.creative())
    r2 = api.runtime(app, etag=etag)
    assert r2.status_code == 200 and r2.json()["config_version"] == v1 + 1 and r2.headers["etag"] != etag
    assert "max-age" in r2.headers["cache-control"]
    client.post(f"/api/v1/admin/placements/{pid}/restore-fallback", headers=admin)
    assert api.runtime(app).json()["config_version"] == v1 + 2


def test_version_moves_when_a_campaign_starts_by_itself(client, api, admin):
    app = api.app()
    camp = new_campaign(client, admin, app, start_time=at(hours=1).isoformat())
    add(client, admin, camp, app["placements"]["home.coffee_cup"], api.creative())
    step(client, admin, camp, "submit"); step(client, admin, camp, "approve")
    before = api.runtime(app).json()
    assert before["next_change_at"] and before["ttl_seconds"] <= 3600  # tells the app when to look again
    clock.freeze(at(hours=1, seconds=1))
    after = api.runtime(app).json()
    assert after["config_version"] == before["config_version"] + 1 and after["placements"][0]["creative"]
    log = client.get("/api/v1/admin/audit?action=campaign.active", headers=admin).json()["items"]
    assert log and log[0]["actor_email"] == "system" and log[0]["detail"]["automatic"] is True


def test_changing_placement_rules_invalidates_incompatible_assignments(client, api, admin):
    app = api.app()
    pid = app["placements"]["home.coffee_cup"]
    api.assign(pid, api.creative("Square", 400, 400))
    assert api.slot(app, "home.coffee_cup")["creative"]
    client.patch(f"/api/v1/admin/placements/{pid}", headers=admin, json={"aspect_ratio": 2.0})  # now wants a 2:1 shape
    assert api.slot(app, "home.coffee_cup")["creative"] is None  # the backend, not the app, decides eligibility


def test_integration_status_and_disable(client, api, admin):
    app = api.app()
    assert client.get(f"/api/v1/admin/applications/{app['id']}", headers=admin).json()["integration_status"] == "awaiting_connection"
    api.runtime(app)
    got = client.get(f"/api/v1/admin/applications/{app['id']}", headers=admin).json()
    assert got["integration_status"] == "connected" and got["last_seen_version"] == got["config_version"]
    clock.freeze(at(days=2))
    assert client.get(f"/api/v1/admin/applications/{app['id']}", headers=admin).status_code == 401  # the admin session itself has expired
    admin = {"Authorization": "Bearer " + client.post("/api/v1/auth/login", json={"email": "admin@test.dev", "password": "pw"}).json()["access_token"]}
    assert client.get(f"/api/v1/admin/applications/{app['id']}", headers=admin).json()["integration_status"] == "stale"
    client.put(f"/api/v1/admin/applications/{app['id']}/integration", headers=admin, json={"enabled": False})
    r = api.runtime(app)  # still a normal answer, so the app replaces whatever it was showing
    assert r.status_code == 200 and r.json()["ads_enabled"] is False
    got = client.get(f"/api/v1/admin/applications/{app['id']}", headers=admin).json()
    assert got["integration_status"] == "connected" and got["ads_enabled"] is False


def test_rotating_the_key_revokes_the_old_one(client, api, admin, keys_required):
    app = api.app()
    new = client.post(f"/api/v1/admin/applications/{app['id']}/rotate-key", headers=admin).json()["runtime_key"]
    assert api.runtime(app).status_code == 401
    assert api.runtime(app, key=new).status_code == 200


def test_runtime_cors_is_open_but_admin_is_not(client, api):
    app = api.app()
    pre = client.options(f"/api/v1/runtime/{app['app_key']}/config", headers={"Origin": "http://localhost:5555", "Access-Control-Request-Method": "GET",
                                                                              "Access-Control-Request-Headers": "x-adforge-key"})
    assert pre.status_code == 204 and pre.headers["access-control-allow-origin"] == "*" and "x-adforge-key" in pre.headers["access-control-allow-headers"].lower()
    assert api.runtime(app).headers["access-control-allow-origin"] == "*"
    evil = client.get("/api/v1/admin/applications", headers={"Origin": "http://evil.example"})
    assert "access-control-allow-origin" not in evil.headers


def test_rate_limit(client, api, monkeypatch):
    app = api.app()
    monkeypatch.setattr(get_settings(), "rate_limit_runtime_per_min", 3)
    codes = [api.runtime(app).status_code for _ in range(5)]
    assert codes == [200, 200, 200, 429, 429]
    assert api.runtime(app).headers.get("retry-after")
    runtime_limiter.reset()
