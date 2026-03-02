from __future__ import annotations
from typing import Optional, Union
import json

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.prompt_template import PromptTemplate


async def list_templates(
    session: AsyncSession, project_id: str, kind: Optional[str] = None
) -> list[PromptTemplate]:
    statement = select(PromptTemplate).where(PromptTemplate.project_id == project_id)
    if kind:
        statement = statement.where(PromptTemplate.kind == kind)
    result = await session.execute(statement)
    return list(result.scalars().all())


async def create_template(
    session: AsyncSession, project_id: str, kind: str, name: str, content: str, tags: list[str]
) -> PromptTemplate:
    template = PromptTemplate(
        project_id=project_id,
        kind=kind,
        name=name,
        content=content,
        tags=json.dumps(tags, ensure_ascii=False) if tags else None,
    )
    session.add(template)
    await session.commit()
    await session.refresh(template)
    return template


async def delete_template(session: AsyncSession, project_id: str, template_id: str) -> bool:
    template = await session.scalar(
        select(PromptTemplate).where(
            PromptTemplate.id == template_id, PromptTemplate.project_id == project_id
        )
    )
    if not template:
        return False
    await session.delete(template)
    await session.commit()
    return True


async def update_template(
    session: AsyncSession,
    project_id: str,
    template_id: str,
    name: str,
    content: str,
    tags: list[str],
) -> Optional[PromptTemplate]:
    template = await session.scalar(
        select(PromptTemplate).where(
            PromptTemplate.id == template_id, PromptTemplate.project_id == project_id
        )
    )
    if not template:
        return None
    template.name = name
    template.content = content
    template.tags = json.dumps(tags, ensure_ascii=False) if tags else None
    await session.commit()
    await session.refresh(template)
    return template
