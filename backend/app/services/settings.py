from __future__ import annotations
from typing import Optional, Union
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import decrypt_value, encrypt_value
from app.models.settings import UserSettings


def _normalize_image_model(model: Optional[str]) -> Optional[str]:
    if model is None:
        return None
    text = str(model).strip()
    if not text:
        return text
    lower = text.lower().replace("_", "-")
    if lower in {"nanobanana2", "nano-banana2", "nanobanana-2"}:
        return "nano-banana-2"
    if lower.startswith("nano-banana-2-4k") or lower in {"nano-banana2-4k", "nanobanana2-4k"}:
        return "nano-banana-2"
    return text


async def get_or_create_settings(session: AsyncSession, user_id: str) -> UserSettings:
    existing = await session.scalar(select(UserSettings).where(UserSettings.user_id == user_id))
    if existing:
        normalized = _normalize_image_model(existing.default_model_image)
        if normalized is not None and normalized != existing.default_model_image:
            existing.default_model_image = normalized
            existing.updated_at = datetime.utcnow()
            await session.commit()
            await session.refresh(existing)
        return existing
    settings = UserSettings(user_id=user_id)
    session.add(settings)
    await session.commit()
    await session.refresh(settings)
    return settings


async def update_settings(
    session: AsyncSession,
    user_id: str,
    endpoint: Optional[str],
    api_key: Optional[str],
    default_model_text: Optional[str],
    default_model_image: Optional[str],
    default_model_video: Optional[str],
    allow_sync: Optional[bool],
) -> UserSettings:
    settings = await get_or_create_settings(session, user_id)
    if endpoint is not None:
        settings.endpoint = endpoint
    if api_key:
        settings.api_key_encrypted = encrypt_value(api_key)
    if default_model_text is not None:
        settings.default_model_text = default_model_text
    if default_model_image is not None:
        settings.default_model_image = _normalize_image_model(default_model_image) or "nano-banana-2"
    if default_model_video is not None:
        settings.default_model_video = default_model_video
    if allow_sync is not None:
        settings.allow_sync = allow_sync
    settings.updated_at = datetime.utcnow()
    await session.commit()
    await session.refresh(settings)
    return settings


async def get_api_key(session: AsyncSession, user_id: str) -> Optional[str]:
    settings = await get_or_create_settings(session, user_id)
    if not settings.api_key_encrypted:
        return None
    return decrypt_value(settings.api_key_encrypted)
