import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../adforge/adforge.dart';
import '../../state/tasks_provider.dart';

class HomeScreen extends ConsumerStatefulWidget {
  const HomeScreen({super.key});

  @override
  ConsumerState<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends ConsumerState<HomeScreen> {
  final _controller = TextEditingController();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _celebrate() => showDialog<void>(
        context: context,
        builder: (_) => Dialog(
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(24)),
          clipBehavior: Clip.antiAlias,
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Image.asset('assets/images/completion_illustration.png', width: 320, height: 213, fit: BoxFit.cover),
            Padding(
              padding: const EdgeInsets.all(20),
              child: Column(children: [
                Text('Nice work!', style: Theme.of(context).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w700)),
                const SizedBox(height: 4),
                const Text('One more task done.'),
                const SizedBox(height: 12),
                FilledButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Keep going')),
              ]),
            ),
          ]),
        ),
      );

  @override
  Widget build(BuildContext context) {
    final tasks = ref.watch(tasksProvider);
    final notifier = ref.read(tasksProvider.notifier);
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('FocusFlow', style: TextStyle(fontWeight: FontWeight.w700))),
      body: RefreshIndicator(
        onRefresh: () async {
          final msg = await ref.read(adForgeProvider.notifier).refresh();
          if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
        },
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.fromLTRB(16, 4, 16, 32),
          children: [
            Text('Good morning', style: theme.textTheme.bodyMedium?.copyWith(color: Colors.black54)),
            Text("Today's focus", style: theme.textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w700)),
            const SizedBox(height: 16),
            // The desk. Ordinary pictures: AdForge found them by scanning the project and can swap them for ads.
            Container(
              height: 190,
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(24),
                gradient: const LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [Color(0xFFEEF0FF), Color(0xFFDDE1F7)]),
              ),
              child: Stack(children: [
                Positioned(left: 0, right: 0, bottom: 0, height: 38, child: Container(decoration: const BoxDecoration(color: Color(0xFFB8A48C), borderRadius: BorderRadius.vertical(bottom: Radius.circular(24))))),
                Positioned(left: 28, bottom: 26, child: Image.asset('assets/images/desk_lamp.png', width: 112, height: 140, alignment: Alignment.bottomCenter)),
                Positioned(right: 36, bottom: 24, child: Image.asset('assets/images/coffee_cup.png', width: 100, height: 100, alignment: Alignment.bottomCenter)),
              ]),
            ),
            const SizedBox(height: 20),
            Row(children: [
              Expanded(child: Text('${tasks.doneCount} of ${tasks.tasks.length} done', style: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w600))),
              SizedBox(width: 90, child: LinearProgressIndicator(value: tasks.progress, borderRadius: BorderRadius.circular(8), minHeight: 8)),
            ]),
            const SizedBox(height: 8),
            for (final t in tasks.tasks)
              Card(
                margin: const EdgeInsets.only(top: 8),
                child: ListTile(
                  key: ValueKey('task-${t.id}'),
                  leading: Checkbox(
                    value: t.done,
                    shape: const CircleBorder(),
                    onChanged: (_) {
                      if (notifier.toggle(t.id)) _celebrate();
                    },
                  ),
                  title: Text(t.title, style: TextStyle(decoration: t.done ? TextDecoration.lineThrough : null, color: t.done ? Colors.black45 : null)),
                  trailing: IconButton(icon: const Icon(Icons.close, size: 18), tooltip: 'Remove', onPressed: () => notifier.remove(t.id)),
                ),
              ),
            const SizedBox(height: 12),
            Row(children: [
              Expanded(
                child: TextField(
                  controller: _controller,
                  decoration: InputDecoration(hintText: 'Add a task', filled: true, fillColor: Colors.white, border: OutlineInputBorder(borderRadius: BorderRadius.circular(14), borderSide: BorderSide.none)),
                  onSubmitted: (v) { notifier.add(v); _controller.clear(); },
                ),
              ),
              const SizedBox(width: 8),
              IconButton.filled(tooltip: 'Add task', icon: const Icon(Icons.add), onPressed: () { notifier.add(_controller.text); _controller.clear(); }),
            ]),
          ],
        ),
      ),
    );
  }
}
