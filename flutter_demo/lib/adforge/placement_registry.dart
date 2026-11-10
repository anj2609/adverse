/// The placements this app implements. Each one is a spot where the app has chosen to draw an [AdForgeImage].
/// An ID here must also be registered in AdForge (Applications → Add placement); AdForge can only change what the app already supports.
class PlacementSpec {
  const PlacementSpec({required this.id, required this.name, required this.fallbackAsset, this.defaultAspect});

  /// Stable ID, unique within this application, e.g. `home.coffee_cup`.
  final String id;
  final String name;

  /// The app's own bundled picture. Always available, never overwritten, shown whenever no creative is eligible.
  final String fallbackAsset;
  final double? defaultAspect;
}

class PlacementRegistry {
  const PlacementRegistry(this.specs);
  final List<PlacementSpec> specs;

  PlacementSpec? lookup(String id) {
    for (final s in specs) {
      if (s.id == id) return s;
    }
    return null;
  }

  PlacementSpec require(String id) =>
      lookup(id) ?? (throw ArgumentError('Placement "$id" is not in this app\'s placement registry. Add it to PlacementRegistry first.'));

  Iterable<String> get ids => specs.map((s) => s.id);
}
