from pydantic import BaseModel


class SettingsResponse(BaseModel):
    endpoint: str
    default_model_text: str
    default_model_image: str
    default_model_video: str
    allow_sync: bool
    has_key: bool


class SettingsUpdate(BaseModel):
    endpoint: str | None = None
    api_key: str | None = None
    default_model_text: str | None = None
    default_model_image: str | None = None
    default_model_video: str | None = None
    allow_sync: bool | None = None
