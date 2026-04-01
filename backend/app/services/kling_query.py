import httpx
from typing import Optional, Tuple
from sqlalchemy.ext.asyncio import AsyncSession
from app.services.linkapi import _kling_task_query_url, resolve_kling_auth_token

async def query_kling_task_status(session: AsyncSession, user_id: str, endpoint: str, task_id: str) -> Tuple[str, Optional[str], Optional[str]]:
    """
    Query the status of a Kling video generation task.
    Returns: (status, video_url, task_status_msg)
    """
    key_value, _key_source = await resolve_kling_auth_token(session, user_id)
    if not key_value:
        return "FAILED", None, "系统未配置 Kling 鉴权 Key"

    query_url = _kling_task_query_url(endpoint, task_id)
    headers = {"Authorization": f"Bearer {key_value}"}
    async with httpx.AsyncClient(timeout=10.0) as client:
        try:
            response = await client.get(query_url, headers=headers)
            if response.status_code != 200:
                return "FAILED", None, f"状态查询失败（HTTP {response.status_code}）"

            payload = response.json()
            if not isinstance(payload, dict):
                return "FAILED", None, "状态查询返回格式异常"

            payload_code = payload.get("code")
            if payload_code not in {0, "0", None, ""}:
                return "FAILED", None, str(payload.get("message") or "状态查询失败")

            data = payload.get("data")
            if not isinstance(data, dict):
                return "FAILED", None, "状态查询缺少 data"

            task_status = str(data.get("task_status") or "").strip().lower()
            task_status_msg = str(data.get("task_status_msg") or "").strip() or None

            video_url = ""
            task_result = data.get("task_result")
            if isinstance(task_result, dict):
                videos = task_result.get("videos")
                if isinstance(videos, list) and videos:
                    first_video = videos[0]
                    if isinstance(first_video, dict):
                        video_url = str(first_video.get("url") or "").strip()
                if not video_url:
                    video_url = str(task_result.get("url") or task_result.get("video_url") or "").strip()

            if video_url:
                return "COMPLETED", video_url, task_status_msg

            if task_status in {"failed", "error", "canceled", "cancelled"}:
                return "FAILED", None, task_status_msg

            return "KLING_PROCESSING", None, task_status_msg

        except Exception:
            return "KLING_PROCESSING", None, None
