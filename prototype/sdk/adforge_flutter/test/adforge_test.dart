import 'dart:convert';

import 'package:adforge_flutter/adforge_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

// A real 1x1 PNG.
final png = base64Decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==');

Map<String, dynamic> manifest({String? validUntil, String token = 'tok.sig'}) => {
      'app': 'demo',
      'refresh_after_sec': 600,
      'placements': [
        {
          'key': 'home_banner', 'match_image': 'home_banner.png', 'integration': 'asset', 'fit': 'cover',
          'creative': {'id': 'cr_1', 'url': 'http://ads.test/media/a.png', 'sha256': 'aaa'},
          'campaign_id': 'cmp_1', 'click_url': 'http://ads.test/sdk/v1/click?t=x', 'valid_until': validUntil, 'token': token,
        },
        {'key': 'streak_icon', 'match_image': 'flame.png', 'integration': 'widget', 'fit': 'cover', 'creative': null},
      ],
    };

class Server {
  Server(this.manifestBody);
  Map<String, dynamic> manifestBody;
  final events = <Map<String, dynamic>>[];
  int manifestCalls = 0;
  late final client = MockClient((req) async {
    if (req.url.path == '/sdk/v1/manifest') {
      manifestCalls++;
      expect(req.headers['x-adforge-key'], 'key');
      return http.Response(jsonEncode(manifestBody), 200, headers: {'etag': '"v1"'});
    }
    if (req.url.path == '/media/a.png') return http.Response.bytes(png, 200);
    if (req.url.path == '/sdk/v1/events') {
      events.addAll(((jsonDecode(req.body) as Map)['events'] as List).cast<Map<String, dynamic>>());
      return http.Response('{}', 200);
    }
    return http.Response('nope', 404);
  });
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  test('file names are matched the same way the dashboard stores them', () {
    expect(adforgeFileName('assets/images/Home_Banner.PNG'), 'home_banner.png');
    expect(adforgeFileName('https://x.com/a/b%20c.png?v=2'), 'b c.png');
  });

  test('swaps only the spot that has a live campaign, passes the rest through', () async {
    final srv = Server(manifest());
    final ad = await AdForge.init(baseUrl: 'http://ads.test', appKey: 'key', client: srv.client, autoRefresh: false);
    expect(ad.spot('home_banner'), isNotNull);
    expect(ad.spot('streak_icon'), isNull);
    final b = AdForge.bundle as AdForgeAssetBundle;
    expect((await b.load('assets/images/HOME_BANNER.png')).buffer.asUint8List(), png);
  });

  test('never shows a picture after its campaign window has closed', () async {
    var t = DateTime.utc(2026, 1, 1, 10);
    final srv = Server(manifest(validUntil: '2026-01-01T11:00:00Z'));
    final ad = await AdForge.init(baseUrl: 'http://ads.test', appKey: 'key', client: srv.client, autoRefresh: false, clock: () => t);
    expect(ad.spot('home_banner'), isNotNull);
    t = DateTime.utc(2026, 1, 1, 11, 0, 1);
    expect(ad.spot('home_banner'), isNull);
  });

  test('keeps working offline: a failed refresh leaves the app unchanged', () async {
    final ad = await AdForge.init(baseUrl: 'http://ads.test', appKey: 'key', client: MockClient((_) async => throw Exception('offline')), autoRefresh: false);
    expect(ad.spot('home_banner'), isNull);
  });

  test('impressions need a full second and are sent once per 30 minutes', () async {
    var t = DateTime.utc(2026, 1, 1, 10);
    final srv = Server(manifest());
    final ad = await AdForge.init(baseUrl: 'http://ads.test', appKey: 'key', client: srv.client, autoRefresh: false, clock: () => t);
    final s = ad.spot('home_banner')!;
    ad.recordImpression(s, viewableMs: 400);
    ad.recordImpression(s);
    ad.recordImpression(s);
    t = t.add(const Duration(minutes: 31));
    ad.recordImpression(s);
    await ad.flush();
    expect(srv.events.length, 2);
    expect(srv.events.first['token'], 'tok.sig');
    expect(srv.events.first['device_id'], ad.deviceId);
    expect(srv.events.first['viewable_ms'], greaterThanOrEqualTo(1000));
  });

  testWidgets('AdForgePlacement shows the campaign picture and reports it after a second on screen', (tester) async {
    late Server srv;
    await tester.runAsync(() async {
      srv = Server(manifest());
      await AdForge.init(baseUrl: 'http://ads.test', appKey: 'key', client: srv.client, autoRefresh: false);
    });
    await tester.pumpWidget(const MaterialApp(home: Scaffold(body: SizedBox(height: 100, width: 300, child: AdForgePlacement(spot: 'home_banner', child: Text('original'))))));
    expect(find.text('original'), findsNothing);
    expect(find.byType(Image), findsOneWidget);
    for (var i = 0; i < 5; i++) {
      await tester.pump(const Duration(milliseconds: 250));
    }
    await tester.runAsync(() => AdForge.instance.flush());
    expect(srv.events.where((e) => e['type'] == 'impression').length, 1);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('AdForgePlacement shows the original when no campaign is live', (tester) async {
    await tester.runAsync(() async {
      await AdForge.init(baseUrl: 'http://ads.test', appKey: 'key', client: Server(manifest()).client, autoRefresh: false);
    });
    await tester.pumpWidget(const MaterialApp(home: AdForgePlacement(spot: 'streak_icon', child: Text('original'))));
    expect(find.text('original'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });
}
