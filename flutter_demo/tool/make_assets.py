"""Draws the demo app's own (fallback) artwork and fictional sample 'branded' creatives. Run: python tool/make_assets.py
The brand here (BrewCo, Lumen) is invented for the demo. Real campaigns use images the advertiser supplies and approves."""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT, SAMPLES = Path("assets/images"), Path("samples")
S = 2  # draw at 2x then downsample for smooth edges


def font(size):
    return ImageFont.load_default(size=size)


def canvas(w, h, bg=(0, 0, 0, 0)):
    # opaque artwork is drawn in RGB so translucent shapes blend; cut-outs stay RGBA with a transparent background
    return Image.new("RGB" if bg[3:] == (255,) else "RGBA", (w * S, h * S), bg[:3] if bg[3:] == (255,) else bg)


def save(img, path, w, h, rgb=False):
    img = img.resize((w, h), Image.LANCZOS)
    (img.convert("RGB") if rgb else img).save(path)


def cup(body, rim, steam=True, label=None):
    w = h = 512
    im = canvas(w, h)
    d = ImageDraw.Draw(im, "RGBA")
    k = S
    d.ellipse([90 * k, 420 * k, 420 * k, 470 * k], fill=(0, 0, 0, 40))                       # shadow
    d.rounded_rectangle([110 * k, 190 * k, 380 * k, 440 * k], radius=40 * k, fill=body)       # cup
    d.arc([330 * k, 230 * k, 450 * k, 360 * k], 270, 90, fill=body, width=26 * k)             # handle
    d.rounded_rectangle([100 * k, 170 * k, 390 * k, 215 * k], radius=22 * k, fill=rim)        # rim
    d.ellipse([125 * k, 178 * k, 365 * k, 208 * k], fill=(60, 35, 20, 255))                   # coffee
    if steam:
        for x in (190, 245, 300):
            d.arc([x * k, 80 * k, (x + 40) * k, 170 * k], 90, 270, fill=(150, 150, 160, 200), width=8 * k)
    if label:
        d.text((245 * k, 320 * k), label, font=font(46 * k), fill=(255, 255, 255, 255), anchor="mm")
    return im, w, h


def lamp(shade, base, label=None):
    w, h = 480, 600
    im = canvas(w, h)
    d, k = ImageDraw.Draw(im, "RGBA"), S
    d.ellipse([110 * k, 540 * k, 370 * k, 585 * k], fill=(0, 0, 0, 40))
    d.rounded_rectangle([140 * k, 520 * k, 340 * k, 560 * k], radius=18 * k, fill=base)
    d.rectangle([228 * k, 260 * k, 252 * k, 530 * k], fill=base)
    d.polygon([(120 * k, 270 * k), (360 * k, 270 * k), (300 * k, 70 * k), (180 * k, 70 * k)], fill=shade)
    d.ellipse([200 * k, 255 * k, 280 * k, 290 * k], fill=(255, 236, 160, 255))
    if label:
        d.text((240 * k, 190 * k), label, font=font(40 * k), fill=(255, 255, 255, 255), anchor="mm")
    return im, w, h


def scene(title, c1, c2, w=900, h=600, badge=None):
    im = canvas(w, h, c1 + (255,))
    d, k = ImageDraw.Draw(im, "RGBA"), S
    for i in range(h * k):
        t = i / (h * k)
        d.line([(0, i), (w * k, i)], fill=tuple(int(c1[j] * (1 - t) + c2[j] * t) for j in range(3)) + (255,))
    for cx, cy, r in ((150, 120, 70), (760, 450, 110), (700, 90, 40)):
        d.ellipse([(cx - r) * k, (cy - r) * k, (cx + r) * k, (cy + r) * k], fill=(255, 255, 255, 40))
    d.ellipse([(w / 2 - 120) * k, (h / 2 - 150) * k, (w / 2 + 120) * k, (h / 2 + 90) * k], fill=(255, 255, 255, 235))
    d.line([((w / 2 - 55) * k, (h / 2 - 25) * k), ((w / 2 - 12) * k, (h / 2 + 22) * k), ((w / 2 + 62) * k, (h / 2 - 70) * k)], fill=c1 + (255,), width=26 * k, joint="curve")
    d.text((w / 2 * k, (h - 110) * k), title, font=font(60 * k), fill=(255, 255, 255, 255), anchor="mm")
    if badge:
        d.text((w / 2 * k, (h - 50) * k), badge, font=font(32 * k), fill=(255, 255, 255, 220), anchor="mm")
    return im, w, h


def banner(title, sub, c1, c2, cta):
    w, h = 900, 300
    im, _, _ = scene("", c1, c2, w, h)
    d, k = ImageDraw.Draw(im, "RGBA"), S
    for i in range(w * k):
        t = i / (w * k)
        d.line([(i, 0), (i, h * k)], fill=tuple(int(c1[j] * (1 - t) + c2[j] * t) for j in range(3)) + (255,))
    d.ellipse([650 * k, -80 * k, 980 * k, 250 * k], fill=(255, 255, 255, 36))
    d.text((48 * k, 100 * k), title, font=font(64 * k), fill=(255, 255, 255, 255), anchor="lm")
    d.text((48 * k, 165 * k), sub, font=font(30 * k), fill=(255, 255, 255, 220), anchor="lm")
    d.rounded_rectangle([48 * k, 205 * k, 300 * k, 262 * k], radius=28 * k, fill=(255, 255, 255, 255))
    d.text((174 * k, 234 * k), cta, font=font(28 * k), fill=c1 + (255,), anchor="mm")
    return im, w, h


# The app's own artwork (what ships inside the app and shows when no creative is eligible).
for name, (im, w, h), rgb in [
    ("coffee_cup", cup((236, 232, 224, 255), (250, 248, 243, 255)), False),
    ("desk_lamp", lamp((99, 102, 241, 255), (71, 85, 105, 255)), False),
    ("completion_illustration", scene("Task complete!", (79, 70, 229), (139, 92, 246)), True),
    ("promo_banner", banner("FocusFlow Pro", "Unlimited focus sessions", (79, 70, 229), (124, 58, 237), "Try free"), True),
]:
    save(im, OUT / f"{name}.png", w, h, rgb)

# Fictional sample brands for the demo flow: what an advertiser would upload.
for name, (im, w, h), rgb in [
    ("brewco_travel_cup", cup((194, 65, 12, 255), (251, 146, 60, 255), label="BrewCo"), False),
    ("lumen_desk_lamp", lamp((14, 165, 233, 255), (30, 41, 59, 255), label="Lumen"), False),
    ("brewco_celebration", scene("Well brewed!", (194, 65, 12), (234, 88, 12), badge="BrewCo celebrates with you"), True),
    ("brewco_banner", banner("BrewCo", "Fuel your next focus session", (194, 65, 12), (251, 146, 60), "Order now"), True),
]:
    save(im, SAMPLES / f"{name}.png", w, h, rgb)
print("assets written")
