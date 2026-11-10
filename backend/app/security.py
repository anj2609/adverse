import hashlib
import hmac
import secrets
import time
from collections import defaultdict, deque

import jwt
from fastapi import Depends, Header, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.orm import Session

from . import clock
from .config import get_settings
from .db import get_db
from .errors import ApiError
from .models import Application, User

_bearer = HTTPBearer(auto_error=False)
RANK = {"viewer": 0, "editor": 1, "admin": 2}


# ---------- passwords and tokens ----------
def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1, dklen=32)
    return f"scrypt${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        _, salt, digest = stored.split("$")
        got = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=2**14, r=8, p=1, dklen=32)
        return hmac.compare_digest(got, bytes.fromhex(digest))
    except ValueError:
        return False


def create_token(user: User) -> str:
    s = get_settings()
    now = int(clock.now().timestamp())
    return jwt.encode({"sub": user.id, "role": user.role, "exp": now + s.jwt_ttl_minutes * 60}, s.secret_key, algorithm="HS256")


def current_user(creds: HTTPAuthorizationCredentials | None = Depends(_bearer), db: Session = Depends(get_db)) -> User:
    unauthorized = ApiError(401, "unauthorized", "Please sign in", headers={"WWW-Authenticate": "Bearer"})
    if creds is None:
        raise unauthorized
    try:
        # expiry is checked against our own clock (see clock.py) rather than the library's
        claims = jwt.decode(creds.credentials, get_settings().secret_key, algorithms=["HS256"], options={"verify_exp": False, "require": ["exp", "sub"]})
    except jwt.PyJWTError:
        raise unauthorized
    if claims["exp"] < clock.now().timestamp():
        raise unauthorized
    user = db.get(User, claims["sub"])
    if user is None or not user.is_active:
        raise unauthorized
    return user


def require(role: str):
    """Dependency: the signed-in user must have at least this role (viewer < editor < admin)."""
    def dep(user: User = Depends(current_user)) -> User:
        if RANK[user.role] < RANK[role]:
            raise ApiError(403, "forbidden", f"This needs the {role} role")
        return user
    return dep


# ---------- runtime credentials ----------
def new_runtime_key() -> tuple[str, str, str]:
    key = "afk_" + secrets.token_urlsafe(24)
    return key, hashlib.sha256(key.encode()).hexdigest(), key[:10]


def runtime_app(application_id: str, x_adforge_key: str | None = Header(None), db: Session = Depends(get_db)) -> Application:
    """Which application is asking. By default its public ID is enough: the runtime config is read-only, holds no
    administrative data, and only says what that app would show anyway (and requests are rate limited).

    With RUNTIME_REQUIRE_KEY on, the app's runtime key must match too, with one answer for every failure so nobody
    can probe which application IDs exist."""
    app = db.scalar(select(Application).where(Application.app_key == application_id))
    if not get_settings().runtime_require_key:
        if app is None:
            raise ApiError(404, "unknown_application", "No application with that ID is registered")
        return app
    denied = ApiError(401, "invalid_runtime_credentials", "Unknown application or invalid runtime key")
    supplied = hashlib.sha256((x_adforge_key or "").encode()).hexdigest()
    if app is None or not x_adforge_key or not hmac.compare_digest(supplied, app.runtime_key_hash):
        raise denied
    return app


# ---------- rate limiting ----------
class RateLimiter:
    """Sliding one-minute window per client. In-memory: fine for one process; use a shared store when scaling out."""

    def __init__(self, scope: str, limit_getter):
        self.scope, self.limit_getter = scope, limit_getter
        self.hits: dict[str, deque] = defaultdict(deque)

    def __call__(self, request: Request) -> None:
        limit = self.limit_getter()
        if limit <= 0:
            return
        who = f"{request.client.host if request.client else 'unknown'}"
        now = time.monotonic()
        q = self.hits[who]
        while q and now - q[0] > 60:
            q.popleft()
        if len(q) >= limit:
            raise ApiError(429, "rate_limited", "Too many requests, slow down", headers={"Retry-After": str(int(60 - (now - q[0])) + 1)})
        q.append(now)

    def reset(self) -> None:
        self.hits.clear()


login_limiter = RateLimiter("login", lambda: get_settings().rate_limit_login_per_min)
runtime_limiter = RateLimiter("runtime", lambda: get_settings().rate_limit_runtime_per_min)
