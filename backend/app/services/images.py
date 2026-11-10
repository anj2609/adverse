"""Validates uploads by actually decoding them (never by trusting the file name or declared type)."""
import hashlib
import io
from dataclasses import dataclass

from PIL import Image, UnidentifiedImageError

from ..config import get_settings
from ..errors import bad_request
from .storage import get_storage

Image.MAX_IMAGE_PIXELS = 4096 * 4096 * 2  # refuse decompression bombs before decoding
FORMAT_MAP = {"PNG": "png", "JPEG": "jpeg", "WEBP": "webp"}
THUMB_SIDE = 320


@dataclass
class StoredImage:
    storage_key: str
    thumbnail_key: str
    file_format: str
    width: int
    height: int
    file_size: int
    has_transparency: bool
    sha256: str


def _has_alpha(img: Image.Image) -> bool:
    if img.mode in ("RGBA", "LA"):
        lo, _ = img.getchannel("A").getextrema()
        return lo < 255
    if img.mode == "P" and "transparency" in img.info:
        return True
    return False


def inspect_image(data: bytes) -> tuple[str, int, int, bool]:
    s = get_settings()
    if not data:
        raise bad_request("empty_file", "The file is empty")
    if len(data) > s.max_upload_bytes:
        raise bad_request("file_too_large", f"The file is larger than {s.max_upload_bytes // (1024 * 1024)} MB")
    try:
        probe = Image.open(io.BytesIO(data))
        fmt = FORMAT_MAP.get(probe.format or "")
        probe.verify()
        img = Image.open(io.BytesIO(data))
        img.load()
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError, SyntaxError, ValueError):
        raise bad_request("invalid_image", "That file is not a readable image")
    if fmt is None:
        raise bad_request("unsupported_format", "Only PNG, JPEG and WebP images are accepted")
    if getattr(img, "n_frames", 1) > 1:
        raise bad_request("animated_image", "Animated images are not supported")
    w, h = img.size
    if min(w, h) < s.min_image_side or max(w, h) > s.max_image_side:
        raise bad_request("bad_dimensions", f"Image sides must be between {s.min_image_side} and {s.max_image_side} pixels (got {w}×{h})")
    return fmt, w, h, _has_alpha(img)


def store_image(data: bytes, folder: str) -> StoredImage:
    fmt, w, h, alpha = inspect_image(data)
    digest = hashlib.sha256(data).hexdigest()
    storage = get_storage()
    key = f"{folder}/{digest}.{fmt}"
    thumb_key = f"{folder}/{digest}.thumb.webp"
    storage.save(key, data)
    if not storage.exists(thumb_key):
        img = Image.open(io.BytesIO(data))
        img = img.convert("RGBA") if alpha or img.mode in ("P", "LA") else img.convert("RGB")
        img.thumbnail((THUMB_SIDE, THUMB_SIDE))
        out = io.BytesIO()
        img.save(out, "WEBP", quality=82)
        storage.save(thumb_key, out.getvalue())
    return StoredImage(key, thumb_key, fmt, w, h, len(data), alpha, digest)
