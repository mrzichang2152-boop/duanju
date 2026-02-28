from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import create_access_token, hash_password, verify_password
from app.models.user import User


async def register_user(session: AsyncSession, email: str, password: str) -> str:
    existing = await session.scalar(select(User).where(User.email == email))
    if existing:
        raise ValueError("邮箱已注册")
    user = User(email=email, password_hash=hash_password(password))
    session.add(user)
    await session.commit()
    return create_access_token(user.id)


async def login_user(session: AsyncSession, email: str, password: str) -> str:
    user = await session.scalar(select(User).where(User.email == email))
    if not user or not verify_password(password, user.password_hash):
        raise ValueError("账号或密码错误")
    return create_access_token(user.id)
