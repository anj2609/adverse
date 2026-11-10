# AdForge

Shows advertisers' ads **on the pictures inside a Flutter app**, and takes them off again the moment you say stop,
without rebuilding or republishing the app.

1. **Upload the app's project as a zip.** AdForge finds every picture in it: pictures shipped inside the app, and photos
   it loads from the internet. For each one you see where the code uses it.
2. **Pick the pictures that may carry ads** ("ad slots").
3. **Put your ads on them.** Your ads are already in the ads library. The app's picture stays, and the ad is drawn on top of
   it, in a corner, the centre or a strip along the bottom, at the size you choose. Any ad fits any picture.
4. **Stop.** One click stops the ad on one picture, every ad in the app, or one ad everywhere. A running app drops it within
   about a second and shows its plain picture again.

The app needs AdForge **once**, and AdForge adds itself: after the scan, **Download app ready for ads** gives back the same
project with AdForge inside (its folder, its packages, one line around `runApp`, this server's address and the app's ID). The
developer builds and publishes that as usual, once. No key is needed. After that release, everything above happens from the
dashboard. (Apps can also place an `AdForgeImage` widget for an explicit ad box with an "Ad" label: the original model.)

```
adverse/
  backend/        FastAPI + PostgreSQL + SQLAlchemy + Alembic     (management API, runtime API, campaign engine)
  dashboard/      Next.js + TypeScript + Tailwind                 (the admin UI)
  flutter_demo/   Flutter + Riverpod                              (FocusFlow, a demo app wired to AdForge)
  storage/        uploaded images (local disk storage backend)
  prototype/      an earlier Node/SQLite prototype, kept for reference only
```

## What AdForge can and cannot do

**Works with no app update**, once the app contains AdForge: any PNG/JPEG/WebP the app shows with `Image.asset` /
`AssetImage` (shipped inside it) or `Image.network` / `NetworkImage` (loaded from a web address found in its code) can carry an
ad on top; changing the ad, its spot or size; scheduling; stopping one ad, every ad in the app, or one ad everywhere; a new
scan of a newer app version.

**Can't be done without an app update:** an installed app that does not contain AdForge cannot be changed from outside (no
system can do that). Also out of reach: SVGs, pictures whose address is built at runtime (from an API response) rather than
written in the code, `Image.network` calls that send custom headers, new screens, layout or logic changes. AdForge never ships
or runs code.

**How fast:** an app in the foreground keeps one request waiting on the server, so a new ad or a stop reaches it in about a
second. A backgrounded app stops listening and catches up when it's reopened. An offline app can't be reached; if it can't
refresh for `RUNTIME_MAX_STALE_SECONDS` (default 6 h) it stops showing ads by itself.

**Photos the app crops.** Apps usually crop photos to fit a box (FitFlow shows a tall photo as a wide banner). For photos
from the internet the ad is kept inside the part that stays visible for any crop from a 4:5 box to a 2:1 banner, so a
"bottom right" ad is bottom right of what people actually see. Pictures shipped in the app use the whole picture.

## Run it locally

You need Python 3.12, Node 20+, PostgreSQL 14+ and Flutter 3.x.

```bash
# 1. database
createdb adforge
cp .env.example .env            # edit DATABASE_URL, SECRET_KEY (32+ chars), ADMIN_PASSWORD

# 2. backend  ->  http://localhost:8000  (interactive API docs at /docs)
cd backend
python3.12 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
.venv/bin/alembic upgrade head
.venv/bin/python -m app.seed                   # creates the administrator from ADMIN_EMAIL / ADMIN_PASSWORD
.venv/bin/uvicorn app.main:app --port 8000

# 3. dashboard  ->  http://localhost:3000
cd dashboard
npm install
NEXT_PUBLIC_API_URL=http://localhost:8000 npm run dev

# 4. register the demo app (uploads its project zip, makes ad slots) and sample ads, then run it (no key needed)
cd backend && .venv/bin/python scripts/register_demo_app.py --password '<ADMIN_PASSWORD>' --zip-out /tmp/focusflow.zip
cd flutter_demo && flutter run -d chrome --dart-define-from-file=dart_defines.json     # or -d macos / an emulator
```

Android emulators reach your machine at `10.0.2.2`; set `ADFORGE_URL` in `dart_defines.json` accordingly.

**Docker:** `cp .env.example .env`, set `SECRET_KEY` and `ADMIN_PASSWORD`, then `docker compose up --build`
(dashboard `:3000`, API `:8000`). The compose file was written but not run in the environment this was built in (no Docker there).

Roles: **viewer** (read), **editor** (upload creatives, create and submit campaigns, register placements),
**admin** (everything: approvals, direct and bulk assignment, pause/expire, rollback, restore fallback, keys).
`python -m app.seed --demo-users` also creates `editor@adforge.local` and `viewer@adforge.local` with the admin password.

## Try it: zip in, ads on, stop

The dashboard shows only two pages, **Apps** and **Ads**. (Campaigns, approvals, the audit log and the runtime test still
exist in the API and at `/campaigns`, `/audit` and `/demo-preview`, but are left out of the menu.)

1. **Ads → Upload an ad**: a picture and a name. Your own uploads are approved at once.
2. **Apps → Add app**: a name (the ID is made from it). No key.
3. On the app's page: **1 Upload the app** (the project zip) → **2 Choose the pictures that get ads** (tick, then
   **Use N pictures for ads**; *remove* takes one back) → **3 Download app ready for ads**, then build it as usual (if the
   project has no android/ios/web folder, run `flutter create .` once first), for example `flutter run -d chrome`.
   `ADFORGE.txt` in the zip lists exactly what was changed. `flutter_demo/` (FocusFlow) is an app connected the same way.
4. **Put ads on pictures** → **Put an ad on it** → pick an ad, drag it where you want it on the picture, set **Size** and
   **Rounded corners** → **Show this ad**. About a second later the app shows its photo with your ad on top. **Move or resize**
   on the card changes it later, and the app redraws. (Positions are saved as shares of the picture, so every screen agrees.
   Apps built before this change ignore dragged spots and rounding: download step 3 again for them.)
5. **Stop ad** on a card, or **Stop all ads**: the plain photo is back within about a second. **Turn ads back on** restores them.
   **Stop this ad everywhere** (on the ad, under Ads) takes one ad off every picture.
6. To remove an app: its page → **Delete this app** (bottom) → type its ID. Installed copies stop showing ads at their next check.

Prefer curl? `GET /api/v1/runtime/fitflow/config` (add `?wait=25` with `If-None-Match` to watch it wait for a change).
`/demo-preview` in the dashboard shows the same document.

## How it decides what to show

One creative per placement at a time. Server-side only; the app never decides eligibility.

A campaign assignment is **eligible** when all of these hold: the placement is active; the campaign is approved, not paused,
and now is inside `[start, end)`; the creative is approved and active; and the creative still satisfies the placement's rules.

Campaign states: `draft → pending_approval → approved`, then derived from the clock `scheduled → active → expired`;
plus `paused`, `rejected`, and a manual `expired` (end now).

**Precedence** among eligible assignments for one placement: highest campaign **priority** wins; ties go to the campaign that
**started most recently** (no start time counts as earliest), then the newest assignment, then the lowest id. Deterministic.
**No silent overwrites:** two campaigns that are pending/approved/paused with the *same* priority and *overlapping* dates cannot
both claim a placement. Submitting, approving, resuming, editing dates, or assigning is refused with `409 assignment_conflict`
naming the other campaign. Different priorities are allowed and the preview says who will win (it only counts rivals that can still
serve during the new assignment's dates: not drafts, rejected or ended campaigns). When the winner ends or is paused, the
next-best eligible one takes over; if none, the app shows its fallback.

**Config version** is per application and moves only when what the app would be told changes, including by the clock (a campaign
starting or ending on its own). The runtime response carries an `ETag` and the app sends `If-None-Match`, so unchanged configs cost a `304`.

**Stopping.** Per slot: **Stop ad** removes its assignments (the app shows its original). Whole app: **Stop all ads** sets the
app's ads switch off; the runtime then answers with `ads_enabled: false` and no creatives (a normal answer, so apps drop what they
show; an error would leave their last good config on screen), and assignments are kept for **Resume**. One ad everywhere:
**Deactivate** it in the creative library. Every stop moves the config version, which releases waiting apps at once.

**Ad slots** (pictures found in the app) accept any ad: the app draws it on top of its own picture, at the slot's
position and size, keeping the ad's shape. The picture keeps its pixel size, so the app's layout never moves.

**Direct / bulk assignment** (admin) creates an auto-approved one-off campaign (priority 5 unless you set one) holding the
assignments. Re-assigning a placement replaces its previous direct assignment, and rolling back restores it. Bulk validates every
placement first: *all or nothing* (default) changes nothing if any placement can't take the creative, *partial* applies the valid ones.
Per-placement results are returned and stored; failed attempts are audited too.

## API

Interactive docs: `http://localhost:8000/docs`.

| Area | Prefix | Auth |
|---|---|---|
| Sign in | `POST /api/v1/auth/login` | none (rate limited) |
| Management | `/api/v1/admin/...` applications, placements, creatives, campaigns, assignments, bulk-operations, audit, overview | bearer token, role-checked |
| Scans | `POST /api/v1/admin/applications/{id}/scans` (zip), `GET …/scans`, `GET /api/v1/admin/scans/{id}`, `POST …/scans/{id}/slots` | bearer token, editor |
| App ready for ads | `POST /api/v1/admin/applications/{id}/ready-zip` (zip in, zip out; header `X-AdForge-Report` says what changed) | bearer token, editor |
| Delete an app | `DELETE /api/v1/admin/applications/{id}?confirm=<its ID>` (its slots, scans, campaigns go; the ads library stays) | bearer token, admin |
| Ads switch | `PUT /api/v1/admin/applications/{id}/integration {"enabled": false}` stops every ad in the app | bearer token, admin |
| Runtime | `GET /api/v1/runtime/{application_id}/config[?wait=25]` | none: the application ID (a runtime key only if `RUNTIME_REQUIRE_KEY=true`) |
| Images | `GET /media/{folder}/{file}` | public, content-addressed, strict key pattern |

Errors are always `{"error": {"code", "message", "details"}}`. Collections are paginated (`page`, `page_size`).

Runtime response (schema v1): `application_id`, `config_version`, `server_time`, `ttl_seconds`, `next_change_at`, `ads_enabled`,
`max_stale_seconds`, and per active placement `placement_id`, `integration` (`widget`, `asset` for a picture in the app, `remote`
for a photo from the internet), `asset_path` (the picture's file name or web address), `asset_keys` (every file name of a bundled
picture, one per screen density), `render` (for ad slots: `ad_position`, `ad_size`, `ad_area`), `fallback` and `creative` (`null`,
or id, version, url, sha256, size, advertiser, campaign id and status, validity window). Nothing administrative is included.
With `If-None-Match` and `?wait=N` the server holds the request (up to `RUNTIME_LONG_POLL_SECONDS`, default 25) and answers as
soon as the config changes, else `304`. Waiting requests hold no database connection.

## Security notes

* Admin API: JWT bearer, roles `viewer < editor < admin`, scrypt password hashes, rate-limited login, CORS limited to `CORS_ORIGINS`.
* Runtime: apps connect with their application ID alone. The runtime config is read-only, answers for that one app, holds no administrative data and only says what that app would show anyway; requests are rate limited per client. Set `RUNTIME_REQUIRE_KEY=true` to also require each app's runtime key (stored hashed, shown once, rotatable); the dashboard then shows keys again. CORS is open only on runtime and image routes, which carry no cookies or admin rights.
* Uploads: decoded with Pillow, never trusted by extension or declared type; PNG/JPEG/WebP only, size and dimension limits, animated and corrupt files refused, decompression-bomb guard, thumbnails generated, content-addressed filenames. Storage keys are server-generated and validated against a strict pattern, so no client value reaches the filesystem. The AdForge server never fetches remote URLs: photos from the internet are previewed by the admin's browser and drawn on by the app itself. `destination_url` must be `http(s)`.
* Project zips are read in place and never stored or extracted: entry-count, total-size and compression-ratio limits (zip bombs),
  unsafe paths and symlinks ignored, build output and platform folders skipped, pictures decoded with Pillow. Only previews and findings are kept.
* The Flutter app holds no admin credentials. It verifies each downloaded image against the SHA-256 in the config before caching it, and never downloads code.
* Rate limiting is in-memory (single process). Use a shared store if you scale out. Each waiting app request is one open HTTP
  connection on the server (one DB query a second while it waits), fine for this MVP; at scale put a push channel or a shared notifier behind it. Change `SECRET_KEY` and the admin password before deploying.

## Storage

Binary files go through a small `Storage` interface (`save/read/exists/delete`) in `backend/app/services/storage.py`. Local disk
is built in (`STORAGE_PATH`). For S3 or GCS, add a class with those four methods and select it in `get_storage()`. Metadata and
references live in PostgreSQL; images never do. Original app assets (the fallbacks), AdForge creatives and the optional fallback
*previews* used by the dashboard are three separate things; AdForge never writes to an app's own assets.

## Flutter integration

Everything under `flutter_demo/lib/adforge/` is app-agnostic and can be lifted into a package: models and strict parsing, HTTP
client (with the waiting request), `AdForgeService` (restore, fetch, ETag, ad download, hash check, prune, staleness),
`ConfigStore` (last-known-good), `AssetCache`, logger, Riverpod providers, `ad_overlay.dart` (where the ad goes, and drawing it),
`AdForgeAssetBundle`, and two widgets.

```dart
runApp(const AdForgeScope(child: MyApp()));       // the whole integration; or ProviderScope(child: AdForgeAssets(child: MyApp()))
```

**Download app ready for ads** does this for you, and puts the server address and app ID in `lib/adforge/connection.dart`.
By hand: copy the folder, add `flutter_riverpod`, `http`, `shared_preferences`, `path_provider` and `crypto` to `pubspec.yaml`,
wrap `runApp`, and build with `--dart-define=ADFORGE_URL=…` and `--dart-define=ADFORGE_APP_ID=…` (add `ADFORGE_VERBOSE=true`
to print AdForge's log in a release build). The app's code stays as it is:

* **Pictures shipped in the app** load through `AdForgeAssetBundle`: when one has an ad, the app gets that picture with the ad
  drawn on top, same pixel size, for every screen density.
* **Photos from the internet**: `Image.network` looks the photo up in Flutter's image cache by its address first. AdForge puts
  "the photo with the ad on top" there (it downloads the photo the way the app would, and draws the ad on it); on stop it takes
  it out and the app loads the plain photo again. On web the photo's host must allow cross-origin requests, as the app itself needs.

When anything changes the app's pictures are looked up again once; the app itself is never restarted or remounted.
Ads are downloaded and hash-checked before they show. Everything falls back to the app's own picture on no ad, a failed
download, ads stopped, or a config older than the staleness limit. `AdForgeImage(placementId: …)` remains for explicit spots
with an "Ad" label (listed in a `PlacementRegistry`).

## Tests

```bash
cd backend && .venv/bin/python -m pytest -q       # 66 tests, PostgreSQL (TEST_DATABASE_URL, default .../adforge_test)
cd flutter_demo && flutter test                  # 48 tests
cd dashboard && npx tsc --noEmit && npm run build
```

Backend: registration, placement uniqueness, upload validation, compatibility, approvals, scheduling by clock, paused/rejected/
expired campaigns, conflicts, precedence, direct/bulk assignment, rollback, runtime filtering, app ID without a key (and keys
when required), versioning/ETag/304, audit, rate limit, CORS, migrations match the models, the brief's acceptance flow, two
unrelated apps on one backend, and `tests/test_asset_slots.py`: zip scanning (variants, SVG, unsafe paths, build output, bad
zips, photos from the internet named from their code), slots and rescans, any ad on any picture, ad position and size, stop-all
and resume, a waiting request released by a stop, and `tests/test_ready_zip.py`: the app-ready zip (AdForge added, packages
added or kept, runApp wrapped once even with brackets in strings, found outside main.dart, original files untouched, twice = once).

Flutter: parsing and invalid configs, fetch/304/cache/prune/hash check, offline and last-known-good, `AdForgeImage`, where the
ad goes (corners, centre, strip, the always-visible part of cropped photos), real pixels of a picture with the ad on top, a photo
from the internet getting the ad and losing it on stop, the demo's own `Image.asset` with an ad and back without remounting
the app, staleness, and live updates picking up a new ad and a stop in under 1.5 s.

## Known limits

* "Download app ready for ads" wraps the first `runApp(...)` it finds; an app that starts in an unusual way is told to add the
  line by hand. It was checked on FitFlow: the downloaded project builds with no edits.
* Docker files are untested here (no Docker available). Everything else was run against a real server in a browser, including
  FitFlow (all photos from the internet): its zip scanned, an ad drawn on its hero photo inside the visible part, and *Stop all
  ads* removing it in about 1.5 s with no refresh.
* If Flutter evicts a photo-with-ad from its image cache under memory pressure while it is off screen, that photo shows plain
  until the next change; pictures shipped in the app don't have this limit.
* Ads drawn on pictures carry no automatic "Ad" label. Use an ad image that includes one, or `AdForgeImage` where a label is required.
* The Flutter demo was run on web. Its mobile and desktop builds compile from the same code but were not launched here.
* Image-only replacements; no click tracking or analytics (out of scope for this MVP).
* The sample brands (BrewCo, Lumen) and their images are invented stand-ins. Real campaigns must use images the advertiser supplies and approves; AdForge does not generate or invent product images or logos.
* No automated browser tests for the dashboard; it is type-checked, built and was exercised in a browser.
