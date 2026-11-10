import 'dart:async';

import 'package:flutter/widgets.dart';

import 'adforge.dart';
import 'spot.dart';

/// Marks a spot in the app where AdForge may show a campaign picture.
///
/// While no campaign is live, [child] (the app's own picture) is shown. When one is, its picture
/// is drawn instead, tapping opens the advertiser's page, and an impression is reported once the
/// picture has been at least half on screen, in front, for a full second.
///
/// ```dart
/// AdForgePlacement(
///   spot: 'home_banner',
///   child: Image.asset('assets/images/home_banner.png'),
/// )
/// ```
///
/// Use this for spots marked "widget" in the dashboard, and for any spot where you want tap and
/// visibility to be measured exactly. Spots marked "asset" also work without it (see `AdForge.wrap`),
/// but then taps are not counted.
class AdForgePlacement extends StatefulWidget {
  const AdForgePlacement({super.key, required this.spot, required this.child});

  /// The spot's key in the AdForge dashboard.
  final String spot;

  /// What to show when there is no campaign picture.
  final Widget child;

  @override
  State<AdForgePlacement> createState() => _AdForgePlacementState();
}

class _AdForgePlacementState extends State<AdForgePlacement> {
  static const _step = Duration(milliseconds: 250);
  Timer? _timer;
  int _visibleMs = 0;
  String? _countedToken;

  @override
  void initState() {
    super.initState();
    _timer = Timer.periodic(_step, (_) => _tick());
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  void _tick() {
    if (!AdForge.isInitialized || !mounted) return;
    final ad = AdForge.instance;
    final spot = ad.spot(widget.spot);
    if (spot == null || _countedToken == spot.token) {
      _visibleMs = 0;
      return;
    }
    _visibleMs = _isVisible(ad) ? _visibleMs + _step.inMilliseconds : 0;
    if (_visibleMs >= 1000) {
      _countedToken = spot.token;
      ad.recordImpression(spot, viewableMs: _visibleMs);
    }
  }

  /// At least half the picture is inside the screen and inside any scroll view around it,
  /// this page is the top one, tabs are not hidden, and the app is in front.
  bool _isVisible(AdForge ad) {
    if (!ad.inForeground) return false;
    if (!TickerMode.valuesOf(context).enabled) return false;
    if (ModalRoute.of(context)?.isCurrent == false) return false;
    final box = context.findRenderObject();
    if (box is! RenderBox || !box.attached || !box.hasSize || box.size.isEmpty) return false;
    var rect = box.localToGlobal(Offset.zero) & box.size;
    final view = View.maybeOf(context);
    if (view != null) rect = rect.intersect(Offset.zero & (view.physicalSize / view.devicePixelRatio));
    final scroller = Scrollable.maybeOf(context)?.context.findRenderObject();
    if (scroller is RenderBox && scroller.hasSize) {
      rect = rect.intersect(scroller.localToGlobal(Offset.zero) & scroller.size);
    }
    if (rect.isEmpty) return false;
    return rect.width * rect.height >= box.size.width * box.size.height * 0.5;
  }

  @override
  Widget build(BuildContext context) {
    if (!AdForge.isInitialized) return widget.child;
    final ad = AdForge.instance;
    return ListenableBuilder(
      listenable: ad,
      builder: (context, _) {
        final AdForgeSpot? spot = ad.spot(widget.spot);
        if (spot == null) return widget.child;
        Widget image = Image.memory(spot.bytes!, fit: spot.fit, gaplessPlayback: true, width: double.infinity, height: double.infinity);
        if (spot.clickUrl != null) {
          image = GestureDetector(behavior: HitTestBehavior.opaque, onTap: () => ad.openClick(spot), child: image);
        }
        return image;
      },
    );
  }
}
