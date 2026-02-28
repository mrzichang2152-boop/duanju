from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user_id
from app.core.db import get_db
from app.schemas.common import StatusResponse
from app.services.projects import get_project

router = APIRouter()


@router.post("/{project_id}/merge", response_model=StatusResponse)
async def merge_final(
    project_id: str,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
) -> StatusResponse:
    project = await get_project(db, user_id, project_id)
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    return StatusResponse(status="queued")
