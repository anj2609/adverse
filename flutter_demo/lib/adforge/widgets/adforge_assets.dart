import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../providers.dart';

/// Puts AdForge between the app and its own pictures. Wrap the app once, and every bundled picture AdForge has made
/// an ad slot (by scanning the project zip) can show an ad, fitted to the original's exact pixels, and go back to
/// the original the moment the ad is stopped. No other code changes: the app keeps using `Image.asset` as before.
///
/// Inside an existing [ProviderScope]:
///
///     runApp(const ProviderScope(child: AdForgeAssets(child: MyApp())));
class AdForgeAssets extends ConsumerWidget {
  const AdForgeAssets({super.key, required this.child});
  final Widget child;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    ref.watch(adForgeProvider.select((_) => 0)); // starts AdForge: restore, refresh, listen for changes
    return DefaultAssetBundle(bundle: ref.watch(adForgeBundleProvider), child: child);
  }
}

/// The whole integration in one line, for apps that don't use Riverpod themselves:
///
///     runApp(const AdForgeScope(child: MyApp()));
///
/// Connection settings come from `--dart-define` (ADFORGE_URL and ADFORGE_APP_ID) unless given here.
class AdForgeScope extends StatelessWidget {
  const AdForgeScope({super.key, required this.child, this.settings});
  final Widget child;
  final AdForgeSettings? settings;

  @override
  Widget build(BuildContext context) => ProviderScope(
        overrides: [if (settings != null) adForgeSettingsProvider.overrideWithValue(settings!)],
        child: AdForgeAssets(child: child),
      );
}
