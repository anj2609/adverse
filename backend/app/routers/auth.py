from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..errors import ApiError
from ..models import User
from ..schemas import LoginIn, TokenOut, UserOut
from ..security import create_token, current_user, login_limiter, verify_password
from ..services import audit

router = APIRouter(prefix="/api/v1/auth", tags=["auth"])


@router.post("/login", response_model=TokenOut, dependencies=[Depends(login_limiter)])
def login(body: LoginIn, db: Session = Depends(get_db)):
    user = db.scalar(select(User).where(User.email == body.email.strip().lower()))
    # same message and same work whether the email exists or not
    ok = verify_password(body.password, user.password_hash if user else "scrypt$00$00") and user is not None and user.is_active
    if not ok:
        raise ApiError(401, "bad_credentials", "Wrong email or password")
    audit.record(db, user.email, "user.login", "user", user.id)
    db.commit()
    return TokenOut(access_token=create_token(user), user=UserOut.model_validate(user))


@router.get("/me", response_model=UserOut)
def me(user: User = Depends(current_user)):
    return user
