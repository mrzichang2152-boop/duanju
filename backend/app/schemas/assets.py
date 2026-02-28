from pydantic import BaseModel


class AssetVersionResponse(BaseModel):
    id: str
    image_url: str
    prompt: str | None
    is_selected: bool


class AssetResponse(BaseModel):
    id: str
    type: str
    name: str
    description: str | None
    versions: list[AssetVersionResponse]


class AssetGenerateRequest(BaseModel):
    prompt: str | None = None
    model: str | None = None
    options: dict[str, object] | None = None
    ref_image_url: str | None = None


class AssetSelectRequest(BaseModel):
    version_id: str
