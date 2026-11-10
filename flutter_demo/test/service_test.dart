import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:focusflow_demo/adforge/adforge.dart';

import 'support.dart';

FakeServer withCreative({int version = 1}) => FakeServer(configJson(version: version, placements: [
      placementJson('home.coffee_cup', creative: creativeJson()),
      placementJson('home.desk_lamp', aspect: 0.8),
    ]));

void main() {
  test('refresh fetches, downloads and caches the creative, with no key: the application ID is enough', () async {
    final server = withCreative();
    final cache = MemoryAssetCache();
    final service = makeService(server, cache: cache);
    final out = await service.refresh();
    expect(out.result, RefreshResult.updated);
    expect(service.config!.configVersion, 1);
    expect(server.lastKey, isNull);
    expect(await service.bytesFor(service.config!.placement('home.coffee_cup')!.creative!), tinyPng);
    expect(server.imageCalls, 1);
  });

  test('an unchanged config is answered with 304 and nothing is downloaded again', () async {
    final server = withCreative();
    final service = makeService(server);
    await service.refresh();
    final out = await service.refresh();
    expect(out.result, RefreshResult.unchanged);
    expect(server.lastIfNoneMatch, '"1"');
    expect(server.imageCalls, 1); // still just the first download
  });

  test('a new version downloads the new image and forgets the old one', () async {
    final server = withCreative();
    final cache = MemoryAssetCache();
    final service = makeService(server, cache: cache);
    await service.refresh();
    server.body = configJson(version: 2, placements: [placementJson('home.coffee_cup', creative: creativeJson(id: 'cr-9'))]);
    expect((await service.refresh()).result, RefreshResult.updated);
    expect(server.imageCalls, 2);
    expect((await cache.stats()).count, 1);
    expect(await cache.contains(service.config!.placement('home.coffee_cup')!.creative!.cacheKey), isTrue);
  });

  test('a creative removed on the server disappears and its image is pruned', () async {
    final server = withCreative();
    final cache = MemoryAssetCache();
    final service = makeService(server, cache: cache);
    await service.refresh();
    server.body = configJson(version: 2, placements: [placementJson('home.coffee_cup')]);
    await service.refresh();
    expect(service.config!.placement('home.coffee_cup')!.creative, isNull);
    expect((await cache.stats()).count, 0);
  });

  test('network failure keeps the last known good configuration', () async {
    final server = withCreative();
    final service = makeService(server);
    await service.refresh();
    server.offline = true;
    final out = await service.refresh();
    expect(out.result, RefreshResult.offline);
    expect(out.message, contains('last known configuration (v1)'));
    expect(service.config!.configVersion, 1);
  });

  test('a malformed response is ignored and the good config stays', () async {
    final server = withCreative();
    final service = makeService(server);
    await service.refresh();
    server.body = '{ this is not json';
    var out = await service.refresh();
    expect(out.result, RefreshResult.failed);
    server.body = {'schema_version': 1};
    out = await service.refresh();
    expect(out.result, RefreshResult.failed);
    expect(service.config!.configVersion, 1);
  });

  test('a server that requires runtime keys gets the configured one', () async {
    final server = withCreative();
    await makeService(server, runtimeKey: 'afk_test').refresh();
    expect(server.lastKey, 'afk_test');
  });

  test('an unregistered app, refused credentials and server errors are reported plainly', () async {
    final server = withCreative();
    final service = makeService(server);
    server.status = 404;
    expect((await service.refresh()).message, contains('has no application "focusflow"'));
    server.status = 401;
    expect((await service.refresh()).message, contains('requires a runtime key'));
    server.status = 500;
    expect((await service.refresh()).message, contains('500'));
    expect(service.config, isNull); // nothing to fall back on but the app's own assets
  });

  test('an image whose hash does not match is rejected, not cached', () async {
    final server = withCreative();
    server.imageBytes = Uint8List.fromList([1, 2, 3]);
    final cache = MemoryAssetCache();
    final service = makeService(server, cache: cache);
    await service.refresh();
    expect((await cache.stats()).count, 0);
    expect(await service.bytesFor(service.config!.placement('home.coffee_cup')!.creative!), isNull); // placement keeps its original
  });

  test('image download failure does not fail the refresh', () async {
    final server = withCreative();
    server.imageBytes = Uint8List(0);
    final service = makeService(server);
    expect((await service.refresh()).result, RefreshResult.updated);
  });

  test('the saved configuration lets the app start offline', () async {
    final store = MemoryConfigStore();
    final cache = MemoryAssetCache();
    final online = makeService(withCreative(), store: store, cache: cache);
    await online.refresh();

    final offlineServer = withCreative()..offline = true;
    final restarted = makeService(offlineServer, store: store, cache: cache);
    await restarted.restore();
    expect(restarted.config!.configVersion, 1);
    expect(restarted.usingStoredConfig, isTrue);
    expect(await restarted.bytesFor(restarted.config!.placement('home.coffee_cup')!.creative!), tinyPng); // image cached too
    expect((await restarted.refresh()).result, RefreshResult.offline);
    expect(restarted.config!.placement('home.coffee_cup')!.creative, isNotNull);
  });

  test('a corrupt saved configuration is discarded, not fatal', () async {
    final store = MemoryConfigStore();
    await store.save(StoredConfig(rawJson: '{{{', savedAt: DateTime.now()));
    final service = makeService(withCreative(), store: store);
    await service.restore();
    expect(service.config, isNull);
    expect(await store.load(), isNull);
  });

  group('file asset cache', () {
    late Directory dir;
    setUp(() => dir = Directory.systemTemp.createTempSync('adforge_cache_test'));
    tearDown(() => dir.deleteSync(recursive: true));

    test('stores, reads, counts and prunes', () async {
      final cache = FileAssetCache(dir);
      await cache.write('cr-1-v1-abc', tinyPng);
      await cache.write('cr-2-v1-def', tinyPng);
      expect(await cache.read('cr-1-v1-abc'), tinyPng);
      expect(await cache.read('missing'), isNull);
      expect((await cache.stats()).count, 2);
      expect(await cache.retainOnly({'cr-1-v1-abc'}), 1);
      expect(await cache.contains('cr-2-v1-def'), isFalse);
    });

    test('a hostile key cannot write outside the cache folder', () async {
      final cache = FileAssetCache(dir);
      await cache.write('../../evil', tinyPng);
      expect(File('${dir.parent.parent.path}/evil').existsSync(), isFalse);
      expect(dir.listSync().length, 1);
    });
  });
}
