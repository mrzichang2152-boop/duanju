from typing import Literal

from pydantic import BaseModel


class ScriptRequest(BaseModel):
    content: str


class ScriptResponse(BaseModel):
    id: str | None = None
    project_id: str
    content: str
    version: int | None = None
    is_active: bool | None = None
    created_at: str | None = None


class ScriptValidationResponse(BaseModel):
    valid: bool
    missing: list[str]
    warnings: list[str]


class ScriptValidationRequest(BaseModel):
    content: str
    model: str | None = None


class ScriptGenerateRequest(BaseModel):
    mode: Literal["format", "complete", "revise", "extract_resources", "generate_storyboard", "step1_modify", "step2_modify", "suggestion_paid", "suggestion_traffic", "continuation", "continuation_paid", "continuation_traffic"]
    content: str
    model: str | None = None
    instruction: str | None = None


class ScriptGenerateResponse(BaseModel):
    content: str


class ScriptHistoryItem(BaseModel):
    id: str
    project_id: str
    content: str
    version: int
    is_active: bool
    created_at: str

    class Config:
        from_attributes = True


class ScriptHistoryResponse(BaseModel):
    items: list[ScriptHistoryItem]

