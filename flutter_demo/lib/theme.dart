import 'package:flutter/material.dart';

ThemeData focusFlowTheme() {
  const seed = Color(0xFF4F46E5);
  final scheme = ColorScheme.fromSeed(seedColor: seed);
  return ThemeData(
    colorScheme: scheme,
    useMaterial3: true,
    scaffoldBackgroundColor: const Color(0xFFF6F7FB),
    cardTheme: CardThemeData(elevation: 0, color: Colors.white, shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20), side: const BorderSide(color: Color(0xFFE5E8F2)))),
    appBarTheme: const AppBarTheme(backgroundColor: Color(0xFFF6F7FB), elevation: 0, scrolledUnderElevation: 0, centerTitle: false),
  );
}
