from pydantic_settings import BaseSettings, SettingsConfigDict
from pathlib import Path


class Settings(BaseSettings):
    database_url: str = "sqlite+aiosqlite:///./backend/app.db"
    secret_key: str = "change-me"
    access_token_expire_minutes: int = 60 * 24
    cors_origins: str = "http://localhost:3000,http://localhost:3002"
    fish_audio_api_key: str = ""
    elevenlabs_api_key: str = ""
    openrouter_api_key: str = ""
    foursapi_api_key: str = ""
    suchuang_api_key: str = ""
    grsai_api_key: str = ""
    ark_api_key: str = ""
    volcengine_ark_api_key: str = ""

    # 腾讯云 COS（可选）：配齐后用户生成的图片/视频等可上传 COS 并返回公网 URL
    tencent_cos_secret_id: str = ""
    tencent_cos_secret_key: str = ""
    tencent_cos_region: str = ""
    tencent_cos_bucket: str = ""
    tencent_cos_prefix: str = "duanju"
    # 若绑定自定义域名/CDN，填写可公网访问的根 URL（无尾斜杠），否则使用默认 bucket.cos.region.myqcloud.com
    tencent_cos_public_base_url: str = ""

    model_config = SettingsConfigDict(
        env_file=str(Path(__file__).resolve().parents[2] / ".env"),
        env_prefix="",
        extra="ignore",
    )


settings = Settings()
