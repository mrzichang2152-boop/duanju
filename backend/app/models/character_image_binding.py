from __future__ import annotations

from datetime import datetime
from uuid import uuid4

from sqlalchemy import DateTime, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class CharacterImageBinding(Base):
    __tablename__ = "character_image_bindings"
    __table_args__ = (
        UniqueConstraint("project_id", "image_url", name="uq_character_image_bindings_project_image"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    project_id: Mapped[str] = mapped_column(String(36), index=True)
    image_url: Mapped[str] = mapped_column(Text)
    base_character_name: Mapped[str] = mapped_column(String(255), index=True)
    asset_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    source_image_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
