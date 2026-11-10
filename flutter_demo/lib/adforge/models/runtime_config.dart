/// Typed view of the AdForge runtime response (schema_version 1).
///
/// Parsing is strict about the document's shape, so a malformed config is rejected whole and the
/// last-known-good one stays in use. A single unusable creative, though, only drops that creative:
/// that placement falls back to the app's own asset while the rest keep working.
library;

class ConfigFormatException implements Exception {
  ConfigFormatException(this.message);
  final String message;
  @override
  String toString() => 'ConfigFormatException: $message';
}

T _req<T>(Map<String, dynamic> json, String key, [String? where]) {
  final v = json[key];
  if (v is! T) throw ConfigFormatException('${where ?? 'config'}: "$key" is missing or not a ${T.toString()}');
  return v;
}

class RenderSpec {
  const RenderSpec({
    this.aspectRatio,
    this.fit = 'contain',
    this.alignment = 'center',
    this.backgroundColor,
    this.renderingMode = 'image',
    this.maxWidth,
    this.maxHeight,
    this.cornerRadius,
    this.requiresTransparency = false,
    this.adPosition = 'bottom_right',
    this.adSize = 0.3,
    this.adArea = 'whole',
    this.adX = 0.5,
    this.adY = 0.5,
    this.adRadius = 0,
  });

  factory RenderSpec.fromJson(Map<String, dynamic> j) => RenderSpec(
        aspectRatio: (j['aspect_ratio'] as num?)?.toDouble(),
        fit: j['fit'] as String? ?? 'contain',
        alignment: j['alignment'] as String? ?? 'center',
        backgroundColor: j['background_color'] as String?,
        renderingMode: j['rendering_mode'] as String? ?? 'image',
        maxWidth: (j['max_width'] as num?)?.toDouble(),
        maxHeight: (j['max_height'] as num?)?.toDouble(),
        cornerRadius: (j['corner_radius'] as num?)?.toDouble(),
        requiresTransparency: j['requires_transparency'] as bool? ?? false,
        adPosition: j['ad_position'] as String? ?? 'bottom_right',
        adSize: (j['ad_size'] as num?)?.toDouble() ?? 0.3,
        adArea: j['ad_area'] as String? ?? 'whole',
        adX: (j['ad_x'] as num?)?.toDouble() ?? 0.5,
        adY: (j['ad_y'] as num?)?.toDouble() ?? 0.5,
        adRadius: (j['ad_radius'] as num?)?.toDouble() ?? 0,
      );

  final double? aspectRatio;
  final String fit;
  final String alignment;
  final String? backgroundColor;
  final String renderingMode;
  final double? maxWidth;
  final double? maxHeight;
  final double? cornerRadius;
  final bool requiresTransparency;

  /// Ad slots: where the ad sits on top of the picture (top_left, top_right, bottom_left, bottom_right, center,
  /// bottom_strip, or custom: centred at [adX], [adY]) and how big it is (a share of the picture's width; for
  /// bottom_strip, of its height).
  final String adPosition;
  final double adSize;
  final double adX, adY;

  /// Rounded corners as a share of the ad's shorter side (0 square, 0.5 fully round).
  final double adRadius;

  /// `whole` or `safe` (the centre part that stays visible however the app crops the picture).
  final String adArea;

  Map<String, dynamic> toJson() => {
        'aspect_ratio': aspectRatio, 'fit': fit, 'alignment': alignment, 'background_color': backgroundColor,
        'rendering_mode': renderingMode, 'max_width': maxWidth, 'max_height': maxHeight, 'corner_radius': cornerRadius,
        'requires_transparency': requiresTransparency, 'ad_position': adPosition, 'ad_size': adSize, 'ad_area': adArea,
        'ad_x': adX, 'ad_y': adY, 'ad_radius': adRadius,
      };
}

class RuntimeCreative {
  const RuntimeCreative({
    required this.creativeId,
    required this.version,
    required this.url,
    required this.width,
    required this.height,
    required this.format,
    required this.sha256,
    required this.advertiser,
    required this.campaignId,
    required this.campaignStatus,
    this.productName,
    this.destinationUrl,
    this.validUntil,
  });

  factory RuntimeCreative.fromJson(Map<String, dynamic> j) {
    const where = 'creative';
    return RuntimeCreative(
      creativeId: _req<String>(j, 'creative_id', where),
      version: _req<int>(j, 'version', where),
      url: _req<String>(j, 'url', where),
      width: _req<int>(j, 'width', where),
      height: _req<int>(j, 'height', where),
      format: _req<String>(j, 'format', where),
      sha256: _req<String>(j, 'sha256', where),
      advertiser: _req<String>(j, 'advertiser', where),
      campaignId: _req<String>(j, 'campaign_id', where),
      campaignStatus: _req<String>(j, 'campaign_status', where),
      productName: j['product_name'] as String?,
      destinationUrl: j['destination_url'] as String?,
      validUntil: j['valid_until'] == null ? null : DateTime.tryParse(j['valid_until'] as String),
    );
  }

  final String creativeId;
  final int version;
  final String url;
  final int width;
  final int height;
  final String format;
  final String sha256;
  final String advertiser;
  final String campaignId;
  final String campaignStatus;
  final String? productName;
  final String? destinationUrl;
  final DateTime? validUntil;

  /// Images are cached by identity and version: a new upload is a new key, an unchanged one is never fetched again.
  String get cacheKey => '$creativeId-v$version-${sha256.substring(0, 12)}';

  /// The backend decides eligibility; this only guards against showing a creative after its end time
  /// when the device has been offline for a while.
  bool isStillValid(DateTime now) => validUntil == null || now.isBefore(validUntil!);

  @override
  bool operator ==(Object other) => other is RuntimeCreative && other.cacheKey == cacheKey;

  @override
  int get hashCode => cacheKey.hashCode;
}

class RuntimePlacement {
  const RuntimePlacement({required this.id, required this.render, this.fallbackRef, this.creative, this.integration = 'widget', this.assetPath, this.assetKeys = const []});

  factory RuntimePlacement.fromJson(Map<String, dynamic> j, {void Function(String)? onDropped}) {
    final id = _req<String>(j, 'placement_id', 'placement');
    RuntimeCreative? creative;
    if (j['creative'] != null) {
      try {
        creative = RuntimeCreative.fromJson(_req<Map<String, dynamic>>(j, 'creative', id));
      } on ConfigFormatException catch (e) {
        onDropped?.call('$id: unusable creative dropped (${e.message})');
      }
    }
    final fallback = j['fallback'];
    return RuntimePlacement(
      id: id,
      render: RenderSpec.fromJson((j['render'] as Map?)?.cast<String, dynamic>() ?? const {}),
      fallbackRef: fallback is Map ? fallback['ref'] as String? : null,
      creative: creative,
      integration: j['integration'] as String? ?? 'widget',
      assetPath: j['asset_path'] as String?,
      assetKeys: [for (final k in (j['asset_keys'] as List?) ?? const []) if (k is String) k],
    );
  }

  final String id;
  final RenderSpec render;
  final String? fallbackRef;
  final RuntimeCreative? creative;

  /// `widget`: drawn by an AdForgeImage. `asset`: one of the app's own bundled pictures. `remote`: a photo the app loads
  /// from a web address. For `asset` and `remote`, AdForge draws the ad on top of the app's picture.
  final String integration;

  /// Ad slots: the app's picture the ad goes on (its bundled path, or its web address).
  final String? assetPath;

  /// Bundled pictures: every file name the app may load for it (one per screen density).
  final List<String> assetKeys;

  bool get isAssetSlot => integration == 'asset' && assetPath != null;
  bool get isRemoteSlot => integration == 'remote' && assetPath != null;
}

class RuntimeConfig {
  const RuntimeConfig({
    required this.applicationId,
    required this.configVersion,
    required this.serverTime,
    required this.ttlSeconds,
    required this.placements,
    this.nextChangeAt,
    this.adsEnabled = true,
    this.maxStaleSeconds,
  });

  factory RuntimeConfig.fromJson(Object? raw, {void Function(String)? onDropped}) {
    if (raw is! Map<String, dynamic>) throw ConfigFormatException('config is not a JSON object');
    final schema = _req<int>(raw, 'schema_version');
    if (schema != 1) throw ConfigFormatException('unsupported schema_version $schema');
    final list = _req<List>(raw, 'placements');
    final placements = <String, RuntimePlacement>{};
    for (final p in list) {
      if (p is! Map<String, dynamic>) throw ConfigFormatException('placements contains a non-object');
      final rp = RuntimePlacement.fromJson(p, onDropped: onDropped);
      placements[rp.id] = rp;
    }
    return RuntimeConfig(
      applicationId: _req<String>(raw, 'application_id'),
      configVersion: _req<int>(raw, 'config_version'),
      serverTime: DateTime.tryParse(_req<String>(raw, 'server_time')) ?? (throw ConfigFormatException('server_time is not a date')),
      ttlSeconds: (raw['ttl_seconds'] as num?)?.toInt() ?? 60,
      nextChangeAt: raw['next_change_at'] == null ? null : DateTime.tryParse(raw['next_change_at'] as String),
      placements: placements,
      adsEnabled: raw['ads_enabled'] as bool? ?? true,
      maxStaleSeconds: (raw['max_stale_seconds'] as num?)?.toInt(),
    );
  }

  final String applicationId;
  final int configVersion;
  final DateTime serverTime;
  final int ttlSeconds;
  final DateTime? nextChangeAt;
  final Map<String, RuntimePlacement> placements;

  /// False when ads are stopped for the whole app: every placement shows the app's own asset.
  final bool adsEnabled;

  /// If the app can't refresh for this long, it stops showing ads until it can (null: no limit).
  final int? maxStaleSeconds;

  RuntimePlacement? placement(String id) => placements[id];
}
