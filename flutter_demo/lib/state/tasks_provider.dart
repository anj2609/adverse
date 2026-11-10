import 'package:flutter_riverpod/flutter_riverpod.dart';

class Task {
  const Task({required this.id, required this.title, this.done = false});
  final int id;
  final String title;
  final bool done;
  Task copyWith({bool? done}) => Task(id: id, title: title, done: done ?? this.done);
}

class TasksState {
  const TasksState({required this.tasks, this.streak = 3});
  final List<Task> tasks;
  final int streak;
  int get doneCount => tasks.where((t) => t.done).length;
  double get progress => tasks.isEmpty ? 0 : doneCount / tasks.length;
}

class TasksNotifier extends Notifier<TasksState> {
  int _next = 4;

  @override
  TasksState build() => const TasksState(tasks: [
        Task(id: 1, title: 'Write the project brief'),
        Task(id: 2, title: 'Review pull requests'),
        Task(id: 3, title: 'Plan tomorrow'),
      ]);

  void add(String title) {
    final t = title.trim();
    if (t.isEmpty) return;
    state = TasksState(tasks: [...state.tasks, Task(id: _next++, title: t)], streak: state.streak);
  }

  /// Returns true when this call completed the task (so the UI can celebrate).
  bool toggle(int id) {
    var completed = false;
    state = TasksState(
      tasks: [
        for (final t in state.tasks)
          if (t.id == id) () {
            completed = !t.done;
            return t.copyWith(done: !t.done);
          }() else t,
      ],
      streak: state.streak,
    );
    return completed;
  }

  void remove(int id) => state = TasksState(tasks: state.tasks.where((t) => t.id != id).toList(), streak: state.streak);
}

final tasksProvider = NotifierProvider<TasksNotifier, TasksState>(TasksNotifier.new);
