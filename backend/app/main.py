from contextlib import asynccontextmanager
import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import assets, auth, final, health, linkapi, projects, script, segments, settings as settings_api, templates
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
app.include_router(auth.router, prefix="/auth", tags=["auth"])
app.include_router(projects.router, prefix="/projects", tags=["projects"])
app.include_router(script.router, prefix="/projects", tags=["script"])
app.include_router(assets.router, prefix="/projects", tags=["assets"])
app.include_router(segments.router, prefix="/projects", tags=["segments"])
app.include_router(final.router, prefix="/projects", tags=["final"])
app.include_router(settings_api.router, prefix="/settings", tags=["settings"])
app.include_router(linkapi.router, prefix="/linkapi", tags=["linkapi"])
app.include_router(templates.router, prefix="/projects", tags=["templates"])
