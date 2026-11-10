/// Everything that can go wrong talking to AdForge, as types the UI and the log can tell apart.
sealed class AdForgeException implements Exception {
  const AdForgeException(this.message);
  final String message;
  @override
  String toString() => '$runtimeType: $message';
}

class AdForgeNetworkException extends AdForgeException {
  const AdForgeNetworkException(super.message);
}

class AdForgeAuthException extends AdForgeException {
  const AdForgeAuthException(super.message);
}

/// AdForge has no application with this ID (never registered, or deleted): the app shows no ads at all.
class AdForgeUnknownAppException extends AdForgeException {
  const AdForgeUnknownAppException(super.message);
}

class AdForgeServerException extends AdForgeException {
  const AdForgeServerException(super.message, this.statusCode);
  final int statusCode;
}

class AdForgeAssetException extends AdForgeException {
  const AdForgeAssetException(super.message);
}
