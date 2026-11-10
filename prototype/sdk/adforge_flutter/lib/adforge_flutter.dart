/// Shows AdForge campaign assets inside a Flutter app.
///
/// ```dart
/// Future<void> main() async {
///   await AdForge.init(baseUrl: 'https://ads.example.com', appKey: 'afk_...');
///   runApp(AdForge.wrap(const MyApp()));
/// }
/// ```
library;

export 'src/adforge.dart' show AdForge;
export 'src/bundle.dart' show AdForgeAssetBundle, adforgeFileName;
export 'src/placement.dart' show AdForgePlacement;
export 'src/spot.dart' show AdForgeSpot;
