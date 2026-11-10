import 'dart:typed_data';
import 'dart:ui' as ui;

/// An ad to draw on top of one of the app's pictures: the ad image, where it goes and how big it is.
class AdOverlay {
  const AdOverlay({required this.ad, required this.position, required this.size, required this.id, this.area = 'whole',
      this.x = 0.5, this.y = 0.5, this.radius = 0});

  /// The ad image as uploaded (already downloaded and checked against its published hash).
  final Uint8List ad;

  /// top_left, top_right, bottom_left, bottom_right, center, bottom_strip, or custom (wherever it was dragged: [x], [y]).
  final String position;

  /// custom: the ad's centre as a share of the picture's width and height. The ad is kept fully inside the picture.
  final double x, y;

  /// Rounded corners as a share of the ad's shorter side: 0 square, 0.5 fully round.
  final double radius;

  /// The ad's width as a share of the picture's width (bottom_strip: the strip's height as a share of the picture's height).
  final double size;

  /// `whole`: place it within the whole picture. `safe`: within the centre part that stays visible however the app
  /// crops the picture (from a 4:5 box to a 2:1 banner), for photos the app shows cropped.
  final String area;

  /// Identifies this ad and its placement, so a changed spot or size is noticed.
  final String id;
}

/// The part of a picture that stays visible whether the app shows it whole or crops it to any box from 4:5 to 2:1.
ui.Rect safeArea(ui.Size picture) {
  final w = picture.width < picture.height * 0.8 ? picture.width : picture.height * 0.8;
  final h = picture.height < picture.width / 2 ? picture.height : picture.width / 2;
  return ui.Rect.fromLTWH((picture.width - w) / 2, (picture.height - h) / 2, w, h);
}

/// Where the ad goes on a picture of [picture] size. The ad keeps its own shape and is never stretched.
/// The dashboard preview uses the same rule.
ui.Rect adRect(ui.Size picture, ui.Size ad, String position, double size, {String area = 'whole', double x = 0.5, double y = 0.5}) {
  if (area == 'safe' && picture.width > 0 && picture.height > 0) {
    final s = safeArea(picture);
    return adRect(s.size, ad, position, size, x: x, y: y).shift(s.topLeft);
  }
  final w = picture.width, h = picture.height;
  if (w <= 0 || h <= 0 || ad.width <= 0 || ad.height <= 0) return ui.Rect.zero;
  final aspect = ad.width / ad.height;
  if (position == 'bottom_strip') {
    final stripH = h * size.clamp(0.05, 1.0);
    var bw = w, bh = w / aspect;
    if (bh > stripH) {
      bh = stripH;
      bw = bh * aspect;
    }
    return ui.Rect.fromLTWH((w - bw) / 2, h - bh, bw, bh);
  }
  if (position == 'custom') {
    var bw = w * size.clamp(0.05, 1.0), bh = bw / aspect;
    if (bh > h) {
      bh = h;
      bw = bh * aspect;
    }
    final left = (w * x.clamp(0.0, 1.0) - bw / 2).clamp(0.0, w - bw);
    final top = (h * y.clamp(0.0, 1.0) - bh / 2).clamp(0.0, h - bh);
    return ui.Rect.fromLTWH(left, top, bw, bh);
  }
  final margin = w * 0.03;
  var bw = w * size.clamp(0.05, 1.0), bh = bw / aspect;
  final maxH = h - 2 * margin, maxW = w - 2 * margin;
  if (bh > maxH) {
    bh = maxH;
    bw = bh * aspect;
  }
  if (bw > maxW) {
    bw = maxW;
    bh = bw / aspect;
  }
  final left = switch (position) { 'top_left' || 'bottom_left' => margin, 'center' => (w - bw) / 2, _ => w - margin - bw };
  final top = switch (position) { 'top_left' || 'top_right' => margin, 'center' => (h - bh) / 2, _ => h - margin - bh };
  return ui.Rect.fromLTWH(left, top, bw, bh);
}

Future<ui.Image> decodeImage(Uint8List bytes) async {
  final codec = await ui.instantiateImageCodecFromBuffer(await ui.ImmutableBuffer.fromUint8List(bytes));
  return (await codec.getNextFrame()).image;
}

/// The picture with the ad drawn on top. Same pixel size as the picture, so the app's layout never moves.
Future<ui.Image> drawOnTop(ui.Image picture, ui.Image ad, String position, double size,
    {String area = 'whole', double x = 0.5, double y = 0.5, double radius = 0}) async {
  final recorder = ui.PictureRecorder();
  final canvas = ui.Canvas(recorder);
  final paint = ui.Paint()..filterQuality = ui.FilterQuality.medium;
  canvas.drawImage(picture, ui.Offset.zero, paint);
  final dst = adRect(ui.Size(picture.width.toDouble(), picture.height.toDouble()), ui.Size(ad.width.toDouble(), ad.height.toDouble()), position, size,
      area: area, x: x, y: y);
  final corner = radius.clamp(0.0, 0.5) * dst.shortestSide;
  if (corner > 0) {
    canvas.save();
    canvas.clipRRect(ui.RRect.fromRectAndRadius(dst, ui.Radius.circular(corner)), doAntiAlias: true);
  }
  canvas.drawImageRect(ad, ui.Rect.fromLTWH(0, 0, ad.width.toDouble(), ad.height.toDouble()), dst, paint);
  if (corner > 0) canvas.restore();
  return recorder.endRecording().toImage(picture.width, picture.height);
}

/// [drawOnTop] with everything an [AdOverlay] says.
Future<ui.Image> drawOverlay(ui.Image picture, AdOverlay o) async =>
    drawOnTop(picture, await decodeImage(o.ad), o.position, o.size, area: o.area, x: o.x, y: o.y, radius: o.radius);

/// [drawOnTop] for encoded pictures: what the asset bundle hands the app instead of the plain picture.
Future<Uint8List> drawOnTopBytes(Uint8List picture, AdOverlay o) async {
  final combined = await drawOverlay(await decodeImage(picture), o);
  final png = await combined.toByteData(format: ui.ImageByteFormat.png);
  return png!.buffer.asUint8List();
}
