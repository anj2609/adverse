import 'dart:async';
import 'dart:ui' as ui;

import 'package:flutter/services.dart';

/// Reduces an asset key or URL to the file name spots are matched on: no folders, no query,
/// lower case. `assets/images/Home_Banner.PNG` becomes `home_banner.png`.
String adforgeFileName(String keyOrUrl) {
  var path = keyOrUrl.split(RegExp('[?#]')).first;
  try {
    path = Uri.decodeComponent(path);
  } catch (_) {
    // keep the raw text
  }
  return path.substring(path.lastIndexOf('/') + 1).trim().toLowerCase();
}

/// An [AssetBundle] that hands out a campaign picture in place of the app's own whenever the
/// requested file is an ad spot with a live campaign, and passes everything else straight through.
///
/// `AdForge.wrap` installs it above the app, so existing `Image.asset` calls need no changes.
/// Flame games read `Flame.bundle` instead: set `Flame.bundle = AdForge.bundle`.
class AdForgeAssetBundle extends AssetBundle {
  AdForgeAssetBundle({required this.parent, required this.replacementFor, this.onServed});

  final AssetBundle parent;

  /// Returns the campaign picture for a file name, or null to use the app's own.
  final Uint8List? Function(String fileName) replacementFor;

  /// Called when a campaign picture is handed to the app.
  final void Function(String fileName)? onServed;

  Uint8List? _swap(String key) {
    final name = adforgeFileName(key);
    final bytes = replacementFor(name);
    if (bytes != null) onServed?.call(name);
    return bytes;
  }

  @override
  Future<ByteData> load(String key) async {
    final bytes = _swap(key);
    return bytes != null ? ByteData.sublistView(bytes) : parent.load(key);
  }

  @override
  Future<ui.ImmutableBuffer> loadBuffer(String key) async {
    final bytes = _swap(key);
    return bytes != null ? ui.ImmutableBuffer.fromUint8List(bytes) : parent.loadBuffer(key);
  }

  @override
  Future<String> loadString(String key, {bool cache = true}) => parent.loadString(key, cache: cache);

  @override
  Future<T> loadStructuredData<T>(String key, Future<T> Function(String value) parser) =>
      parent.loadStructuredData(key, parser);

  @override
  Future<T> loadStructuredBinaryData<T>(String key, FutureOr<T> Function(ByteData data) parser) =>
      parent.loadStructuredBinaryData(key, parser);

  @override
  void evict(String key) => parent.evict(key);

  @override
  void clear() => parent.clear();
}
