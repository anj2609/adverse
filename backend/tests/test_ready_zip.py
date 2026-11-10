"""'Download app ready for ads': the app's own zip comes back with AdForge added, so its developer only builds it."""
import io
import json
import zipfile

import yaml

from app.services.connect import _closing_paren, wrap_main
from conftest import png

PUBSPEC = b"""name: cookwise
description: Recipes.   # keep my comment
environment:
  sdk: '>=3.3.0 <4.0.0'
dependencies:
    flutter:
        sdk: flutter
    flutter_riverpod: ^2.5.0   # already used by the app
flutter:
    assets:
        - assets/images/
"""
MAIN = b"""import 'package:flutter/material.dart';
import 'app.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(CookApp(title: 'Cook (beta)'));
}
"""


def project(files=None) -> bytes:
    base = {"pubspec.yaml": PUBSPEC, "lib/main.dart": MAIN, "lib/app.dart": b"class CookApp {}", "assets/images/milk.png": png(40, 40),
            "build/web/main.dart.js": b"old build", "../evil.dart": b"x"}
    base.update(files or {})
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for name, data in base.items():
            if data is not None:
                z.writestr(name if name.startswith("../") else "cookwise/" + name, data)
    return buf.getvalue()


def ready(client, admin, app, data):
    return client.post(f"/api/v1/admin/applications/{app['id']}/ready-zip", headers=admin, files={"file": ("cookwise.zip", data, "application/zip")})


def test_the_app_comes_back_ready_for_ads_and_nothing_else_changes(client, api, admin):
    app = api.app("cookwise", "CookWise", placements=[])
    r = ready(client, admin, app, project())
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "application/zip"
    assert r.headers["content-disposition"] == 'attachment; filename="cookwise-ready-for-ads.zip"'
    report = json.loads(r.headers["x-adforge-report"])
    assert report["main_file"] == "lib/main.dart" and report["packages_kept"] == ["flutter_riverpod"]
    assert report["packages_added"] == ["http", "shared_preferences", "path_provider", "crypto"]

    z = zipfile.ZipFile(io.BytesIO(r.content))
    names = set(z.namelist())
    assert "cookwise/lib/adforge/adforge.dart" in names and "cookwise/lib/adforge/widgets/adforge_assets.dart" in names
    assert "cookwise/ADFORGE.txt" in names
    assert not any(n.startswith("cookwise/build/") or "evil" in n for n in names)  # build output and unsafe entries left out
    assert z.read("cookwise/assets/images/milk.png") == png(40, 40) and z.read("cookwise/lib/app.dart") == b"class CookApp {}"

    connection = z.read("cookwise/lib/adforge/connection.dart").decode()
    assert "defaultValue: 'http://testserver'" in connection and "defaultValue: 'cookwise'" in connection

    pubspec = z.read("cookwise/pubspec.yaml").decode()
    deps = yaml.safe_load(pubspec)["dependencies"]
    assert deps["flutter_riverpod"] == "^2.5.0" and deps["http"] == "^1.2.2" and deps["crypto"] == "^3.0.5"
    assert "# keep my comment" in pubspec and "    http: ^1.2.2" in pubspec  # layout and comments kept, same indentation

    main = z.read("cookwise/lib/main.dart").decode()
    assert main.count("AdForgeScope(") == 1
    assert "runApp(AdForgeScope(settings: const AdForgeSettings(baseUrl: adForgeServer, applicationId: adForgeAppId), child: CookApp(title: 'Cook (beta)')));" in main
    assert "import 'package:cookwise/adforge/adforge.dart';\nimport 'package:cookwise/adforge/connection.dart';\n" in main
    assert main.index("import 'app.dart';") < main.index("package:cookwise/adforge")  # after the app's own imports

    again = ready(client, admin, app, r.content)  # running it twice changes nothing more
    z2 = zipfile.ZipFile(io.BytesIO(again.content))
    assert z2.read("cookwise/lib/main.dart") == z.read("cookwise/lib/main.dart")
    assert z2.read("cookwise/pubspec.yaml").decode().count("http: ^1.2.2") == 1
    assert json.loads(again.headers["x-adforge-report"])["main_change"] == "already has AdForge"

    actions = [a["action"] for a in client.get("/api/v1/admin/audit", headers=admin, params={"application_id": app["id"]}).json()["items"]]
    assert actions.count("application.ready_zip") == 2


def test_where_the_app_starts_is_found_and_bad_projects_get_a_plain_reason(client, api, admin, viewer):
    app = api.app("cookwise", "CookWise", placements=[])
    elsewhere = project({"lib/main.dart": None, "lib/start.dart": b"void main() => runApp(const CookApp());\n"})
    r = ready(client, admin, app, elsewhere)
    assert r.status_code == 200 and json.loads(r.headers["x-adforge-report"])["main_file"] == "lib/start.dart"
    assert "runApp(const AdForgeScope(settings: AdForgeSettings(baseUrl: adForgeServer, applicationId: adForgeAppId), child: CookApp()));" in \
        zipfile.ZipFile(io.BytesIO(r.content)).read("cookwise/lib/start.dart").decode()

    no_start = ready(client, admin, app, project({"lib/main.dart": b"// no runApp here\n"}))
    assert no_start.status_code == 400 and no_start.json()["error"]["code"] == "no_run_app"
    assert ready(client, admin, app, b"not a zip").json()["error"]["code"] == "bad_zip"
    assert ready(client, viewer, app, project()).status_code == 403


def test_matching_brackets_ignore_strings_and_comments():
    src = "runApp(App(t: 'a ) b', u: \"(\", /* ) */ v: r'\\)')) // )"
    assert src[_closing_paren(src, src.index("("))] == ")" and _closing_paren(src, src.index("(")) == src.index(")) //") + 1
    assert wrap_main("void main() {}", "x") == ("void main() {}", "")
