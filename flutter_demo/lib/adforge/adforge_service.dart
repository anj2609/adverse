import 'dart:convert';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';

import 'ad_overlay.dart';
import 'adforge_client.dart';
import 'asset_cache.dart';
import 'config_store.dart';
import 'errors.dart';
import 'logger.dart';
import 'models/runtime_config.dart';

enum RefreshResult { updated, unchanged, offline, failed }

class RefreshOutcome {
  const RefreshOutcome(this.result, this.message, {this.configVersion});
  final RefreshResult result;
  final String message;
  final int? configVersion;
}

/// Fetching, remembering and caching. Plain Dart (no Flutter, no Riverpod) so it is easy to test and to lift into a package.
class AdForgeService {
  AdForgeService({required this.client, required this.store, required this.cache, required this.logger, DateTime Function()? clock}) : now = clock ?? DateTime.now;

  final AdForgeClient client;
  final ConfigStore store;
  final AssetCache cache;
  final AdForgeLogger logger;
  final DateTime Function() now;

  RuntimeConfig? config;
  String? etag;
  DateTime? lastAttempt;
  DateTime? lastSuccess;
  String? lastMessage;
  bool usingStoredConfig = false;

  /// Loads the last-known-good config from disk so the app works immediately, even offline.
  Future<void> restore() async {
    final stored = await store.load();
    if (stored == null) return;
    try {
      config = RuntimeConfig.fromJson(jsonDecode(stored.rawJson), onDropped: (m) => logger.warn('creative_dropped', {'detail': m}));
      etag = stored.etag;
      lastSuccess = stored.savedAt;
      usingStoredConfig = true;
      logger.info('config_restored', {'version': config!.configVersion, 'saved_at': stored.savedAt.toIso8601String()});
    } catch (e) {
      logger.warn('stored_config_unusable', {'error': e.toString()});
      await store.clear();
    }
  }

  /// One fetch. With [wait], the server holds the request until something changes (see [AdForgeClient.fetchConfig]).
  Future<RefreshOutcome> refresh({int wait = 0}) async {
    lastAttempt = now();
    try {
      final res = await client.fetchConfig(etag: etag, wait: wait, onDropped: (m) => logger.warn('creative_dropped', {'detail': m}));
      if (res.notModified) {
        usingStoredConfig = false;
        lastSuccess = now();
        await _prefetch(config);
        return _done(RefreshResult.unchanged, 'Already up to date (v${config?.configVersion})');
      }
      final fresh = res.config!;
      final current = config;
      if (current != null && current.applicationId == fresh.applicationId && fresh.serverTime.isBefore(current.serverTime)) {
        lastSuccess = now(); // an older answer that crossed a newer one in flight: keep the newer
        return _done(RefreshResult.unchanged, 'Already up to date (v${current.configVersion})');
      }
      config = fresh;
      etag = res.etag;
      usingStoredConfig = false;
      lastSuccess = now();
      await store.save(StoredConfig(rawJson: res.rawJson!, etag: res.etag, savedAt: lastSuccess!));
      await _prefetch(fresh);
      return _done(RefreshResult.updated, 'Updated to v${fresh.configVersion}');
    } on AdForgeUnknownAppException catch (e) {
      // the application was deleted (or never registered): no ads, and nothing saved that could bring them back
      config = null;
      etag = null;
      usingStoredConfig = false;
      await store.clear();
      await cache.retainOnly(const {});
      return _done(RefreshResult.failed, e.message);
    } on AdForgeNetworkException catch (e) {
      return _done(RefreshResult.offline, 'Offline: using ${config == null ? 'the app\'s own assets' : 'the last known configuration (v${config!.configVersion})'}. ${e.message}');
    } on AdForgeException catch (e) {
      return _done(RefreshResult.failed, e.message);
    } on ConfigFormatException catch (e) {
      // keep the last good configuration; a malformed response must never blank the app
      return _done(RefreshResult.failed, 'Ignored a malformed response: ${e.message}');
    }
  }

  RefreshOutcome _done(RefreshResult r, String message) {
    lastMessage = message;
    final level = r == RefreshResult.failed ? logger.error : (r == RefreshResult.offline ? logger.warn : logger.info);
    level('refresh_${r.name}', {'message': message, 'version': config?.configVersion});
    return RefreshOutcome(r, message, configVersion: config?.configVersion);
  }

  /// Whether ads may show at all right now: AdForge hasn't stopped them for this app, and the configuration isn't
  /// older than its staleness limit (an app that can't reach AdForge for long stops showing ads it may no longer run).
  bool adsActive() {
    final c = config;
    if (c == null || !c.adsEnabled) return false;
    final limit = c.maxStaleSeconds, seen = lastSuccess;
    return limit == null || seen == null || now().difference(seen).inSeconds <= limit;
  }

  /// Downloads ads that aren't cached yet, checks their hash, and forgets ads no longer referenced.
  Future<void> _prefetch(RuntimeConfig? c) async {
    if (c == null) return;
    final keep = <String>{};
    for (final p in c.placements.values) {
      final cr = p.creative;
      if (!adsActive() || cr == null || !cr.isStillValid(now())) continue;
      for (final (key, url, hash) in [(cr.cacheKey, cr.url, cr.sha256)]) {
        keep.add(key);
        if (await cache.contains(key)) continue;
        try {
          final bytes = await client.downloadImage(url);
          if (sha256.convert(bytes).toString() != hash) throw const AdForgeAssetException('Downloaded image does not match its published hash');
          await cache.write(key, bytes);
          logger.info('image_cached', {'placement': p.id, 'creative': cr.creativeId, 'bytes': bytes.length});
        } on AdForgeException catch (e) {
          logger.warn('image_unavailable', {'placement': p.id, 'error': e.message});
          keep.remove(key);
        }
      }
    }
    final removed = await cache.retainOnly(keep);
    if (removed > 0) logger.info('cache_pruned', {'removed': removed});
  }

  /// Which of the app's pictures get an ad drawn on top, with the ad, its spot and its size. Bundled pictures are listed
  /// under every file name the app may load (one per screen density); photos from the internet under their web address.
  Future<AssetSwaps> swaps() async {
    final c = config;
    if (c == null || !adsActive()) return const AssetSwaps({}, {}, '');
    final bundled = <String, AdOverlay>{}, remote = <String, AdOverlay>{};
    final ids = <String>[];
    for (final p in c.placements.values) {
      final cr = p.creative;
      if (!(p.isAssetSlot || p.isRemoteSlot) || cr == null || !cr.isStillValid(now())) continue;
      final ad = await cache.read(cr.cacheKey);
      if (ad == null) continue; // not downloaded yet: the plain picture meanwhile
      final r = p.render;
      final o = AdOverlay(ad: ad, position: r.adPosition, size: r.adSize, area: r.adArea, x: r.adX, y: r.adY, radius: r.adRadius,
          id: '${cr.cacheKey}@${r.adPosition}@${r.adSize}@${r.adArea}@${r.adX},${r.adY}@${r.adRadius}');
      if (p.isRemoteSlot) {
        remote[p.assetPath!] = o;
        ids.add('${p.assetPath}=${o.id}');
      } else {
        for (final key in p.assetKeys.isEmpty ? [p.assetPath!] : p.assetKeys) {
          bundled[key] = o;
          ids.add('$key=${o.id}');
        }
      }
    }
    return AssetSwaps(bundled, remote, (ids..sort()).join('|'));
  }

  /// The cached picture for a creative, or null (then the placement shows the app's own asset).
  Future<Uint8List?> bytesFor(RuntimeCreative c) => cache.read(c.cacheKey);
}

/// The ads to draw on the app's pictures, plus a signature that changes only when any of that changes.
class AssetSwaps {
  const AssetSwaps(this.bundled, this.remote, this.signature);

  /// Bundled picture file name -> its ad.
  final Map<String, AdOverlay> bundled;

  /// Web address of a photo the app loads -> its ad.
  final Map<String, AdOverlay> remote;
  final String signature;
  bool get isEmpty => bundled.isEmpty && remote.isEmpty;
}
