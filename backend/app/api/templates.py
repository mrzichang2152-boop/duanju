from __future__ import annotations
from typing import Optional, Union
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user_id
from app.core.db import get_db
from app.schemas.common import StatusResponse
import json

from app.schemas.templates import TemplateCreateRequest, TemplateResponse, TemplateUpdateRequest
from app.services.projects import get_project
from app.services.templates import create_template, delete_template, list_templates, update_template

router = APIRouter()


@router.get("/{project_id}/templates", response_model=list[TemplateResponse])
async def fetch_templates(
    project_id: str,
    kind: Optional[str] = Query(default=None),
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
) -> list[TemplateResponse]:
    project = await get_project(db, user_id, project_id)
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    templates = await list_templates(db, project_id, kind)

    def parse_tags(raw: Optional[str]) -> list[str]:
        if not raw:
            return []
        try:
            data = json.loads(raw)
            if isinstance(data, list):
                return [str(item) for item in data]
        except json.JSONDecodeError:
            return []
        return []

    return [
        TemplateResponse(
            id=item.id,
            kind=item.kind,
            name=item.name,
            content=item.content,
            tags=parse_tags(item.tags),
        )
        for item in templates
    ]


@router.post("/{project_id}/templates", response_model=TemplateResponse)
async def create_template_entry(
    project_id: str,
    payload: TemplateCreateRequest,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
) -> TemplateResponse:
    project = await get_project(db, user_id, project_id)
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    template = await create_template(
        db, project_id, payload.kind, payload.name, payload.content, payload.tags
    )
    return TemplateResponse(
        id=template.id,
        kind=template.kind,
        name=template.name,
        content=template.content,
        tags=payload.tags,
    )


@router.delete("/{project_id}/templates/{template_id}", response_model=StatusResponse)
async def remove_template(
    project_id: str,
    template_id: str,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
) -> StatusResponse:
    project = await get_project(db, user_id, project_id)
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    deleted = await delete_template(db, project_id, template_id)
    if not deleted:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="模板不存在")
    return StatusResponse(status="ready")


@router.put("/{project_id}/templates/{template_id}", response_model=TemplateResponse)
async def edit_template(
    project_id: str,
    template_id: str,
    payload: TemplateUpdateRequest,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
) -> TemplateResponse:
    project = await get_project(db, user_id, project_id)
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    template = await update_template(
        db, project_id, template_id, payload.name, payload.content, payload.tags
    )
    if not template:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="模板不存在")
    return TemplateResponse(
        id=template.id,
        kind=template.kind,
        name=template.name,
        content=template.content,
        tags=payload.tags,
    )
