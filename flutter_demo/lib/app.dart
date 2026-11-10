import 'package:flutter/material.dart';

import 'features/dashboard/dashboard_screen.dart';
import 'features/diagnostics/diagnostics_screen.dart';
import 'features/home/home_screen.dart';
import 'theme.dart';

class FocusFlowApp extends StatelessWidget {
  const FocusFlowApp({super.key});

  @override
  Widget build(BuildContext context) => MaterialApp(title: 'FocusFlow', debugShowCheckedModeBanner: false, theme: focusFlowTheme(), home: const Shell());
}

class Shell extends StatefulWidget {
  const Shell({super.key});

  @override
  State<Shell> createState() => _ShellState();
}

class _ShellState extends State<Shell> {
  int _index = 0;
  static const _pages = [HomeScreen(), DashboardScreen(), DiagnosticsScreen()];

  @override
  Widget build(BuildContext context) => Scaffold(
        body: IndexedStack(index: _index, children: _pages),
        bottomNavigationBar: NavigationBar(
          selectedIndex: _index,
          onDestinationSelected: (i) => setState(() => _index = i),
          destinations: const [
            NavigationDestination(icon: Icon(Icons.home_outlined), selectedIcon: Icon(Icons.home), label: 'Home'),
            NavigationDestination(icon: Icon(Icons.insights_outlined), selectedIcon: Icon(Icons.insights), label: 'Dashboard'),
            NavigationDestination(icon: Icon(Icons.bug_report_outlined), selectedIcon: Icon(Icons.bug_report), label: 'Diagnostics'),
          ],
        ),
      );
}
