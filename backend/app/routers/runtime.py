import asyncio
import time

from fastapi import APIRouter, Depends, Header, Query, Request, Response
from sqlalchemy import select
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from .. import clock
from ..config import get_settings
from ..db import SessionLocal, get_db
from ..errors import ApiError
from ..models import Application
from ..schemas import RuntimeConfig
from ..security import runtime_app, runtime_limiter
from ..services.runtime import build_core, reconcile_application, render_payload
from .deps import base_url

router = APIRouter(prefix="/api/v1/runtime", tags=["runtime"], dependencies=[Depends(runtime_limiter)])


def _matches(if_none_match: str | None, version: int) -> bool:
    return bool(if_none_match) and f'"{version}"' in [t.strip().removeprefix("W/") for t in if_none_match.split(",")]


def _current_version(app_id: str) -> int | None:
    with SessionLocal() as s:  # a short session per check, so a waiting app never holds a pooled connection
        return s.scalar(select(Application.config_version).where(Application.id == app_id))


def _answer(request: Request, response: Response, app: Application, db: Session, if_none_match: str | None):
    now = clock.now()
    reconcile_application(db, app, now)
    app.last_seen_at, app.last_seen_version = now, app.config_version
    s = get_settings()
    payload = render_payload(build_core(db, app, now), app, base_url(request), now, s.runtime_ttl_seconds, s.runtime_max_stale_seconds)
    db.commit()
    etag = f'"{app.config_version}"'
    headers = {"ETag": etag, "Cache-Control": f"private, max-age={payload['ttl_seconds']}", "X-Config-Version": str(app.config_version)}
    if _matches(if_none_match, app.config_version):
        return Response(status_code=304, headers=headers)
    response.headers.update(headers)
    return payload


@router.get("/{application_id}/config", response_model=RuntimeConfig,
            responses={304: {"description": "Config unchanged since If-None-Match"}, 401: {"description": "Bad application ID or key"}})
async def get_config(request: Request, response: Response, app: Application = Depends(runtime_app), db: Session = Depends(get_db),
                     if_none_match: str | None = Header(None),
                     wait: int = Query(0, ge=0, le=60, description="With If-None-Match: hold the request up to this many seconds "
                                                                   "(capped by the server) and answer as soon as the config changes")):
    """What this application should show right now. Identified by its application ID (and, only when the server sets
    RUNTIME_REQUIRE_KEY, its runtime key in X-AdForge-Key). Read-only: it answers for this one application and nothing
    else, with no administrative data. Eligibility is decided here, never by the client.

    When ads are stopped for the application the answer is still a normal config (`ads_enabled: false`, no creatives),
    so an app that already shows an ad drops it on its next fetch instead of keeping its last-known-good config."""
    if wait and if_none_match:
        app_id = app.id
        await run_in_threadpool(db.rollback)  # end the auth query's transaction before waiting
        deadline = time.monotonic() + min(wait, get_settings().runtime_long_poll_seconds)
        while True:
            version = await run_in_threadpool(_current_version, app_id)
            if version is None:  # the application was deleted while the app was waiting: say so now, so it drops its ads
                raise (ApiError(401, "invalid_runtime_credentials", "Unknown application or invalid runtime key") if get_settings().runtime_require_key
                       else ApiError(404, "unknown_application", "No application with that ID is registered"))
            if time.monotonic() >= deadline or not _matches(if_none_match, version):
                break
            await asyncio.sleep(1)
    return await run_in_threadpool(_answer, request, response, app, db, if_none_match)
