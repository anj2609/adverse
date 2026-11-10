import 'dart:convert';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:focusflow_demo/adforge/adforge.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// A real 1x1 PNG, so Image.memory has something valid to decode.
final Uint8List tinyPng = base64Decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==');
final String tinyPngSha = sha256.convert(tinyPng).toString();

Map<String, dynamic> creativeJson({String id = 'cr-1', int version = 1, String? sha, String? validUntil, String advertiser = 'BrewCo'}) => {
      'creative_id': id, 'version': version, 'url': 'http://ads.test/media/$id.png', 'thumbnail_url': 'http://ads.test/media/$id.thumb.webp',
      'width': 512, 'height': 512, 'format': 'png', 'sha256': sha ?? tinyPngSha, 'has_transparency': true, 'advertiser': advertiser,
      'product_name': 'Travel Cup', 'destination_url': null, 'campaign_id': 'camp-1', 'campaign_status': 'active', 'valid_from': null, 'valid_until': validUntil,
    };

Map<String, dynamic> placementJson(String id, {Map<String, dynamic>? creative, String fit = 'contain', double? aspect = 1.0}) => {
      'placement_id': id,
      'render': {'aspect_ratio': aspect, 'fit': fit, 'alignment': 'center', 'background_color': null, 'rendering_mode': 'image', 'max_width': null, 'max_height': null, 'corner_radius': null, 'requires_transparency': false},
      'fallback': {'kind': 'bundled_asset', 'ref': 'assets/$id.png'},
      'creative': creative,
    };

/// A picture found in the app (bundled), with an optional ad drawn on top of it.
Map<String, dynamic> assetSlotJson(String path, {Map<String, dynamic>? creative, List<String>? keys, String position = 'bottom_right', double size = 0.3}) => {
      'placement_id': 'asset.${path.replaceAll('assets/', '').replaceAll(RegExp(r'\.png$'), '').replaceAll('/', '.')}',
      'integration': 'asset', 'asset_path': path, 'asset_keys': keys ?? [path],
      'render': {'fit': 'contain', 'alignment': 'center', 'ad_position': position, 'ad_size': size},
      'fallback': {'kind': 'bundled_asset', 'ref': path},
      'creative': creative,
    };

/// A photo the app loads from a web address, with an optional ad drawn on top of it.
Map<String, dynamic> remoteSlotJson(String url, {Map<String, dynamic>? creative, String position = 'bottom_right', double size = 0.3}) => {
      'placement_id': 'web.photo', 'integration': 'remote', 'asset_path': url,
      'render': {'fit': 'cover', 'alignment': 'center', 'ad_position': position, 'ad_size': size},
      'fallback': {'kind': 'remote_url', 'ref': url},
      'creative': creative,
    };

Map<String, dynamic> configJson({int version = 1, List<Map<String, dynamic>>? placements, int ttl = 60, bool adsEnabled = true, int? maxStale,
        String serverTime = '2030-01-01T12:00:00+00:00'}) => {
      'schema_version': 1, 'application_id': 'focusflow', 'config_version': version, 'server_time': serverTime, 'ttl_seconds': ttl, 'next_change_at': null,
      'ads_enabled': adsEnabled, 'max_stale_seconds': maxStale,
      'placements': placements ?? [placementJson('home.coffee_cup'), placementJson('home.desk_lamp', aspect: 0.8), placementJson('task.completion_illustration', aspect: 1.5), placementJson('dashboard.promotional_banner', aspect: 3.0)],
    };

/// A fake AdForge server whose answers a test can change between refreshes.
class FakeServer {
  FakeServer(this.body);
  Object? body;
  int status = 200;
  bool offline = false;
  Uint8List imageBytes = tinyPng;
  int configCalls = 0;
  int imageCalls = 0;
  String? lastKey;
  String? lastIfNoneMatch;
  int waitingRequests = 0;
  bool closed = false;

  /// Bytes for specific addresses (e.g. a photo the app loads); anything else gets [imageBytes].
  final Map<String, Uint8List> files = {};

  String get etag => '"${(body is Map ? (body as Map)['config_version'] : 0)}"';

  late final http.Client client = MockClient((req) async {
    if (offline) throw http.ClientException('no route to host');
    if (req.url.path.endsWith('/config')) {
      configCalls++;
      lastKey = req.headers['X-AdForge-Key'] ?? req.headers['x-adforge-key'];
      lastIfNoneMatch = req.headers['If-None-Match'] ?? req.headers['if-none-match'];
      final wait = int.tryParse(req.url.queryParameters['wait'] ?? '');
      if (wait != null && lastIfNoneMatch == etag) {
        // like the real server: hold the request until the config changes or the wait runs out
        waitingRequests++;
        final until = DateTime.now().add(Duration(seconds: wait));
        while (!closed && lastIfNoneMatch == etag && DateTime.now().isBefore(until)) {
          await Future<void>.delayed(const Duration(milliseconds: 20));
        }
      }
      if (status != 200) return http.Response('{}', status);
      if (lastIfNoneMatch == etag) return http.Response('', 304, headers: {'etag': etag});
      return http.Response(body is String ? body! as String : jsonEncode(body), 200, headers: {'etag': etag});
    }
    imageCalls++;
    return http.Response.bytes(files[req.url.toString()] ?? imageBytes, 200);
  });
}

AdForgeService makeService(FakeServer s, {ConfigStore? store, AssetCache? cache, DateTime Function()? clock, String runtimeKey = ''}) => AdForgeService(
      client: AdForgeClient(baseUrl: 'http://ads.test', applicationId: 'focusflow', runtimeKey: runtimeKey, httpClient: s.client),
      store: store ?? MemoryConfigStore(),
      cache: cache ?? MemoryAssetCache(),
      logger: AdForgeLogger(print: false),
      clock: clock,
    );

/// A registry of AdForgeImage placements (widget mode) for the tests of that path.
const testPlacements = PlacementRegistry([
  PlacementSpec(id: 'home.coffee_cup', name: 'Coffee cup', fallbackAsset: 'assets/images/coffee_cup.png', defaultAspect: 1.0),
  PlacementSpec(id: 'home.desk_lamp', name: 'Desk lamp', fallbackAsset: 'assets/images/desk_lamp.png', defaultAspect: 0.8),
  PlacementSpec(id: 'task.completion_illustration', name: 'Completion illustration', fallbackAsset: 'assets/images/completion_illustration.png', defaultAspect: 1.5),
  PlacementSpec(id: 'dashboard.promotional_banner', name: 'Promotional banner', fallbackAsset: 'assets/images/promo_banner.png', defaultAspect: 3.0),
]);
