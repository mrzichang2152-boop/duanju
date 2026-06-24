from __future__ import annotations

from typing import Optional

from pydantic import BaseModel


class UsageSummaryTotalsResponse(BaseModel):
    account_count: int
    project_count: int
    text_characters: int
    image_count: int
    video_count: int
    video_seconds: float
    estimated_video_count: int


class UsageSummaryAccountResponse(BaseModel):
    user_id: str
    email: str
    created_at: Optional[str] = None
    project_count: int
    text_characters: int
    image_count: int
    video_count: int
    video_seconds: float
    estimated_video_count: int


class UsageSelfResponse(BaseModel):
    generated_at: str
    email: str
    account: UsageSummaryAccountResponse
    notes: list[str]


class UsageSummaryResponse(BaseModel):
    generated_at: str
    admin_email: str
    totals: UsageSummaryTotalsResponse
    accounts: list[UsageSummaryAccountResponse]
    notes: list[str]
