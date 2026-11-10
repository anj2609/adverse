import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from starlette.middleware.base import BaseHTTPMiddleware

from . import clock, errors
from .config import get_settings
from .db import SessionLocal
from .routers import applications, audit, auth, campaigns, creatives, media, runtime
from .services.runtime import reconcile_all

log = logging.getLogger("adforge")
OPEN_PREFIXES = ("/api/v1/runtime/", "/media/")


class OpenReadCors(BaseHTTPMiddleware):
    """Runtime config and images are read by apps running anywhere (including Flutter web), so those two prefixes
    allow any origin. They carry no cookies or admin rights. Everything else is limited to CORS_ORIGINS."""

    async def dispatch(self, request: Request, call_next):
        if not request.url.path.startswith(OPEN_PREFIXES):
            return await call_next(request)
        headers = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "X-AdForge-Key, If-None-Match, Content-Type",
                   "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Expose-Headers": "ETag, X-Config-Version, Cache-Control", "Access-Control-Max-Age": "600"}
        if request.method == "OPTIONS":
            return Response(status_code=204, headers=headers)
        response = await call_next(request)
        response.headers.update(headers)
        return response


async def _reconcile_loop():
    while True:
        await asyncio.sleep(get_settings().reconcile_interval_seconds)
        try:
            with SessionLocal() as db:
                reconcile_all(db, clock.now())
        except Exception:  # noqa: BLE001  (keep the loop alive; the next tick retries)
            log.exception("reconcile failed")


@asynccontextmanager
async def lifespan(_: FastAPI):
    with SessionLocal() as db:
        reconcile_all(db, clock.now())
    task = asyncio.create_task(_reconcile_loop())
    yield
    task.cancel()


def create_app() -> FastAPI:
    app = FastAPI(title="AdForge", version="1.0.0", lifespan=lifespan,
                  description="Application-agnostic advertising asset management. Management API: /api/v1/admin (bearer token). "
                              "Runtime API: /api/v1/runtime (per-application runtime key).")
    errors.install(app)
    app.add_middleware(CORSMiddleware, allow_origins=get_settings().cors_origin_list, allow_methods=["*"], allow_headers=["*"], expose_headers=["ETag", "Content-Disposition", "X-AdForge-Report"])
    app.add_middleware(OpenReadCors)
    for r in (auth.router, applications.router, creatives.router, campaigns.router, audit.router, runtime.router, media.router):
        app.include_router(r)

    @app.get("/health", tags=["meta"])
    def health():
        return {"status": "ok"}

    return app


app = create_app()
