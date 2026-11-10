import 'dart:ui' as ui;

import 'package:crypto/crypto.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:focusflow_demo/adforge/adforge.dart';
import 'package:focusflow_demo/app.dart';
import 'package:focusflow_demo/features/home/home_screen.dart';
import 'package:focusflow_demo/state/tasks_provider.dart';

import 'support.dart';

const cup = 'assets/images/coffee_cup.png';
const cup2x = 'assets/images/2.0x/coffee_cup.png';
const photoUrl = 'https://photos.example.com/gym.jpg';
const blue = Color(0xFF2040C0), orange = Color(0xFFFF8800);

/// A real PNG of one colour, so pixels can be checked after the ad is drawn.
Future<Uint8List> solidPng(int w, int h, Color c) async {
  final r = ui.PictureRecorder();
  ui.Canvas(r).drawRect(ui.Rect.fromLTWH(0, 0, w.toDouble(), h.toDouble()), ui.Paint()..color = c);
  final img = await r.endRecording().toImage(w, h);
  return (await img.toByteData(format: ui.ImageByteFormat.png))!.buffer.asUint8List();
}

Future<Color> pixel(ui.Image img, int x, int y) async {
  final d = (await img.toByteData(format: ui.ImageByteFormat.rawRgba))!;
  final o = (y * img.width + x) * 4;
  return Color.fromARGB(d.getUint8(o + 3), d.getUint8(o), d.getUint8(o + 1), d.getUint8(o + 2));
}

/// The app's own bundle, as plain bytes per key.
class FakeBundle extends CachingAssetBundle {
  FakeBundle(this.files);
  final Map<String, Uint8List> files;
  @override
  Future<ByteData> load(String key) async => files.containsKey(key) ? ByteData.sublistView(files[key]!) : throw FlutterError('missing $key');
}

Uint8List bytesOf(ByteData d) => d.buffer.asUint8List(d.offsetInBytes, d.lengthInBytes);

Map<String, dynamic> adFor(Uint8List ad) => creativeJson(sha: sha256.convert(ad).toString());

Map<String, dynamic> withCup({int version = 2, bool adsEnabled = true, int? maxStale, List<String>? keys, String position = 'bottom_right'}) =>
    configJson(version: version, adsEnabled: adsEnabled, maxStale: maxStale, placements: [assetSlotJson(cup, creative: creativeJson(), keys: keys, position: position)]);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('where the ad goes on a picture', () {
    const pic = Size(200, 100), wide = Size(100, 50);
    test('a corner: the ad keeps its shape, a small margin from the edges', () {
      expect(adRect(pic, wide, 'bottom_right', 0.3), const Rect.fromLTWH(134, 64, 60, 30));
      expect(adRect(pic, wide, 'top_left', 0.3), const Rect.fromLTWH(6, 6, 60, 30));
    });
    test('the centre, and a strip along the bottom', () {
      expect(adRect(pic, wide, 'center', 0.5), const Rect.fromLTWH(50, 25, 100, 50));
      expect(adRect(pic, wide, 'bottom_strip', 0.25), const Rect.fromLTWH(75, 75, 50, 25)); // a quarter of the height, centred
    });
    test('for photos the app crops, the ad stays in the part that is always visible', () {
      const tall = Size(1200, 1500); // like FitFlow's hero photo, which the app shows cropped to a wide banner
      expect(safeArea(tall), const Rect.fromLTWH(0, 450, 1200, 600)); // the middle band survives any crop from 4:5 to 2:1
      final r = adRect(tall, wide, 'bottom_right', 0.3, area: 'safe');
      expect(r.bottom, lessThanOrEqualTo(1050)); // above where a wide crop cuts the photo off
      expect(r.top, greaterThanOrEqualTo(450));
      expect(adRect(tall, wide, 'bottom_right', 0.3).bottom, greaterThan(1050)); // the whole-picture corner would be cut off
    });
    test('a dragged ad sits where it was dropped, and never past the picture\'s edge', () {
      expect(adRect(pic, wide, 'custom', 0.25, x: 0.25, y: 0.5), const Rect.fromLTWH(25, 37.5, 50, 25)); // centred on (50, 50)
      expect(adRect(pic, wide, 'custom', 0.25, x: 1, y: 0), const Rect.fromLTWH(150, 0, 50, 25)); // pushed back inside
      final safe = adRect(const Size(1200, 1500), wide, 'custom', 0.2, area: 'safe', x: 0.5, y: 1);
      expect(safe.bottom, 1050); // a cropped photo: the bottom of the always-visible band
    });
    test('a big ad shrinks to fit inside the picture, never stretched', () {
      final r = adRect(pic, const Size(100, 100), 'center', 1.0);
      expect(r.height, closeTo(88, 0.01));
      expect(r.width, r.height);
    });
  });

  group('AdForgeAssetBundle', () {
    test('the app\'s picture comes back the same size with the ad drawn on top; everything else is untouched', () async {
      final photo = await solidPng(200, 100, blue), ad = await solidPng(100, 50, orange);
      final bundle = AdForgeAssetBundle(FakeBundle({cup: photo, 'assets/data.json': Uint8List.fromList('{"a":1}'.codeUnits)}),
          {cup: AdOverlay(ad: ad, position: 'bottom_right', size: 0.3, id: 'x')});
      final drawn = await decodeImage(bytesOf(await bundle.load(cup)));
      expect((drawn.width, drawn.height), (200, 100)); // the picture's own size: the app's layout can't move
      expect(await pixel(drawn, 160, 80), orange); // inside the ad's spot
      expect(await pixel(drawn, 20, 20), blue); // the picture is still there everywhere else
      expect(await bundle.loadString('assets/data.json'), '{"a":1}');
      expect(bundle.hasAd(cup), isTrue);
    });
    test('rounded corners let the picture show through at the ad\'s corners', () async {
      final photo = await solidPng(200, 100, blue), ad = await solidPng(100, 100, orange);
      final o = AdOverlay(ad: ad, position: 'custom', size: 0.5, x: 0.5, y: 0.5, radius: 0.5, id: 'round'); // a circle, 100 wide
      final drawn = await decodeImage(await drawOnTopBytes(photo, o));
      expect(await pixel(drawn, 100, 50), orange); // the middle of the ad
      expect(await pixel(drawn, 52, 2), blue); // its top-left corner is cut away
      final square = await decodeImage(await drawOnTopBytes(photo, AdOverlay(ad: ad, position: 'custom', size: 0.5, id: 'sq')));
      expect(await pixel(square, 52, 2), orange); // without rounding the corner is ad
    });
  });

  group('which pictures get an ad', () {
    test('every file name of a bundled picture, and a photo from the internet by its address', () async {
      final server = FakeServer(configJson(version: 2, placements: [
        assetSlotJson(cup, creative: creativeJson(), keys: [cup, cup2x], position: 'top_left'),
        remoteSlotJson(photoUrl, creative: creativeJson(id: 'cr-2')),
      ]));
      final s = makeService(server);
      await s.refresh();
      final swaps = await s.swaps();
      expect(swaps.bundled.keys, unorderedEquals([cup, cup2x]));
      expect(swaps.bundled[cup]!.position, 'top_left');
      expect(swaps.remote.keys, [photoUrl]);
      expect(swaps.signature, isNotEmpty);
    });

    test('stopping ads empties the list and forgets the downloaded ads', () async {
      final server = FakeServer(withCup());
      final cache = MemoryAssetCache();
      final s = makeService(server, cache: cache);
      await s.refresh();
      expect((await s.swaps()).isEmpty, isFalse);
      server.body = withCup(version: 3, adsEnabled: false)..['placements'] = [assetSlotJson(cup)];
      await s.refresh();
      expect(s.adsActive(), isFalse);
      expect((await s.swaps()).isEmpty, isTrue);
      expect((await cache.stats()).count, 0);
    });

    test('a device that can\'t reach AdForge for longer than allowed stops showing ads', () async {
      var now = DateTime.utc(2030, 1, 1, 12);
      final server = FakeServer(withCup(maxStale: 3600));
      final s = makeService(server, clock: () => now);
      await s.refresh();
      server.offline = true;
      now = now.add(const Duration(minutes: 59));
      await s.refresh();
      expect((await s.swaps()).isEmpty, isFalse); // offline, but still within the limit
      now = now.add(const Duration(minutes: 2));
      expect((await s.swaps()).isEmpty, isTrue);
    });

    test('a deleted app drops its ads at once and doesn\'t bring them back at the next launch', () async {
      final server = FakeServer(withCup());
      final store = MemoryConfigStore(), cache = MemoryAssetCache();
      final s = makeService(server, store: store, cache: cache);
      await s.refresh();
      expect((await s.swaps()).isEmpty, isFalse);
      server.status = 404; // an admin deleted the application
      expect((await s.refresh()).message, contains('has no application'));
      expect(s.config, isNull);
      expect((await s.swaps()).isEmpty, isTrue);
      expect((await cache.stats()).count, 0);
      final relaunched = makeService(server, store: store, cache: cache);
      await relaunched.restore(); // what the app does when it starts, before it reaches the server
      expect(relaunched.config, isNull);
    });

    test('an ad whose download fails its check is not shown', () async {
      final server = FakeServer(configJson(version: 2, placements: [assetSlotJson(cup, creative: creativeJson(sha: 'f' * 64))]));
      final s = makeService(server);
      await s.refresh();
      expect((await s.swaps()).isEmpty, isTrue);
    });

    test('an older answer that crosses a newer one in flight is ignored', () async {
      final server = FakeServer(withCup(version: 5)..['server_time'] = '2030-01-01T12:00:05+00:00');
      final s = makeService(server);
      await s.refresh();
      server.body = configJson(version: 4, serverTime: '2030-01-01T12:00:01+00:00');
      await s.refresh();
      expect(s.config!.configVersion, 5);
    });
  });

  testWidgets('the app\'s own picture gets the ad on top, and loses it the moment ads stop, without losing app state', (tester) async {
    tester.view.physicalSize = const Size(800, 2000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final server = FakeServer(configJson(version: 1, placements: [assetSlotJson(cup)]));
    final container = ProviderContainer(overrides: [
      adForgeSettingsProvider.overrideWithValue(const AdForgeSettings(baseUrl: 'http://ads.test', applicationId: 'focusflow', liveUpdates: false)),
      adForgeLoggerProvider.overrideWithValue(AdForgeLogger(print: false)),
      adForgeServiceProvider.overrideWith((ref) => makeService(server)),
    ]);
    addTearDown(container.dispose);
    await tester.pumpWidget(UncontrolledProviderScope(container: container, child: const AdForgeAssets(child: FocusFlowApp())));
    Future<void> settle() async {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 80)));
      await tester.pump();
      await tester.pump();
    }

    await settle();
    final cupImage = find.byWidgetPredicate((w) => w is Image && w.image is AssetImage && (w.image as AssetImage).assetName == cup);
    AssetBundle bundleOnScreen() => DefaultAssetBundle.of(tester.element(cupImage));
    expect(bundleOnScreen(), isNot(isA<AdForgeAssetBundle>())); // no ad yet: the app's own bundle, untouched

    container.read(tasksProvider.notifier).add('Write the AdForge report');
    final home = find.byType(HomeScreen);
    final homeState = tester.state(home);
    server.body = withCup();
    await tester.runAsync(() => container.read(adForgeProvider.notifier).refresh());
    await settle();
    final withAd = bundleOnScreen() as AdForgeAssetBundle;
    expect(withAd.hasAd(cup), isTrue);
    // drawn again here in real time (the app's own load of it runs on the test's simulated clock)
    final drawn = (await tester.runAsync(() async => decodeImage(bytesOf(await AdForgeAssetBundle(rootBundle, withAd.overlays).load(cup)))))!;
    final own = (await tester.runAsync(() async => decodeImage(bytesOf(await rootBundle.load(cup)))))!;
    expect((drawn.width, drawn.height), (own.width, own.height)); // the app's own cup picture, same size, ad on top
    expect(find.text('Write the AdForge report'), findsOneWidget);
    expect(tester.state(home), same(homeState));

    server.body = withCup(version: 3, adsEnabled: false)..['placements'] = [assetSlotJson(cup)];
    await tester.runAsync(() => container.read(adForgeProvider.notifier).refresh());
    await settle();
    expect((bundleOnScreen() as AdForgeAssetBundle).hasAd(cup), isFalse);
    expect(tester.state(home), same(homeState)); // the app is never restarted or rebuilt from scratch
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('a photo the app loads from the internet gets the ad on top, and the plain photo comes back on stop', (tester) async {
    final photo = (await tester.runAsync(() => solidPng(200, 100, blue)))!, ad = (await tester.runAsync(() => solidPng(100, 50, orange)))!;
    final server = FakeServer(configJson(version: 1, placements: [remoteSlotJson(photoUrl)]))
      ..files[photoUrl] = photo
      ..imageBytes = ad;
    final container = ProviderContainer(overrides: [
      adForgeSettingsProvider.overrideWithValue(const AdForgeSettings(baseUrl: 'http://ads.test', applicationId: 'fitflow', liveUpdates: false)),
      adForgeLoggerProvider.overrideWithValue(AdForgeLogger(print: false)),
      adForgeServiceProvider.overrideWith((ref) => makeService(server)),
    ]);
    addTearDown(container.dispose);
    // the app's own code, unchanged: a plain Image.network
    await tester.pumpWidget(UncontrolledProviderScope(container: container, child: AdForgeAssets(child: MaterialApp(home: Center(
        child: SizedBox(width: 200, height: 100, child: Image.network(photoUrl, fit: BoxFit.cover, errorBuilder: (_, __, ___) => const Text('offline'))))))));
    Future<void> settle() async {
      for (var i = 0; i < 4; i++) {
        await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 60)));
        await tester.pump();
      }
    }

    await settle();
    server.body = configJson(version: 2, placements: [remoteSlotJson(photoUrl, creative: adFor(ad))]);
    await tester.runAsync(() => container.read(adForgeProvider.notifier).refresh());
    await settle();
    expect(PaintingBinding.instance.imageCache.containsKey(const NetworkImage(photoUrl)), isTrue);
    final shown = tester.widget<RawImage>(find.byType(RawImage)).image!;
    expect((shown.width, shown.height), (200, 100)); // the photo, at its own size
    expect((await tester.runAsync(() => pixel(shown, 160, 80)))!, orange); // ad on top
    expect((await tester.runAsync(() => pixel(shown, 20, 20)))!, blue); // photo still visible

    server.body = configJson(version: 3, placements: [remoteSlotJson(photoUrl)]); // the ad is stopped
    await tester.runAsync(() => container.read(adForgeProvider.notifier).refresh());
    await settle();
    final after = find.byType(RawImage).evaluate().isEmpty ? null : tester.widget<RawImage>(find.byType(RawImage)).image;
    expect(after == null || (await tester.runAsync(() => pixel(after, 160, 80)))! != orange, isTrue); // no ad any more
    await tester.pumpWidget(const SizedBox());
  });

  test('with live updates a running app picks up a new ad, and a stop, within about a second', () async {
    final server = FakeServer(configJson(version: 1, placements: [assetSlotJson(cup)]));
    final container = ProviderContainer(overrides: [
      adForgeSettingsProvider.overrideWithValue(const AdForgeSettings(baseUrl: 'http://ads.test', applicationId: 'focusflow')),
      adForgeLoggerProvider.overrideWithValue(AdForgeLogger(print: false)),
      adForgeServiceProvider.overrideWith((ref) => makeService(server)),
    ]);
    addTearDown(() {
      server.closed = true;
      container.dispose();
    });
    container.listen(adForgeBundleProvider, (_, __) {}, fireImmediately: true);
    bool hasAd() => switch (container.read(adForgeBundleProvider)) { AdForgeAssetBundle b => b.hasAd(cup), _ => false };
    Future<Duration> until(bool Function() ok) async {
      final t0 = DateTime.now();
      while (!ok()) {
        if (DateTime.now().difference(t0) > const Duration(seconds: 5)) fail('timed out');
        await Future<void>.delayed(const Duration(milliseconds: 20));
      }
      return DateTime.now().difference(t0);
    }

    await until(() => container.read(adForgeProvider).config?.configVersion == 1 && server.waitingRequests > 0);
    server.body = withCup(); // an admin puts an ad on the picture: nobody presses refresh in the app
    final shown = await until(hasAd);
    server.body = withCup(version: 3, adsEnabled: false)..['placements'] = [assetSlotJson(cup)]; // ...and stops it
    final stopped = await until(() => !hasAd());
    expect(shown, lessThan(const Duration(milliseconds: 1500)));
    expect(stopped, lessThan(const Duration(milliseconds: 1500)));
  });
}
