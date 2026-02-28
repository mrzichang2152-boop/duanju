from pydantic import BaseModel


class SegmentVersionResponse(BaseModel):
    id: str
    video_url: str
    prompt: str | None
    status: str
    is_selected: bool


class SegmentResponse(BaseModel):
    id: str
    order_index: int
    text_content: str
    status: str
    versions: list[SegmentVersionResponse]


class SegmentGenerateRequest(BaseModel):
    segment_id: str | None = None
    prompt: str | None = None
    model: str | None = None
    options: dict[str, object] | None = None


class SegmentSelectRequest(BaseModel):
    version_id: str
