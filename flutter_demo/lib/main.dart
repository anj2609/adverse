import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'adforge/adforge.dart';
import 'app.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  // The whole AdForge integration: the app's own pictures now load through AdForge, which swaps in the ads an
  // administrator assigns (and drops them the moment they are stopped). The rest of the app is plain Flutter.
  runApp(const ProviderScope(child: AdForgeAssets(child: FocusFlowApp())));
}
