from pydantic import BaseModel


class TemplateResponse(BaseModel):
    id: str
    kind: str
    name: str
    content: str
    tags: list[str] = []


class TemplateCreateRequest(BaseModel):
    kind: str
    name: str
    content: str
    tags: list[str] = []


class TemplateUpdateRequest(BaseModel):
    name: str
    content: str
    tags: list[str] = []
