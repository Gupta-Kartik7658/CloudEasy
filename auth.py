import os
import uuid
from typing import Optional
from dotenv import load_dotenv
from fastapi import Depends, Request
from fastapi.security import OAuth2PasswordRequestForm
from pydantic import field_validator
from fastapi_users import BaseUserManager, FastAPIUsers, UUIDIDMixin, schemas
from fastapi_users.authentication import (
    AuthenticationBackend,
    BearerTransport,
    JWTStrategy,
)
from fastapi_users.db import SQLAlchemyUserDatabase
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_async_db
from models import User

load_dotenv()

# Fallback secret ensures out-of-the-box transparent auth even without a .env file
SECRET = os.environ.get("SECRET_KEY") or "cloudeasy-transparent-auth-secret-key-2026"


def _normalize_email(value: str) -> str:
    if not isinstance(value, str):
        raise ValueError("Email must be a string")
    normalized = value.strip().lower()
    if not normalized:
        raise ValueError("Email cannot be empty")
    return normalized


class UserRead(schemas.BaseUser[uuid.UUID]):
    email: str


class UserCreate(schemas.BaseUserCreate):
    email: str

    @field_validator("email", mode="before")
    @classmethod
    def normalize_email(cls, v: str) -> str:
        return _normalize_email(v)


class UserUpdate(schemas.BaseUserUpdate):
    email: Optional[str] = None

    @field_validator("email", mode="before")
    @classmethod
    def normalize_email(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        return _normalize_email(v)


class UserManager(UUIDIDMixin, BaseUserManager[User, uuid.UUID]):
    reset_password_token_secret = SECRET
    verification_token_secret = SECRET

    async def authenticate(
        self, credentials: OAuth2PasswordRequestForm
    ) -> Optional[User]:
        credentials.username = credentials.username.strip().lower()
        return await super().authenticate(credentials)

    async def on_after_register(self, user: User, request: Request | None = None):
        print(f"User {user.id} ({user.email}) has registered.")


async def get_user_db(session: AsyncSession = Depends(get_async_db)):
    yield SQLAlchemyUserDatabase(session, User)


async def get_user_manager(user_db: SQLAlchemyUserDatabase = Depends(get_user_db)):
    yield UserManager(user_db)


# --- Bearer Token Transport ---
bearer_transport = BearerTransport(tokenUrl="auth/jwt/login")


def get_jwt_strategy() -> JWTStrategy:
    return JWTStrategy(secret=SECRET, lifetime_seconds=604800)  # 7 days expiry


# --- Authentication Backend ---
auth_backend = AuthenticationBackend(
    name="jwt",
    transport=bearer_transport,
    get_strategy=get_jwt_strategy,
)

# --- FastAPIUsers ---
fastapi_users = FastAPIUsers[User, uuid.UUID](get_user_manager, [auth_backend])

# --- Dependency ---
current_active_user = fastapi_users.current_user(active=True)