from pydantic_settings import BaseSettings, SettingsConfigDict
from pathlib import Path


class Settings(BaseSettings):
    database_url: str = "sqlite+aiosqlite:///./backend/app.db"
    secret_key: str = "change-me"
    access_token_expire_minutes: int = 60 * 24
    cors_origins: str = "http://localhost:3000,http://localhost:3002"
    fish_audio_api_key: str = ""

    model_config = SettingsConfigDict(
        env_file=str(Path(__file__).resolve().parents[2] / ".env"),
        env_prefix="",
        extra="ignore",
    )


settings = Settings()
