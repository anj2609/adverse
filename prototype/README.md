# AdForge

Advertising asset management and campaign platform for apps built by TrendPilot. An administrator or
advertiser picks which pictures inside a Flutter app get replaced by advertising pictures, schedules
when, and watches verified results.

```
adverse/
  server/                     Node 22 + SQLite API, campaign engine, SDK endpoints
  web/                        The dashboard (plain HTML/JS, no build step, served by the server)
  sdk/adforge_flutter/        Flutter package that goes inside each app
```

## Run it

```bash
cd server && npm install && npm start      # http://localhost:8300
```

First start creates demo data (4 apps, 4 advertisers, campaigns in every state). `npm run seed` resets it.

| Sign in as | Password | Sees |
|---|---|---|
| admin@adforge.local | adforge123 | everything |
| aqua@ / brew@ / sprint@ / luma@adforge.local | adforge123 | only that advertiser's creatives, campaigns, results |

## What the dashboard does

| Need | Where |
|---|---|
| View every TrendPilot app | Applications |
| Explore spots; inspect original asset, location, formats | App → Ad spots → click a spot |
| Upload many creatives for an app | App → Creatives (multi-select or drag and drop) |
| Several campaigns per app | App → Campaigns, or Campaigns → New |
| Replace all eligible assets in one operation | Campaign → Replace all eligible… |
| Replace one asset on its own | Campaign → Assets → Replace / Change |
| Schedule on/off per campaign and per asset | Campaign → Edit details; Assets → Change → Show from/until |
| Activate, pause, end | Buttons on the campaign. Start/end dates flip it to Active and Expired automatically |
| Preview the app with chosen ads | App → Preview (live, at a chosen time, selected campaigns, or originals); Campaign → Preview |
| Verified delivery and performance | Campaign → Performance, App → Performance, Overview |
| Placement history | App → Placement history; each spot's detail |
| Audit trail | Audit log; Campaign → Activity |

When two campaigns want the same spot, the higher priority wins; a tie goes to the one that started most recently.
A creative "fits" a spot when its format is accepted, its shape is within 12% of the spot's, and it is at least half the spot's width.

## Putting ads in a Flutter app

TrendPilot registers an app and its spots (this is how apps appear in AdForge):

```bash
curl -X POST localhost:8300/api/ingest/apps -H 'x-trendpilot-key: trendpilot-dev-key' -H 'content-type: application/json' -d '{
  "slug": "my-app", "name": "My App", "category": "Health", "version": "1.0.0",
  "screens": [{"key": "home", "name": "Home", "image_base64": "..."}],
  "placements": [{"key": "home_banner", "name": "Home banner", "screen": "home", "kind": "banner",
    "location": "Top of Home", "match_image": "home_banner.png", "integration": "asset",
    "x": 0, "y": 12, "w": 100, "h": 14, "px_w": 720, "px_h": 200, "original_base64": "..."}]}'
```

The response carries the app's `sdk_key` (also shown under App → SDK setup). In the app:

```yaml
dependencies:
  adforge_flutter:
    path: ../adforge/sdk/adforge_flutter
```
```dart
await AdForge.init(baseUrl: 'https://ads.yourhost.com', appKey: 'afk_...');
runApp(AdForge.wrap(const MyApp()));
```

* **Asset spots** need no further code: any image loaded under the spot's file name is swapped (`Image.asset`, `AssetImage`; for Flame set `Flame.bundle = AdForge.bundle`). Impressions are counted after the picture has been served and the app has stayed in front for a second; taps are not counted.
* **Exact tracking** (and all "widget" spots): wrap the picture in `AdForgePlacement(spot: 'home_banner', child: Image.asset(...))`. The impression counts once at least half of it has been on screen, on the top page, for a full second, and taps are counted and sent to the advertiser's link.
* Swaps apply to pictures loaded after a refresh. Already-decoded images update on the next load or app start.
* If AdForge is unreachable the app keeps its own pictures. A campaign's picture is never shown after its end time, even offline.

## How "verified" works

The server signs a token for every ad it hands out. The SDK can only report events that carry one:
forged, expired, wrong-app and unknown-campaign tokens are rejected, as are impressions under one second,
missing device ids, and repeats (one impression per ad per device per 30 minutes; one click per minute).
Rejections are counted and shown to administrators.

## Checks

```bash
cd server && npm test                       # 24 API/engine/SDK-endpoint checks
cd sdk/adforge_flutter && flutter test      # SDK unit and widget tests
ADFORGE_URL=http://localhost:8300 ADFORGE_KEY=afk_... ADFORGE_ADMIN_TOKEN=... \
  flutter test integration/live_server_test.dart   # real SDK against a running server
```

## Configuration

`PORT` (8300), `ADFORGE_DATA` (server/data), `PUBLIC_URL` (used in image and click links, set this behind a proxy),
`ADFORGE_SECRET` (token signing; generated into the data folder if unset), `TRENDPILOT_KEY` (ingest key; change it).
Change the demo passwords and `TRENDPILOT_KEY` before exposing the server.
