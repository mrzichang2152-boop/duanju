from typing import Literal

from pydantic import BaseModel


class ScriptRequest(BaseModel):
    content: str


class ScriptResponse(BaseModel):
    project_id: str
    content: str


class ScriptValidationResponse(BaseModel):
    valid: bool
    missing: list[str]
    warnings: list[str]


class ScriptValidationRequest(BaseModel):
    content: str
    model: str | None = None


class ScriptGenerateRequest(BaseModel):
    mode: Literal["format", "complete", "revise", "extract_resources", "generate_storyboard", "step1_modify", "step2_modify", "suggestion_paid", "suggestion_traffic"]
    content: str
    model: str | None = None
    instruction: str | None = None


class ScriptGenerateResponse(BaseModel):
    content: str
