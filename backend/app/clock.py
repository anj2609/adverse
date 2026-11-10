"""One place to ask "what time is it", so tests can move time without sleeping."""
from datetime import datetime, timezone

_fixed: datetime | None = None


def now() -> datetime:
    return _fixed or datetime.now(timezone.utc)


def freeze(at: datetime | None) -> None:
    global _fixed
    _fixed = at
