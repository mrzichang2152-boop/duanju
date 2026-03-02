from __future__ import annotations
from typing import Optional, Union
from pydantic import BaseModel


class AssetVersionResponse(BaseModel):
    id: str
    image_url: str
    prompt: Optional[str]
    is_selected: bool


class AssetResponse(BaseModel):
    id: str
    type: str
    name: str
    description: Optional[str]
    versions: list[AssetVersionResponse]


class AssetGenerateRequest(BaseModel):
    prompt: Optional[str] = None
    model: Optional[str] = None
    options: Optional[dict[str, object]] = None
    ref_image_url: Optional[str] = None


class AssetSelectRequest(BaseModel):
    version_id: str
