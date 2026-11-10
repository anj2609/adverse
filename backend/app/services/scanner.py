"""Finds the pictures in an uploaded Flutter project zip, and where the code uses them.

The zip is read in place and never extracted to disk or stored. Only the pictures' previews and the findings are kept.
Guarded against zip bombs (entry count, total size, compression ratio), hostile paths and symlinks."""
import io
import posixpath
import re
import stat
import zipfile
from dataclasses import dataclass, field

import yaml
from PIL import Image, UnidentifiedImageError

from ..errors import ApiError, bad_request
from .images import FORMAT_MAP, store_image

IMAGE_EXT = {"png", "jpg", "jpeg", "webp"}
UNSUPPORTED_EXT = {"svg": "SVG pictures can't be swapped yet (only PNG, JPEG and WebP)", "gif": "Animated or GIF pictures can't be swapped",
                   "bmp": "BMP pictures can't be swapped", "ico": "Icon files can't be swapped"}
SKIP_DIRS = {"android", "ios", "macos", "windows", "linux", "web", "build", ".dart_tool", ".git", ".idea", "test", "integration_test", "__MACOSX"}
VARIANT = re.compile(r"/(\d+(?:\.\d+)?)x/")
LITERAL = re.compile(r"""(['"])((?:(?!\1)[^\n\\]){1,300})\1""")
GENERATED = re.compile(r"\bAssets\.([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)")
SIZE = {k: re.compile(rf"\b{k}:\s*([0-9]+(?:\.[0-9]+)?)") for k in ("width", "height")}
FIT = re.compile(r"\bfit:\s*BoxFit\.(\w+)")
URL = re.compile(r"""(['"])(https?://[^'"\s]{4,1000})\1""")
IMAGE_URL = re.compile(r"\.(png|jpe?g|webp|gif|svg|avif)(\?|#|$)|^https?://[^/]*(image|img|photo|cdn|unsplash|pexels|cloudinary|imgix)", re.I)
NETWORK_IMAGE = re.compile(r"\b(Image\.network|NetworkImage|CachedNetworkImage)\b")
TITLE = re.compile(r"""\btitle:\s*(['"])([^'"\n]{1,60})\1""")
MAP_KEY = re.compile(r"""(?:['"]|\b)([A-Za-z][A-Za-z0-9_]{1,40})['"]?\s*:\s*['"]https?://""")
GENERIC = {"image", "url", "src", "photo", "imageurl", "picture", "img", "uri", "link", "href"}


def _remote_name(url: str, use: dict) -> str:
    """A readable name for a photo the app loads from a web address: the title next to it, or the name it's stored
    under in the code ('hero': 'https://...'), else its file name."""
    snippet = use.get("snippet", "")
    for rx, group in ((TITLE, 2), (MAP_KEY, 1)):
        m = rx.search(snippet)
        if m and m.group(group).strip().lower() not in GENERIC:
            return m.group(group).strip()
    stem = posixpath.splitext(posixpath.basename(url.split("?")[0].split("#")[0]))[0]
    return stem or "Photo"

MAX_ENTRIES = 50_000
MAX_TOTAL = 2 * 1024**3        # uncompressed bytes across the whole zip
MAX_RATIO = 250                # a member that inflates more than this is treated as a bomb
MAX_IMAGE = 25 * 1024**2
MAX_SOURCE = 2 * 1024**2


@dataclass
class Found:
    base: str                                   # path of the picture at 1x, relative to the project root
    variants: dict[float, zipfile.ZipInfo] = field(default_factory=dict)
    usages: list[dict] = field(default_factory=list)


def _camel(s: str) -> str:
    parts = re.split(r"[_\-\s]+", s)
    return parts[0].lower() + "".join(p[:1].upper() + p[1:] for p in parts[1:])


def _generated_name(base: str) -> str:
    """What flutter_gen calls a picture: assets/images/coffee_cup.png -> images.coffeeCup"""
    segs = base.split("/")
    if segs and segs[0] == "assets":
        segs = segs[1:]
    stem = posixpath.splitext(segs[-1])[0]
    return ".".join([_camel(s) for s in segs[:-1]] + [_camel(stem)])


def _kind(w: int, h: int, alpha: bool) -> str:
    ratio = w / h
    if max(w, h) <= 96:
        return "icon"
    if ratio >= 2.5 or ratio <= 0.4:
        return "banner"
    if alpha:
        return "object"
    if max(w, h) >= 1000:
        return "background"
    return "illustration"


def _safe(name: str) -> bool:
    return not (name.startswith("/") or "\\" in name or any(p in ("..", "") for p in name.split("/")[:-1]) or re.match(r"^[A-Za-z]:", name))


def _declared(rel: str, entries: list[str]) -> bool:
    folder = posixpath.dirname(rel) + "/"
    plain = VARIANT.sub("/", "/" + folder).lstrip("/")  # assets/images/2.0x/ -> assets/images/
    for e in entries:
        if rel == e or (e.endswith("/") and (folder == e or plain == e)):
            return True
    return False


def scan_zip(fileobj, file_name: str) -> dict:
    try:
        zf = zipfile.ZipFile(fileobj)
    except (zipfile.BadZipFile, OSError):
        raise bad_request("bad_zip", "That file is not a readable zip")
    infos = [i for i in zf.infolist() if not i.is_dir()]
    warnings: list[str] = []
    if len(infos) > MAX_ENTRIES:
        raise bad_request("zip_too_big", f"The zip has more than {MAX_ENTRIES:,} files")
    if sum(i.file_size for i in infos) > MAX_TOTAL:
        raise bad_request("zip_too_big", "The zip unpacks to more than 2 GB. Zip just the project (lib, assets, pubspec.yaml)")
    clean = []
    for i in infos:
        if not _safe(i.filename) or stat.S_ISLNK(i.external_attr >> 16):
            warnings.append(f"Ignored a suspicious entry: {i.filename[:80]}")
            continue
        if i.compress_size and i.file_size / i.compress_size > MAX_RATIO and i.file_size > 1024**2:
            warnings.append(f"Ignored an entry that inflates suspiciously: {i.filename[:80]}")
            continue
        clean.append(i)

    def read(info: zipfile.ZipInfo, cap: int) -> bytes | None:
        if info.file_size > cap:
            return None
        with zf.open(info) as f:
            data = f.read(cap + 1)
        return data if len(data) <= cap else None

    # the project root is where the shallowest Flutter pubspec.yaml sits
    root, pubspec = None, {}
    for i in sorted((i for i in clean if posixpath.basename(i.filename) == "pubspec.yaml"), key=lambda i: i.filename.count("/")):
        if set(i.filename.split("/")) & SKIP_DIRS:
            continue
        try:
            doc = yaml.safe_load(read(i, 1024**2) or b"") or {}
        except yaml.YAMLError:
            continue
        if isinstance(doc, dict) and ("flutter" in doc or "flutter" in (doc.get("dependencies") or {})):
            root, pubspec = posixpath.dirname(i.filename), doc
            break
    if root is None:
        raise bad_request("not_flutter", "No Flutter pubspec.yaml found in the zip. Zip the project folder (the one with pubspec.yaml)")
    prefix = root + "/" if root else ""
    flutter_cfg = pubspec.get("flutter") or {}
    entries = []
    for e in (flutter_cfg.get("assets") or []) if isinstance(flutter_cfg, dict) else []:
        path = e.get("path") if isinstance(e, dict) else e
        if isinstance(path, str) and not path.startswith("packages/"):
            entries.append(path.strip())
    if not entries:
        warnings.append("pubspec.yaml declares no assets, so the app can't load any bundled pictures")

    groups: dict[str, Found] = {}
    unsupported, sources = [], []
    for i in clean:
        if not i.filename.startswith(prefix):
            continue
        rel = i.filename[len(prefix):]
        if rel.split("/")[0] in SKIP_DIRS:
            continue
        ext = rel.rsplit(".", 1)[-1].lower() if "." in rel else ""
        if ext == "dart" and rel.startswith("lib/"):
            sources.append((rel, i))
        elif ext in IMAGE_EXT and _declared(rel, entries):
            m = VARIANT.search("/" + rel)
            scale = float(m.group(1)) if m else 1.0
            base = VARIANT.sub("/", "/" + rel, count=1).lstrip("/")
            groups.setdefault(base, Found(base)).variants[scale] = i
        elif ext in UNSUPPORTED_EXT and _declared(rel, entries) and not VARIANT.search("/" + rel):
            unsupported.append({"path": rel, "reason": UNSUPPORTED_EXT[ext]})

    # where the code uses each picture: full path, bare file name, or a flutter_gen accessor
    by_path = {g.base: g for g in groups.values()}
    by_file: dict[str, list[Found]] = {}
    for g in groups.values():
        by_file.setdefault(posixpath.basename(g.base), []).append(g)
    by_gen = {_generated_name(g.base): g for g in groups.values()}
    remote: dict[str, list[dict]] = {}  # pictures the code loads from the internet: found, listed, but not swappable
    network_uses = 0
    for rel, info in sources:
        raw = read(info, MAX_SOURCE)
        if raw is None:
            warnings.append(f"Skipped a very large source file: {rel}")
            continue
        text = raw.decode("utf-8", "replace")
        hits: list[tuple[int, Found]] = []
        for m in LITERAL.finditer(text):
            lit = m.group(2)
            g = by_path.get(lit) or by_path.get(VARIANT.sub("/", "/" + lit).lstrip("/"))
            if g is None:
                cands = by_file.get(posixpath.basename(lit), [])
                g = cands[0] if len(cands) == 1 else None
            if g:
                hits.append((m.start(), g))
        for m in GENERATED.finditer(text):
            g = by_gen.get(m.group(1).removesuffix(".path").removesuffix(".image").removesuffix(".provider"))
            if g:
                hits.append((m.start(), g))
        network_uses += len(NETWORK_IMAGE.findall(text))
        for m in URL.finditer(text):
            if IMAGE_URL.search(m.group(2)):
                line_no = text.count("\n", 0, m.start()) + 1
                uses = remote.setdefault(m.group(2), [])
                if len(uses) < 8:
                    uses.append({"file": rel, "line": line_no, "snippet": text.splitlines()[line_no - 1].strip()[:180]})
        for pos, g in hits:
            line_no = text.count("\n", 0, pos) + 1
            line = text.splitlines()[line_no - 1].strip() if text.splitlines() else ""
            window = text[pos: pos + 400]
            use = {"file": rel, "line": line_no, "snippet": line[:180]}
            for k, rx in SIZE.items():
                if (mm := rx.search(window)):
                    use[k] = float(mm.group(1))
            if (mm := FIT.search(window)):
                use["fit"] = mm.group(1)
            if len(g.usages) < 8 and use not in g.usages:
                g.usages.append(use)

    assets = []
    for g in sorted(groups.values(), key=lambda g: g.base):
        top_scale = max(g.variants)
        data = read(g.variants[top_scale], MAX_IMAGE)
        record = {"path": g.base, "file_name": posixpath.basename(g.base), "used": bool(g.usages), "usages": g.usages, "usage_count": len(g.usages),
                  "replaceable": True, "reason": None}
        if data is None:
            assets.append({**record, "replaceable": False, "reason": "Picture is too large to analyse"})
            continue
        try:
            img = Image.open(io.BytesIO(data))
            img.load()
        except (UnidentifiedImageError, OSError, Image.DecompressionBombError):
            assets.append({**record, "replaceable": False, "reason": "Picture can't be read"})
            continue
        variants = []
        for scale, info in sorted(g.variants.items()):
            if scale == top_scale:
                w, h = img.size
            else:
                try:
                    w, h = Image.open(io.BytesIO(read(info, MAX_IMAGE) or b"")).size
                except Exception:  # noqa: BLE001
                    continue
            variants.append({"scale": scale, "width": w, "height": h, "path": info.filename[len(prefix):]})  # the exact key the app loads
        base_w, base_h = (variants[0]["width"], variants[0]["height"]) if variants[0]["scale"] == 1.0 else (round(img.width / top_scale), round(img.height / top_scale))
        alpha = img.mode in ("RGBA", "LA") and img.getchannel("A").getextrema()[0] < 255 or (img.mode == "P" and "transparency" in img.info)
        record.update({"format": FORMAT_MAP.get(img.format or "", (img.format or "").lower()), "width": base_w, "height": base_h, "variants": variants,
                       "has_transparency": bool(alpha), "file_size": g.variants[top_scale].file_size, "kind": _kind(img.width, img.height, bool(alpha))})
        try:
            stored = store_image(data, "fallbacks")
            record["preview_key"] = stored.storage_key
            record["preview_thumb_key"] = stored.thumbnail_key
        except ApiError as e:
            record.update({"replaceable": False, "reason": e.message})
        assets.append(record)

    if remote and not network_uses:
        warnings.append("Found picture web addresses in the code but no Image.network / NetworkImage call: if the app draws them some other "
                        "way, ads on them may not show")
    remote_assets = [{"path": url, "file_name": posixpath.basename(url.split("?")[0].split("#")[0]) or url, "name": _remote_name(url, uses[0]),
                      "host": url.split("/")[2], "kind": "remote", "remote": True, "replaceable": True, "reason": None,
                      "used": True, "usages": uses, "usage_count": len(uses)}
                     for url, uses in sorted(remote.items())][:200]
    summary = {"images": len(assets), "used": sum(a["used"] for a in assets), "unused": sum(not a["used"] for a in assets),
               "not_replaceable": sum(not a["replaceable"] for a in assets) + len(unsupported), "source_files": len(sources),
               "remote": len(remote_assets)}
    return {"project_name": pubspec.get("name"),
            "assets": assets + [{**u, "replaceable": False, "used": None, "usages": []} for u in unsupported] + remote_assets,
            "summary": summary, "warnings": warnings[:50], "file_name": file_name}
