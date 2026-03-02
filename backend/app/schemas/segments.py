from __future__ import annotations
from typing import Optional, Union
from pydantic import BaseModel


class SegmentVersionResponse(BaseModel):
    id: str
    video_url: str
    prompt: Optional[str]
    status: str
    is_selected: bool


class SegmentResponse(BaseModel):
    id: str
    order_index: int
    text_content: str
    status: str
    versions: list[SegmentVersionResponse]


class SegmentGenerateRequest(BaseModel):
    segment_id: Optional[str] = None
    prompt: Optional[str] = None
    model: Optional[str] = None
    options: Optional[dict[str, object]] = None


class SegmentSelectRequest(BaseModel):
    version_id: str
