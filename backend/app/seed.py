"""Creates the first administrator. Run once after migrating:  python -m app.seed"""
import sys

from sqlalchemy import select

from .config import get_settings
from .db import SessionLocal
from .models import User
from .security import hash_password


def ensure_user(db, email: str, name: str, role: str, password: str) -> User:
    user = db.scalar(select(User).where(User.email == email.lower()))
    if user is None:
        user = User(email=email.lower(), name=name, role=role, password_hash=hash_password(password))
        db.add(user)
        db.commit()
    return user


def main() -> None:
    s = get_settings()
    with SessionLocal() as db:
        ensure_user(db, s.admin_email, "Administrator", "admin", s.admin_password)
        if "--demo-users" in sys.argv:
            ensure_user(db, "editor@adforge.local", "Edith Editor", "editor", s.admin_password)
            ensure_user(db, "viewer@adforge.local", "Victor Viewer", "viewer", s.admin_password)
    print(f"Administrator ready: {s.admin_email}")


if __name__ == "__main__":
    main()
