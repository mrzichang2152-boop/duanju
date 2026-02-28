from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user_id
from app.core.db import get_db
from app.schemas.common import StatusResponse
from app.schemas.segments import SegmentGenerateRequest, SegmentResponse, SegmentSelectRequest
from app.services.projects import get_project
from app.services.segments import (
    create_segment_version,
    create_segments_from_script,
    list_segment_versions,
    list_segments,
    select_segment_version,
)
from app.services.linkapi import create_video
from app.services.settings import get_or_create_settings

router = APIRouter()


@router.get("/{project_id}/segments", response_model=list[SegmentResponse])
async def fetch_segments(
    project_id: str,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
) -> list[SegmentResponse]:
    project = await get_project(db, user_id, project_id)
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    segments = await list_segments(db, project_id)
    if not segments:
        segments = await create_segments_from_script(db, project_id)
    responses: list[SegmentResponse] = []
    for segment in segments:
        versions = await list_segment_versions(db, segment.id)
        responses.append(
            SegmentResponse(
                id=segment.id,
                order_index=segment.order_index,
                text_content=segment.text_content,
                status=segment.status,
                versions=[
                    {
                        "id": version.id,
                        "video_url": version.video_url,
                        "prompt": version.prompt,
                        "status": version.status,
                        "is_selected": version.is_selected,
                    }
                    for version in versions
                ],
            )
        )
    return responses


@router.post("/{project_id}/segments/generate", response_model=StatusResponse)
async def generate_segments(
    project_id: str,
    payload: SegmentGenerateRequest,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
) -> StatusResponse:
    project = await get_project(db, user_id, project_id)
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    segments = await list_segments(db, project_id)
    if not segments:
        segments = await create_segments_from_script(db, project_id)
    target = None
    if payload.segment_id:
        target = next((item for item in segments if item.id == payload.segment_id), None)
    if not target and segments:
        target = segments[0]
    if not target:
        return StatusResponse(status="empty")
    settings = await get_or_create_settings(db, user_id)
    prompt = payload.prompt or target.text_content
    model = payload.model or settings.default_model_video
    request_payload = payload.options.copy() if payload.options else {}
    request_payload["model"] = model
    request_payload["prompt"] = prompt
    try:
        result = await create_video(
            db,
            user_id,
            request_payload,
        )
    except Exception as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="生成失败") from exc
    video_url = ""
    if isinstance(result, dict):
        data = result.get("data") or []
        if data:
            first = data[0]
            video_url = first.get("url") or ""
    if not video_url:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="生成失败")
    await create_segment_version(db, target.id, video_url, prompt)
    return StatusResponse(status="ready")


@router.put("/{project_id}/segments/{segment_id}/select", response_model=StatusResponse)
async def select_segment(
    project_id: str,
    segment_id: str,
    payload: SegmentSelectRequest,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
) -> StatusResponse:
    project = await get_project(db, user_id, project_id)
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    await select_segment_version(db, segment_id, payload.version_id)
    return StatusResponse(status="ready")
