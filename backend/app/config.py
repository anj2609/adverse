from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    """All configuration comes from the environment (or a .env file). See .env.example."""

    model_config = SettingsConfigDict(env_file=(ROOT / ".env", ROOT / "backend" / ".env"), extra="ignore")

    database_url: str = "postgresql+psycopg://postgres@localhost:5432/adforge"
    secret_key: str = "change-me-in-production"
    jwt_ttl_minutes: int = 480
    admin_email: str = "admin@adforge.local"
    admin_password: str = "adforge-admin"

    storage_backend: str = "local"
    storage_path: str = str(ROOT / "storage")
    public_base_url: str | None = None  # used in asset URLs; defaults to the request's own origin
    cors_origins: str = "http://localhost:3000"

    max_upload_bytes: int = 8 * 1024 * 1024
    max_scan_bytes: int = 300 * 1024 * 1024  # an app's project zip (source and assets, not build output)
    # AdForge's app files, added to an app by "Download app ready for ads" (the folder developers would otherwise copy)
    adforge_sdk_path: str = str(ROOT / "flutter_demo" / "lib" / "adforge")
    max_image_side: int = 4096
    min_image_side: int = 16

    rate_limit_runtime_per_min: int = 120
    rate_limit_login_per_min: int = 10
    reconcile_interval_seconds: int = 15
    runtime_ttl_seconds: int = 60
    # Apps identify themselves by application ID alone. Turn on to also require each app's runtime key (X-AdForge-Key).
    runtime_require_key: bool = False
    runtime_long_poll_seconds: int = 25  # how long a waiting app's request may be held open for an instant change
    runtime_max_stale_seconds: int = 6 * 3600  # an app that can't reach AdForge for this long stops showing ads

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
