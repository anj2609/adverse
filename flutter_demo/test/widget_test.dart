import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:focusflow_demo/adforge/adforge.dart';
import 'package:focusflow_demo/app.dart';

import 'support.dart';

// Widget tests run on fake time, so the long-lived "wait for changes" request is off here (it has its own test).
const settings = AdForgeSettings(baseUrl: 'http://ads.test', applicationId: 'focusflow', liveUpdates: false);

List<Override> overrides(FakeServer server, {AssetCache? cache, ConfigStore? store}) => [
      adForgeSettingsProvider.overrideWithValue(settings),
      adForgeLoggerProvider.overrideWithValue(AdForgeLogger(print: false)),
      adForgeServiceProvider.overrideWith((ref) => makeService(server, cache: cache, store: store)),
      placementRegistryProvider.overrideWithValue(testPlacements),
    ];

/// Lets the launch-time restore + refresh (real async work) finish, then rebuilds the widgets.
Future<void> settle(WidgetTester tester) async {
  await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
  await tester.pump();
  await tester.pump();
}

Widget host(List<Override> o, Widget child) => ProviderScope(
      overrides: o,
      child: MaterialApp(home: Scaffold(body: Center(child: Consumer(builder: (_, ref, __) {
        ref.watch(adForgeProvider); // what main.dart does at the top of the app
        return child;
      })))),
    );

ImageProvider imageOf(WidgetTester tester) => tester.widget<Image>(find.byType(Image).first).image;

void main() {
  testWidgets('shows the app\'s own asset when no creative is assigned', (tester) async {
    await tester.pumpWidget(host(overrides(FakeServer(configJson())), const AdForgeImage(placementId: 'home.coffee_cup', width: 100, height: 100)));
    await settle(tester);
    expect(imageOf(tester), isA<AssetImage>());
    expect((imageOf(tester) as AssetImage).assetName, 'assets/images/coffee_cup.png');
    expect(find.textContaining('Ad ·'), findsNothing);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('renders the assigned creative, keeping the placement\'s box, and labels it as an ad', (tester) async {
    final server = FakeServer(configJson(placements: [placementJson('home.coffee_cup', creative: creativeJson())]));
    await tester.pumpWidget(host(overrides(server), const AdForgeImage(placementId: 'home.coffee_cup', width: 100, height: 100)));
    await settle(tester);
    expect(imageOf(tester), isA<MemoryImage>());
    expect(find.text('Ad · BrewCo'), findsOneWidget);
    final box = tester.getSize(find.byType(AdForgeImage));
    expect(box, const Size(100, 100)); // the layout around it is unchanged
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('applies the placement\'s render rules (fit, aspect ratio)', (tester) async {
    final server = FakeServer(configJson(placements: [placementJson('dashboard.promotional_banner', creative: creativeJson(), fit: 'cover', aspect: 3.0)]));
    await tester.pumpWidget(host(overrides(server), const SizedBox(width: 300, child: AdForgeImage(placementId: 'dashboard.promotional_banner'))));
    await settle(tester);
    expect(tester.getSize(find.byType(AdForgeImage)), const Size(300, 100)); // 3:1 from the config
    expect(tester.widget<Image>(find.byType(Image).first).fit, BoxFit.cover);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('falls back when the creative image is not available', (tester) async {
    final server = FakeServer(configJson(placements: [placementJson('home.coffee_cup', creative: creativeJson())]))..imageBytes = Uint8List(0);
    await tester.pumpWidget(host(overrides(server), const AdForgeImage(placementId: 'home.coffee_cup', width: 100, height: 100)));
    await settle(tester);
    expect(imageOf(tester), isA<AssetImage>());
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('a placement missing from the server config still shows its original', (tester) async {
    await tester.pumpWidget(host(overrides(FakeServer(configJson(placements: []))), const AdForgeImage(placementId: 'home.desk_lamp', width: 80, height: 100)));
    await settle(tester);
    expect(imageOf(tester), isA<AssetImage>());
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('an unregistered placement ID is a clear developer error', (tester) async {
    await tester.pumpWidget(host(overrides(FakeServer(configJson())), const AdForgeImage(placementId: 'home.sofa', width: 10, height: 10)));
    expect(tester.takeException(), isA<ArgumentError>());
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('manual refresh picks up a change and a removal without rebuilding anything', (tester) async {
    final server = FakeServer(configJson(version: 1));
    final container = ProviderContainer(overrides: overrides(server));
    addTearDown(container.dispose);
    await tester.pumpWidget(UncontrolledProviderScope(container: container, child: const MaterialApp(home: Scaffold(body: Center(child: AdForgeImage(placementId: 'home.coffee_cup', width: 100, height: 100))))));
    container.read(adForgeProvider);
    await settle(tester);
    expect(imageOf(tester), isA<AssetImage>());

    server.body = configJson(version: 2, placements: [placementJson('home.coffee_cup', creative: creativeJson())]); // an admin assigned a creative
    await tester.runAsync(() => container.read(adForgeProvider.notifier).refresh());
    await settle(tester);
    expect(imageOf(tester), isA<MemoryImage>());
    expect(container.read(adForgeProvider).config!.configVersion, 2);

    server.body = configJson(version: 3); // ...and then removed it
    await tester.runAsync(() => container.read(adForgeProvider.notifier).refresh());
    await settle(tester);
    expect(imageOf(tester), isA<AssetImage>());
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('keeps the creative on screen when the network drops, and says it is offline', (tester) async {
    final server = FakeServer(configJson(placements: [placementJson('home.coffee_cup', creative: creativeJson())]));
    final container = ProviderContainer(overrides: overrides(server));
    addTearDown(container.dispose);
    await tester.pumpWidget(UncontrolledProviderScope(container: container, child: const MaterialApp(home: Scaffold(body: AdForgeImage(placementId: 'home.coffee_cup', width: 100, height: 100)))));
    container.read(adForgeProvider);
    await settle(tester);
    server.offline = true;
    await tester.runAsync(() => container.read(adForgeProvider.notifier).refresh());
    await settle(tester);
    expect(container.read(adForgeProvider).status, SyncStatus.offline);
    expect(imageOf(tester), isA<MemoryImage>());
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('the whole app works with AdForge unreachable: tasks, dashboard and the celebration dialog use the originals', (tester) async {
    final server = FakeServer(configJson())..offline = true;
    await tester.pumpWidget(ProviderScope(overrides: overrides(server), child: const _BootedApp()));
    await settle(tester);
    expect(find.text("Today's focus"), findsOneWidget);
    await tester.tap(find.byType(Checkbox).first);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.text('Nice work!'), findsOneWidget);
    expect(tester.widgetList<Image>(find.byType(Image)).every((i) => i.image is AssetImage), isTrue);
    await tester.tap(find.text('Keep going'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Dashboard'));
    await tester.pumpAndSettle();
    expect(find.text('Tasks done'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('diagnostics shows status, version and per-placement detail, and its Refresh button works', (tester) async {
    tester.view.physicalSize = const Size(800, 2600); // tall enough that the lazy list builds every placement tile
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final server = FakeServer(configJson(version: 4, placements: [placementJson('home.coffee_cup', creative: creativeJson())]));
    await tester.pumpWidget(ProviderScope(overrides: overrides(server), child: const _BootedApp()));
    await settle(tester);
    await tester.tap(find.text('Diagnostics'));
    await tester.pumpAndSettle();
    expect(find.textContaining('Connected'), findsOneWidget);
    expect(find.text('v4'), findsOneWidget);
    expect(find.textContaining('home.desk_lamp'), findsWidgets);
    expect(find.textContaining('Showing BrewCo'), findsOneWidget);
    expect(find.textContaining('afk_'), findsNothing); // the runtime key is never displayed

    server.body = configJson(version: 5);
    await tester.tap(find.byKey(const Key('diag-refresh')));
    await settle(tester);
    expect(find.text('v5'), findsOneWidget);
    expect(find.textContaining('Showing BrewCo'), findsNothing);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('without an application ID the app still runs and says why', (tester) async {
    await tester.pumpWidget(ProviderScope(
      overrides: [adForgeSettingsProvider.overrideWithValue(const AdForgeSettings(baseUrl: 'http://x', applicationId: '')), adForgeLoggerProvider.overrideWithValue(AdForgeLogger(print: false))],
      child: const _BootedApp(),
    ));
    await settle(tester);
    await tester.tap(find.text('Diagnostics'));
    await tester.pumpAndSettle();
    expect(find.textContaining('No application ID configured'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });
}

class _BootedApp extends ConsumerWidget {
  const _BootedApp();
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    ref.watch(adForgeProvider.select((_) => 0));
    return const FocusFlowApp();
  }
}
