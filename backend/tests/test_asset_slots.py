"""An app arrives as a project zip, AdForge finds its pictures, ads go onto them, and stopping them works at once."""
import hashlib
import io
import threading
import time
import zipfile

from fastapi.testclient import TestClient
from PIL import Image

from app.main import create_app
from conftest import png

PUBSPEC = b"""name: cookwise
dependencies:
  flutter:
    sdk: flutter
flutter:
  assets:
    - assets/images/
"""
MAIN_DART = b"""import 'package:flutter/material.dart';
class Kitchen extends StatelessWidget {
  Widget build(BuildContext context) => Column(children: [
        Image.asset('assets/images/milk.png', width: 120, height: 120, fit: BoxFit.contain),
        Image.asset('assets/images/banner.jpg'),
      ]);
}
"""


def project_zip(extra: dict[str, bytes] | None = None, top: str = "cookwise/") -> bytes:
    files = {
        "pubspec.yaml": PUBSPEC, "lib/main.dart": MAIN_DART,
        "assets/images/milk.png": png(100, 160, alpha=True), "assets/images/2.0x/milk.png": png(200, 320, alpha=True),
        "assets/images/banner.jpg": png(600, 200, fmt="JPEG"), "assets/images/logo.svg": b"<svg/>",
        "build/web/assets/images/milk.png": png(100, 160, alpha=True),  # build output is ignored
        **(extra or {}),
    }
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for name, data in files.items():
            z.writestr(name if name.startswith("../") else top + name, data)
    return buf.getvalue()


def scan(client, admin, app, data=None):
    return client.post(f"/api/v1/admin/applications/{app['id']}/scans", headers=admin,
                       files={"file": ("cookwise.zip", data or project_zip(), "application/zip")})


def make_slots(client, admin, scan_id, *paths):
    r = client.post(f"/api/v1/admin/scans/{scan_id}/slots", headers=admin, json={"paths": list(paths)})
    assert r.status_code == 200, r.text
    return r.json()


def test_scan_finds_the_apps_pictures(client, api, admin):
    app = api.app("cookwise", "CookWise", placements=[])
    r = scan(client, admin, app, project_zip({"../evil.png": png(20, 20)}))
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["project_name"] == "cookwise"
    found = {a["path"]: a for a in body["assets"]}
    assert set(found) == {"assets/images/milk.png", "assets/images/banner.jpg", "assets/images/logo.svg"}  # not build/, not ../
    milk = found["assets/images/milk.png"]
    assert milk["replaceable"] and milk["has_transparency"] and (milk["width"], milk["height"]) == (100, 160)
    assert [(v["scale"], v["width"], v["height"], v["path"]) for v in milk["variants"]] == [
        (1.0, 100, 160, "assets/images/milk.png"), (2.0, 200, 320, "assets/images/2.0x/milk.png")]
    assert milk["usages"][0]["file"] == "lib/main.dart" and milk["usages"][0]["width"] == 120 and milk["preview_url"].endswith(".png")
    assert milk["slot"] is None and "preview_key" not in milk
    assert found["assets/images/logo.svg"]["replaceable"] is False
    assert any("suspicious" in w for w in body["warnings"])
    assert client.get(f"/api/v1/admin/applications/{app['id']}/scans", headers=admin).json()[0]["summary"]["images"] == 2


def test_bad_uploads_are_refused(client, api, admin):
    app = api.app("cookwise", "CookWise", placements=[])
    assert scan(client, admin, app, b"not a zip").json()["error"]["code"] == "bad_zip"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("readme.txt", "hello")
    assert scan(client, admin, app, buf.getvalue()).json()["error"]["code"] == "not_flutter"


def test_slots_from_a_scan_and_rescans_update_them(client, api, admin):
    app = api.app("cookwise", "CookWise", placements=[])
    s = scan(client, admin, app).json()
    out = make_slots(client, admin, s["id"], "assets/images/milk.png", "assets/images/banner.jpg", "assets/images/logo.svg", "assets/nope.png")
    status = {r["path"]: r["status"] for r in out["results"]}
    assert status == {"assets/images/milk.png": "created", "assets/images/banner.jpg": "created",
                      "assets/images/logo.svg": "not_replaceable", "assets/nope.png": "not_found"}
    placements = {p["placement_key"]: p for p in client.get(f"/api/v1/admin/applications/{app['id']}/placements", headers=admin).json()}
    milk, banner = placements["asset.images.milk"], placements["asset.images.banner"]
    assert milk["integration"] == "asset" and milk["asset_path"] == "assets/images/milk.png" and milk["fallback_preview_url"]
    assert milk["fallback"]["ref"] == "assets/images/milk.png" and not milk["requires_transparency"]  # any ad can sit on top
    assert milk["render"]["ad_position"] == "bottom_right" and milk["render"]["ad_size"] == 0.3
    assert set(banner["supported_asset_types"]) == {"product_image", "illustration", "texture", "sprite", "background", "banner",
                                                    "promotional_card", "sticker", "theme_artwork"}
    # the app ships a bigger 1x picture: the slot follows it instead of being duplicated
    bigger = project_zip({"assets/images/milk.png": png(150, 240, alpha=True)})
    rescan = scan(client, admin, app, bigger).json()
    milk = client.get(f"/api/v1/admin/placements/{milk['id']}", headers=admin).json()  # refreshed by the scan itself
    assert milk["variants"][0] == {"scale": 1.0, "width": 150, "height": 240, "path": "assets/images/milk.png"}
    assert next(a for a in rescan["assets"] if a["path"] == "assets/images/milk.png")["slot"]["placement_key"] == "asset.images.milk"
    again = make_slots(client, admin, rescan["id"], "assets/images/milk.png")
    assert again["results"][0]["status"] == "updated" and again["created"] == 0  # asking again changes nothing
    assert len(client.get(f"/api/v1/admin/applications/{app['id']}/placements", headers=admin).json()) == 2


def test_any_ad_goes_on_top_of_a_picture_where_you_choose(client, api, admin):
    app = api.app("cookwise", "CookWise", placements=[])
    make_slots(client, admin, scan(client, admin, app).json()["id"], "assets/images/milk.png")
    pid = client.get(f"/api/v1/admin/applications/{app['id']}/placements", headers=admin).json()[0]["id"]
    opaque_wide_ad = api.creative("Flat logo", 600, 200, alpha=False)  # opaque and a different shape: fine on top of a picture
    assert api.assign(pid, opaque_wide_ad).status_code == 201
    slot = api.slot(app, "asset.images.milk")
    assert slot["integration"] == "asset" and slot["asset_path"] == "assets/images/milk.png"
    assert slot["asset_keys"] == ["assets/images/milk.png", "assets/images/2.0x/milk.png"]  # every file the app may load for it
    assert (slot["render"]["ad_position"], slot["render"]["ad_size"]) == ("bottom_right", 0.3)
    ad = slot["creative"]
    assert ad["creative_id"] == opaque_wide_ad and "renditions" not in ad  # the ad as uploaded; the app draws it on its picture
    assert hashlib.sha256(client.get(ad["url"].replace("http://testserver", "")).content).hexdigest() == ad["sha256"]

    before = api.runtime(app).json()["config_version"]
    moved = client.patch(f"/api/v1/admin/placements/{pid}", headers=admin, json={"render": {"ad_position": "bottom_strip", "ad_size": 0.25}})
    assert moved.status_code == 200
    after = api.runtime(app).json()
    assert (after["placements"][0]["render"]["ad_position"], after["placements"][0]["render"]["ad_size"]) == ("bottom_strip", 0.25)
    assert after["config_version"] > before  # running apps redraw with the ad in its new place
    bad = client.patch(f"/api/v1/admin/placements/{pid}", headers=admin, json={"render": {"ad_position": "upside_down"}})
    assert bad.status_code == 422

    # dragged anywhere, any size, rounded corners: sent to the app as shares of the picture, so every screen size agrees
    dragged = {"ad_position": "custom", "ad_x": 0.2, "ad_y": 0.75, "ad_size": 0.12, "ad_radius": 0.25}
    assert client.patch(f"/api/v1/admin/placements/{pid}", headers=admin, json={"render": dragged}).status_code == 200
    render = api.runtime(app).json()["placements"][0]["render"]
    assert {k: render[k] for k in dragged} == dragged
    for wrong in ({"ad_x": 1.5}, {"ad_radius": 0.8}, {"ad_size": 0.01}):
        assert client.patch(f"/api/v1/admin/placements/{pid}", headers=admin, json={"render": {**dragged, **wrong}}).status_code == 422


def test_stop_all_ads_and_resume(client, api, admin):
    app = api.app("cookwise", "CookWise", placements=[])
    make_slots(client, admin, scan(client, admin, app).json()["id"], "assets/images/milk.png")
    pid = client.get(f"/api/v1/admin/applications/{app['id']}/placements", headers=admin).json()[0]["id"]
    api.assign(pid, api.creative("Carton", 300, 480, advertiser="DairyCo"))
    before = api.runtime(app).json()
    assert before["ads_enabled"] and before["placements"][0]["creative"]
    stopped = client.put(f"/api/v1/admin/applications/{app['id']}/integration", headers=admin, json={"enabled": False}).json()
    assert stopped["ads_enabled"] is False and stopped["config_version"] > before["config_version"]
    off = api.runtime(app).json()
    assert off["ads_enabled"] is False and all(p["creative"] is None for p in off["placements"])
    assert off["placements"][0]["asset_path"] == "assets/images/milk.png"  # the slot itself stays known
    client.put(f"/api/v1/admin/applications/{app['id']}/integration", headers=admin, json={"enabled": True})
    on = api.runtime(app).json()
    assert on["ads_enabled"] and on["placements"][0]["creative"]["creative_id"] == before["placements"][0]["creative"]["creative_id"]
    assert on["config_version"] > off["config_version"] and on["max_stale_seconds"] > 0
    actions = [a["action"] for a in client.get("/api/v1/admin/audit", headers=admin, params={"application_id": app["id"]}).json()["items"]]
    assert "application.ads_stopped" in actions and "application.ads_resumed" in actions


def test_a_waiting_app_hears_about_a_stop_at_once(client, api, admin):
    app = api.app("cookwise", "CookWise", placements=[])
    make_slots(client, admin, scan(client, admin, app).json()["id"], "assets/images/milk.png")
    pid = client.get(f"/api/v1/admin/applications/{app['id']}/placements", headers=admin).json()[0]["id"]
    api.assign(pid, api.creative("Carton", 300, 480, advertiser="DairyCo"))
    etag = api.runtime(app).headers["etag"]

    t0 = time.monotonic()
    assert api.c.get(f"/api/v1/runtime/cookwise/config?wait=2", headers={"X-AdForge-Key": app["runtime_key"], "If-None-Match": etag}).status_code == 304
    assert 1.5 < time.monotonic() - t0 < 5  # nothing changed: held for the wait, then "not modified"

    got = {}

    def wait_for_change():
        start = time.monotonic()
        r = TestClient(create_app()).get("/api/v1/runtime/cookwise/config?wait=20", headers={"X-AdForge-Key": app["runtime_key"], "If-None-Match": etag})
        got.update(status=r.status_code, body=r.json(), seconds=time.monotonic() - start)

    waiter = threading.Thread(target=wait_for_change)
    waiter.start()
    time.sleep(1.5)
    client.put(f"/api/v1/admin/applications/{app['id']}/integration", headers=admin, json={"enabled": False})
    waiter.join(timeout=25)
    assert got["status"] == 200 and got["body"]["ads_enabled"] is False
    assert got["seconds"] < 6  # answered about a second after the stop, not at the 20 s deadline


def test_photos_the_app_loads_from_the_internet_can_show_ads_and_stop(client, api, admin):
    """FitFlow-style app: every photo comes from a web address. They are found, named, can show any ad, and stop."""
    dart = b"""const photos = {'hero': 'https://images.unsplash.com/photo-1?auto=format&w=1200'};
const api = 'https://api.example.com/v1/users';
Widget photo() => Image.network(photos['hero']!, fit: BoxFit.cover);
Widget meal() => MealCard(image: 'https://cdn.example.com/meals/salad.jpg', title: 'Green bowl');
"""
    app = api.app("fitflow", "FitFlow", placements=[])
    s = scan(client, admin, app, project_zip({"lib/main.dart": dart})).json()
    remote = {a["path"]: a for a in s["assets"] if a.get("remote")}
    hero, salad = remote["https://images.unsplash.com/photo-1?auto=format&w=1200"], remote["https://cdn.example.com/meals/salad.jpg"]
    assert set(remote) == {hero["path"], salad["path"]}  # the API address is not a picture
    assert hero["replaceable"] and hero["name"] == "hero" and salad["name"] == "Green bowl" and salad["usages"][0]["line"] == 4
    assert hero["preview_url"] == hero["path"] and s["summary"]["remote"] == 2  # previewed from its own address

    out = make_slots(client, admin, s["id"], hero["path"], salad["path"])
    assert [r["placement_key"] for r in out["results"]] == ["web.hero", "web.green_bowl"] and out["created"] == 2
    places = {p["placement_key"]: p for p in client.get(f"/api/v1/admin/applications/{app['id']}/placements", headers=admin).json()}
    assert places["web.hero"]["integration"] == "remote" and places["web.hero"]["fallback_preview_url"] == hero["path"]
    assert places["web.hero"]["render"]["ad_area"] == "safe"  # apps crop photos: keep the ad where it stays visible
    assert make_slots(client, admin, s["id"], hero["path"])["results"][0]["status"] == "updated"  # no duplicates

    ad = api.creative("Any shape at all", 300, 900, alpha=False)  # tall, opaque: fine, the app sizes the photo
    assert api.assign(places["web.hero"]["id"], ad).status_code == 201
    slot = api.slot(app, "web.hero")
    assert slot["integration"] == "remote" and slot["asset_path"] == hero["path"] and slot["creative"]["creative_id"] == ad
    assert slot["creative"].get("renditions") is None  # served as uploaded
    client.put(f"/api/v1/admin/applications/{app['id']}/integration", headers=admin, json={"enabled": False})
    assert api.slot(app, "web.hero")["creative"] is None


def test_a_waiting_app_hears_at_once_that_its_application_was_deleted(client, api, admin):
    app = api.app("cookwise", "CookWise", placements=[])
    etag = api.runtime(app).headers["etag"]
    got = {}

    def wait_for_change():
        start = time.monotonic()
        r = TestClient(create_app()).get("/api/v1/runtime/cookwise/config?wait=20", headers={"If-None-Match": etag})
        got.update(status=r.status_code, seconds=time.monotonic() - start)

    waiter = threading.Thread(target=wait_for_change)
    waiter.start()
    time.sleep(1.5)
    assert client.delete(f"/api/v1/admin/applications/{app['id']}?confirm=cookwise", headers=admin).status_code == 200
    waiter.join(timeout=25)
    assert got["status"] == 404 and got["seconds"] < 6  # not a 20 s wait, and not a server error
