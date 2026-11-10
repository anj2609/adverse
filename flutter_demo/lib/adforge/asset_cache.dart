import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:path_provider/path_provider.dart';

/// Where downloaded creative images live. Keys are creative identity + version + hash, so an image is downloaded once.
abstract class AssetCache {
  Future<Uint8List?> read(String key);
  Future<void> write(String key, Uint8List bytes);
  Future<bool> contains(String key);

  /// Deletes everything not in [keep], so replaced creatives don't pile up on the device.
  Future<int> retainOnly(Set<String> keep);
  Future<CacheStats> stats();
}

class CacheStats {
  const CacheStats(this.count, this.bytes);
  final int count;
  final int bytes;
}

class MemoryAssetCache implements AssetCache {
  final Map<String, Uint8List> _m = {};
  @override
  Future<Uint8List?> read(String key) async => _m[key];
  @override
  Future<void> write(String key, Uint8List bytes) async => _m[key] = bytes;
  @override
  Future<bool> contains(String key) async => _m.containsKey(key);
  @override
  Future<int> retainOnly(Set<String> keep) async {
    final drop = _m.keys.where((k) => !keep.contains(k)).toList();
    drop.forEach(_m.remove);
    return drop.length;
  }

  @override
  Future<CacheStats> stats() async => CacheStats(_m.length, _m.values.fold(0, (a, b) => a + b.length));
}

class FileAssetCache implements AssetCache {
  FileAssetCache([Directory? dir]) : _dir = dir;
  Directory? _dir;

  Future<Directory> get _root async {
    final d = _dir ??= Directory('${(await getApplicationSupportDirectory()).path}/adforge_cache');
    if (!await d.exists()) await d.create(recursive: true);
    return d;
  }

  // keys come from creative ids and hashes; strip anything that could climb out of the folder
  String _safe(String key) => key.replaceAll(RegExp(r'[^A-Za-z0-9._-]'), '_');

  @override
  Future<Uint8List?> read(String key) async {
    final f = File('${(await _root).path}/${_safe(key)}');
    return await f.exists() ? await f.readAsBytes() : null;
  }

  @override
  Future<void> write(String key, Uint8List bytes) async {
    final path = '${(await _root).path}/${_safe(key)}';
    final tmp = File('$path.part');
    await tmp.writeAsBytes(bytes, flush: true);
    await tmp.rename(path); // never leave a half-written image behind
  }

  @override
  Future<bool> contains(String key) async => File('${(await _root).path}/${_safe(key)}').exists();

  @override
  Future<int> retainOnly(Set<String> keep) async {
    final keepNames = keep.map(_safe).toSet();
    var removed = 0;
    await for (final e in (await _root).list()) {
      if (e is File && !keepNames.contains(e.uri.pathSegments.last)) {
        await e.delete();
        removed++;
      }
    }
    return removed;
  }

  @override
  Future<CacheStats> stats() async {
    var n = 0, bytes = 0;
    await for (final e in (await _root).list()) {
      if (e is File && !e.path.endsWith('.part')) {
        n++;
        bytes += await e.length();
      }
    }
    return CacheStats(n, bytes);
  }
}

AssetCache defaultAssetCache() => kIsWeb ? MemoryAssetCache() : FileAssetCache();
