// Runs the real SDK against a real AdForge server.
//   ADFORGE_URL=http://localhost:8300 ADFORGE_KEY=afk_... flutter test integration/live_server_test.dart
import 'dart:convert';
import 'dart:io';

import 'package:adforge_flutter/adforge_flutter.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  final url = Platform.environment['ADFORGE_URL'];
  final key = Platform.environment['ADFORGE_KEY'];
  final token = Platform.environment['ADFORGE_ADMIN_TOKEN'];
  final spotKey = Platform.environment['ADFORGE_SPOT'] ?? 'dash_hero';

  test('downloads a live campaign picture and gets a verified impression counted', () async {
    TestWidgetsFlutterBinding.ensureInitialized();
    HttpOverrides.global = null; // flutter test blocks real network by default
    // ignore: invalid_use_of_visible_for_testing_member
    SharedPreferences.setMockInitialValues({});
    final ad = await AdForge.init(baseUrl: url!, appKey: key!, autoRefresh: false);
    final spot = ad.spot(spotKey);
    expect(spot, isNotNull, reason: 'no campaign is live for $spotKey');
    expect(spot!.bytes!.length, greaterThan(100));

    final before = await _impressions(url, token!, spot.campaignId);
    ad.recordImpression(spot);
    await ad.flush();
    final after = await _impressions(url, token, spot.campaignId);
    expect(after, before + 1);

    // A second report from the same device inside 30 minutes must not count again.
    await ad.flush();
    expect(await _impressions(url, token, spot.campaignId), after);
  });
}

Future<int> _impressions(String url, String token, String campaignId) async {
  final r = await http.get(Uri.parse('$url/api/campaigns/$campaignId/analytics'), headers: {'authorization': 'Bearer $token'});
  return (jsonDecode(r.body) as Map)['impressions'] as int;
}
