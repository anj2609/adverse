import 'dart:typed_data';

import 'package:flutter/widgets.dart';

/// One ad spot in the app, with the campaign picture that currently fills it.
class AdForgeSpot {
  AdForgeSpot({
    required this.key,
    required this.matchImage,
    required this.integration,
    required this.fit,
    required this.creativeId,
    required this.sha256,
    required this.url,
    required this.campaignId,
    required this.token,
    this.clickUrl,
    this.validUntil,
    this.bytes,
  });

  /// Reads one entry of the manifest's `placements` list. Returns null when the spot has no campaign picture.
  static AdForgeSpot? fromJson(Map<String, dynamic> json) {
    final creative = json['creative'] as Map<String, dynamic>?;
    if (creative == null) return null;
    final until = json['valid_until'] as String?;
    return AdForgeSpot(
      key: json['key'] as String,
      matchImage: (json['match_image'] as String?)?.toLowerCase(),
      integration: (json['integration'] as String?) ?? 'asset',
      fit: (json['fit'] as String?) == 'contain' ? BoxFit.contain : BoxFit.cover,
      creativeId: creative['id'] as String,
      sha256: creative['sha256'] as String,
      url: creative['url'] as String,
      campaignId: json['campaign_id'] as String,
      token: json['token'] as String,
      clickUrl: json['click_url'] as String?,
      validUntil: until == null ? null : DateTime.parse(until),
    );
  }

  /// The spot's name in the AdForge dashboard, used by [AdForgePlacement].
  final String key;

  /// File name of the app's own picture this spot replaces (lower case), for automatic swapping.
  final String? matchImage;

  /// `asset` swaps the app's picture by file name; `widget` is drawn by [AdForgePlacement].
  final String integration;
  final BoxFit fit;
  final String creativeId;
  final String sha256;
  final String url;
  final String campaignId;

  /// Signed proof that the server chose this ad; every impression and click carries it.
  final String token;

  /// Tracking link: opening it counts the click, then lands on the advertiser's page.
  final String? clickUrl;

  /// When the campaign picture stops being valid. The SDK never shows it after this, even offline.
  final DateTime? validUntil;

  /// The downloaded picture; null until it has been fetched.
  Uint8List? bytes;

  bool isLive(DateTime now) => bytes != null && (validUntil == null || now.isBefore(validUntil!));

  Map<String, dynamic> toJson() => {
        'key': key,
        'match_image': matchImage,
        'integration': integration,
        'fit': fit == BoxFit.contain ? 'contain' : 'cover',
        'creative': {'id': creativeId, 'sha256': sha256, 'url': url},
        'campaign_id': campaignId,
        'token': token,
        'click_url': clickUrl,
        'valid_until': validUntil?.toUtc().toIso8601String(),
      };
}
