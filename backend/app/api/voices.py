from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import os
import re
import subprocess
import time
import uuid
from typing import Any, List, Optional

import httpx
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select

from app.api.deps import get_current_user_id
from app.core.db import get_db
from app.models.character_voice import CharacterVoice
from app.models.project import Project
from app.services.eleven_labs import eleven_labs_service
from app.services import media_storage
from app.services.settings import get_api_key

router = APIRouter()


class VoiceConfigUpdate(BaseModel):
    voice_id: str
    voice_type: str  # PRESET, CUSTOM, CLONE, KLING_CUSTOM
    preview_url: Optional[str] = None
    config: Optional[dict] = {}


class CharacterVoiceResponse(BaseModel):
    id: str
    character_name: str
    voice_id: str
    voice_type: str
    preview_url: Optional[str]
    config: dict


class TTSRequest(BaseModel):
    text: str
    character_name: str
    speed: float = 1.0
    volume: float = 0.0
    pitch: float = 0.0
    tts_config: Optional[dict] = None


class TTSResponse(BaseModel):
    audio_url: str


def _base64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("utf-8").rstrip("=")


def _build_kling_jwt(access_key: str, secret_key: str) -> str:
    now_ts = int(time.time())
    header_bytes = b'{"alg":"HS256","typ":"JWT"}'
    payload_bytes = (
        f'{{"iss":"{access_key}","exp":{now_ts + 1800},"nbf":{now_ts - 5}}}'
    ).encode("utf-8")
    signing_input = f"{_base64url_encode(header_bytes)}.{_base64url_encode(payload_bytes)}"
    signature = hmac.new(secret_key.encode("utf-8"), signing_input.encode("utf-8"), hashlib.sha256).digest()
    return f"{signing_input}.{_base64url_encode(signature)}"


def _parse_kling_ak_sk(raw_key_text: str) -> tuple[str, str]:
    raw = str(raw_key_text or "").strip()
    if not raw:
        return "", ""
    if "|" in raw:
        parts = [item.strip() for item in raw.split("|") if item.strip()]
        if len(parts) == 2:
            return parts[0], parts[1]
    if raw.startswith("{") and raw.endswith("}"):
        try:
            import json

            parsed = json.loads(raw)
            if isinstance(parsed, dict):
                ak = str(
                    parsed.get("access_key")
                    or parsed.get("accessKey")
                    or parsed.get("ak")
                    or ""
                ).strip()
                sk = str(
                    parsed.get("secret_key")
                    or parsed.get("secretKey")
                    or parsed.get("sk")
                    or ""
                ).strip()
                if ak and sk:
                    return ak, sk
        except Exception:
            pass
    ak_match = re.search(r"access\s*key\s*[:：=]\s*([A-Za-z0-9_-]{8,})", raw, flags=re.IGNORECASE)
    sk_match = re.search(r"secret\s*key\s*[:：=]\s*([A-Za-z0-9_-]{8,})", raw, flags=re.IGNORECASE)
    if ak_match and sk_match:
        return ak_match.group(1).strip(), sk_match.group(1).strip()
    return "", ""


def _extract_audio_duration_seconds(file_path: str) -> Optional[float]:
    ffprobe_cmd = [
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        file_path,
    ]
    try:
        result = subprocess.run(ffprobe_cmd, capture_output=True, text=True, timeout=6)
        if result.returncode != 0:
            return None
        duration = float((result.stdout or "").strip())
        if duration > 0:
            return duration
    except Exception:
        return None
    return None


def _build_kling_voice_ready_sample(local_path: str) -> str:
    """将上传样本规整为 Kling 更稳定识别的 WAV（16k/mono/pcm_s16le），失败时回退原文件。"""
    base_dir = os.path.dirname(local_path)
    base_name = os.path.splitext(os.path.basename(local_path))[0]
    normalized_path = os.path.join(base_dir, f"{base_name}_kling.wav")
    ffmpeg_cmd = [
        "ffmpeg",
        "-y",
        "-i",
        local_path,
        "-vn",
        "-ar",
        "16000",
        "-ac",
        "1",
        "-c:a",
        "pcm_s16le",
        normalized_path,
    ]
    try:
        result = subprocess.run(ffmpeg_cmd, capture_output=True, text=True, timeout=20)
        if result.returncode != 0 or (not os.path.isfile(normalized_path)):
            return local_path
        if os.path.getsize(normalized_path) <= 0:
            return local_path
        return normalized_path
    except Exception:
        return local_path


def _extract_first_non_empty(data: Any, keys: list[str]) -> str:
    if isinstance(data, dict):
        for key in keys:
            value = str(data.get(key) or "").strip()
            if value:
                return value
        for value in data.values():
            nested = _extract_first_non_empty(value, keys)
            if nested:
                return nested
    elif isinstance(data, list):
        for item in data:
            nested = _extract_first_non_empty(item, keys)
            if nested:
                return nested
    return ""


def _extract_kling_task_status_message(payload: Any) -> str:
    if isinstance(payload, dict):
        data_obj = payload.get("data") if isinstance(payload.get("data"), dict) else {}
        if isinstance(data_obj, dict):
            status_msg = str(data_obj.get("task_status_msg") or data_obj.get("status_msg") or "").strip()
            if status_msg:
                return status_msg
            task_info = data_obj.get("task_info") if isinstance(data_obj.get("task_info"), dict) else {}
            if isinstance(task_info, dict):
                info_msg = str(task_info.get("message") or task_info.get("msg") or task_info.get("reason") or "").strip()
                if info_msg:
                    return info_msg
    return _extract_first_non_empty(payload, ["task_status_msg", "status_msg", "reason", "msg", "message"])


async def _create_kling_custom_voice(
    api_key: str,
    voice_name: str,
    voice_url: str,
    external_task_id: str,
) -> dict[str, Any]:
    endpoint_candidates = [
        str(os.getenv("KLING_CUSTOM_VOICE_ENDPOINT") or "").strip(),
        "https://api-beijing.klingai.com/v1/general/custom-voices",
        "https://api.magic666.cn/api/v1/general/custom-voices",
    ]
    endpoint_candidates = [item for item in endpoint_candidates if item]
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    request_payload = {
        "voice_name": voice_name[:20],
        "voice_url": voice_url,
        "external_task_id": external_task_id,
    }

    async with httpx.AsyncClient(timeout=90.0, trust_env=True) as client:
        last_error = ""
        for endpoint in endpoint_candidates:
            try:
                response = await client.post(endpoint, headers=headers, json=request_payload)
            except Exception as exc:
                last_error = f"{endpoint} 请求异常: {exc}"
                continue
            if response.status_code != 200:
                last_error = f"{endpoint} 返回 {response.status_code}: {response.text[:200]}"
                continue
            try:
                payload = response.json()
            except Exception:
                last_error = f"{endpoint} 返回非 JSON: {response.text[:200]}"
                continue
            code = payload.get("code") if isinstance(payload, dict) else None
            if code not in (None, 0, "0", 200, "200"):
                last_error = f"{endpoint} 返回错误 code={code} body={str(payload)[:200]}"
                continue
            task_id = _extract_first_non_empty(payload, ["task_id", "id"])
            voice_id = _extract_first_non_empty(
                payload,
                [
                    "voice_id",
                    "id",
                    "custom_voice_id",
                    "voiceId",
                    "voiceID",
                ],
            )
            return {
                "voice_id": voice_id,
                "task_id": task_id,
                "raw": payload,
                "endpoint": endpoint,
            }
        raise RuntimeError(last_error or "创建 Kling 自定义音色失败")


async def _query_kling_custom_voice(
    api_key: str,
    task_id: str,
    create_endpoint: str,
) -> dict[str, Any]:
    normalized_task_id = str(task_id or "").strip()
    if not normalized_task_id:
        return {}
    endpoint_candidates = [
        str(os.getenv("KLING_CUSTOM_VOICE_QUERY_ENDPOINT") or "").strip(),
        f"{create_endpoint.rstrip('/')}/{normalized_task_id}",
        f"https://api-beijing.klingai.com/v1/general/custom-voices/{normalized_task_id}",
        f"https://api.magic666.cn/api/v1/general/custom-voices/{normalized_task_id}",
    ]
    endpoint_candidates = [item for item in endpoint_candidates if item]
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    async with httpx.AsyncClient(timeout=60.0, trust_env=True) as client:
        for _ in range(45):
            for endpoint in endpoint_candidates:
                query_url = endpoint.replace("{id}", normalized_task_id)
                try:
                    response = await client.get(query_url, headers=headers)
                except Exception:
                    continue
                if response.status_code != 200:
                    continue
                try:
                    payload = response.json()
                except Exception:
                    continue
                code = payload.get("code") if isinstance(payload, dict) else None
                if code not in (None, 0, "0", 200, "200"):
                    continue
                task_status = _extract_first_non_empty(payload, ["task_status", "status"]).lower()
                voice_id = _extract_first_non_empty(
                    payload,
                    ["voice_id", "custom_voice_id", "voiceId", "voiceID", "id"],
                )
                preview_url = _extract_first_non_empty(payload, ["trial_url", "preview_url", "audio_url", "url"])
                if voice_id:
                    return {
                        "voice_id": voice_id,
                        "preview_url": preview_url,
                        "raw": payload,
                    }
                if task_status in {"failed", "error", "canceled", "cancelled"}:
                    status_msg = _extract_kling_task_status_message(payload)
                    lowered = status_msg.lower()
                    if "failure to pas" in lowered or "pass" in lowered or "audit" in lowered:
                        raise RuntimeError("自定义音色任务失败：音频未通过平台审核，请更换为清晰的人声、无背景音乐且避免敏感内容后重试")
                    if "parse" in lowered or "decode" in lowered or "format" in lowered:
                        raise RuntimeError("自定义音色任务失败：音频解析失败，请使用 5-30 秒、清晰人声（建议 WAV/MP3）后重试")
                    raise RuntimeError(f"自定义音色任务失败：{status_msg or str(payload)[:300]}")
            await asyncio.sleep(2.0)
    return {}


@router.get("/{project_id}/voices", response_model=List[CharacterVoiceResponse])
async def get_project_voices(
    project_id: str,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Project).where(Project.id == project_id, Project.user_id == user_id))
    project = result.scalars().first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    result = await db.execute(select(CharacterVoice).where(CharacterVoice.project_id == project_id))
    voices = result.scalars().all()
    return voices


@router.post("/{project_id}/voices/{character_name}", response_model=CharacterVoiceResponse)
async def update_character_voice(
    project_id: str,
    character_name: str,
    payload: VoiceConfigUpdate,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Project).where(Project.id == project_id, Project.user_id == user_id))
    project = result.scalars().first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    result = await db.execute(
        select(CharacterVoice).where(
            CharacterVoice.project_id == project_id,
            CharacterVoice.character_name == character_name,
        )
    )
    voice = result.scalars().first()

    if voice:
        voice.voice_id = payload.voice_id
        voice.voice_type = payload.voice_type
        if payload.preview_url:
            voice.preview_url = payload.preview_url
        if payload.config:
            voice.config = payload.config
    else:
        voice = CharacterVoice(
            project_id=project_id,
            character_name=character_name,
            voice_id=payload.voice_id,
            voice_type=payload.voice_type,
            preview_url=payload.preview_url,
            config=payload.config or {},
        )
        db.add(voice)

    await db.commit()
    await db.refresh(voice)
    return voice


@router.post("/{project_id}/voices/{character_name}/upload-sample", response_model=CharacterVoiceResponse)
async def upload_character_voice_sample(
    project_id: str,
    character_name: str,
    file: UploadFile = File(...),
    title: Optional[str] = Form(None),
    duration_sec: Optional[float] = Form(None),
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Project).where(Project.id == project_id, Project.user_id == user_id))
    project = result.scalars().first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in {".mp3", ".wav", ".mp4", ".mov"}:
        raise HTTPException(status_code=400, detail="仅支持 .mp3/.wav/.mp4/.mov 文件")

    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="上传文件为空")
    if len(raw) > 200 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="文件大小不能超过200MB")

    backend_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    static_dir = os.path.join(backend_dir, "static", "voice_samples", project_id)
    os.makedirs(static_dir, exist_ok=True)
    local_name = f"{uuid.uuid4().hex}{ext}"
    local_path = os.path.join(static_dir, local_name)
    with open(local_path, "wb") as fp:
        fp.write(raw)

    resolved_duration = duration_sec if isinstance(duration_sec, (int, float)) and duration_sec > 0 else None
    if resolved_duration is None:
        resolved_duration = _extract_audio_duration_seconds(local_path)
    if resolved_duration is not None and (resolved_duration < 5 or resolved_duration > 30):
        raise HTTPException(status_code=400, detail="音频时长需在 5-30 秒")

    configured_key = await get_api_key(db, user_id)
    ak, sk = _parse_kling_ak_sk(configured_key)
    if not ak or not sk:
        raise HTTPException(
            status_code=400,
            detail="Kling Key 未配置为 AK/SK，请先在设置页配置（支持 AK|SK 或 JSON）",
        )
    kling_jwt = _build_kling_jwt(ak, sk)

    async def _resolve_public_voice_sample_url(source_path: str) -> str:
        source_name = os.path.basename(source_path)
        resolved_url = f"/static/voice_samples/{project_id}/{source_name}"
        try:
            resolved_url = await media_storage.publish_local_file_under_static(project_id, source_path)
        except Exception:
            pass
        if resolved_url.startswith("/"):
            public_base = str(os.getenv("PUBLIC_BASE_URL") or os.getenv("KLING_PUBLIC_BASE_URL") or "").strip().rstrip("/")
            if public_base:
                resolved_url = f"{public_base}{resolved_url}"
        if not resolved_url.startswith(("http://", "https://")):
            raise HTTPException(
                status_code=400,
                detail="音频样本未生成公网可访问 URL，请配置 PUBLIC_BASE_URL/KLING_PUBLIC_BASE_URL 或启用 COS",
            )
        return resolved_url

    sample_source_path = _build_kling_voice_ready_sample(local_path)
    sample_url = await _resolve_public_voice_sample_url(sample_source_path)

    voice_title = (title or f"{character_name}-voice").strip()[:20]
    external_task_id = f"{project_id}-{character_name}-{int(time.time() * 1000)}"
    try:
        created = await _create_kling_custom_voice(
            api_key=kling_jwt,
            voice_name=voice_title,
            voice_url=sample_url,
            external_task_id=external_task_id,
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"创建 Kling 自定义音色失败：{exc}") from exc

    preview_url = sample_url
    voice_id = str(created.get("voice_id") or "").strip()
    if not voice_id and str(created.get("task_id") or "").strip():
        try:
            queried = await _query_kling_custom_voice(
                api_key=kling_jwt,
                task_id=str(created.get("task_id") or "").strip(),
                create_endpoint=str(created.get("endpoint") or ""),
            )
            voice_id = str(queried.get("voice_id") or "").strip()
        except Exception as exc:
            can_retry_with_original = os.path.abspath(sample_source_path) != os.path.abspath(local_path)
            if not can_retry_with_original:
                raise HTTPException(status_code=400, detail=f"查询 Kling 自定义音色失败：{exc}") from exc
            try:
                fallback_sample_url = await _resolve_public_voice_sample_url(local_path)
                retried = await _create_kling_custom_voice(
                    api_key=kling_jwt,
                    voice_name=voice_title,
                    voice_url=fallback_sample_url,
                    external_task_id=f"{external_task_id}-fallback",
                )
                fallback_task_id = str(retried.get("task_id") or "").strip()
                voice_id = str(retried.get("voice_id") or "").strip()
                if not voice_id and fallback_task_id:
                    queried = await _query_kling_custom_voice(
                        api_key=kling_jwt,
                        task_id=fallback_task_id,
                        create_endpoint=str(retried.get("endpoint") or ""),
                    )
                    voice_id = str(queried.get("voice_id") or "").strip()
                if voice_id:
                    preview_url = fallback_sample_url
            except Exception as retry_exc:
                raise HTTPException(status_code=400, detail=f"查询 Kling 自定义音色失败：{exc}；重试原始音频仍失败：{retry_exc}") from retry_exc
    if not voice_id:
        raise HTTPException(status_code=400, detail="Kling 未返回有效音色ID，请稍后重试")

    result = await db.execute(
        select(CharacterVoice).where(
            CharacterVoice.project_id == project_id,
            CharacterVoice.character_name == character_name,
        )
    )
    voice = result.scalars().first()
    cfg = {
        "provider": "kling",
        "title": voice_title,
        "source": "uploaded_sample",
        "duration_sec": round(float(resolved_duration), 3) if isinstance(resolved_duration, (int, float)) else None,
        "sample_url": preview_url,
    }
    if voice:
        voice.voice_id = voice_id
        voice.voice_type = "KLING_CUSTOM"
        voice.preview_url = preview_url
        voice.config = cfg
    else:
        voice = CharacterVoice(
            project_id=project_id,
            character_name=character_name,
            voice_id=voice_id,
            voice_type="KLING_CUSTOM",
            preview_url=preview_url,
            config=cfg,
        )
        db.add(voice)

    await db.commit()
    await db.refresh(voice)
    return voice


@router.post("/{project_id}/tts", response_model=TTSResponse)
async def generate_tts(
    project_id: str,
    payload: TTSRequest,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Project).where(Project.id == project_id, Project.user_id == user_id))
    project = result.scalars().first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    result = await db.execute(
        select(CharacterVoice).where(
            CharacterVoice.project_id == project_id,
            CharacterVoice.character_name == payload.character_name,
        )
    )
    voice = result.scalars().first()

    if not voice:
        raise HTTPException(status_code=400, detail=f"Voice not configured for character: {payload.character_name}")

    try:
        tts_config = payload.tts_config if isinstance(payload.tts_config, dict) else {}
        settings = tts_config.get("settings") if isinstance(tts_config.get("settings"), dict) else {}
        if "speed" not in settings and isinstance(payload.speed, (int, float)):
            settings["speed"] = payload.speed
        if isinstance(payload.volume, (int, float)):
            settings["style"] = max(0.0, min(1.0, (float(payload.volume) + 12.0) / 24.0))
        model_id = str(tts_config.get("model_id", "")).strip() or "eleven_v3"
        output_format = str(tts_config.get("output_format", "")).strip() or "mp3_44100_128"
        language_code = str(tts_config.get("language_code", "")).strip() or None
        previous_text = str(tts_config.get("previous_text", "")).strip() or None
        next_text = str(tts_config.get("next_text", "")).strip() or None
        seed = tts_config.get("seed") if isinstance(tts_config.get("seed"), int) else None
        pronunciation_overrides = (
            tts_config.get("pronunciation_overrides")
            if isinstance(tts_config.get("pronunciation_overrides"), list)
            else None
        )
        pronunciation_dictionary_locators = (
            tts_config.get("pronunciation_dictionary_locators")
            if isinstance(tts_config.get("pronunciation_dictionary_locators"), list)
            else None
        )
        audio_content = await eleven_labs_service.tts(
            text=payload.text,
            voice_id=voice.voice_id,
            model_id=model_id,
            output_format=output_format,
            settings=settings,
            language_code=language_code,
            seed=seed,
            previous_text=previous_text,
            next_text=next_text,
            pronunciation_overrides=pronunciation_overrides,
            pronunciation_dictionary_locators=pronunciation_dictionary_locators,
        )

        backend_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        static_dir = os.path.join(backend_dir, "static", "audio", project_id)
        os.makedirs(static_dir, exist_ok=True)

        filename_ext = "mp3" if output_format.startswith("mp3") else "wav"
        filename = f"{uuid.uuid4()}.{filename_ext}"
        file_path = os.path.join(static_dir, filename)

        with open(file_path, "wb") as f:
            f.write(audio_content)

        from app.services import media_storage

        out_url = f"/static/audio/{project_id}/{filename}"
        if media_storage.cos_enabled():
            out_url = await media_storage.publish_local_file_under_static(project_id, file_path)
        return TTSResponse(audio_url=out_url)

    except Exception as e:
        import logging

        logging.getLogger(__name__).error(f"TTS generation failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))
