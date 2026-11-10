import io

from PIL import Image

from conftest import png


def upload(client, h, data, filename="x.png", **fields):
    return client.post("/api/v1/admin/creatives", headers=h, files={"file": (filename, data, "image/png")},
                       data={"name": "Cup", "advertiser": "BrewCo", "asset_type": "product_image", **fields})


def test_upload_stores_metadata_and_thumbnail(client, admin):
    r = upload(client, admin, png(640, 480, alpha=True), product_name="Morning Blend", destination_url="https://brewco.example/blend")
    assert r.status_code == 201
    c = r.json()
    assert (c["width"], c["height"], c["file_format"], c["has_transparency"], c["approval_status"]) == (640, 480, "png", True, "pending")
    assert client.get(c["url"].replace("http://testserver", "")).status_code == 200
    thumb = client.get(c["thumbnail_url"].replace("http://testserver", ""))
    assert thumb.status_code == 200 and max(Image.open(io.BytesIO(thumb.content)).size) <= 320


def test_upload_validation(client, admin):
    assert upload(client, admin, b"not an image at all").json()["error"]["code"] == "invalid_image"
    assert upload(client, admin, b"").status_code == 400
    assert upload(client, admin, png(8, 8)).json()["error"]["code"] == "bad_dimensions"
    gif = io.BytesIO()
    Image.new("P", (64, 64)).save(gif, "GIF")
    assert upload(client, admin, gif.getvalue(), "x.png").json()["error"]["code"] == "unsupported_format"  # extension says png, bytes say gif
    assert upload(client, admin, png(), asset_type="meme").json()["error"]["code"] == "bad_asset_type"
    assert upload(client, admin, png(), destination_url="javascript:alert(1)").json()["error"]["code"] == "bad_url"
    big = io.BytesIO()
    Image.effect_noise((1900, 1900), 80).convert("RGB").save(big, "PNG")
    assert len(big.getvalue()) > 8 * 1024 * 1024
    assert upload(client, admin, big.getvalue()).json()["error"]["code"] == "file_too_large"


def test_formats_and_opaque_detection(client, admin):
    jpg = upload(client, admin, png(300, 300, fmt="JPEG"), "x.jpg").json()
    webp = upload(client, admin, png(300, 300, alpha=True, fmt="WEBP"), "x.webp").json()
    assert (jpg["file_format"], jpg["has_transparency"]) == ("jpeg", False)
    assert (webp["file_format"], webp["has_transparency"]) == ("webp", True)


def test_editor_can_upload_but_not_approve(client, editor, admin):
    cid = upload(client, editor, png()).json()["id"]
    assert client.post(f"/api/v1/admin/creatives/{cid}/approve", headers=editor).status_code == 403
    assert client.post(f"/api/v1/admin/creatives/{cid}/approve", headers=admin).json()["approval_status"] == "approved"
    assert client.post(f"/api/v1/admin/creatives/{cid}/reject", headers=admin, json={"reason": "wrong product"}).json()["approval_status"] == "rejected"
    assert client.post(f"/api/v1/admin/creatives/{cid}/reject", headers=admin).status_code in (400, 422)  # a reason is required


def test_search_filter_and_pagination(client, api, admin):
    api.creative("Blue Bottle", advertiser="AquaCo", asset_type="product_image")
    api.creative("Spring Banner", w=600, h=200, advertiser="AquaCo", asset_type="banner", approve=False)
    api.creative("Coffee Cup", advertiser="BrewCo")
    get = lambda q: client.get(f"/api/v1/admin/creatives?{q}", headers=admin).json()  # noqa: E731
    assert get("")["total"] == 3
    assert [c["name"] for c in get("q=bottle")["items"]] == ["Blue Bottle"]
    assert get("advertiser=AquaCo")["total"] == 2
    assert get("asset_type=banner")["items"][0]["name"] == "Spring Banner"
    assert get("approval_status=pending")["total"] == 1
    assert len(get("page_size=2")["items"]) == 2


def test_compatibility_filter_and_checks(client, api, admin):
    app = api.app("focusflow", placements=[api.placement_spec("home.coffee_cup", aspect=1.0, transparency=True)])
    pid = app["placements"]["home.coffee_cup"]
    ok = api.creative("Square cutout", 400, 400)
    api.creative("Wide", 800, 200)
    api.creative("Opaque square", 400, 400, alpha=False)
    api.creative("Wrong type", 400, 400, asset_type="banner")
    api.creative("Tiny", 50, 50)
    found = client.get(f"/api/v1/admin/creatives?compatible_with={pid}", headers=admin).json()
    assert [c["id"] for c in found["items"]] == [ok]
    r = api.assign(pid, api.creative("Opaque two", 400, 400, alpha=False))
    problems = {e["code"] for e in r.json()["error"]["details"][0]["errors"]}
    assert r.status_code == 422 and problems == {"transparency"}


def test_new_version_keeps_old_and_starts_pending(client, api, admin):
    cid = api.creative("Cup")
    r = client.post(f"/api/v1/admin/creatives/{cid}/versions", headers=admin, files={"file": ("v2.png", png(500, 500, (10, 10, 10), alpha=True), "image/png")})
    v2 = r.json()
    assert r.status_code == 201 and v2["version"] == 2 and v2["approval_status"] == "pending" and v2["family_id"] == client.get(f"/api/v1/admin/creatives/{cid}", headers=admin).json()["family_id"]
    assert client.get(f"/api/v1/admin/creatives?latest_only=true", headers=admin).json()["items"][0]["id"] == v2["id"]


def test_media_cannot_escape_storage(client):
    for path in ("/media/creatives/..%2F..%2Fetc%2Fpasswd", "/media/creatives/passwd", "/media/..%2F/x.png", "/media/creatives/" + "a" * 64 + ".exe"):
        assert client.get(path).status_code == 404
