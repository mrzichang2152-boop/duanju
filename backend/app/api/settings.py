from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user_id
from app.core.db import get_db
from app.schemas.settings import SettingsResponse, SettingsUpdate
from app.services.settings import get_or_create_settings, update_settings

router = APIRouter()


@router.get("", response_model=SettingsResponse)
async def fetch_settings(
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
) -> SettingsResponse:
    settings = await get_or_create_settings(db, user_id)
    return SettingsResponse(
        endpoint=settings.endpoint,
        default_model_text=settings.default_model_text,
        default_model_image=settings.default_model_image,
        default_model_video=settings.default_model_video,
        allow_sync=settings.allow_sync,
        has_key=bool(settings.api_key_encrypted),
    )


@router.put("", response_model=SettingsResponse)
async def save_settings(
    payload: SettingsUpdate,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
) -> SettingsResponse:
    settings = await update_settings(
        db,
        user_id,
        payload.endpoint,
        payload.api_key,
        payload.default_model_text,
        payload.default_model_image,
        payload.default_model_video,
        payload.allow_sync,
    )
    return SettingsResponse(
        endpoint=settings.endpoint,
        default_model_text=settings.default_model_text,
        default_model_image=settings.default_model_image,
        default_model_video=settings.default_model_video,
        allow_sync=settings.allow_sync,
        has_key=bool(settings.api_key_encrypted),
    )
