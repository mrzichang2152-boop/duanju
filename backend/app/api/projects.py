from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user_id
from app.core.db import get_db
from app.schemas.project import ProjectCreate, ProjectResponse
from app.services.projects import create_project, get_project, list_projects

router = APIRouter()


@router.get("", response_model=list[ProjectResponse])
async def fetch_projects(
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
) -> list[ProjectResponse]:
    projects = await list_projects(db, user_id)
    return [ProjectResponse(id=item.id, name=item.name, status=item.status) for item in projects]


@router.post("", response_model=ProjectResponse)
async def create_new_project(
    payload: ProjectCreate,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
) -> ProjectResponse:
    project = await create_project(db, user_id, payload.name)
    return ProjectResponse(id=project.id, name=project.name, status=project.status)


@router.get("/{project_id}", response_model=ProjectResponse)
async def fetch_project(
    project_id: str,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
) -> ProjectResponse:
    project = await get_project(db, user_id, project_id)
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    return ProjectResponse(id=project.id, name=project.name, status=project.status)
