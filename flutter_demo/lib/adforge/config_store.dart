import 'package:shared_preferences/shared_preferences.dart';

class StoredConfig {
  const StoredConfig({required this.rawJson, this.etag, required this.savedAt});
  final String rawJson;
  final String? etag;
  final DateTime savedAt;
}

/// Keeps the last configuration that parsed successfully ("last known good") so the app starts offline with it.
abstract class ConfigStore {
  Future<StoredConfig?> load();
  Future<void> save(StoredConfig config);
  Future<void> clear();
}

class PrefsConfigStore implements ConfigStore {
  static const _key = 'adforge.config.v1', _etag = 'adforge.config.etag', _at = 'adforge.config.saved_at';

  @override
  Future<StoredConfig?> load() async {
    final p = await SharedPreferences.getInstance();
    final raw = p.getString(_key);
    if (raw == null) return null;
    return StoredConfig(rawJson: raw, etag: p.getString(_etag), savedAt: DateTime.tryParse(p.getString(_at) ?? '') ?? DateTime.fromMillisecondsSinceEpoch(0));
  }

  @override
  Future<void> save(StoredConfig c) async {
    final p = await SharedPreferences.getInstance();
    await p.setString(_key, c.rawJson);
    if (c.etag != null) await p.setString(_etag, c.etag!);
    await p.setString(_at, c.savedAt.toIso8601String());
  }

  @override
  Future<void> clear() async {
    final p = await SharedPreferences.getInstance();
    await p.remove(_key);
    await p.remove(_etag);
    await p.remove(_at);
  }
}

class MemoryConfigStore implements ConfigStore {
  StoredConfig? _value;
  @override
  Future<StoredConfig?> load() async => _value;
  @override
  Future<void> save(StoredConfig config) async => _value = config;
  @override
  Future<void> clear() async => _value = null;
}
