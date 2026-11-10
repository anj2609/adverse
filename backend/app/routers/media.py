from fastapi import APIRouter
from fastapi.responses import Response

from ..services.storage import CONTENT_TYPES, get_storage

router = APIRouter(tags=["media"])


@router.get("/media/{folder}/{filename}")
def media(folder: str, filename: str):
    """Serves stored images. Keys are validated against a strict pattern inside the storage layer, so no path a
    client sends can escape the storage root."""
    key = f"{folder}/{filename}"
    data = get_storage().read(key)
    ext = filename.rsplit(".", 1)[-1]
    return Response(data, media_type=CONTENT_TYPES.get(ext, "application/octet-stream"),
                    headers={"Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff"})
