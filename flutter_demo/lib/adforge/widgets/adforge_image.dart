import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../providers.dart';

BoxFit boxFitFrom(String fit) => switch (fit) {
      'cover' => BoxFit.cover,
      'fill' => BoxFit.fill,
      'fitWidth' => BoxFit.fitWidth,
      'fitHeight' => BoxFit.fitHeight,
      'none' => BoxFit.none,
      'scaleDown' => BoxFit.scaleDown,
      _ => BoxFit.contain,
    };

Alignment alignmentFrom(String a) => switch (a) {
      'topLeft' => Alignment.topLeft,
      'topCenter' => Alignment.topCenter,
      'topRight' => Alignment.topRight,
      'centerLeft' => Alignment.centerLeft,
      'centerRight' => Alignment.centerRight,
      'bottomLeft' => Alignment.bottomLeft,
      'bottomCenter' => Alignment.bottomCenter,
      'bottomRight' => Alignment.bottomRight,
      _ => Alignment.center,
    };

Color? colorFromHex(String? hex) {
  if (hex == null) return null;
  final v = int.tryParse(hex.replaceFirst('#', ''), radix: 16);
  return v == null ? null : Color(0xFF000000 | v);
}

/// Draws a registered placement: the assigned AdForge creative when one is eligible and downloaded,
/// otherwise the app's own asset. The box is the same either way, so swapping never moves anything around it.
///
///     AdForgeImage(placementId: 'home.coffee_cup', width: 96, height: 96)
///
/// Give a [width] and [height], or only a [width] (the height then follows the placement's aspect ratio).
class AdForgeImage extends ConsumerWidget {
  const AdForgeImage({super.key, required this.placementId, this.width, this.height, this.showAdLabel = true});

  final String placementId;
  final double? width;
  final double? height;

  /// A small "Ad · Brand" tag on creatives, so a sponsored picture is never passed off as the app's own.
  final bool showAdLabel;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final p = ref.watch(placementProvider(placementId)); // throws a clear error if the ID isn't in the app's registry
    final r = p.render;
    final fit = boxFitFrom(r.fit);
    final align = alignmentFrom(r.alignment);
    final fallback = Image.asset(
      p.spec.fallbackAsset,
      fit: fit, alignment: align, width: double.infinity, height: double.infinity, gaplessPlayback: true,
      semanticLabel: p.spec.name,
      errorBuilder: (_, __, ___) => const ColoredBox(color: Color(0x11000000), child: Center(child: Icon(Icons.image_not_supported_outlined))),
    );

    Widget content = fallback;
    Widget? label;
    final creative = p.creative;
    if (creative != null) {
      final bytes = ref.watch(creativeBytesProvider(creative));
      final data = bytes.valueOrNull;
      if (data != null) {
        content = Image.memory(
          data,
          fit: fit, alignment: align, width: double.infinity, height: double.infinity, gaplessPlayback: true,
          semanticLabel: '${p.spec.name}, sponsored by ${creative.advertiser}',
          errorBuilder: (_, __, ___) => fallback, // an undecodable cached file must never break the screen
        );
        if (showAdLabel) label = _AdLabel(creative.advertiser);
      }
    }

    Widget box = ClipRRect(
      borderRadius: BorderRadius.circular(r.cornerRadius ?? 0),
      child: ColoredBox(color: colorFromHex(r.backgroundColor) ?? Colors.transparent, child: Stack(fit: StackFit.expand, children: [content, if (label != null) label])),
    );
    final ratio = r.aspectRatio ?? p.spec.defaultAspect;
    if (width != null && height != null) {
      box = SizedBox(width: width, height: height, child: box);
    } else {
      box = AspectRatio(aspectRatio: ratio ?? 1, child: box);
      if (width != null) box = SizedBox(width: width, child: box);
      if (height != null) box = SizedBox(height: height, child: box);
    }
    if (r.maxWidth != null || r.maxHeight != null) {
      box = ConstrainedBox(constraints: BoxConstraints(maxWidth: r.maxWidth ?? double.infinity, maxHeight: r.maxHeight ?? double.infinity), child: box);
    }
    return KeyedSubtree(key: ValueKey('adforge-$placementId-${creative?.creativeId ?? 'fallback'}'), child: box);
  }
}

class _AdLabel extends StatelessWidget {
  const _AdLabel(this.advertiser);
  final String advertiser;

  @override
  Widget build(BuildContext context) => Align(
        alignment: Alignment.bottomLeft,
        child: Padding(
          padding: const EdgeInsets.all(4),
          child: DecoratedBox(
            decoration: BoxDecoration(color: Colors.black.withValues(alpha: 0.55), borderRadius: BorderRadius.circular(6)),
            child: Padding(padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2), child: Text('Ad · $advertiser', style: const TextStyle(color: Colors.white, fontSize: 10, fontWeight: FontWeight.w600))),
          ),
        ),
      );
}
