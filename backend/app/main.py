from contextlib import asynccontextmanager
import logging
import shutil

from fastapi import FastAPI, APIRouter
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
import os

from app.api import assets, auth, eleven_labs, final, fish_audio, health, linkapi, projects, script, segments, settings as settings_api, templates, voices
from app.core.config import settings as app_settings
from app.core.db import engine
from app.models import Base


@asynccontextmanager
async def lifespan(_: FastAPI):
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield


app = FastAPI(title="Short Play Generation API", lifespan=lifespan)
logging.basicConfig(level=logging.INFO)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin.strip() for origin in app_settings.cors_origins.split(",") if origin],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(health.router)

api_router = APIRouter()
api_router.include_router(auth.router, prefix="/auth", tags=["auth"])
api_router.include_router(projects.router, prefix="/projects", tags=["projects"])
api_router.include_router(script.router, prefix="/projects", tags=["script"])
api_router.include_router(assets.router, prefix="/projects", tags=["assets"])
api_router.include_router(segments.router, prefix="/projects", tags=["segments"])
api_router.include_router(final.router, prefix="/projects", tags=["final"])
api_router.include_router(settings_api.router, prefix="/settings", tags=["settings"])
api_router.include_router(linkapi.router, prefix="/linkapi", tags=["linkapi"])
api_router.include_router(templates.router, prefix="/projects", tags=["templates"])
api_router.include_router(eleven_labs.router, prefix="/eleven-labs", tags=["eleven-labs"])
api_router.include_router(fish_audio.router, prefix="/fish-audio", tags=["fish-audio"])
api_router.include_router(voices.router, prefix="/projects", tags=["voices"])

app.include_router(api_router, prefix="/api")
app.include_router(api_router)

# Mount static files
static_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)), "static")
os.makedirs(static_dir, exist_ok=True)
legacy_audio_pipeline_dir = os.path.join(os.path.dirname(__file__), "static", "audio_pipeline")
audio_pipeline_dir = os.path.join(static_dir, "audio_pipeline")
if os.path.exists(legacy_audio_pipeline_dir):
    os.makedirs(audio_pipeline_dir, exist_ok=True)
    for name in os.listdir(legacy_audio_pipeline_dir):
        src = os.path.join(legacy_audio_pipeline_dir, name)
        dst = os.path.join(audio_pipeline_dir, name)
        if os.path.exists(dst):
            continue
        if os.path.isdir(src):
            shutil.copytree(src, dst, dirs_exist_ok=True)
        else:
            shutil.copy2(src, dst)
app.mount("/static", StaticFiles(directory=static_dir), name="static")
