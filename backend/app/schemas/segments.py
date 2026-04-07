from __future__ import annotations
from typing import Optional, Union
from pydantic import BaseModel


class SegmentVersionResponse(BaseModel):
    id: str
    video_url: str
    prompt: Optional[str]
    status: str
    task_id: Optional[str] = None
    task_status_msg: Optional[str] = None
    is_selected: bool


class SegmentResponse(BaseModel):
    id: str
    order_index: int
    text_content: str
    status: str
    task_status: Optional[str] = None
    task_id: Optional[str] = None
    versions: list[SegmentVersionResponse]


class SegmentGenerateRequest(BaseModel):
    segment_id: Optional[str] = None
    prompt: Optional[str] = None
    model: Optional[str] = None
    options: Optional[dict[str, object]] = None


class SegmentSelectRequest(BaseModel):
    version_id: str


class SegmentFrameGenerateRequest(BaseModel):
    prompt: str
    references: Optional[list[str]] = None
    frame_type: Optional[str] = "first"
    aspect_ratio: Optional[str] = "16:9"
    model: Optional[str] = None


class SegmentFrameGenerateResponse(BaseModel):
    image_url: str


class SegmentFrameDeleteRequest(BaseModel):
    image_url: str
