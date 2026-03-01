from contextlib import asynccontextmanager
import logging

from fastapi import FastAPI, APIRouter
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

app.include_router(api_router, prefix="/api")
app.include_router(api_router)

