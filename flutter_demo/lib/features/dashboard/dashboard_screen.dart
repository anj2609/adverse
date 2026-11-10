import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../state/tasks_provider.dart';

class DashboardScreen extends ConsumerWidget {
  const DashboardScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final tasks = ref.watch(tasksProvider);
    final theme = Theme.of(context);
    Widget stat(String label, String value, IconData icon) => Expanded(
          child: Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Icon(icon, color: theme.colorScheme.primary),
                const SizedBox(height: 10),
                Text(value, style: theme.textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w700)),
                Text(label, style: theme.textTheme.bodySmall?.copyWith(color: Colors.black54)),
              ]),
            ),
          ),
        );
    return Scaffold(
      appBar: AppBar(title: const Text('Dashboard', style: TextStyle(fontWeight: FontWeight.w700))),
      body: ListView(padding: const EdgeInsets.fromLTRB(16, 4, 16, 32), children: [
        // The app's own banner. If AdForge puts an ad here, it arrives fitted to this picture's pixels: same box.
        ClipRRect(
          borderRadius: BorderRadius.circular(16),
          child: AspectRatio(aspectRatio: 3, child: Image.asset('assets/images/promo_banner.png', fit: BoxFit.cover)),
        ),
        const SizedBox(height: 16),
        Row(children: [stat('Tasks done', '${tasks.doneCount}', Icons.task_alt), stat('Day streak', '${tasks.streak}', Icons.local_fire_department_outlined)]),
        Row(children: [stat('Open tasks', '${tasks.tasks.length - tasks.doneCount}', Icons.pending_actions_outlined), stat('Focus score', '${(tasks.progress * 100).round()}%', Icons.speed_outlined)]),
      ]),
    );
  }
}
