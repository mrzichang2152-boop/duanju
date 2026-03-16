from __future__ import annotations
from datetime import datetime
from uuid import uuid4

from sqlalchemy import DateTime, String, JSON
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class CharacterVoice(Base):
    __tablename__ = "character_voices"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    project_id: Mapped[str] = mapped_column(String(36), index=True)
    character_name: Mapped[str] = mapped_column(String(255))
    voice_id: Mapped[str] = mapped_column(String(64))  # Fish Audio model ID
    voice_type: Mapped[str] = mapped_column(String(32), default="PRESET")  # PRESET, CUSTOM, CLONE
    preview_url: Mapped[str] = mapped_column(String(1024), nullable=True)
    config: Mapped[dict] = mapped_column(JSON, default={})
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
