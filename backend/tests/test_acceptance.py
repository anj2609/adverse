"""The end-to-end flow from the product brief, and proof that one backend serves unrelated applications."""
from app import clock
from conftest import at, png


def test_remote_replacement_without_rebuilding_the_app(client, api, admin, editor):
    # An app registered with its placement and its own bundled fallback.
    app = api.app("focusflow", "FocusFlow", placements=[api.placement_spec("home.coffee_cup")])
    pid = app["placements"]["home.coffee_cup"]

    # 1-2. The app launches: it shows its original asset (there is no creative, only a fallback reference).
    slot = api.slot(app, "home.coffee_cup")
    assert slot["creative"] is None and slot["fallback"]["ref"] == "assets/coffee_cup.png"
    before = api.runtime(app).json()["config_version"]

    # 3-5. An editor uploads a branded product image; it can't serve until an admin approves it.
    r = client.post("/api/v1/admin/creatives", headers=editor, files={"file": ("brewco-cup.png", png(512, 512, (120, 60, 20), alpha=True), "image/png")},
                    data={"name": "BrewCo travel cup", "advertiser": "BrewCo", "asset_type": "product_image", "product_name": "Travel Cup",
                          "destination_url": "https://brewco.example/cup"})
    cid = r.json()["id"]
    assert r.json()["approval_status"] == "pending"
    assert client.post(f"/api/v1/admin/placements/{pid}/assign", headers=admin, json={"creative_id": cid}).status_code == 201
    assert api.slot(app, "home.coffee_cup")["creative"] is None  # assigned but unapproved: still the original
    assert client.post(f"/api/v1/admin/creatives/{cid}/approve", headers=admin).status_code == 200

    # 6-9. The app refreshes its config (same app binary) and now gets the branded creative.
    after = api.runtime(app).json()
    creative = next(p for p in after["placements"] if p["placement_id"] == "home.coffee_cup")["creative"]
    assert creative["creative_id"] == cid and creative["advertiser"] == "BrewCo"
    assert after["config_version"] > before
    assert client.get(creative["url"].replace("http://testserver", "")).headers["content-type"] == "image/png"

    # 10. The original is still known to AdForge as the fallback and was never overwritten.
    ws = client.get(f"/api/v1/admin/applications/{app['id']}/workspace", headers=admin).json()["placements"][0]
    assert ws["status"] == "active" and ws["placement"]["fallback"]["ref"] == "assets/coffee_cup.png" and ws["effective"]["creative"]["id"] == cid

    # 12-13. The administrator restores the fallback; the app goes back to its original asset.
    assert client.post(f"/api/v1/admin/placements/{pid}/restore-fallback", headers=admin).status_code == 200
    final = api.slot(app, "home.coffee_cup")
    assert final["creative"] is None and final["fallback"]["ref"] == "assets/coffee_cup.png"
    assert client.get(f"/api/v1/admin/applications/{app['id']}", headers=admin).json()["last_seen_version"] == api.runtime(app).json()["config_version"]


def test_expiry_returns_to_fallback_on_its_own(client, api, admin):
    app = api.app()
    pid = app["placements"]["home.coffee_cup"]
    api.assign(pid, api.creative(), start_time=at(minutes=-5).isoformat(), end_time=at(hours=1).isoformat())
    assert api.slot(app, "home.coffee_cup")["creative"]
    clock.freeze(at(hours=1, seconds=1))
    assert api.slot(app, "home.coffee_cup")["creative"] is None


def test_two_unrelated_applications_on_one_backend(client, api, admin):
    """A productivity app and a cooking app: different placements, asset types, shapes and render rules. No backend change for either."""
    focus = api.app("focusflow", "FocusFlow", placements=[
        api.placement_spec("home.coffee_cup", types=("product_image", "sticker"), aspect=1.0),
        api.placement_spec("dashboard.banner", types=("banner", "promotional_card"), aspect=3.0, transparency=False, render={"fit": "cover"})])
    cook = api.app("cookwise", "CookWise", placements=[
        api.placement_spec("recipe.milk_carton", types=("product_image",), aspect=0.5, render={"fit": "contain", "alignment": "bottomCenter"}),
        api.placement_spec("recipe.hero", types=("illustration", "background"), aspect=None, transparency=False, min_width=300),
        api.placement_spec("pantry.oil_bottle", types=("product_image",), aspect=0.4)])
    cup, banner = api.creative("Cup", 400, 400), api.creative("Banner", 900, 300, asset_type="banner", alpha=False)
    carton = api.creative("Carton", 200, 400, advertiser="DairyCo")
    assert api.assign(focus["placements"]["home.coffee_cup"], cup).status_code == 201
    assert api.assign(focus["placements"]["dashboard.banner"], banner).status_code == 201
    assert api.assign(cook["placements"]["recipe.milk_carton"], carton).status_code == 201
    assert api.assign(cook["placements"]["pantry.oil_bottle"], carton).status_code == 422  # 0.5:1 doesn't fit a 0.4:1 slot
    assert api.assign(focus["placements"]["dashboard.banner"], carton, priority=7).status_code == 422  # wrong type and shape

    f, c = api.runtime(focus).json(), api.runtime(cook).json()
    assert [p["placement_id"] for p in f["placements"]] == ["dashboard.banner", "home.coffee_cup"]
    assert [p["placement_id"] for p in c["placements"]] == ["pantry.oil_bottle", "recipe.hero", "recipe.milk_carton"]
    served = lambda cfg: {p["placement_id"]: (p["creative"] or {}).get("creative_id") for p in cfg["placements"]}  # noqa: E731
    assert served(f) == {"dashboard.banner": banner, "home.coffee_cup": cup}
    assert served(c) == {"pantry.oil_bottle": None, "recipe.hero": None, "recipe.milk_carton": carton}
    assert next(p for p in c["placements"] if p["placement_id"] == "recipe.milk_carton")["render"]["alignment"] == "bottomCenter"
    # versions are independent per application
    api.assign(cook["placements"]["recipe.hero"], api.creative("Kitchen", 800, 500, asset_type="illustration", alpha=False))
    assert api.runtime(focus).json()["config_version"] == f["config_version"]
