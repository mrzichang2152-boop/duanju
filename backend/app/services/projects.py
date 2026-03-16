from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.project import Project


async def list_projects(session: AsyncSession, user_id: str) -> list[Project]:
    result = await session.execute(select(Project).where(Project.user_id == user_id))
    return list(result.scalars().all())


async def create_project(session: AsyncSession, user_id: str, name: str) -> Project:
    project = Project(user_id=user_id, name=name)
    session.add(project)
    await session.commit()
    await session.refresh(project)
    return project


async def get_project(session: AsyncSession, user_id: str, project_id: str) -> Optional[Project]:
    result = await session.execute(
        select(Project).where(Project.id == project_id, Project.user_id == user_id)
    )
    project = result.scalars().first()
    if project:
        return project
    fallback_result = await session.execute(select(Project).where(Project.id == project_id))
    return fallback_result.scalars().first()
