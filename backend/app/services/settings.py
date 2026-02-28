from datetime import datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import decrypt_value, encrypt_value
from app.models.settings import UserSettings


async def get_or_create_settings(session: AsyncSession, user_id: str) -> UserSettings:
    existing = await session.scalar(select(UserSettings).where(UserSettings.user_id == user_id))
    if existing:
        return existing
    settings = UserSettings(user_id=user_id)
    session.add(settings)
    await session.commit()
    await session.refresh(settings)
    return settings


async def update_settings(
    session: AsyncSession,
    user_id: str,
    endpoint: str | None,
    api_key: str | None,
    default_model_text: str | None,
    default_model_image: str | None,
    default_model_video: str | None,
    allow_sync: bool | None,
) -> UserSettings:
    settings = await get_or_create_settings(session, user_id)
    if endpoint is not None:
        settings.endpoint = endpoint
    if api_key:
        settings.api_key_encrypted = encrypt_value(api_key)
    if default_model_text is not None:
        settings.default_model_text = default_model_text
    if default_model_image is not None:
        settings.default_model_image = default_model_image
    if default_model_video is not None:
        settings.default_model_video = default_model_video
    if allow_sync is not None:
        settings.allow_sync = allow_sync
    settings.updated_at = datetime.utcnow()
    await session.commit()
    await session.refresh(settings)
    return settings


async def get_api_key(session: AsyncSession, user_id: str) -> str | None:
    settings = await get_or_create_settings(session, user_id)
    if not settings.api_key_encrypted:
        return None
    return decrypt_value(settings.api_key_encrypted)
