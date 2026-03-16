from __future__ import annotations
from typing import Optional, Union, Literal, List
from pydantic import BaseModel


class CharacterProfile(BaseModel):
    name: str
    bio: str


class ScriptParseResponse(BaseModel):
    theme: str
    characters: List[CharacterProfile]
    episodes: List[str]


class ScriptRequest(BaseModel):
    content: Optional[str] = None
    thinking: Optional[str] = None
    storyboard: Optional[str] = None
    outline: Optional[str] = None
    episodes: Optional[List[dict]] = None


class ScriptResponse(BaseModel):
    id: Optional[str] = None
    project_id: str
    content: str
    thinking: Optional[str] = None
    storyboard: Optional[str] = None
    outline: Optional[str] = None
    episodes: Optional[List[dict]] = None
    version: Optional[int] = None
    is_active: Optional[bool] = None
    created_at: Optional[str] = None


class ScriptValidationResponse(BaseModel):
    valid: bool
    missing: list[str]
    warnings: list[str]


class ScriptValidationRequest(BaseModel):
    content: str
    model: Optional[str] = None


class ScriptGenerateRequest(BaseModel):
    mode: Literal["format", "complete", "revise", "extract_resources", "generate_storyboard", "step1_modify", "step2_modify", "suggestion_paid", "suggestion_traffic", "continuation", "continuation_paid", "continuation_traffic", "step0_generate", "step0_continue", "step0_modify", "extract_outline", "split_script"]
    content: str
    model: Optional[str] = None
    instruction: Optional[str] = None


class ScriptGenerateResponse(BaseModel):
    content: str


class ScriptHistoryItem(BaseModel):
    id: str
    project_id: str
    content: str
    thinking: Optional[str] = None
    storyboard: Optional[str] = None
    outline: Optional[str] = None
    episodes: Optional[List[dict]] = None
    version: int
    is_active: bool
    created_at: str

    class Config:
        from_attributes = True


class ScriptHistoryResponse(BaseModel):
    items: list[ScriptHistoryItem]

