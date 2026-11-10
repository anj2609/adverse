import 'dart:async';
import 'dart:ui' as ui;

import 'package:flutter/services.dart';

import 'ad_overlay.dart';

/// The app's own asset bundle, with AdForge ads drawn on top of the pictures that have one.
///
/// Every `Image.asset(...)`, `AssetImage(...)` and `DefaultAssetBundle.of(context).load(...)` in the app goes through
/// it, so a picture found by scanning the app's project zip can carry an ad without any per-picture code. The picture
/// itself stays: the ad is drawn on top of it at the chosen spot, and the result has the picture's exact pixel size.
/// Everything else (fonts, JSON, the asset manifest, pictures without an ad) comes straight from the app's bundle.
/// Ads are downloaded and hash-checked before a bundle is built, so loading never waits on the network.
class AdForgeAssetBundle extends AssetBundle {
  AdForgeAssetBundle(this.base, Map<String, AdOverlay> overlays, {Set<String> remote = const {}})
      : overlays = Map.unmodifiable(overlays),
        remote = Set.unmodifiable(remote);

  final AssetBundle base;

  /// Asset key (exactly as the app loads it, per screen density) -> the ad to draw on it.
  final Map<String, AdOverlay> overlays;

  /// Web addresses of photos that have an ad on them (drawn through the image cache, not this bundle). For diagnostics.
  final Set<String> remote;

  final Map<String, Future<Uint8List>> _drawn = {};

  bool hasAd(String key) => overlays.containsKey(key) || remote.contains(key);

  Future<Uint8List> _withAd(String key, AdOverlay o) => _drawn[key] ??= () async {
        final own = await base.load(key);
        try {
          return await drawOnTopBytes(own.buffer.asUint8List(own.offsetInBytes, own.lengthInBytes), o);
        } catch (_) {
          return own.buffer.asUint8List(own.offsetInBytes, own.lengthInBytes); // can't draw it: the plain picture, never a broken one
        }
      }();

  @override
  Future<ByteData> load(String key) async {
    final o = overlays[key];
    if (o == null) return base.load(key);
    return ByteData.sublistView(await _withAd(key, o));
  }

  @override
  Future<ui.ImmutableBuffer> loadBuffer(String key) async {
    final o = overlays[key];
    if (o == null) return base.loadBuffer(key);
    return ui.ImmutableBuffer.fromUint8List(await _withAd(key, o));
  }

  @override
  Future<String> loadString(String key, {bool cache = true}) => base.loadString(key, cache: cache);

  @override
  Future<T> loadStructuredData<T>(String key, Future<T> Function(String value) parser) => base.loadStructuredData(key, parser);

  @override
  Future<T> loadStructuredBinaryData<T>(String key, FutureOr<T> Function(ByteData data) parser) => base.loadStructuredBinaryData(key, parser);

  @override
  void evict(String key) => base.evict(key);

  @override
  void clear() => base.clear();

  @override
  String toString() => 'AdForgeAssetBundle(${overlays.length} pictures, ${remote.length} photos with ads)';
}
