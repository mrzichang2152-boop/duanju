import httpx
from typing import Optional, Tuple
from sqlalchemy.ext.asyncio import AsyncSession
from app.services.settings import get_or_create_settings, get_api_key
from app.services.linkapi import _kling_task_query_url, _parse_kling_ak_sk, _build_kling_jwt

async def query_kling_task_status(session: AsyncSession, user_id: str, endpoint: str, task_id: str) -> Tuple[str, Optional[str]]:
    """
    Query the status of a Kling video generation task.
    """
    # 之前强制替换为 api.klingai.com 导致 1002 错误，已移除
    settings = await get_or_create_settings(session, user_id)
    configured_key = await get_api_key(session, user_id)
    
    key_value = ""
    if configured_key:
        key_value = configured_key
    else:
        key_value = str(settings.api_key_video or "").strip()
    
    print(f"DEBUG: query_kling_task_status called with endpoint: {endpoint}, task_id: {task_id}")
    print(f"DEBUG: configured_key length: {len(configured_key) if configured_key else 0}")
    
    if not key_value:
        print("DEBUG: key_value is empty")
        return "FAILED", None

    # Handle AK/SK
    ak, sk = _parse_kling_ak_sk(key_value)
    if ak and sk:
        key_value = _build_kling_jwt(ak, sk)
        print(f"DEBUG: generated jwt token starting with {key_value[:20]}")
    else:
        print("DEBUG: _parse_kling_ak_sk failed to extract ak/sk")
    
    query_url = _kling_task_query_url(endpoint, task_id)
    print(f"DEBUG: query_url: {query_url}")
    
    headers = {"Authorization": f"Bearer {key_value}"}
    async with httpx.AsyncClient(timeout=10.0) as client:
        try:
            response = await client.get(query_url, headers=headers)
            print(f"DEBUG: Kling API response status: {response.status_code}, content: {response.text[:200]}")
            if response.status_code != 200:
                return "FAILED", None
            
            payload = response.json()
            if not isinstance(payload, dict):
                return "FAILED", None
                
            payload_code = payload.get("code")
            if payload_code not in {0, "0", None, ""}:
                return "FAILED", None
                
            data = payload.get("data")
            if not isinstance(data, dict):
                return "FAILED", None
                
            task_status = str(data.get("task_status") or "").strip().lower()
            
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
                return "COMPLETED", video_url
                
            if task_status in {"failed", "error", "canceled", "cancelled"}:
                return "FAILED", None
                
            return "KLING_PROCESSING", None
            
        except Exception:
            return "KLING_PROCESSING", None
