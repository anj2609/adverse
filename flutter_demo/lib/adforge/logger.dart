import 'package:flutter/foundation.dart';

enum LogLevel { debug, info, warn, error }

class LogEntry {
  LogEntry(this.level, this.event, this.fields, this.at);
  final LogLevel level;
  final String event;
  final Map<String, Object?> fields;
  final DateTime at;
  @override
  String toString() => '[adforge] ${level.name} $event ${fields.isEmpty ? '' : fields}';
}

/// Prints in any build when the app is built with --dart-define=ADFORGE_VERBOSE=true (for troubleshooting).
const _verbose = bool.fromEnvironment('ADFORGE_VERBOSE');

/// Structured, in-memory log (shown on the diagnostics screen) that also prints in debug builds.
/// Never logs the runtime key.
class AdForgeLogger {
  AdForgeLogger({this.capacity = 100, DateTime Function()? clock, this.print = true}) : _clock = clock ?? DateTime.now;
  final int capacity;
  final bool print;
  final DateTime Function() _clock;
  final List<LogEntry> entries = [];

  void log(LogLevel level, String event, [Map<String, Object?> fields = const {}]) {
    final e = LogEntry(level, event, fields, _clock());
    entries.insert(0, e);
    if (entries.length > capacity) entries.removeLast();
    if (print && (kDebugMode || _verbose)) debugPrint(e.toString());
  }

  void info(String event, [Map<String, Object?> f = const {}]) => log(LogLevel.info, event, f);
  void warn(String event, [Map<String, Object?> f = const {}]) => log(LogLevel.warn, event, f);
  void error(String event, [Map<String, Object?> f = const {}]) => log(LogLevel.error, event, f);
}
