import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

import 'errors.dart';
import 'models/runtime_config.dart';

class ConfigResponse {
  const ConfigResponse({this.config, this.etag, this.notModified = false, this.rawJson});
  final RuntimeConfig? config;
  final String? etag;
  final bool notModified;
  final String? rawJson;
}

/// Talks to the runtime API. The application ID is all it needs (plus a runtime key only on servers that require
/// one). It can read this application's configuration and nothing else; there are no administrative credentials here.
class AdForgeClient {
  AdForgeClient({required this.baseUrl, required this.applicationId, this.runtimeKey = '', http.Client? httpClient, this.timeout = const Duration(seconds: 8)})
      : _http = httpClient ?? http.Client();

  final String baseUrl;
  final String applicationId;
  final String runtimeKey;
  final Duration timeout;
  final http.Client _http;

  Uri get _configUri => Uri.parse('${baseUrl.replaceAll(RegExp(r'/+$'), '')}/api/v1/runtime/$applicationId/config');

  /// With [wait] (seconds) and an [etag], the server holds the request until the config changes (a stop, a new ad)
  /// or the wait runs out (then 304). That is how a running app hears about changes within about a second.
  Future<ConfigResponse> fetchConfig({String? etag, int wait = 0, void Function(String)? onDropped}) async {
    final http.Response res;
    final uri = wait > 0 && etag != null ? _configUri.replace(queryParameters: {'wait': '$wait'}) : _configUri;
    try {
      res = await _http.get(uri, headers: {if (runtimeKey.isNotEmpty) 'X-AdForge-Key': runtimeKey, 'Accept': 'application/json', if (etag != null) 'If-None-Match': etag})
          .timeout(timeout + Duration(seconds: wait > 0 && etag != null ? wait : 0));
    } on TimeoutException {
      throw const AdForgeNetworkException('The AdForge server did not answer in time');
    } catch (e) {
      throw AdForgeNetworkException('Could not reach AdForge ($e)');
    }
    if (res.statusCode == 304) return ConfigResponse(etag: etag, notModified: true);
    if (res.statusCode == 404) throw AdForgeUnknownAppException('AdForge has no application "$applicationId" (not registered, or deleted). Showing the app\'s own pictures.');
    if (res.statusCode == 401 || res.statusCode == 403) throw AdForgeAuthException('AdForge refused this app (${res.statusCode}). This server requires a runtime key: check ADFORGE_RUNTIME_KEY.');
    if (res.statusCode != 200) throw AdForgeServerException('AdForge answered ${res.statusCode}', res.statusCode);
    try {
      final body = utf8.decode(res.bodyBytes);
      return ConfigResponse(config: RuntimeConfig.fromJson(jsonDecode(body), onDropped: onDropped), etag: res.headers['etag'], rawJson: body);
    } on FormatException catch (e) {
      throw ConfigFormatException('response is not valid JSON (${e.message})');
    }
  }

  Future<Uint8List> downloadImage(String url) async {
    try {
      final res = await _http.get(Uri.parse(url)).timeout(timeout * 2);
      if (res.statusCode != 200) throw AdForgeAssetException('Image download answered ${res.statusCode}');
      return res.bodyBytes;
    } on AdForgeException {
      rethrow;
    } catch (e) {
      throw AdForgeAssetException('Image download failed ($e)');
    }
  }
}
