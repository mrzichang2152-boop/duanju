from __future__ import annotations
from typing import Optional, Union
from pydantic import BaseModel


class SettingsResponse(BaseModel):
    endpoint: str
    default_model_text: str
    default_model_image: str
    default_model_video: str
    allow_sync: bool
    has_key: bool


class SettingsUpdate(BaseModel):
    endpoint: Optional[str] = None
    api_key: Optional[str] = None
    default_model_text: Optional[str] = None
    default_model_image: Optional[str] = None
    default_model_video: Optional[str] = None
    allow_sync: Optional[bool] = None
