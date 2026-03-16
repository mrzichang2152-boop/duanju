from __future__ import annotations
from typing import Optional, Union
from datetime import datetime
from uuid import uuid4

from sqlalchemy import Boolean, DateTime, String
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class UserSettings(Base):
    __tablename__ = "user_settings"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    user_id: Mapped[str] = mapped_column(String(36), unique=True, index=True)
    endpoint: Mapped[str] = mapped_column(String(255), default="https://openrouter.ai/api/v1")
    api_key_encrypted: Mapped[Optional[str]] = mapped_column(String(2048), nullable=True)
    default_model_text: Mapped[str] = mapped_column(
        String(128), default="doubao-seed-2-0-pro-260215"
    )
    default_model_image: Mapped[str] = mapped_column(
        String(128), default="google/gemini-3-pro-image-preview"
    )
    default_model_video: Mapped[str] = mapped_column(String(128), default="sora2")
    allow_sync: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
