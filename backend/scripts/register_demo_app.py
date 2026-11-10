"""Registers the FocusFlow demo app with a running AdForge server, the way any app is onboarded: create the
application, upload its project zip so AdForge finds its pictures, make the pictures the code uses into ad slots,
and upload sample branded creatives (pending approval, so you approve and assign them in the dashboard).

    python scripts/register_demo_app.py --api http://localhost:8000 --email admin@adforge.local --password ...

Writes flutter_demo/dart_defines.json (server address and application ID) for `flutter run --dart-define-from-file`.
"""
import argparse
import io
import json
import sys
import zipfile
from pathlib import Path

import httpx

DEMO = Path(__file__).resolve().parents[2] / "flutter_demo"
SAMPLES = [  # (file, name, type, product)
    ("brewco_travel_cup.png", "BrewCo travel cup", "product_image", "Travel Cup"),
    ("lumen_desk_lamp.png", "Lumen desk lamp", "product_image", "Aurora Lamp"),
    ("brewco_celebration.png", "BrewCo celebration", "illustration", None),
    ("brewco_banner.png", "BrewCo banner", "banner", "Morning Blend"),
]


def project_zip(root: Path) -> bytes:
    """What a developer would zip: pubspec.yaml, lib/ and assets/ (no build output, no platform folders)."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.write(root / "pubspec.yaml", f"{root.name}/pubspec.yaml")
        for folder in ("lib", "assets"):
            for f in sorted((root / folder).rglob("*")):
                if f.is_file():
                    z.write(f, f"{root.name}/{f.relative_to(root).as_posix()}")
    return buf.getvalue()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default="http://localhost:8000")
    ap.add_argument("--email", default="admin@adforge.local")
    ap.add_argument("--password", required=True)
    ap.add_argument("--app-key", default="focusflow")
    ap.add_argument("--no-samples", action="store_true")
    ap.add_argument("--zip-out", help="Also save the project zip here (to try the upload in the dashboard yourself)")
    a = ap.parse_args()
    http = httpx.Client(base_url=a.api, timeout=60)

    def check(r: httpx.Response) -> dict:
        if r.status_code >= 400:
            sys.exit(f"{r.request.method} {r.request.url.path} -> {r.status_code}: {r.text}")
        return r.json()

    token = check(http.post("/api/v1/auth/login", json={"email": a.email, "password": a.password}))["access_token"]
    http.headers["Authorization"] = f"Bearer {token}"
    admin = "/api/v1/admin"

    existing = http.get(f"{admin}/applications/{a.app_key}")
    if existing.status_code == 200:
        app = existing.json()
        print(f"Application {a.app_key} already exists")
    else:
        app = check(http.post(f"{admin}/applications", json={"app_key": a.app_key, "name": "FocusFlow", "category": "Productivity", "platform": "flutter",
                                                             "description": "A small productivity app used to demonstrate AdForge."}))
        print(f"Registered application {a.app_key}")

    data = project_zip(DEMO)
    if a.zip_out:
        Path(a.zip_out).write_bytes(data)
        print(f"Saved the project zip to {a.zip_out}")
    scan = check(http.post(f"{admin}/applications/{app['id']}/scans", files={"file": ("focusflow.zip", data, "application/zip")}))
    used = [x["path"] for x in scan["assets"] if x["replaceable"] and x["used"]]
    made = check(http.post(f"{admin}/scans/{scan['id']}/slots", json={"paths": used}))
    print(f"Scanned the project: {scan['summary']['images']} pictures; {made['created']} new ad slots, {made['updated']} updated")

    if not a.no_samples:
        have = {c["name"] for c in check(http.get(f"{admin}/creatives", params={"page_size": 100}))["items"]}
        for fname, name, typ, product in SAMPLES:
            if name in have:
                continue
            form = {"name": name, "advertiser": "BrewCo" if "BrewCo" in name else "Lumen", "asset_type": typ}
            if product:
                form["product_name"] = product
            check(http.post(f"{admin}/creatives", data=form, files={"file": (fname, (DEMO / "samples" / fname).read_bytes(), "image/png")}))
        print("Uploaded sample creatives (pending approval). Approve and assign them in the dashboard.")

    (DEMO / "dart_defines.json").write_text(json.dumps({"ADFORGE_URL": a.api, "ADFORGE_APP_ID": a.app_key}, indent=2) + "\n")  # no key needed
    print(f"\nWrote {DEMO / 'dart_defines.json'}\nRun the app:  cd flutter_demo && flutter run -d chrome --dart-define-from-file=dart_defines.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
