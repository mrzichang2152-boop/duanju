import asyncio
import json
import logging
import os
from datetime import datetime, timezone
from uuid import uuid4

import httpx
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user_id
from app.core.config import settings as app_settings
from app.core.db import get_db, SessionLocal
from app.schemas.common import StatusResponse
from app.schemas.script import AsyncTaskStatusResponse
from app.schemas.segments import (
    SegmentFrameDeleteRequest,
    SegmentFrameGenerateRequest,
    SegmentFrameGenerateResponse,
    SegmentGenerateRequest,
    SegmentResponse,
    SegmentSelectRequest,
    SegmentVersionResponse,
)
from app.services import media_storage
from app.services.character_image_bindings import (
    infer_base_character_name_from_references,
    upsert_character_image_binding,
)
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
    sync_segments_with_script,
)
from app.services.settings import get_api_key, get_or_create_settings
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
_GEMINI_REFERENCE_IMAGE_LIMIT = 16
_FRAME_TASK_TYPE = "FRAME_GENERATE"
_SEGMENT_TASK_PROCESSING_TIMEOUT_SECONDS = max(
    300,
    int(str(os.getenv("SEGMENT_TASK_PROCESSING_TIMEOUT_SECONDS", "1800") or "1800").strip() or 1800),
)
_FRAME_TASK_STALE_SECONDS = max(
    300,
    int(str(os.getenv("FRAME_TASK_STALE_SECONDS", "900") or "900").strip() or 900),
)


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


def _is_seedance_task(task_id: Optional[str]) -> bool:
    return str(task_id or "").strip().lower().startswith("seedance|")


def _is_version_processing_timed_out(version) -> bool:
    created_at = getattr(version, "created_at", None)
    if not isinstance(created_at, datetime):
        return False
    now = datetime.now(timezone.utc)
    created = created_at.replace(tzinfo=timezone.utc) if created_at.tzinfo is None else created_at.astimezone(timezone.utc)
    return (now - created).total_seconds() >= _SEGMENT_TASK_PROCESSING_TIMEOUT_SECONDS


async def _resolve_seedance_key(db: AsyncSession, user_id: str) -> str:
    def _normalize_seedance_api_key(raw_value: str) -> str:
        text = str(raw_value or "").strip().strip('"').strip("'")
        if not text:
            return ""
        lowered = text.lower()
        if lowered.startswith("bearer "):
            text = text[7:].strip().strip('"').strip("'")
            lowered = text.lower()
        if lowered in {"primary_key", "<primary_key>", "your_primary_key", "api_key", "apikey"}:
            return ""
        if lowered.startswith("{") and lowered.endswith("}"):
            try:
                parsed = json.loads(text)
            except Exception:
                parsed = {}
            if isinstance(parsed, dict):
                extracted = ""
                for key in ("api_key", "ark_api_key", "volcengine_ark_api_key", "primary_key", "token"):
                    candidate = str(parsed.get(key) or "").strip().strip('"').strip("'")
                    if candidate and "primary_key" not in candidate.lower():
                        extracted = candidate
                        break
                if not extracted:
                    return ""
                text = extracted
                lowered = text.lower()
        if "=" in text and any(flag in lowered for flag in ("primary_key", "api_key", "ark_api_key", "token")):
            text = text.split("=", 1)[1].strip().strip('"').strip("'")
            lowered = text.lower()
        if ":" in text and any(flag in lowered for flag in ("primary_key", "api_key", "ark_api_key", "token")):
            text = text.split(":", 1)[1].strip().strip('"').strip("'")
            lowered = text.lower()
        if "primary_key" in lowered or (text.startswith("<") and text.endswith(">")):
            return ""
        if len(text) < 16:
            return ""
        return text

    env_key = _normalize_seedance_api_key(
        str(
            getattr(app_settings, "ark_api_key", "")
            or getattr(app_settings, "volcengine_ark_api_key", "")
            or os.getenv("ARK_API_KEY")
            or os.getenv("VOLCENGINE_ARK_API_KEY")
            or ""
        )
    )
    if env_key:
        return env_key
    configured = _normalize_seedance_api_key(str(await get_api_key(db, user_id) or ""))
    return configured


async def _query_seedance_task_status(task_id: str, api_key: str) -> tuple[str, str, str]:
    tid = str(task_id or "").strip()
    if not tid:
        return "FAILED", "", "任务ID为空"
    url = f"https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/{tid}"
    headers = {"Authorization": f"Bearer {api_key}"}
    async with httpx.AsyncClient(timeout=15.0, trust_env=True) as client:
        resp = await client.get(url, headers=headers)
    if resp.status_code != 200:
        return "FAILED", "", f"状态查询失败（HTTP {resp.status_code}）"
    try:
        payload = resp.json()
    except Exception:
        return "FAILED", "", "状态查询返回非 JSON"
    if not isinstance(payload, dict):
        return "FAILED", "", "状态查询返回格式异常"

    status_text = str(payload.get("status") or payload.get("task_status") or "").strip().lower()
    task_result = payload.get("task_result") if isinstance(payload.get("task_result"), dict) else {}
    content_obj = payload.get("content") if isinstance(payload.get("content"), dict) else {}
    error_obj = payload.get("error") if isinstance(payload.get("error"), dict) else {}

    video_url = str(content_obj.get("video_url") or "").strip()
    if not video_url:
        videos = task_result.get("videos") if isinstance(task_result.get("videos"), list) else []
        if videos and isinstance(videos[0], dict):
            video_url = str(videos[0].get("url") or "").strip()
    if not video_url:
        video_url = str(task_result.get("url") or task_result.get("video_url") or "").strip()

    if video_url or status_text in {"succeeded", "success", "completed"}:
        return "COMPLETED", video_url, ""

    if status_text in {"failed", "error", "canceled", "cancelled"}:
        fail_msg = str(error_obj.get("message") or payload.get("message") or "Seedance 任务失败").strip()
        return "FAILED", "", fail_msg

    if error_obj:
        fail_msg = str(error_obj.get("message") or payload.get("message") or "Seedance 任务失败").strip()
        if fail_msg:
            return "FAILED", "", fail_msg

    return "SEEDANCE_PROCESSING", "", ""


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
        segments = await sync_segments_with_script(db, project_id)
        if not segments:
            segments = await create_segments_from_script(db, project_id)
        
        all_versions = []
        for segment in segments:
            versions = await list_segment_versions(db, segment.id)
            all_versions.extend(versions)
            
        processing_versions = [v for v in all_versions if _is_kling_pending_status(v.status) and v.task_id and "|" in v.task_id]
        version_status_msg_map: dict[str, str] = {}
        if processing_versions:
            seedance_key = await _resolve_seedance_key(db, user_id)

            async def check_and_update(v):
                try:
                    raw_task_id = str(v.task_id or "").strip()
                    is_seedance = _is_seedance_task(raw_task_id)
                    if is_seedance:
                        _, tid = raw_task_id.split("|", 1)
                        if not seedance_key:
                            version_status_msg_map[str(v.id)] = "Seedance 鉴权未配置"
                            return False
                        new_status, video_url, task_status_msg = await _query_seedance_task_status(tid, seedance_key)
                    else:
                        endpoint, tid = raw_task_id.split("|", 1)
                        new_status, video_url, task_status_msg = await query_kling_task_status(db, user_id, endpoint, tid)
                    if task_status_msg:
                        version_status_msg_map[str(v.id)] = task_status_msg
                    if (not is_seedance) and _is_kling_pending_status(new_status) and _is_version_processing_timed_out(v):
                        v.status = "FAILED"
                        version_status_msg_map[str(v.id)] = (
                            f"任务超时：超过 {int(_SEGMENT_TASK_PROCESSING_TIMEOUT_SECONDS // 60)} 分钟仍未完成，请重试"
                        )
                        db.add(v)
                        return True
                    if not _is_kling_pending_status(new_status):
                        v.status = str(new_status or v.status or "PENDING")
                        if video_url:
                            cos_url = await media_storage.mirror_http_url_to_cos(
                                project_id,
                                "segment_videos",
                                str(video_url),
                                strict=True,
                            )
                            v.video_url = cos_url
                        db.add(v)
                        return True
                except Exception:
                    logger.exception("查询视频任务状态异常 version_id=%s", getattr(v, "id", ""))
                    raw_task_id = str(v.task_id or "").strip()
                    if (not _is_seedance_task(raw_task_id)) and _is_version_processing_timed_out(v):
                        v.status = "FAILED"
                        version_status_msg_map[str(v.id)] = (
                            f"任务超时：状态查询异常且超过 {int(_SEGMENT_TASK_PROCESSING_TIMEOUT_SECONDS // 60)} 分钟，请重试"
                        )
                        db.add(v)
                        return True
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
        if not media_storage.cos_enabled():
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="未配置腾讯云 COS，已禁止将生成视频落盘到服务器",
            )
        segments = await sync_segments_with_script(db, project_id)
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
            video_url = await media_storage.mirror_http_url_to_cos(project_id, "segment_videos", video_url, strict=True)

        version_status = "PROCESSING" if not video_url and task_id else "COMPLETED"
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
        "quick_channel": bool(payload.quick_channel),
    }
    if references:
        request_payload["image_urls"] = references[:_GEMINI_REFERENCE_IMAGE_LIMIT]
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
                if not image_url and first.get("b64_json"):
                    image_url = f"data:image/png;base64,{first.get('b64_json')}"
    if not image_url:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="生成图片失败：未获取到图片地址")
    frame_type = str(payload.frame_type or "").strip().lower() or "first"
    if not media_storage.cos_enabled():
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="未配置腾讯云 COS，无法保存生成图片")
    try:
        if image_url.startswith("data:image"):
            image_bytes, content_type = media_storage.decode_data_image_url(image_url)
            cos_url = await media_storage.upload_bytes_under_project_to_cos(
                project_id,
                f"segment_frame_images/{frame_type}",
                image_bytes,
                content_type,
                filename_hint=f"{frame_type}.png",
            )
        elif image_url.startswith(("http://", "https://")):
            cos_url = await media_storage.mirror_http_url_to_cos(
                project_id,
                f"segment_frame_images/{frame_type}",
                image_url,
                strict=True,
            )
        elif image_url.startswith("/static/"):
            rel = image_url.replace("/static/", "", 1).lstrip("/")
            abs_img = os.path.join(media_storage.backend_static_dir(), rel)
            cos_url = await media_storage.publish_local_file_under_static(
                project_id,
                abs_img,
                strict=True,
                delete_local=True,
            )
        else:
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="上传 COS 失败：图片地址格式不支持")
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("Segment frame image upload to COS failed: %s", exc, exc_info=True)
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=f"上传 COS 失败: {exc}") from exc
    if not media_storage.is_cos_public_url(cos_url):
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="上传 COS 失败：未返回 COS 地址")
    if frame_type == "character":
        base_character_name = await infer_base_character_name_from_references(db, project_id, references)
        if base_character_name:
            await upsert_character_image_binding(
                db,
                project_id,
                cos_url,
                base_character_name,
                source_image_url=references[0] if references else "",
            )
            await db.commit()
    return SegmentFrameGenerateResponse(image_url=cos_url)


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

    status_upper = str(task.status or "PENDING").upper()
    if status_upper in {"PENDING", "RUNNING"}:
        now = datetime.utcnow()
        updated_at = task.updated_at or task.created_at or now
        stale_seconds = (now - updated_at).total_seconds()
        if stale_seconds > _FRAME_TASK_STALE_SECONDS:
            fail_message = "任务状态丢失（服务重启或任务中断），请重新生成"
            task = await mark_async_task_failed(db, task, fail_message)
            status_upper = "FAILED"

    return AsyncTaskStatusResponse(
        task_id=task.id,
        project_id=project_id,
        task_type=task.task_type,
        status=status_upper,
        result=parse_task_result(task),
        error=(str(task.error or "").strip() or None),
    )


@router.post("/{project_id}/segments/frame-images/delete", response_model=StatusResponse)
async def delete_segment_frame_image(
    project_id: str,
    payload: SegmentFrameDeleteRequest,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
) -> StatusResponse:
    project = await get_project(db, user_id, project_id)
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    image_url = str(payload.image_url or "").strip()
    if not image_url:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="图片地址不能为空")
    deleted = await media_storage.delete_cos_media_by_url(image_url)
    if not deleted:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="仅支持删除已上传到 COS 的图片")
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
