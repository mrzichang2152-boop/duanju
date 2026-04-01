import asyncio
import json
import logging
import os
from uuid import uuid4
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user_id
from app.core.db import get_db, SessionLocal
from app.schemas.common import StatusResponse
from app.schemas.script import AsyncTaskStatusResponse
from app.schemas.segments import (
    SegmentFrameGenerateRequest,
    SegmentFrameGenerateResponse,
    SegmentGenerateRequest,
    SegmentResponse,
    SegmentSelectRequest,
    SegmentVersionResponse,
)
from app.services.assets import download_image_as_local_file
from app.services import media_storage
from app.services.linkapi import create_image, create_video
from app.services.projects import get_project
from app.services.segments import (
    create_segment_version,
    create_segments_from_script,
    delete_segment_version,
    get_segment,
    list_segment_versions,
    list_segments,
    select_segment_version,
)
from app.services.settings import get_or_create_settings
from app.services.kling_query import query_kling_task_status
from app.services.async_tasks import (
    create_async_task,
    get_async_task,
    mark_async_task_running,
    mark_async_task_completed,
    mark_async_task_failed,
    parse_task_result,
)

router = APIRouter()
logger = logging.getLogger(__name__)
OPENROUTER_IMAGE_MODEL = "nano-banana-2"
_FRAME_TASK_TYPE = "FRAME_GENERATE"


def _safe_int(value: object, default: int = 0) -> int:
    try:
        return int(value)
    except Exception:
        return default


def _is_kling_pending_status(value: str) -> bool:
    normalized = str(value or "").strip().upper()
    if not normalized:
        return False
    if "FAILED" in normalized or "ERROR" in normalized or "CANCEL" in normalized:
        return False
    if "COMPLETED" in normalized or "SUCCESS" in normalized:
        return False
    if normalized in {"KLING_SUBMITTED", "KLING_PROCESSING"}:
        return True
    return (
        "SUBMIT" in normalized
        or "PROCESS" in normalized
        or "PENDING" in normalized
        or "QUEUE" in normalized
        or "RUNNING" in normalized
    )


@router.get("/{project_id}/segments", response_model=list[SegmentResponse])
async def fetch_segments(
    project_id: str,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
) -> list[SegmentResponse]:
    try:
        project = await get_project(db, user_id, project_id)
        if not project:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
        segments = await list_segments(db, project_id)
        if not segments:
            segments = await create_segments_from_script(db, project_id)
        
        all_versions = []
        for segment in segments:
            versions = await list_segment_versions(db, segment.id)
            all_versions.extend(versions)
            
        processing_versions = [v for v in all_versions if _is_kling_pending_status(v.status) and v.task_id and "|" in v.task_id]
        version_status_msg_map: dict[str, str] = {}
        if processing_versions:
            async def check_and_update(v):
                try:
                    endpoint, tid = v.task_id.split("|", 1)
                    new_status, video_url, task_status_msg = await query_kling_task_status(db, user_id, endpoint, tid)
                    if task_status_msg:
                        version_status_msg_map[str(v.id)] = task_status_msg
                    if not _is_kling_pending_status(new_status):
                        v.status = str(new_status or v.status or "PENDING")
                        if video_url:
                            cos_url = await media_storage.mirror_http_url_to_cos(
                                project_id, "segment_videos", str(video_url)
                            )
                            v.video_url = cos_url
                        db.add(v)
                        return True
                except Exception:
                    logger.exception("查询 Kling 任务状态异常 version_id=%s", getattr(v, "id", ""))
                return False

            results = await asyncio.gather(*(check_and_update(v) for v in processing_versions))
            if any(results):
                await db.commit()

        segments = await list_segments(db, project_id)
        
        result: list[SegmentResponse] = []
        for segment in segments:
            versions = await list_segment_versions(db, segment.id)
            version_items: list[SegmentVersionResponse] = []
            for v in versions:
                version_items.append(
                    SegmentVersionResponse(
                        id=str(v.id),
                        video_url=str(v.video_url or ""),
                        prompt=str(v.prompt) if v.prompt is not None else None,
                        status=str(v.status or "PENDING"),
                        task_id=str(v.task_id) if v.task_id is not None else None,
                        task_status_msg=version_status_msg_map.get(str(v.id)),
                        is_selected=bool(v.is_selected),
                    )
                )
            result.append(
                SegmentResponse(
                    id=str(segment.id),
                    order_index=_safe_int(getattr(segment, "order_index", 0), 0),
                    text_content=str(segment.text_content or ""),
                    status=str(segment.status or "PENDING"),
                    task_status=str(getattr(segment, "task_status", "") or "") or None,
                    task_id=str(getattr(segment, "task_id", "") or "") or None,
                    versions=version_items,
                )
            )
        return result
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("获取分镜列表失败 project_id=%s", project_id)
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"获取分镜失败: {exc}") from exc


@router.post("/{project_id}/segments/generate", response_model=StatusResponse)
async def generate_segments(
    project_id: str,
    payload: SegmentGenerateRequest,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
) -> StatusResponse:
    try:
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
        request_payload["project_id"] = project_id
        try:
            result = await create_video(
                db,
                user_id,
                request_payload,
                wait_for_result=False,
            )
        except Exception as exc:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
        video_url = ""
        task_id = None
        if isinstance(result, dict):
            data = result.get("data")
            if isinstance(data, list) and data:
                first = data[0]
                if isinstance(first, dict):
                    video_url = str(first.get("url") or "").strip()
            elif isinstance(data, dict):
                task_id = str(data.get("task_id") or "").strip()
                kling_endpoint = result.get("_kling_endpoint")
                if task_id and kling_endpoint:
                    task_id = f"{kling_endpoint}|{task_id}"
                task_result = data.get("task_result")
                if isinstance(task_result, dict):
                    videos = task_result.get("videos")
                    if isinstance(videos, list) and videos:
                        first_video = videos[0]
                        if isinstance(first_video, dict):
                            video_url = str(first_video.get("url") or "").strip()
                    if not video_url:
                        video_url = str(task_result.get("url") or task_result.get("video_url") or "").strip()
        if not video_url and not task_id:
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="生成失败：未获取到视频或任务ID")

        if video_url:
            video_url = await media_storage.mirror_http_url_to_cos(project_id, "segment_videos", video_url)

        version_status = "KLING_PROCESSING" if not video_url and task_id else "COMPLETED"
        await create_segment_version(db, target.id, video_url, prompt, task_id=task_id, status=version_status)
        return StatusResponse(status="ready")
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("提交分镜视频任务失败 project_id=%s segment_id=%s", project_id, payload.segment_id)
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"提交视频任务失败: {exc}") from exc


async def _generate_segment_frame_image_sync(
    project_id: str,
    payload: SegmentFrameGenerateRequest,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
) -> SegmentFrameGenerateResponse:
    project = await get_project(db, user_id, project_id)
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    prompt = str(payload.prompt or "").strip()
    if not prompt:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="提示词不能为空")
    references = [str(item).strip() for item in (payload.references or []) if str(item).strip()]
    request_payload: dict[str, object] = {
        "model": str(payload.model or OPENROUTER_IMAGE_MODEL).strip() or OPENROUTER_IMAGE_MODEL,
        "prompt": prompt,
        "aspect_ratio": str(payload.aspect_ratio or "16:9"),
        "size": "4K",
    }
    if references:
        request_payload["image_urls"] = references[:4]
    try:
        result = await create_image(db, user_id, request_payload)
    except Exception as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"生成图片失败: {exc}") from exc
    if isinstance(result, dict):
        error_obj = result.get("error")
        if isinstance(error_obj, dict):
            error_message = str(error_obj.get("message") or "").strip() or str(error_obj)
            error_code = str(error_obj.get("code") or "").strip()
            error_detail = f"{error_message} ({error_code})" if error_code else error_message
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"生成图片失败: {error_detail}")
    image_url = ""
    if isinstance(result, dict):
        data = result.get("data")
        if isinstance(data, list) and data:
            first = data[0]
            if isinstance(first, dict):
                image_url = str(first.get("url") or "").strip()
    if not image_url:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="生成图片失败：未获取到图片地址")
    frame_type = "last" if str(payload.frame_type or "").strip().lower() == "last" else "first"
    try:
        local_url = await download_image_as_local_file(
            image_url,
            filename_base=f"{project_id}_{frame_type}_frame_{uuid4().hex[:8]}",
        )
    except Exception as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=f"落地图片失败: {exc}") from exc
    if media_storage.cos_enabled() and local_url.startswith("/static/"):
        rel = local_url.replace("/static/", "", 1).lstrip("/")
        abs_path = os.path.join(media_storage.backend_static_dir(), rel)
        local_url = await media_storage.publish_local_file_under_static(project_id, abs_path)
    return SegmentFrameGenerateResponse(image_url=local_url)


async def _run_frame_generate_task(task_id: str) -> None:
    async with SessionLocal() as db:
        task = await get_async_task(db, task_id=task_id)
        if not task:
            return
        try:
            await mark_async_task_running(db, task)
            payload_data: dict[str, object] = {}
            if task.payload_json:
                payload_data = json.loads(task.payload_json)
            req_payload = SegmentFrameGenerateRequest(**(payload_data.get("payload") or {}))
            result = await _generate_segment_frame_image_sync(
                project_id=str(task.project_id),
                payload=req_payload,
                user_id=str(task.user_id),
                db=db,
            )
            await mark_async_task_completed(db, task, {"image_url": result.image_url})
        except Exception as exc:
            await mark_async_task_failed(db, task, str(exc))


@router.post("/{project_id}/segments/frame-images/generate", response_model=AsyncTaskStatusResponse)
async def generate_segment_frame_image(
    project_id: str,
    payload: SegmentFrameGenerateRequest,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
) -> AsyncTaskStatusResponse:
    project = await get_project(db, user_id, project_id)
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    prompt = str(payload.prompt or "").strip()
    if not prompt:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="提示词不能为空")
    task = await create_async_task(
        db,
        project_id=project_id,
        user_id=user_id,
        task_type=_FRAME_TASK_TYPE,
        payload={"payload": payload.model_dump() if hasattr(payload, "model_dump") else payload.dict()},
    )
    asyncio.create_task(_run_frame_generate_task(task.id))
    return AsyncTaskStatusResponse(
        task_id=task.id,
        project_id=project_id,
        task_type=_FRAME_TASK_TYPE,
        status="RUNNING",
        result=None,
        error=None,
    )


@router.get("/{project_id}/segments/frame-images/tasks/{task_id}", response_model=AsyncTaskStatusResponse)
async def get_segment_frame_image_task_status(
    project_id: str,
    task_id: str,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
) -> AsyncTaskStatusResponse:
    project = await get_project(db, user_id, project_id)
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    task = await get_async_task(
        db,
        task_id=task_id,
        project_id=project_id,
        user_id=user_id,
        task_type=_FRAME_TASK_TYPE,
    )
    if not task:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="任务不存在")
    return AsyncTaskStatusResponse(
        task_id=task.id,
        project_id=project_id,
        task_type=task.task_type,
        status=str(task.status or "PENDING").upper(),
        result=parse_task_result(task),
        error=(str(task.error or "").strip() or None),
    )


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


@router.delete("/{project_id}/segments/{segment_id}/versions/{version_id}", response_model=StatusResponse)
async def remove_segment_version(
    project_id: str,
    segment_id: str,
    version_id: str,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
) -> StatusResponse:
    project = await get_project(db, user_id, project_id)
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    segment = await get_segment(db, segment_id)
    if not segment or segment.project_id != project_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="分镜不存在")
    try:
        await delete_segment_version(db, segment_id, version_id)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    return StatusResponse(status="ready")
