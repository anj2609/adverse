import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import 'package:url_launcher/url_launcher.dart';

import 'bundle.dart';
import 'spot.dart';

/// Connects the app to AdForge: downloads the campaign pictures that are live right now,
/// swaps them in, and reports verified impressions and clicks.
///
/// Nothing here can break the app. If AdForge is unreachable the app simply keeps its own pictures.
class AdForge extends ChangeNotifier with WidgetsBindingObserver {
  AdForge._({
    required this.baseUrl,
    required this.appKey,
    required http.Client client,
    required SharedPreferences prefs,
    required this.deviceId,
    required this.timeout,
    required this.now,
  })  : _http = client,
        _prefs = prefs;

  static AdForge? _instance;

  /// The initialised instance. Call [init] first.
  static AdForge get instance =>
      _instance ?? (throw StateError('Call AdForge.init() before using AdForge.'));
  static bool get isInitialized => _instance != null;

  /// Starts AdForge. Call once, before `runApp`.
  ///
  /// Waits at most [timeout] for the first download so the app is never held up; spots that
  /// are not ready in time are picked up by the next refresh.
  static Future<AdForge> init({
    required String baseUrl,
    required String appKey,
    http.Client? client,
    Duration timeout = const Duration(seconds: 4),
    bool autoRefresh = true,
    DateTime Function()? clock,
  }) async {
    WidgetsFlutterBinding.ensureInitialized();
    _instance?._dispose();
    final prefs = await SharedPreferences.getInstance();
    var device = prefs.getString(_deviceKey);
    if (device == null) {
      final rnd = Random.secure();
      device = List.generate(24, (_) => 'abcdefghijklmnopqrstuvwxyz0123456789'[rnd.nextInt(36)]).join();
      await prefs.setString(_deviceKey, device);
    }
    final ad = AdForge._(
      baseUrl: baseUrl.replaceAll(RegExp(r'/+$'), ''),
      appKey: appKey,
      client: client ?? http.Client(),
      prefs: prefs,
      deviceId: device,
      timeout: timeout,
      now: clock ?? DateTime.now,
    );
    _instance = ad;
    WidgetsBinding.instance.addObserver(ad);
    ad._loadCache();
    await ad.refresh();
    if (autoRefresh) ad._scheduleRefresh();
    ad._flushTimer = Timer.periodic(const Duration(seconds: 15), (_) => ad.flush());
    return ad;
  }

  /// Puts the app inside a bundle that swaps in campaign pictures by file name.
  static Widget wrap(Widget app) => Builder(
        builder: (context) => DefaultAssetBundle(bundle: bundle, child: app),
      );

  /// The asset bundle to hand to engines that bypass [DefaultAssetBundle], e.g. `Flame.bundle = AdForge.bundle`.
  static AssetBundle get bundle => _instance?._bundle ?? rootBundle;

  static const _deviceKey = 'adforge.device_id';
  static const _cacheKey = 'adforge.manifest';
  static const _impressionGap = Duration(minutes: 30);
  static const _minViewMs = 1000;

  final String baseUrl;
  final String appKey;
  final String deviceId;
  final Duration timeout;
  final DateTime Function() now;
  final http.Client _http;
  final SharedPreferences _prefs;

  late final AdForgeAssetBundle _bundle = AdForgeAssetBundle(
    parent: rootBundle,
    replacementFor: _bytesForFile,
    onServed: _servedByBundle,
  );

  final Map<String, AdForgeSpot> _spots = {};
  final Map<String, Uint8List> _images = {}; // by sha256
  final List<Map<String, dynamic>> _queue = [];
  final Map<String, DateTime> _lastImpression = {};
  final Set<String> _pendingServed = {};
  String? _etag;
  Timer? _refreshTimer;
  Timer? _flushTimer;
  bool _flushing = false;
  AppLifecycleState? _life;

  /// The spot, if a campaign picture is live for it right now.
  AdForgeSpot? spot(String key) {
    final s = _spots[key];
    return s != null && s.isLive(now()) ? s : null;
  }

  Uint8List? _bytesForFile(String fileName) {
    for (final s in _spots.values) {
      if (s.integration == 'asset' && s.matchImage == fileName && s.isLive(now())) return s.bytes;
    }
    return null;
  }

  // ---------- manifest ----------

  void _loadCache() {
    final raw = _prefs.getString(_cacheKey);
    if (raw == null) return;
    try {
      final cached = jsonDecode(raw) as Map<String, dynamic>;
      _etag = cached['etag'] as String?;
      _applyManifest(cached['manifest'] as Map<String, dynamic>, download: false);
    } catch (_) {
      _prefs.remove(_cacheKey);
    }
  }

  /// Fetches what should be showing now and downloads any new pictures.
  Future<void> refresh() async {
    try {
      final res = await _http.get(
        Uri.parse('$baseUrl/sdk/v1/manifest'),
        headers: {'x-adforge-key': appKey, if (_etag != null) 'if-none-match': _etag!},
      ).timeout(timeout);
      if (res.statusCode == 304) {
        await _downloadMissing();
        return;
      }
      if (res.statusCode != 200) return;
      final manifest = jsonDecode(res.body) as Map<String, dynamic>;
      _etag = res.headers['etag'];
      _applyManifest(manifest, download: true);
      await _downloadMissing();
      await _prefs.setString(_cacheKey, jsonEncode({'etag': _etag, 'manifest': {...manifest, 'placements': _spots.values.map((s) => s.toJson()).toList()}}));
      _refreshAfter = Duration(seconds: (manifest['refresh_after_sec'] as num?)?.toInt() ?? 300);
    } catch (e) {
      debugPrint('AdForge: refresh failed ($e). Keeping the app\'s own pictures.');
    }
    notifyListeners();
  }

  Duration _refreshAfter = const Duration(minutes: 5);

  void _applyManifest(Map<String, dynamic> manifest, {required bool download}) {
    final next = <String, AdForgeSpot>{};
    for (final p in (manifest['placements'] as List? ?? const [])) {
      final s = AdForgeSpot.fromJson(p as Map<String, dynamic>);
      if (s == null) continue;
      final prev = _spots[s.key];
      s.bytes = _images[s.sha256] ?? (prev?.sha256 == s.sha256 ? prev?.bytes : null);
      next[s.key] = s;
    }
    _spots
      ..clear()
      ..addAll(next);
  }

  Future<void> _downloadMissing() async {
    for (final s in _spots.values.where((s) => s.bytes == null).toList()) {
      try {
        final res = await _http.get(Uri.parse(s.url)).timeout(timeout * 2);
        if (res.statusCode == 200 && res.bodyBytes.isNotEmpty) {
          _images[s.sha256] = res.bodyBytes;
          s.bytes = res.bodyBytes;
        }
      } catch (e) {
        debugPrint('AdForge: could not download ${s.key} ($e)');
      }
    }
    notifyListeners();
  }

  void _scheduleRefresh() {
    _refreshTimer?.cancel();
    _refreshTimer = Timer(_refreshAfter, () async {
      await refresh();
      if (_instance == this) _scheduleRefresh();
    });
  }

  // ---------- events ----------

  /// Records that the spot's campaign picture was on screen for [viewableMs]. Counted once per 30 minutes.
  void recordImpression(AdForgeSpot s, {int viewableMs = _minViewMs}) {
    if (viewableMs < _minViewMs) return;
    final last = _lastImpression[s.key];
    if (last != null && now().difference(last) < _impressionGap) return;
    _lastImpression[s.key] = now();
    _enqueue(s, 'impression', viewableMs);
  }

  void _enqueue(AdForgeSpot s, String type, int viewableMs) {
    _queue.add({'token': s.token, 'type': type, 'device_id': deviceId, 'viewable_ms': viewableMs, 'ts': now().toUtc().toIso8601String()});
    if (_queue.length > 200) _queue.removeRange(0, _queue.length - 200);
    if (_queue.length >= 20) flush();
  }

  /// The bundle can't see the screen, so a served picture counts once the app has stayed in front for a second.
  void _servedByBundle(String fileName) {
    final s = _spots.values.where((s) => s.matchImage == fileName).firstOrNull;
    if (s == null || !_pendingServed.add(s.key)) return;
    Timer(const Duration(milliseconds: _minViewMs), () {
      _pendingServed.remove(s.key);
      if (_life == null || _life == AppLifecycleState.resumed) recordImpression(s);
    });
  }

  /// Sends queued events. Failed sends are kept and retried.
  Future<void> flush() async {
    if (_flushing || _queue.isEmpty) return;
    _flushing = true;
    final batch = List<Map<String, dynamic>>.of(_queue.take(100));
    try {
      final res = await _http
          .post(Uri.parse('$baseUrl/sdk/v1/events'),
              headers: {'x-adforge-key': appKey, 'content-type': 'application/json'}, body: jsonEncode({'events': batch}))
          .timeout(timeout);
      // 4xx other than rate limiting means retrying can't help.
      if (res.statusCode == 200 || (res.statusCode >= 400 && res.statusCode < 500 && res.statusCode != 429)) {
        _queue.removeRange(0, batch.length);
      }
    } catch (_) {
      // try again on the next tick
    } finally {
      _flushing = false;
    }
  }

  /// Opens the advertiser's page through AdForge's tracking link, which counts the click.
  Future<void> openClick(AdForgeSpot s) async {
    final link = s.clickUrl;
    if (link == null) return;
    final uri = Uri.parse(link).replace(queryParameters: {...Uri.parse(link).queryParameters, 'd': deviceId});
    try {
      await launchUrl(uri, mode: LaunchMode.externalApplication);
    } catch (e) {
      debugPrint('AdForge: could not open $uri ($e)');
    }
  }

  // ---------- lifecycle ----------

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _life = state;
    if (state == AppLifecycleState.paused) flush();
    if (state == AppLifecycleState.resumed) refresh();
  }

  /// True while the app is in the foreground.
  bool get inForeground => _life == null || _life == AppLifecycleState.resumed;

  void _dispose() {
    _refreshTimer?.cancel();
    _flushTimer?.cancel();
    WidgetsBinding.instance.removeObserver(this);
  }
}
