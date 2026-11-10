import os
import subprocess
import sys
from pathlib import Path

import psycopg
import pytest

ROOT = Path(__file__).resolve().parents[1]
ADMIN_URL = os.environ["DATABASE_URL"].replace("+psycopg", "").rsplit("/", 1)[0] + "/postgres"
SCRATCH = "adforge_migration_check"


def test_migrations_build_the_same_schema_as_the_models():
    if not os.environ["DATABASE_URL"].startswith("postgresql"):
        pytest.skip("migration check needs PostgreSQL")
    with psycopg.connect(ADMIN_URL, autocommit=True) as conn:
        conn.execute(f"DROP DATABASE IF EXISTS {SCRATCH}")
        conn.execute(f"CREATE DATABASE {SCRATCH}")
    url = os.environ["DATABASE_URL"].rsplit("/", 1)[0] + f"/{SCRATCH}"
    env = {**os.environ, "DATABASE_URL": url}
    up = subprocess.run([sys.executable, "-m", "alembic", "upgrade", "head"], cwd=ROOT, env=env, capture_output=True, text=True)
    assert up.returncode == 0, up.stderr
    # alembic's own autogenerate must find nothing left to do: migrations and models agree
    check = subprocess.run([sys.executable, "-m", "alembic", "check"], cwd=ROOT, env=env, capture_output=True, text=True)
    assert check.returncode == 0, check.stdout + check.stderr
    down = subprocess.run([sys.executable, "-m", "alembic", "downgrade", "base"], cwd=ROOT, env=env, capture_output=True, text=True)
    assert down.returncode == 0, down.stderr
    with psycopg.connect(ADMIN_URL, autocommit=True) as conn:
        conn.execute(f"DROP DATABASE {SCRATCH}")
