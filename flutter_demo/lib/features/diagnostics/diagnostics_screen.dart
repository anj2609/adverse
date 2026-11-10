import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../adforge/adforge.dart';

String _ago(DateTime? t) {
  if (t == null) return 'never';
  final s = DateTime.now().difference(t).inSeconds;
  if (s < 5) return 'just now';
  if (s < 60) return '${s}s ago';
  if (s < 3600) return '${s ~/ 60} min ago';
  return '${s ~/ 3600} h ago';
}

String _short(String id) => id.length > 8 ? '${id.substring(0, 8)}…' : id;

String _kb(int bytes) => bytes < 1024 ? '$bytes B' : '${(bytes / 1024).toStringAsFixed(0)} KB';

/// For development and demos: what AdForge told this app, what it is showing, and why. Shows nothing secret:
/// the runtime key is never displayed, and there are no administrative credentials in the app.
class DiagnosticsScreen extends ConsumerWidget {
  const DiagnosticsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(adForgeProvider);
    final settings = ref.watch(adForgeSettingsProvider);
    final registry = ref.watch(placementRegistryProvider);
    final logger = ref.watch(adForgeLoggerProvider);
    final service = ref.watch(adForgeServiceProvider);
    final cfg = state.config;
    final (statusLabel, statusColor) = switch (state.status) {
      SyncStatus.refreshing => ('Refreshing…', Colors.blue),
      SyncStatus.ok => ('Connected', Colors.green),
      SyncStatus.offline => ('Offline: using saved configuration', Colors.orange),
      SyncStatus.failed => ('Problem', Colors.red),
      SyncStatus.idle => ('Starting', Colors.grey),
    };
    final ads = cfg == null
        ? '—'
        : !cfg.adsEnabled
            ? 'Stopped by AdForge'
            : service.adsActive()
                ? 'On'
                : 'Paused: no contact with AdForge for too long';
    final placements = [...?cfg?.placements.values];
    final widgetOnly = registry.specs.where((s) => cfg?.placement(s.id) == null);

    Widget row(String k, String v, {Key? key}) => Padding(
          padding: const EdgeInsets.symmetric(vertical: 4),
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            SizedBox(width: 150, child: Text(k, style: const TextStyle(color: Colors.black54))),
            Expanded(child: Text(v, key: key, style: const TextStyle(fontWeight: FontWeight.w500))),
          ]),
        );

    return Scaffold(
      appBar: AppBar(title: const Text('AdForge diagnostics', style: TextStyle(fontWeight: FontWeight.w700))),
      body: ListView(padding: const EdgeInsets.fromLTRB(16, 4, 16, 32), children: [
        Card(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                Icon(Icons.circle, size: 12, color: statusColor),
                const SizedBox(width: 8),
                Expanded(child: Text('Runtime API: $statusLabel', key: const Key('diag-status'), style: const TextStyle(fontWeight: FontWeight.w700))),
                FilledButton.icon(
                  key: const Key('diag-refresh'),
                  onPressed: state.status == SyncStatus.refreshing ? null : () async {
                    final msg = await ref.read(adForgeProvider.notifier).refresh();
                    if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
                  },
                  icon: const Icon(Icons.refresh, size: 18),
                  label: const Text('Refresh'),
                ),
              ]),
              const SizedBox(height: 8),
              row('Application ID', settings.applicationId),
              row('Server', settings.baseUrl),
              row('Config version', cfg == null ? '—' : 'v${cfg.configVersion}', key: const Key('diag-version')),
              row('Ads', ads, key: const Key('diag-ads')),
              row('Live updates', settings.liveUpdates ? 'On: changes arrive within seconds' : 'Off: on launch, return, timer and Refresh'),
              row('Last successful fetch', state.lastSuccess == null ? 'never' : '${_ago(state.lastSuccess)}${state.usingStoredConfig ? ' (saved copy)' : ''}'),
              row('Last refresh result', state.message ?? '—', key: const Key('diag-message')),
              row('Image cache', '${state.cache.count} image${state.cache.count == 1 ? '' : 's'} · ${_kb(state.cache.bytes)}'),
              row('Placements', placements.isEmpty && registry.specs.isEmpty ? 'none yet' : [for (final p in placements) p.id, for (final s in widgetOnly) s.id].join('\n')),
            ]),
          ),
        ),
        const SizedBox(height: 12),
        for (final p in placements) _PlacementTile(placement: p),
        for (final s in widgetOnly) _PlacementTile(spec: s),
        const SizedBox(height: 12),
        Card(
          child: ExpansionTile(
            shape: const Border(),
            title: const Text('Recent log', style: TextStyle(fontWeight: FontWeight.w600)),
            children: [for (final e in logger.entries.take(30)) ListTile(dense: true, title: Text(e.event), subtitle: Text(e.fields.isEmpty ? e.level.name : '${e.level.name} · ${e.fields}'))],
          ),
        ),
      ]),
    );
  }
}

/// One placement: the app's original next to what it is drawing right now, and why.
class _PlacementTile extends ConsumerWidget {
  const _PlacementTile({this.placement, this.spec});
  final RuntimePlacement? placement;
  final PlacementSpec? spec;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final p = placement;
    final id = p?.id ?? spec!.id;
    final service = ref.watch(adForgeServiceProvider);
    ref.watch(adForgeProvider.select((s) => s.imageEpoch));
    final bundle = ref.watch(adForgeBundleProvider);
    final onTop = p != null && (p.isAssetSlot || p.isRemoteSlot); // a picture found in the app: the ad is drawn on top of it
    final original = p?.isAssetSlot == true ? p!.assetPath! : (p?.isRemoteSlot == true ? null : (ref.watch(placementRegistryProvider).lookup(id)?.fallbackAsset ?? p?.fallbackRef));
    final c = p?.creative != null && p!.creative!.isStillValid(service.now()) && service.adsActive() ? p.creative : null;
    final swapped = onTop && bundle is AdForgeAssetBundle && bundle.hasAd(p.assetPath!);

    Widget thumb(Widget child, String label) => Column(children: [
          ClipRRect(borderRadius: BorderRadius.circular(8), child: SizedBox(width: 56, height: 56, child: child)),
          Text(label, style: const TextStyle(fontSize: 10, color: Colors.black45)),
        ]);
    final broken = Container(color: const Color(0x11000000), child: const Icon(Icons.image_not_supported_outlined, size: 18));

    final String status;
    if (c == null) {
      status = p == null ? 'Not in the configuration: showing the original' : 'Showing the original asset (no eligible ad)';
    } else if (onTop && !swapped) {
      status = 'Ad from ${c.advertiser} on its way (the plain picture shows meanwhile)';
    } else {
      status = '${onTop ? 'Ad on top:' : 'Showing'} ${c.advertiser}${c.productName == null ? '' : ' · ${c.productName}'}${onTop ? ' (${p.render.adPosition.replaceAll('_', ' ')})' : ''}\n'
          'ad ${_short(c.creativeId)} v${c.version} · ${c.campaignStatus}${c.validUntil == null ? '' : ' until ${c.validUntil!.toLocal()}'}';
    }
    return Card(
      key: Key('diag-$id'),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          if (original != null) thumb(Image.asset(original, bundle: rootBundle, fit: BoxFit.contain, errorBuilder: (_, __, ___) => broken), 'original'),
          if (p?.isAssetSlot == true) ...[const SizedBox(width: 6), thumb(Image.asset(p!.assetPath!, fit: BoxFit.contain, errorBuilder: (_, __, ___) => broken), 'on screen')],
          if (p?.isRemoteSlot == true) thumb(Image.network(p!.assetPath!, fit: BoxFit.cover, errorBuilder: (_, __, ___) => broken), 'on screen'),
          const SizedBox(width: 12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(id, style: const TextStyle(fontWeight: FontWeight.w700, fontFamily: 'monospace', fontSize: 13)),
              const SizedBox(height: 2),
              Text(p?.isAssetSlot == true ? 'Picture in the app: ${p!.assetPath}' : p?.isRemoteSlot == true ? 'Photo from ${Uri.tryParse(p!.assetPath!)?.host ?? 'the internet'}' : 'Original: ${original ?? '—'}',
                  style: const TextStyle(fontSize: 12, color: Colors.black54), maxLines: 2, overflow: TextOverflow.ellipsis),
              const SizedBox(height: 4),
              Text(status, style: c == null ? const TextStyle(fontSize: 12) : const TextStyle(fontSize: 12, color: Color(0xFF0F7B4B), fontWeight: FontWeight.w600)),
            ]),
          ),
        ]),
      ),
    );
  }
}
