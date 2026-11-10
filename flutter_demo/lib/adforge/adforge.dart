/// AdForge integration. Everything under lib/adforge is app-agnostic and can later be lifted into a package.
///
/// Two ways to show ads. Asset slots: wrap the app once in [AdForgeScope] (or [AdForgeAssets]) and every bundled
/// picture AdForge made a slot can be swapped, with no per-picture code. Widget placements: put an [AdForgeImage]
/// where you want explicit control (and an "Ad" label); list those in a [PlacementRegistry].
library;

export 'ad_overlay.dart';
export 'adforge_client.dart';
export 'adforge_service.dart';
export 'asset_bundle.dart';
export 'asset_cache.dart';
export 'config_store.dart';
export 'errors.dart';
export 'logger.dart';
export 'models/runtime_config.dart';
export 'placement_registry.dart';
export 'providers.dart';
export 'widgets/adforge_assets.dart';
export 'widgets/adforge_image.dart';
