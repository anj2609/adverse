import 'package:flutter_test/flutter_test.dart';
import 'package:focusflow_demo/adforge/adforge.dart';

import 'support.dart';

void main() {
  test('parses a full configuration', () {
    final cfg = RuntimeConfig.fromJson(configJson(version: 7, placements: [placementJson('home.coffee_cup', creative: creativeJson(), fit: 'cover')]));
    expect(cfg.configVersion, 7);
    expect(cfg.applicationId, 'focusflow');
    final p = cfg.placement('home.coffee_cup')!;
    expect(p.render.fit, 'cover');
    expect(p.fallbackRef, 'assets/home.coffee_cup.png');
    expect(p.creative!.advertiser, 'BrewCo');
    expect(p.creative!.cacheKey, startsWith('cr-1-v1-'));
    expect(cfg.placement('nope'), isNull);
  });

  test('a placement without a creative is a placement that shows its fallback', () {
    final cfg = RuntimeConfig.fromJson(configJson());
    expect(cfg.placement('home.desk_lamp')!.creative, isNull);
    expect(cfg.placements.length, 4);
  });

  test('rejects documents that are not a usable configuration', () {
    expect(() => RuntimeConfig.fromJson('nonsense'), throwsA(isA<ConfigFormatException>()));
    expect(() => RuntimeConfig.fromJson(<String, dynamic>{...configJson(), 'schema_version': 2}), throwsA(isA<ConfigFormatException>()));
    expect(() => RuntimeConfig.fromJson(<String, dynamic>{...configJson()}..remove('config_version')), throwsA(isA<ConfigFormatException>()));
    expect(() => RuntimeConfig.fromJson(<String, dynamic>{...configJson(), 'placements': 'x'}), throwsA(isA<ConfigFormatException>()));
    expect(() => RuntimeConfig.fromJson(<String, dynamic>{...configJson(), 'server_time': 'yesterday'}), throwsA(isA<ConfigFormatException>()));
  });

  test('one broken creative only drops that creative', () {
    final broken = creativeJson()..remove('sha256');
    final dropped = <String>[];
    final cfg = RuntimeConfig.fromJson(
      configJson(placements: [placementJson('home.coffee_cup', creative: broken), placementJson('home.desk_lamp', creative: creativeJson(id: 'cr-2'))]),
      onDropped: dropped.add,
    );
    expect(cfg.placement('home.coffee_cup')!.creative, isNull);
    expect(cfg.placement('home.desk_lamp')!.creative!.creativeId, 'cr-2');
    expect(dropped.single, contains('home.coffee_cup'));
  });

  test('ignores fields it does not know (forward compatible)', () {
    final json = configJson(placements: [placementJson('home.coffee_cup', creative: {...creativeJson(), 'future_field': 1})]);
    json['something_new'] = true;
    expect(RuntimeConfig.fromJson(json).placement('home.coffee_cup')!.creative, isNotNull);
  });

  test('a creative past its end time is not valid, even before the next refresh', () {
    final c = RuntimeCreative.fromJson(creativeJson(validUntil: '2030-01-01T12:00:00Z'));
    expect(c.isStillValid(DateTime.utc(2030, 1, 1, 11, 59)), isTrue);
    expect(c.isStillValid(DateTime.utc(2030, 1, 1, 12)), isFalse);
    expect(RuntimeCreative.fromJson(creativeJson()).isStillValid(DateTime.utc(2099)), isTrue);
  });

  test('cache key changes with version and content, not with the URL', () {
    final a = RuntimeCreative.fromJson(creativeJson(version: 1));
    final b = RuntimeCreative.fromJson(creativeJson(version: 2));
    final c = RuntimeCreative.fromJson(creativeJson(sha: 'f' * 64));
    expect({a.cacheKey, b.cacheKey, c.cacheKey}.length, 3);
    expect(a, RuntimeCreative.fromJson(creativeJson()));
  });

  group('placement registry', () {
    test('finds registered placements', () {
      expect(testPlacements.lookup('home.coffee_cup')!.fallbackAsset, 'assets/images/coffee_cup.png');
      expect(testPlacements.ids.length, 4);
    });

    test('refuses an unregistered placement with a helpful message', () {
      expect(testPlacements.lookup('home.sofa'), isNull);
      expect(() => testPlacements.require('home.sofa'), throwsA(isA<ArgumentError>().having((e) => e.message, 'message', contains('placement registry'))));
    });
  });
}
