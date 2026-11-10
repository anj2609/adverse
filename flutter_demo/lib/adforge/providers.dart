import 'dart:async';

import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'ad_overlay.dart';
import 'adforge_client.dart';
import 'adforge_service.dart';
import 'asset_bundle.dart';
import 'asset_cache.dart';
import 'config_store.dart';
import 'logger.dart';
import 'models/runtime_config.dart';
import 'placement_registry.dart';

/// Connection settings. Passed with --dart-define (see README); the runtime key only reads this app's config.
class AdForgeSettings {
  const AdForgeSettings({required this.baseUrl, required this.applicationId, this.runtimeKey = '', this.liveUpdates = true});
  final String baseUrl;

  /// The application ID registered in AdForge, e.g. `focusflow`. All an app needs to connect.
  final String applicationId;

  /// Only for servers set to require runtime keys (RUNTIME_REQUIRE_KEY). Leave empty otherwise.
  final String runtimeKey;

  /// Keep one request waiting on the server while the app is in the foreground, so a stop or a new ad arrives
  /// within about a second. Off: refresh on launch, on returning to the app, on a timer and on demand.
  final bool liveUpdates;

  static const fromEnvironment = AdForgeSettings(
    baseUrl: String.fromEnvironment('ADFORGE_URL', defaultValue: 'http://localhost:8000'),
    applicationId: String.fromEnvironment('ADFORGE_APP_ID', defaultValue: 'focusflow'),
    runtimeKey: String.fromEnvironment('ADFORGE_RUNTIME_KEY', defaultValue: ''),
    liveUpdates: bool.fromEnvironment('ADFORGE_LIVE_UPDATES', defaultValue: true),
  );
}

final adForgeSettingsProvider = Provider<AdForgeSettings>((_) => AdForgeSettings.fromEnvironment);

/// Placements the app draws with [AdForgeImage]. Apps that only use asset slots (found by scanning the project zip)
/// leave this empty: their pictures are swapped by [AdForgeAssetBundle] instead.
final placementRegistryProvider = Provider<PlacementRegistry>((_) => const PlacementRegistry([]));
final adForgeLoggerProvider = Provider<AdForgeLogger>((_) => AdForgeLogger());
final configStoreProvider = Provider<ConfigStore>((_) => PrefsConfigStore());
final assetCacheProvider = Provider<AssetCache>((_) => defaultAssetCache());

final adForgeServiceProvider = Provider<AdForgeService>((ref) {
  final s = ref.watch(adForgeSettingsProvider);
  return AdForgeService(
    client: AdForgeClient(baseUrl: s.baseUrl, applicationId: s.applicationId, runtimeKey: s.runtimeKey),
    store: ref.watch(configStoreProvider),
    cache: ref.watch(assetCacheProvider),
    logger: ref.watch(adForgeLoggerProvider),
  );
});

enum SyncStatus { idle, refreshing, ok, offline, failed }

class AdForgeState {
  const AdForgeState({this.config, this.status = SyncStatus.idle, this.lastAttempt, this.lastSuccess, this.message, this.usingStoredConfig = false, this.cache = const CacheStats(0, 0), this.imageEpoch = 0});
  final RuntimeConfig? config;
  final SyncStatus status;
  final DateTime? lastAttempt;
  final DateTime? lastSuccess;
  final String? message;
  final bool usingStoredConfig;
  final CacheStats cache;

  /// Bumped whenever the set of cached images may have changed, so widgets re-read them.
  final int imageEpoch;

  AdForgeState copyWith({RuntimeConfig? config, SyncStatus? status, DateTime? lastAttempt, DateTime? lastSuccess, String? message, bool? usingStoredConfig, CacheStats? cache, int? imageEpoch}) =>
      AdForgeState(
        config: config ?? this.config,
        status: status ?? this.status,
        lastAttempt: lastAttempt ?? this.lastAttempt,
        lastSuccess: lastSuccess ?? this.lastSuccess,
        message: message ?? this.message,
        usingStoredConfig: usingStoredConfig ?? this.usingStoredConfig,
        cache: cache ?? this.cache,
        imageEpoch: imageEpoch ?? this.imageEpoch,
      );
}

/// Owns "what AdForge currently says": restores the saved config, refreshes on launch and on returning to the app,
/// keeps a waiting request open for instant changes (or, without live updates, refreshes on the server's timer hint),
/// and refreshes on demand. Nothing here ever throws into the UI.
class AdForgeNotifier extends Notifier<AdForgeState> with WidgetsBindingObserver {
  Timer? _timer;
  bool _refreshing = false;
  bool _listening = false;
  bool _foreground = true;
  bool _disposed = false;

  AdForgeService get _service => ref.read(adForgeServiceProvider);
  bool get _live => ref.read(adForgeSettingsProvider).liveUpdates;

  @override
  AdForgeState build() {
    WidgetsBinding.instance.addObserver(this);
    ref.onDispose(() {
      _disposed = true;
      WidgetsBinding.instance.removeObserver(this);
      _timer?.cancel();
    });
    Future.microtask(_start);
    return const AdForgeState();
  }

  Future<void> _start() async {
    if (ref.read(adForgeSettingsProvider).applicationId.isEmpty) {
      ref.read(adForgeLoggerProvider).warn('not_configured', {'hint': 'Pass --dart-define=ADFORGE_APP_ID=...'});
      state = state.copyWith(status: SyncStatus.failed, message: 'No application ID configured. The app is showing its own assets.');
      return;
    }
    await _service.restore();
    if (_disposed) return;
    _publish(SyncStatus.idle);
    await refresh();
    _listen();
  }

  /// Manual or automatic refresh. Returns the human-readable outcome.
  Future<String> refresh() async {
    if (_refreshing) return 'A refresh is already running';
    _refreshing = true;
    state = state.copyWith(status: SyncStatus.refreshing);
    try {
      final out = await _service.refresh();
      if (_disposed) return out.message;
      _publish(_statusOf(out.result));
      if (!_live) _schedule();
      return out.message;
    } finally {
      _refreshing = false;
    }
  }

  /// One request at a time waits on the server; it returns the moment the config changes, or after the wait with
  /// "not modified". Offline or refused: back off and try again (each failure also re-checks the staleness limit).
  Future<void> _listen() async {
    if (_listening || _disposed || !_live) return;
    _listening = true;
    var backoff = 2;
    try {
      while (!_disposed && _foreground) {
        final started = DateTime.now();
        final out = await _service.refresh(wait: 25);
        if (_disposed) return;
        final ok = out.result == RefreshResult.updated || out.result == RefreshResult.unchanged;
        if (out.result != RefreshResult.unchanged || state.status != SyncStatus.ok) {
          _publish(_statusOf(out.result), images: out.result != RefreshResult.unchanged);
        } else {
          state = state.copyWith(lastSuccess: _service.lastSuccess, lastAttempt: _service.lastAttempt);
        }
        backoff = ok ? 2 : (backoff * 2).clamp(2, 60);
        final pause = ok ? const Duration(seconds: 1) - DateTime.now().difference(started) : Duration(seconds: backoff);
        if (pause > Duration.zero) await Future<void>.delayed(pause); // never spin, even if a server answers at once
      }
    } finally {
      _listening = false;
    }
  }

  static SyncStatus _statusOf(RefreshResult r) => switch (r) {
        RefreshResult.updated || RefreshResult.unchanged => SyncStatus.ok,
        RefreshResult.offline => SyncStatus.offline,
        RefreshResult.failed => SyncStatus.failed,
      };

  void _publish(SyncStatus status, {bool images = true}) {
    final s = _service;
    state = AdForgeState(
      config: s.config, status: status, lastAttempt: s.lastAttempt, lastSuccess: s.lastSuccess, message: s.lastMessage,
      usingStoredConfig: s.usingStoredConfig, cache: state.cache, imageEpoch: state.imageEpoch + (images ? 1 : 0),
    );
    s.cache.stats().then((c) {
      if (!_disposed && ref.exists(adForgeProvider)) state = state.copyWith(cache: c);
    });
  }

  void _schedule() {
    _timer?.cancel();
    final secs = (state.config?.ttlSeconds ?? 60).clamp(15, 900);
    _timer = Timer(Duration(seconds: secs), refresh);
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    switch (state) {
      case AppLifecycleState.resumed:
        _foreground = true;
        refresh().then((_) => _listen());
      case AppLifecycleState.paused || AppLifecycleState.hidden || AppLifecycleState.detached:
        _foreground = false; // the waiting request ends on its own; no network use in the background
      case AppLifecycleState.inactive:
        break;
    }
  }
}

final adForgeProvider = NotifierProvider<AdForgeNotifier, AdForgeState>(AdForgeNotifier.new);

/// A placement as the UI should draw it right now.
class ResolvedPlacement {
  const ResolvedPlacement({required this.spec, required this.render, this.creative});
  final PlacementSpec spec;
  final RenderSpec render;
  final RuntimeCreative? creative;
}

final placementProvider = Provider.family<ResolvedPlacement, String>((ref, id) {
  final spec = ref.watch(placementRegistryProvider).require(id);
  final cfg = ref.watch(adForgeProvider.select((s) => s.config));
  final p = cfg?.placement(id);
  final service = ref.read(adForgeServiceProvider);
  final creative = p?.creative;
  return ResolvedPlacement(
    spec: spec,
    render: p?.render ?? RenderSpec(aspectRatio: spec.defaultAspect),
    creative: creative != null && creative.isStillValid(service.now()) && service.adsActive() ? creative : null,
  );
});

final creativeBytesProvider = FutureProvider.family<Uint8List?, RuntimeCreative>((ref, creative) {
  ref.watch(adForgeProvider.select((s) => s.imageEpoch));
  return ref.read(adForgeServiceProvider).bytesFor(creative);
});

/// The bundle the app's own pictures come from. Tests can point it elsewhere.
final adForgeBaseBundleProvider = Provider<AssetBundle>((_) => rootBundle);

/// The asset bundle the app should load its pictures through: its own, with ads drawn on top of the pictures that have
/// one. Photos the app loads from the internet get their ad through Flutter's image cache instead (see [_photoWithAd]).
/// A new bundle only when something changed (an ad, its spot or size, a stop), so the app's pictures are looked up again
/// exactly then, and never otherwise.
class AdForgeBundleNotifier extends Notifier<AssetBundle> {
  String _signature = '';
  int _seq = 0;
  Map<String, AdOverlay> _remote = {};

  @override
  AssetBundle build() {
    ref.listen(adForgeProvider.select((s) => s.imageEpoch), (_, __) => _update(), fireImmediately: true);
    ref.onDispose(() {
      for (final url in _remote.keys) {
        PaintingBinding.instance.imageCache.evict(NetworkImage(url));
      }
    });
    return ref.read(adForgeBaseBundleProvider);
  }

  Future<void> _update() async {
    final seq = ++_seq;
    final service = ref.read(adForgeServiceProvider);
    final swaps = await service.swaps();
    if (seq != _seq || swaps.signature == _signature) return; // a newer update is on its way, or nothing changed
    _signature = swaps.signature;

    // Photos from the internet: Flutter's Image.network looks the photo up in the image cache by its web address first.
    // Put "the photo with the ad on top" there; take it out when the ad stops, so the app loads the plain photo again.
    final cache = PaintingBinding.instance.imageCache;
    for (final MapEntry(key: url, value: was) in _remote.entries) {
      if (swaps.remote[url]?.id != was.id) cache.evict(NetworkImage(url));
    }
    for (final MapEntry(key: url, value: o) in swaps.remote.entries) {
      if (_remote[url]?.id == o.id) continue;
      cache.evict(NetworkImage(url));
      cache.putIfAbsent(NetworkImage(url), () => OneFrameImageStreamCompleter(_photoWithAd(service, url, o, ref.read(adForgeLoggerProvider))));
    }
    _remote = Map.of(swaps.remote);

    // A new bundle: every picture on screen, bundled or from the internet, is looked up again and shows the change.
    state = AdForgeAssetBundle(ref.read(adForgeBaseBundleProvider), swaps.bundled, remote: swaps.remote.keys.toSet());
    ref.read(adForgeLoggerProvider).info('ads_on_pictures', {'bundled': swaps.bundled.keys.toList(), 'internet': swaps.remote.keys.toList()});
  }
}

/// Downloads the app's photo the way the app would, and draws the ad on top of it. If the photo can't be fetched, the
/// cached entry is dropped so the app's own loading (and its own error handling) takes over next time.
Future<ImageInfo> _photoWithAd(AdForgeService service, String url, AdOverlay o, AdForgeLogger log) async {
  try {
    final photo = await decodeImage(await service.client.downloadImage(url));
    final info = ImageInfo(image: await drawOverlay(photo, o));
    log.info('photo_ad_drawn', {'url': url, 'size': '${photo.width}x${photo.height}'});
    return info;
  } catch (e) {
    log.warn('photo_ad_failed', {'url': url, 'error': '$e'});
    PaintingBinding.instance.imageCache.evict(NetworkImage(url));
    rethrow;
  }
}

final adForgeBundleProvider = NotifierProvider<AdForgeBundleNotifier, AssetBundle>(AdForgeBundleNotifier.new);
