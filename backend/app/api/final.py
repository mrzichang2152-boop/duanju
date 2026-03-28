import asyncio
import hashlib
import ipaddress
import json
import logging
import math
import os
import re
import shlex
import shutil
import subprocess
import tempfile
import uuid
import wave
from datetime import datetime
from typing import Any, Optional
from urllib.parse import quote, urlparse

import aiofiles
import httpx
from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile, status
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.background import BackgroundTask

from app.api.deps import get_current_user_id
from app.core.db import get_db
from app.schemas.common import StatusResponse
from app.services.eleven_labs import eleven_labs_service
from app.services.media_storage import load_media_bytes, publish_local_file_under_static
from app.services.projects import get_project

router = APIRouter()
LOGGER = logging.getLogger(__name__)


class EpisodeMergeDownloadRequest(BaseModel):
    clip_urls: list[str]
    episode_title: Optional[str] = None


class EpisodeAudioExtractRequest(BaseModel):
    clip_urls: list[str]
    episode_title: Optional[str] = None
    merge_key: Optional[str] = None


class EpisodeAudioSplitUpdateRequest(BaseModel):
    job_id: str
    split_points: list[float]


class EpisodeAudioGenerateSegmentsRequest(BaseModel):
    job_id: str


class EpisodeAudioS2SRequest(BaseModel):
    job_id: str
    segment_id: str
    voice_id: str
    model_id: Optional[str] = "eleven_v3"
    settings: Optional[dict[str, Any]] = None


class EpisodeAudioOriginalVocalExtractRequest(BaseModel):
    job_id: str


class EpisodeAudioSegmentDeleteRequest(BaseModel):
    job_id: str
    segment_id: str


class EpisodeAudioMergeDubbedRequest(BaseModel):
    job_id: str


class EpisodeAudioMuxDubbedVideoRequest(BaseModel):
    job_id: str


class EpisodeAudioGenerateSfxRequest(BaseModel):
    job_id: str
    source_video_url: Optional[str] = ""
    segment_index: int = 0
    start_sec: float
    end_sec: float
    background_sound_prompt: str


class EpisodeAudioDeleteSfxVersionRequest(BaseModel):
    job_id: str
    segment_index: int
    version: int


SFX_MIN_DURATION_SEC = 0.5
SFX_MAX_DURATION_SEC = 30.0


class EpisodeAudioClipSfxRequest(BaseModel):
    job_id: str
    source_video_url: Optional[str] = ""
    start_sec: float
    end_sec: float


class EpisodeAudioApplySfxSegmentsRequest(BaseModel):
    job_id: str
    source_video_url: Optional[str] = ""
    split_points: list[float]


class FreeSoundSearchRequest(BaseModel):
    query: Optional[str] = ""
    tag: Optional[str] = ""
    page: int = 1
    page_size: int = 20


class EpisodeAudioTranscribeRequest(BaseModel):
    """将分段音频转为文字的请求"""
    job_id: str
    segment_id: str


class EpisodeEpisodeTranscribeRequest(BaseModel):
    """将整集人声音轨转为文字的请求"""
    job_id: str


def _audio_extension_from_upload(filename: str, content_type: str) -> str:
    ext = os.path.splitext(str(filename or ""))[1].strip().lower()
    allowed_ext = {".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"}
    if ext in allowed_ext:
        return ext
    normalized_type = str(content_type or "").strip().lower()
    by_content_type = {
        "audio/mpeg": ".mp3",
        "audio/mp3": ".mp3",
        "audio/wav": ".wav",
        "audio/x-wav": ".wav",
        "audio/mp4": ".m4a",
        "audio/x-m4a": ".m4a",
        "audio/aac": ".aac",
        "audio/ogg": ".ogg",
        "audio/flac": ".flac",
        "audio/x-flac": ".flac",
    }
    return by_content_type.get(normalized_type, ".mp3")


def _sanitize_download_filename(name: str) -> str:
    cleaned = re.sub(r"[\\/:*?\"<>|]+", "_", str(name or "").strip())
    compacted = re.sub(r"\s+", "_", cleaned).strip("._")
    return compacted or "episode"


def _freesound_headers() -> dict[str, str]:
    token = str(os.getenv("FREESOUND_API_TOKEN") or "").strip()
    if not token:
        raise RuntimeError("Freesound API Token 未配置，请设置 FREESOUND_API_TOKEN")
    return {
        "Authorization": f"Bearer {token}",
    }


def _build_merge_key(clip_urls: list[str], episode_title: Optional[str] = None) -> str:
    joined = "\n".join([str(episode_title or "").strip(), *clip_urls])
    return hashlib.sha256(joined.encode("utf-8")).hexdigest()[:20]


def _is_valid_merge_key(text: str) -> bool:
    return bool(re.fullmatch(r"[a-f0-9]{20}", text or ""))


def _cleanup_temp_dir(path: str) -> None:
    shutil.rmtree(path, ignore_errors=True)


def _backend_static_dir() -> str:
    return os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), "static")


def _pipeline_base_dir() -> str:
    return os.path.join(_backend_static_dir(), "audio_pipeline")


def _project_pipeline_dir(project_id: str) -> str:
    return os.path.join(_pipeline_base_dir(), project_id)


def _job_dir(project_id: str, job_id: str) -> str:
    return os.path.join(_project_pipeline_dir(project_id), job_id)


def _metadata_path(project_id: str, job_id: str) -> str:
    return os.path.join(_job_dir(project_id, job_id), "metadata.json")


def _merge_storage_dir(project_id: str) -> str:
    return os.path.join(_project_pipeline_dir(project_id), "merged")


def _merged_video_path(project_id: str, merge_key: str) -> str:
    return os.path.join(_merge_storage_dir(project_id), f"{merge_key}.mp4")


def _to_static_url(abs_path: str) -> str:
    static_dir = _backend_static_dir()
    rel = os.path.relpath(abs_path, static_dir).replace("\\", "/")
    return f"/static/{rel}"


async def _publish_static_file(project_id: str, abs_path: str) -> str:
    """生成本地文件后写入 COS（若已配置）并返回可访问 URL。"""
    return await publish_local_file_under_static(project_id, abs_path)


def _safe_remove_static_file(static_url: str, allowed_root: str) -> None:
    normalized_url = str(static_url or "").strip()
    if not normalized_url.startswith("/static/"):
        return
    abs_path = os.path.abspath(
        os.path.join(_backend_static_dir(), normalized_url.replace("/static/", "", 1))
    )
    allowed_abs = os.path.abspath(allowed_root)
    try:
        if os.path.commonpath([abs_path, allowed_abs]) != allowed_abs:
            return
    except ValueError:
        return
    if os.path.isfile(abs_path):
        os.remove(abs_path)


def _resolve_static_audio_path(static_url: str) -> str:
    normalized_url = str(static_url or "").strip()
    if normalized_url.startswith(("http://", "https://")):
        return normalized_url
    if not normalized_url.startswith("/static/"):
        raise RuntimeError("音频地址无效")
    abs_path = os.path.abspath(
        os.path.join(_backend_static_dir(), normalized_url.replace("/static/", "", 1))
    )
    static_root = os.path.abspath(_backend_static_dir())
    try:
        if os.path.commonpath([abs_path, static_root]) != static_root:
            raise RuntimeError("音频地址越界")
    except ValueError as exc:
        raise RuntimeError("音频地址无效") from exc
    if not os.path.exists(abs_path):
        raise RuntimeError("音频文件不存在")
    return abs_path


def _resolve_static_video_path(static_url: str) -> str:
    normalized_url = str(static_url or "").strip()
    if normalized_url.startswith(("http://", "https://")):
        parsed = urlparse(normalized_url)
        if parsed.path.startswith("/static/"):
            normalized_url = parsed.path
        else:
            # 对象存储等外链，供 ffmpeg/ffprobe 直接读取
            return normalized_url
    if not normalized_url.startswith("/static/"):
        raise RuntimeError("视频地址无效")
    abs_path = os.path.abspath(
        os.path.join(_backend_static_dir(), normalized_url.replace("/static/", "", 1))
    )
    static_root = os.path.abspath(_backend_static_dir())
    try:
        if os.path.commonpath([abs_path, static_root]) != static_root:
            raise RuntimeError("视频地址越界")
    except ValueError as exc:
        raise RuntimeError("视频地址无效") from exc
    if not os.path.exists(abs_path):
        raise RuntimeError("视频文件不存在")
    return abs_path


def _ensure_ffmpeg() -> None:
    try:
        probe = subprocess.run(["ffmpeg", "-version"], capture_output=True, text=True)
        if probe.returncode != 0:
            raise RuntimeError("未检测到 ffmpeg，无法执行音视频处理")
    except FileNotFoundError:
        raise RuntimeError("系统未安装 ffmpeg 或未配置环境变量")


def _run_subprocess(cmd: list[str], err_prefix: str, timeout_sec: Optional[float] = None) -> None:
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout_sec)
        if result.returncode != 0:
            stderr = str(result.stderr or "").strip()
            lines = [line.strip() for line in stderr.splitlines() if line.strip()]
            meaningful = ""
            for line in reversed(lines):
                lower = line.lower()
                if any(key in lower for key in ("error", "invalid", "failed", "cannot", "could not", "no such", "not found")):
                    meaningful = line
                    break
            detail = meaningful or (lines[-1] if lines else "")
            raise RuntimeError(f"{err_prefix}：{(detail or '命令执行失败')[:300]}")
    except FileNotFoundError:
        raise RuntimeError(f"{err_prefix}：找不到命令 {cmd[0]}")
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"{err_prefix}：执行超时")


def _run_subprocess_detail(cmd: list[str], timeout_sec: Optional[float] = None) -> Optional[str]:
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout_sec)
        if result.returncode == 0:
            return None
        stderr = str(result.stderr or "").strip()
        lines = [line.strip() for line in stderr.splitlines() if line.strip()]
        meaningful = ""
        for line in reversed(lines):
            lower = line.lower()
            if any(key in lower for key in ("error", "invalid", "failed", "cannot", "could not", "no such", "not found")):
                meaningful = line
                break
        detail = meaningful or (lines[-1] if lines else "命令执行失败")
        return detail[:300]
    except FileNotFoundError:
        return f"找不到命令 {cmd[0]}"
    except subprocess.TimeoutExpired:
        return "命令执行超时"


def _validate_public_base_url(base_url: str) -> Optional[str]:
    parsed = urlparse(base_url)
    host = str(parsed.hostname or "").strip().lower()
    if not host:
        return "静态文件公网地址无效，请配置 KLING_PUBLIC_BASE_URL（或 PUBLIC_BASE_URL）"
    if host in {"localhost", "127.0.0.1", "0.0.0.0"} or host.endswith(".local"):
        return "静态文件地址为本地地址，Kling 无法访问，请配置可公网访问的 KLING_PUBLIC_BASE_URL（或 PUBLIC_BASE_URL）"
    try:
        ip = ipaddress.ip_address(host)
        if ip.is_private or ip.is_loopback or ip.is_link_local:
            return "静态文件地址为内网地址，Kling 无法访问，请配置可公网访问的 KLING_PUBLIC_BASE_URL（或 PUBLIC_BASE_URL）"
    except ValueError:
        if "." not in host:
            return "静态文件地址域名无效，请配置可公网访问的 KLING_PUBLIC_BASE_URL（或 PUBLIC_BASE_URL）"
    return None


def _publish_static_to_remote(static_url: str) -> str:
    host = str(os.getenv("SFX_REMOTE_UPLOAD_HOST") or "").strip()
    username = str(os.getenv("SFX_REMOTE_UPLOAD_USER") or "root").strip()
    password = str(os.getenv("SFX_REMOTE_UPLOAD_PASSWORD") or "").strip()
    remote_dir = str(os.getenv("SFX_REMOTE_UPLOAD_DIR") or "/srv/kling-static").strip().rstrip("/")
    remote_base_url = str(os.getenv("SFX_REMOTE_PUBLIC_BASE_URL") or "").strip().rstrip("/")
    port_raw = str(os.getenv("SFX_REMOTE_UPLOAD_PORT") or "22").strip()
    if not host and not remote_base_url and not password:
        return ""
    missing_items: list[str] = []
    if not host:
        missing_items.append("SFX_REMOTE_UPLOAD_HOST")
    if not username:
        missing_items.append("SFX_REMOTE_UPLOAD_USER")
    if not password:
        missing_items.append("SFX_REMOTE_UPLOAD_PASSWORD")
    if not remote_dir:
        missing_items.append("SFX_REMOTE_UPLOAD_DIR")
    if not remote_base_url:
        missing_items.append("SFX_REMOTE_PUBLIC_BASE_URL")
    if missing_items:
        missing_text = "、".join(missing_items)
        raise RuntimeError(f"远程上传配置不完整，请补齐：{missing_text}")
    try:
        port = int(port_raw)
    except ValueError:
        raise RuntimeError("远程上传端口配置无效，请检查 SFX_REMOTE_UPLOAD_PORT")
    normalized = str(static_url or "").strip()
    if not normalized.startswith("/static/"):
        raise RuntimeError("静态文件地址无效")
    static_rel = normalized.replace("/static/", "", 1).strip("/")
    if not static_rel:
        raise RuntimeError("静态文件地址无效")
    local_abs = os.path.abspath(os.path.join(_backend_static_dir(), static_rel))
    static_root = os.path.abspath(_backend_static_dir())
    try:
        if os.path.commonpath([local_abs, static_root]) != static_root:
            raise RuntimeError("静态文件路径越界")
    except ValueError as exc:
        raise RuntimeError("静态文件路径无效") from exc
    if not os.path.isfile(local_abs):
        raise RuntimeError("静态文件不存在，无法上传到远程服务器")
    remote_abs = f"{remote_dir}/{static_rel}"
    remote_parent = os.path.dirname(remote_abs)
    mkdir_cmd = [
        "sshpass",
        "-p",
        password,
        "ssh",
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "ConnectTimeout=8",
        "-o",
        "ServerAliveInterval=5",
        "-o",
        "ServerAliveCountMax=1",
        "-p",
        str(port),
        f"{username}@{host}",
        f"mkdir -p {shlex.quote(remote_parent)}",
    ]
    copy_cmd = [
        "sshpass",
        "-p",
        password,
        "scp",
        "-P",
        str(port),
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "ConnectTimeout=8",
        local_abs,
        f"{username}@{host}:{remote_abs}",
    ]
    _run_subprocess(mkdir_cmd, "远程创建目录失败", 25)
    _run_subprocess(copy_cmd, "远程上传视频失败", 40)
    encoded_rel = "/".join(quote(part) for part in static_rel.split("/"))
    return f"{remote_base_url}/{encoded_rel}"


def _public_static_url(request: Request, static_url: str) -> str:
    normalized = str(static_url or "").strip()
    if not normalized.startswith("/static/"):
        raise RuntimeError("静态文件地址无效")
    base_url = str(os.getenv("KLING_PUBLIC_BASE_URL") or os.getenv("PUBLIC_BASE_URL") or "").strip().rstrip("/")
    if not base_url:
        forwarded_host = str(request.headers.get("x-forwarded-host") or "").strip().split(",", 1)[0].strip()
        if forwarded_host:
            forwarded_proto = str(request.headers.get("x-forwarded-proto") or "https").strip().split(",", 1)[0].strip()
            proto = forwarded_proto if forwarded_proto in {"http", "https"} else "https"
            base_url = f"{proto}://{forwarded_host}".rstrip("/")
    if not base_url:
        base_url = str(request.base_url).rstrip("/")
    if base_url.endswith("/api"):
        base_url = base_url[:-4]
    if base_url:
        validation_error = _validate_public_base_url(base_url)
        if not validation_error:
            return f"{base_url}{normalized}"
    uploaded_url = _publish_static_to_remote(normalized)
    if uploaded_url:
        return uploaded_url
    if not base_url:
        raise RuntimeError("静态文件公网地址无效，请配置 KLING_PUBLIC_BASE_URL（或 PUBLIC_BASE_URL）")
    validation_error = _validate_public_base_url(base_url)
    if validation_error:
        raise RuntimeError(f"{validation_error}；或配置远程上传参数 SFX_REMOTE_UPLOAD_* 自动发布文件")
    return f"{base_url}{normalized}"


async def _clip_sfx_video(project_id: str, metadata: dict[str, Any], job_id: str, start_sec_raw: float, end_sec_raw: float) -> tuple[str, str]:
    merged_video_url = str(metadata.get("merged_video_url") or "").strip()
    if not merged_video_url:
        raise RuntimeError("请先提取配音任务，缺少可截取视频")
    source_video_path = _resolve_static_video_path(merged_video_url)
    total_duration = max(float(metadata.get("duration_sec") or 0.0), _probe_duration_seconds(source_video_path))
    if total_duration <= 0:
        raise RuntimeError("当前视频时长无效")
    start_sec = max(0.0, min(total_duration, float(start_sec_raw)))
    end_sec = max(0.0, min(total_duration, float(end_sec_raw)))
    if end_sec <= start_sec:
        raise RuntimeError("截取区间无效")
    clip_duration = end_sec - start_sec
    if clip_duration < SFX_MIN_DURATION_SEC or clip_duration > SFX_MAX_DURATION_SEC:
        raise RuntimeError(f"截取时长需在 {SFX_MIN_DURATION_SEC} 到 {SFX_MAX_DURATION_SEC} 秒之间")
    _ensure_ffmpeg()
    job_dir = _job_dir(project_id, job_id)
    sfx_dir = os.path.join(job_dir, "sfx")
    os.makedirs(sfx_dir, exist_ok=True)
    clip_path = os.path.join(sfx_dir, f"sfx_clip_{int(round(start_sec * 1000))}_{int(round(end_sec * 1000))}.mp4")
    await asyncio.to_thread(
        _run_subprocess,
        [
            "ffmpeg",
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-ss",
            f"{start_sec:.3f}",
            "-i",
            source_video_path,
            "-t",
            f"{clip_duration:.3f}",
            "-an",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "23",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            "-y",
            clip_path,
        ],
        "截取音效视频失败",
    )
    if not os.path.exists(clip_path) or os.path.getsize(clip_path) <= 0:
        raise RuntimeError("截取音效视频失败：未生成有效文件")
    if os.path.getsize(clip_path) > 100 * 1024 * 1024:
        raise RuntimeError("截取视频大小超过 100MB")
    return clip_path, await _publish_static_file(project_id, clip_path)


async def _clip_sfx_video_with_name(
    project_id: str,
    metadata: dict[str, Any],
    job_id: str,
    start_sec_raw: float,
    end_sec_raw: float,
    file_name: str,
) -> tuple[str, str]:
    merged_video_url = str(metadata.get("merged_video_url") or "").strip()
    if not merged_video_url:
        raise RuntimeError("请先提取配音任务，缺少可截取视频")
    source_video_path = _resolve_static_video_path(merged_video_url)
    total_duration = max(float(metadata.get("duration_sec") or 0.0), _probe_duration_seconds(source_video_path))
    if total_duration <= 0:
        raise RuntimeError("当前视频时长无效")
    start_sec = max(0.0, min(total_duration, float(start_sec_raw)))
    end_sec = max(0.0, min(total_duration, float(end_sec_raw)))
    if end_sec <= start_sec:
        raise RuntimeError("截取区间无效")
    clip_duration = end_sec - start_sec
    if clip_duration < SFX_MIN_DURATION_SEC or clip_duration > SFX_MAX_DURATION_SEC:
        raise RuntimeError(f"截取时长需在 {SFX_MIN_DURATION_SEC} 到 {SFX_MAX_DURATION_SEC} 秒之间")
    safe_name = re.sub(r"[^a-zA-Z0-9_.-]+", "_", str(file_name or "").strip()).strip("._")
    if not safe_name:
        raise RuntimeError("截取文件名无效")
    if not safe_name.lower().endswith(".mp4"):
        safe_name = f"{safe_name}.mp4"
    _ensure_ffmpeg()
    job_dir = _job_dir(project_id, job_id)
    sfx_dir = os.path.join(job_dir, "sfx")
    os.makedirs(sfx_dir, exist_ok=True)
    clip_path = os.path.join(sfx_dir, safe_name)
    await asyncio.to_thread(
        _run_subprocess,
        [
            "ffmpeg",
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-ss",
            f"{start_sec:.3f}",
            "-i",
            source_video_path,
            "-t",
            f"{clip_duration:.3f}",
            "-an",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "23",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            "-y",
            clip_path,
        ],
        "截取音效视频失败",
    )
    if not os.path.exists(clip_path) or os.path.getsize(clip_path) <= 0:
        raise RuntimeError("截取音效视频失败：未生成有效文件")
    if os.path.getsize(clip_path) > 100 * 1024 * 1024:
        raise RuntimeError("截取视频大小超过 100MB")
    return clip_path, await _publish_static_file(project_id, clip_path)


def _normalize_sfx_split_points(split_points: list[float], duration_sec: float) -> list[float]:
    safe_duration = float(duration_sec or 0.0)
    if safe_duration <= 0:
        return []
    values = [float(item) for item in split_points if isinstance(item, (int, float)) and math.isfinite(float(item))]
    return sorted(
        set(
            round(value, 3)
            for value in values
            if value > 0.0 and value < safe_duration
        )
    )


def _build_sfx_segments_from_points(split_points: list[float], duration_sec: float) -> list[dict[str, float]]:
    safe_duration = float(duration_sec or 0.0)
    if safe_duration <= 0:
        return []
    normalized_points = _normalize_sfx_split_points(split_points, safe_duration)
    if not normalized_points:
        return []
    boundaries = [0.0, *normalized_points, round(safe_duration, 3)]
    segments: list[dict[str, float]] = []
    for index, start_sec in enumerate(boundaries[:-1]):
        end_sec = float(boundaries[index + 1])
        duration = round(end_sec - float(start_sec), 3)
        if duration <= 0:
            continue
        segments.append(
            {
                "segment_index": int(index),
                "start_sec": round(float(start_sec), 3),
                "end_sec": round(end_sec, 3),
                "duration_sec": duration,
            }
        )
    return segments


def _extract_audio_with_fallback(video_path: str, wav_path: str, mp3_fallback_path: str) -> None:
    attempts: list[tuple[str, list[str]]] = [
        (
            "直出 WAV",
            [
                "ffmpeg",
                "-nostdin",
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                video_path,
                "-vn",
                "-ac",
                "1",
                "-ar",
                "44100",
                "-c:a",
                "pcm_s16le",
                "-f",
                "wav",
                "-y",
                wav_path,
            ],
        ),
        (
            "先出 MP3",
            [
                "ffmpeg",
                "-nostdin",
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                video_path,
                "-vn",
                "-ac",
                "1",
                "-ar",
                "44100",
                "-c:a",
                "libmp3lame",
                "-y",
                mp3_fallback_path,
            ],
        ),
    ]
    errors: list[str] = []
    first_detail = _run_subprocess_detail(attempts[0][1])
    if first_detail is None and os.path.exists(wav_path) and os.path.getsize(wav_path) > 0:
        return
    if first_detail:
        errors.append(f"{attempts[0][0]}: {first_detail}")
    second_detail = _run_subprocess_detail(attempts[1][1])
    if second_detail is None and os.path.exists(mp3_fallback_path) and os.path.getsize(mp3_fallback_path) > 0:
        convert_detail = _run_subprocess_detail(
            [
                "ffmpeg",
                "-nostdin",
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                mp3_fallback_path,
                "-ac",
                "1",
                "-ar",
                "44100",
                "-c:a",
                "pcm_s16le",
                "-f",
                "wav",
                "-y",
                wav_path,
            ]
        )
        if convert_detail is None and os.path.exists(wav_path) and os.path.getsize(wav_path) > 0:
            return
        if convert_detail:
            errors.append(f"MP3 转 WAV: {convert_detail}")
    elif second_detail:
        errors.append(f"{attempts[1][0]}: {second_detail}")
    merged = " | ".join(errors) if errors else "命令执行失败"
    raise RuntimeError(f"提取音频失败：{merged[:300]}")


def _probe_duration_seconds(path: str) -> float:
    try:
        probe = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path],
            capture_output=True,
            text=True,
        )
        if probe.returncode != 0:
            return 0.0
        try:
            return max(0.0, float(str(probe.stdout or "0").strip()))
        except ValueError:
            return 0.0
    except FileNotFoundError:
        return 0.0


def _probe_has_audio_stream(path: str) -> bool:
    try:
        probe = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", path],
            capture_output=True,
            text=True,
        )
        if probe.returncode != 0:
            return False
        return bool(str(probe.stdout or "").strip())
    except FileNotFoundError:
        return False


def _should_rebuild_merged_cache(merged_path: str, clip_urls: list[str]) -> bool:
    if not os.path.exists(merged_path) or os.path.getsize(merged_path) <= 0:
        return True
    if not clip_urls:
        return False
    merged_duration = _probe_duration_seconds(merged_path)
    clip_durations = [_probe_duration_seconds(url) for url in clip_urls]
    total_clip_duration = sum(item for item in clip_durations if item > 0)
    if total_clip_duration > 0 and abs(merged_duration - total_clip_duration) > 1.0:
        return True
    if _probe_has_audio_stream(merged_path):
        return False
    return any(_probe_has_audio_stream(url) for url in clip_urls)


def _extract_silence_ranges(audio_path: str) -> list[tuple[float, float]]:
    cmd = [
        "ffmpeg",
        "-i",
        audio_path,
        "-af",
        "silencedetect=n=-35dB:d=0.35",
        "-f",
        "null",
        "-",
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            return []
    except FileNotFoundError:
        return []
    text = f"{result.stdout}\n{result.stderr}"
    starts = [float(v) for v in re.findall(r"silence_start:\s*([0-9.]+)", text)]
    ends = [float(v) for v in re.findall(r"silence_end:\s*([0-9.]+)", text)]
    ranges: list[tuple[float, float]] = []
    for index, start in enumerate(starts):
        end = ends[index] if index < len(ends) else start
        if end > start:
            ranges.append((start, end))
    return ranges


def _normalize_split_points(split_points: list[float], duration_sec: float) -> list[float]:
    if duration_sec <= 0:
        return []
    values = [float(item) for item in split_points if isinstance(item, (int, float)) and math.isfinite(float(item))]
    if len(values) < 2:
        return [0.0, round(duration_sec, 3)]
    sorted_values = sorted(values)
    start = max(0.0, min(duration_sec, sorted_values[0]))
    end = max(0.0, min(duration_sec, sorted_values[-1]))
    min_gap = 0.2
    if end - start < min_gap:
        if end >= duration_sec:
            start = max(0.0, end - min_gap)
        else:
            end = min(duration_sec, start + min_gap)
    if end - start < min_gap:
        return [0.0, round(duration_sec, 3)]
    return [round(start, 3), round(end, 3)]


def _build_auto_split_points(vocal_audio_path: str, duration_sec: float) -> list[float]:
    if duration_sec <= 0:
        return []
    silence_ranges = _extract_silence_ranges(vocal_audio_path)
    split_points: list[float] = []
    for silence_start, silence_end in silence_ranges:
        silence_duration = silence_end - silence_start
        if silence_duration < 0.2:
            continue
        split_points.append((silence_start + silence_end) / 2.0)
    if not split_points and duration_sec > 12:
        split_points = [duration_sec / 2.0]
    return _normalize_split_points(split_points, duration_sec)


def _build_segments_from_splits(split_points: list[float], duration_sec: float, segment_index: int = 1) -> list[dict[str, Any]]:
    if duration_sec <= 0:
        return []
    start_sec, end_sec = _normalize_split_points(split_points, duration_sec)
    if end_sec - start_sec < 0.2:
        return []
    safe_index = max(1, int(segment_index))
    return [
        {
            "id": f"seg-{safe_index:03d}",
            "index": safe_index,
            "start_sec": start_sec,
            "end_sec": end_sec,
            "speaker_label": f"角色{safe_index}",
            "source_audio_url": "",
            "isolated_audio_url": "",
            "dubbed_audio_url": "",
        }
    ]


def _format_elevenlabs_runtime_error(err: RuntimeError) -> str:
    raw = str(err)
    lower = raw.lower()
    if "paid_plan_required" in lower or "payment_required" in lower:
        if "library voices" in lower:
            return "当前 ElevenLabs 账号套餐不支持使用 Library 音色做 S2S，请切换为自有/克隆音色后重试。"
        return "当前 ElevenLabs 账号套餐暂不支持该语音能力，请升级套餐或切换可用音色后重试。"
    if "voice_not_found" in lower:
        return "所选 ElevenLabs 音色不可用，请重新选择音色后重试。"
    return raw


def _generate_waveform_peaks(audio_path: str, bars: int = 240) -> list[float]:
    if bars <= 0:
        return []
    try:
        with wave.open(audio_path, "rb") as wf:
            frame_count = wf.getnframes()
            if frame_count <= 0:
                return [0.0] * bars
            raw = wf.readframes(frame_count)
            sample_width = wf.getsampwidth()
            channels = wf.getnchannels()
            if sample_width != 2:
                return [0.0] * bars
            import struct

            sample_count = frame_count * channels
            samples = struct.unpack("<" + "h" * sample_count, raw)
            mono = samples if channels == 1 else samples[::channels]
            if not mono:
                return [0.0] * bars
            chunk = max(1, len(mono) // bars)
            peaks: list[float] = []
            for idx in range(0, len(mono), chunk):
                part = mono[idx : idx + chunk]
                if not part:
                    continue
                peak = max(abs(v) for v in part) / 32768.0
                peaks.append(round(min(1.0, peak), 4))
            if len(peaks) < bars:
                peaks.extend([0.0] * (bars - len(peaks)))
            return peaks[:bars]
    except Exception:
        return [0.0] * bars


async def _write_metadata(project_id: str, job_id: str, payload: dict[str, Any]) -> None:
    metadata_file = _metadata_path(project_id, job_id)
    async with aiofiles.open(metadata_file, "w", encoding="utf-8") as file:
        await file.write(json.dumps(payload, ensure_ascii=False))


async def _read_metadata(project_id: str, job_id: str) -> dict[str, Any]:
    metadata_file = _metadata_path(project_id, job_id)
    if not os.path.exists(metadata_file):
        raise RuntimeError("未找到音频处理任务")
    async with aiofiles.open(metadata_file, "r", encoding="utf-8") as file:
        text = await file.read()
    try:
        payload = json.loads(text)
    except json.JSONDecodeError as exc:
        raise RuntimeError("音频处理任务数据损坏") from exc
    if not isinstance(payload, dict):
        raise RuntimeError("音频处理任务数据无效")
    return payload


def _merge_local_videos(temp_dir: str, local_paths: list[str], output_path: str) -> None:
    normalized_paths: list[str] = []
    for index, path in enumerate(local_paths, start=1):
        normalized_path = os.path.join(temp_dir, f"normalized_{index:03d}.mp4")
        if _probe_has_audio_stream(path):
            _run_subprocess(
                [
                    "ffmpeg",
                    "-i",
                    path,
                    "-map",
                    "0:v:0",
                    "-map",
                    "0:a:0",
                    "-c:v",
                    "libx264",
                    "-preset",
                    "veryfast",
                    "-crf",
                    "23",
                    "-pix_fmt",
                    "yuv420p",
                    "-c:a",
                    "aac",
                    "-ac",
                    "1",
                    "-ar",
                    "44100",
                    "-movflags",
                    "+faststart",
                    "-y",
                    normalized_path,
                ],
                "规范化视频失败",
            )
        else:
            _run_subprocess(
                [
                    "ffmpeg",
                    "-i",
                    path,
                    "-f",
                    "lavfi",
                    "-i",
                    "anullsrc=r=44100:cl=mono",
                    "-map",
                    "0:v:0",
                    "-map",
                    "1:a:0",
                    "-c:v",
                    "libx264",
                    "-preset",
                    "veryfast",
                    "-crf",
                    "23",
                    "-pix_fmt",
                    "yuv420p",
                    "-c:a",
                    "aac",
                    "-ac",
                    "1",
                    "-ar",
                    "44100",
                    "-shortest",
                    "-movflags",
                    "+faststart",
                    "-y",
                    normalized_path,
                ],
                "补齐静音轨失败",
            )
        normalized_paths.append(normalized_path)
    concat_txt_path = os.path.join(temp_dir, "concat.txt")
    concat_lines: list[str] = []
    for path in normalized_paths:
        escaped_path = path.replace("'", "'\\''")
        concat_lines.append(f"file '{escaped_path}'")
    with open(concat_txt_path, "w", encoding="utf-8") as file:
        file.write("\n".join(concat_lines))
    encode_cmd = [
        "ffmpeg",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        concat_txt_path,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "23",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-ac",
        "1",
        "-ar",
        "44100",
        "-movflags",
        "+faststart",
        "-y",
        output_path,
    ]
    try:
        encode_result = subprocess.run(encode_cmd, capture_output=True, text=True)
        if encode_result.returncode != 0:
            stderr_text = str(encode_result.stderr or "").strip()
            lines = [line.strip() for line in stderr_text.splitlines() if line.strip()]
            detail = lines[-1] if lines else "命令执行失败"
            raise RuntimeError(f"合并失败：{detail[:300]}")
    except FileNotFoundError:
        raise RuntimeError("合并失败：找不到 ffmpeg 命令")


async def _cut_segment_files_async(project_id: str, metadata: dict[str, Any]) -> dict[str, Any]:
    job_id = str(metadata.get("job_id") or "").strip()
    if not job_id:
        raise RuntimeError("任务数据缺少 job_id")
    vocal_audio_url = str(metadata.get("vocal_audio_url") or "").strip()
    if not (
        vocal_audio_url.startswith("/static/")
        or vocal_audio_url.startswith(("http://", "https://"))
    ):
        raise RuntimeError("任务数据缺少人声文件")
    if vocal_audio_url.startswith("/static/"):
        vocal_audio_path = os.path.join(_backend_static_dir(), vocal_audio_url.replace("/static/", "", 1))
        if not os.path.exists(vocal_audio_path):
            raise RuntimeError("人声音频文件不存在")
    else:
        vocal_audio_path = vocal_audio_url
    segments = metadata.get("segments")
    if not isinstance(segments, list) or not segments:
        raise RuntimeError("缺少可切分片段")
    segment_dir = os.path.join(_job_dir(project_id, job_id), "segments")
    os.makedirs(segment_dir, exist_ok=True)
    for item in segments:
        if not isinstance(item, dict):
            continue
        segment_id = str(item.get("id") or "").strip()
        start_sec = float(item.get("start_sec") or 0.0)
        end_sec = float(item.get("end_sec") or 0.0)
        if not segment_id or end_sec <= start_sec:
            continue
        start_ms = int(round(start_sec * 1000))
        end_ms = int(round(end_sec * 1000))
        file_path = os.path.join(segment_dir, f"{segment_id}_{start_ms}_{end_ms}.wav")
        _run_subprocess(
            [
                "ffmpeg",
                "-i",
                vocal_audio_path,
                "-ss",
                f"{start_sec:.3f}",
                "-to",
                f"{end_sec:.3f}",
                "-ac",
                "1",
                "-ar",
                "44100",
                "-c:a",
                "pcm_s16le",
                "-y",
                file_path,
            ],
            "切分音频失败",
        )
        item["source_audio_url"] = await _publish_static_file(project_id, file_path)
    return metadata


async def _download_video(url: str, target_path: str) -> None:
    normalized_url = str(url or "").strip()
    if normalized_url.startswith("/static/"):
        source_path = _resolve_static_video_path(normalized_url)
        await asyncio.to_thread(shutil.copyfile, source_path, target_path)
        return
    if "/static/" in normalized_url:
        parsed = urlparse(normalized_url)
        if parsed.path.startswith("/static/"):
            source_path = _resolve_static_video_path(parsed.path)
            await asyncio.to_thread(shutil.copyfile, source_path, target_path)
            return
    try:
        async with httpx.AsyncClient(timeout=180.0, trust_env=False, follow_redirects=True) as client:
            response = await client.get(normalized_url)
        if response.status_code != 200:
            raise RuntimeError(f"下载视频失败：{response.status_code}")
        content = response.content
        if not content:
            raise RuntimeError("下载视频失败：空内容")
        async with aiofiles.open(target_path, "wb") as file:
            await file.write(content)
    except httpx.RequestError as exc:
        raise RuntimeError(f"下载视频失败：网络连接错误 ({type(exc).__name__})") from exc


async def _prepare_merged_video(project_id: str, clip_urls: list[str], episode_title: Optional[str] = None) -> tuple[str, str, bool]:
    merge_key = _build_merge_key(clip_urls, episode_title)
    merged_dir = _merge_storage_dir(project_id)
    os.makedirs(merged_dir, exist_ok=True)
    merged_path = _merged_video_path(project_id, merge_key)
    if os.path.exists(merged_path) and os.path.getsize(merged_path) > 0:
        needs_rebuild = await asyncio.to_thread(_should_rebuild_merged_cache, merged_path, clip_urls)
        if not needs_rebuild:
            return merge_key, merged_path, True
        try:
            os.remove(merged_path)
        except OSError:
            pass
    temp_dir = tempfile.mkdtemp(prefix="episode_merge_store_")
    try:
        _ensure_ffmpeg()
        work_output_path = os.path.join(temp_dir, "merged_output.mp4")
        local_paths: list[str] = []
        for index, url in enumerate(clip_urls, start=1):
            local_path = os.path.join(temp_dir, f"clip_{index:03d}.mp4")
            await _download_video(url, local_path)
            local_paths.append(local_path)
        await asyncio.to_thread(_merge_local_videos, temp_dir, local_paths, work_output_path)
        if not os.path.exists(work_output_path) or os.path.getsize(work_output_path) <= 0:
            raise RuntimeError("合并失败：未生成有效视频文件")
        await asyncio.to_thread(shutil.copyfile, work_output_path, merged_path)
        if not os.path.exists(merged_path) or os.path.getsize(merged_path) <= 0:
            raise RuntimeError("合并失败：未生成有效视频文件")
        return merge_key, merged_path, False
    finally:
        _cleanup_temp_dir(temp_dir)


@router.post("/{project_id}/episodes/merge-download")
async def merge_episode_download(
    project_id: str,
    payload: EpisodeMergeDownloadRequest,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
) -> FileResponse:
    project = await get_project(db, user_id, project_id)
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    clip_urls = [str(item or "").strip() for item in payload.clip_urls if str(item or "").strip()]
    if not clip_urls:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="缺少可合并的视频地址")
    for url in clip_urls:
        if not (url.startswith("http://") or url.startswith("https://") or url.startswith("/static/")):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="视频地址格式不合法")

    temp_dir = tempfile.mkdtemp(prefix="episode_merge_")
    concat_txt_path = os.path.join(temp_dir, "concat.txt")
    output_path = os.path.join(temp_dir, "output.mp4")
    try:
        local_paths: list[str] = []
        for index, url in enumerate(clip_urls, start=1):
            local_path = os.path.join(temp_dir, f"clip_{index:03d}.mp4")
            await _download_video(url, local_path)
            local_paths.append(local_path)

        concat_lines: list[str] = []
        for path in local_paths:
            escaped_path = path.replace("'", "'\\''")
            concat_lines.append(f"file '{escaped_path}'")
        async with aiofiles.open(concat_txt_path, "w", encoding="utf-8") as file:
            await file.write("\n".join(concat_lines))

        try:
            probe = await asyncio.to_thread(subprocess.run, ["ffmpeg", "-version"], capture_output=True, text=True)
            if probe.returncode != 0:
                raise RuntimeError("未检测到 ffmpeg，无法执行自动合并")
        except FileNotFoundError:
            raise RuntimeError("系统未安装 ffmpeg 或未配置环境变量")

        copy_cmd = [
            "ffmpeg",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            concat_txt_path,
            "-c",
            "copy",
            "-movflags",
            "+faststart",
            "-y",
            output_path,
        ]
        try:
            copy_result = await asyncio.to_thread(subprocess.run, copy_cmd, capture_output=True, text=True)
        except FileNotFoundError:
            raise RuntimeError("找不到 ffmpeg 命令")
        if copy_result.returncode != 0:
            encode_cmd = [
                "ffmpeg",
                "-f",
                "concat",
                "-safe",
                "0",
                "-i",
                concat_txt_path,
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                "23",
                "-c:a",
                "aac",
                "-movflags",
                "+faststart",
                "-y",
                output_path,
            ]
            try:
                encode_result = await asyncio.to_thread(subprocess.run, encode_cmd, capture_output=True, text=True)
                if encode_result.returncode != 0:
                    stderr_text = str(encode_result.stderr or copy_result.stderr or "").strip()
                    lines = [line.strip() for line in stderr_text.splitlines() if line.strip()]
                    detail = lines[-1] if lines else "命令执行失败"
                    raise RuntimeError(f"合并失败：{detail[:300]}")
            except FileNotFoundError:
                raise RuntimeError("找不到 ffmpeg 命令")

        if not os.path.exists(output_path) or os.path.getsize(output_path) <= 0:
            raise RuntimeError("合并失败：未生成有效视频文件")

        filename = f"{_sanitize_download_filename(payload.episode_title or 'episode')}.mp4"
        return FileResponse(
            path=output_path,
            media_type="video/mp4",
            filename=filename,
            background=BackgroundTask(_cleanup_temp_dir, temp_dir),
        )
    except RuntimeError as exc:
        _cleanup_temp_dir(temp_dir)
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except Exception as exc:
        _cleanup_temp_dir(temp_dir)
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="分集合并失败") from exc


@router.post("/{project_id}/episodes/merge-store")
async def merge_episode_store(
    project_id: str,
    payload: EpisodeMergeDownloadRequest,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
):
    project = await get_project(db, user_id, project_id)
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    clip_urls = [str(item or "").strip() for item in payload.clip_urls if str(item or "").strip()]
    if not clip_urls:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="缺少可合并的视频地址")
    for url in clip_urls:
        if not (url.startswith("http://") or url.startswith("https://") or url.startswith("/static/")):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="视频地址格式不合法")
    try:
        merge_key, merged_path, existed = await _prepare_merged_video(project_id, clip_urls, payload.episode_title)
        return {
            "merge_key": merge_key,
            "merged_video_url": await _publish_static_file(project_id, merged_path),
            "already_exists": existed,
            "episode_title": payload.episode_title or "episode",
        }
    except RuntimeError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="服务端合并失败") from exc


@router.post("/{project_id}/episodes/audio-pipeline/extract")
async def extract_episode_audio_pipeline(
    project_id: str,
    payload: EpisodeAudioExtractRequest,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
):
    project = await get_project(db, user_id, project_id)
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    clip_urls = [str(item or "").strip() for item in payload.clip_urls if str(item or "").strip()]
    merge_key = str(payload.merge_key or "").strip()
    if not merge_key and not clip_urls:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="缺少可处理的视频地址")
    for url in clip_urls:
        if not (url.startswith("http://") or url.startswith("https://") or url.startswith("/static/")):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="视频地址格式不合法")
    if clip_urls:
        merge_key = _build_merge_key(clip_urls, payload.episode_title)
    job_id = str(uuid.uuid4())
    job_dir = _job_dir(project_id, job_id)
    os.makedirs(job_dir, exist_ok=True)
    work_dir = tempfile.mkdtemp(prefix="episode_audio_work_")
    try:
        merged_video_path = os.path.join(job_dir, "merged.mp4")
        source_audio_path = os.path.join(job_dir, "source.wav")
        vocal_audio_path = os.path.join(job_dir, "vocals.wav")
        work_merged_video_path = os.path.join(work_dir, "merged.mp4")
        work_source_audio_path = os.path.join(work_dir, "source.wav")
        source_merged_path = ""
        if merge_key:
            if not _is_valid_merge_key(merge_key):
                raise RuntimeError("merge_key 格式不合法")
            candidate = _merged_video_path(project_id, merge_key)
            if os.path.exists(candidate) and os.path.getsize(candidate) > 0:
                source_merged_path = candidate
        if not source_merged_path:
            if not clip_urls:
                raise RuntimeError("未找到可复用的合并视频，请先执行一键合并视频")
            merge_key, source_merged_path, _ = await _prepare_merged_video(project_id, clip_urls, payload.episode_title)
        await asyncio.to_thread(shutil.copyfile, source_merged_path, work_merged_video_path)
        has_audio_stream = await asyncio.to_thread(_probe_has_audio_stream, work_merged_video_path)
        if has_audio_stream:
            work_source_audio_mp3_path = os.path.join(work_dir, "source.mp3")
            await asyncio.to_thread(_extract_audio_with_fallback, work_merged_video_path, work_source_audio_path, work_source_audio_mp3_path)
        else:
            duration_for_silence = max(0.5, _probe_duration_seconds(work_merged_video_path))
            await asyncio.to_thread(
                _run_subprocess,
                [
                    "ffmpeg",
                    "-f",
                    "lavfi",
                    "-i",
                    "anullsrc=r=44100:cl=mono",
                    "-t",
                    f"{duration_for_silence:.3f}",
                    "-ac",
                    "1",
                    "-ar",
                    "44100",
                    "-c:a",
                    "pcm_s16le",
                    "-y",
                    work_source_audio_path,
                ],
                "视频不包含可提取音轨，生成静音轨失败",
            )
        await asyncio.to_thread(shutil.copyfile, source_merged_path, merged_video_path)
        await asyncio.to_thread(shutil.copyfile, work_source_audio_path, source_audio_path)
        await asyncio.to_thread(shutil.copyfile, work_source_audio_path, vocal_audio_path)
        duration_sec = _probe_duration_seconds(source_audio_path)
        split_points = _normalize_split_points([0.0, duration_sec], duration_sec)
        segments: list[dict[str, Any]] = []
        waveform = _generate_waveform_peaks(source_audio_path)
        metadata = {
            "job_id": job_id,
            "project_id": project_id,
            "episode_title": payload.episode_title or "episode",
            "created_at": datetime.utcnow().isoformat(),
            "merge_key": merge_key,
            "merged_video_url": await _publish_static_file(project_id, merged_video_path),
            "source_audio_url": await _publish_static_file(project_id, source_audio_path),
            "vocal_audio_url": await _publish_static_file(project_id, vocal_audio_path),
            "original_isolated_audio_url": "",
            "duration_sec": duration_sec,
            "waveform": waveform,
            "split_points": split_points,
            "segments": segments,
            "sfx_clip_video_url": "",
            "sfx_audio_url": "",
            "sfx_video_url": "",
            "sfx_segment_results": [],
            "sfx_background_sound_prompt": "",
            "sfx_soundtrack_prompt": "",
            "sfx_asmr_mode": False,
            "sfx_task_id": "",
            "sfx_status": "",
            "sfx_task_created_at": "",
            "sfx_task_updated_at": "",
            "bgm_audio_url": "",
            "bgm_segment_results": [],
            "bgm_segment_index": 0,
            "bgm_start_sec": 0.0,
            "bgm_end_sec": 0.0,
            "bgm_status": "",
            "bgm_task_updated_at": "",
        }
        await _write_metadata(project_id, job_id, metadata)
        return metadata
    except RuntimeError as exc:
        _cleanup_temp_dir(job_dir)
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except Exception as exc:
        _cleanup_temp_dir(job_dir)
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="提取配音失败") from exc
    finally:
        _cleanup_temp_dir(work_dir)


@router.post("/{project_id}/episodes/audio-pipeline/update-splits")
async def update_episode_audio_splits(
    project_id: str,
    payload: EpisodeAudioSplitUpdateRequest,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
):
    project = await get_project(db, user_id, project_id)
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    try:
        metadata = await _read_metadata(project_id, payload.job_id)
        duration_sec = float(metadata.get("duration_sec") or 0.0)
        split_points = _normalize_split_points(payload.split_points, duration_sec)
        existing_segments = metadata.get("segments")
        if not isinstance(existing_segments, list):
            existing_segments = []
        next_index = 1
        for segment in existing_segments:
            if not isinstance(segment, dict):
                continue
            value = segment.get("index")
            if isinstance(value, (int, float)):
                next_index = max(next_index, int(value) + 1)
        new_segments = _build_segments_from_splits(split_points, duration_sec, next_index)
        if not new_segments:
            raise RuntimeError("分割区间无效，无法创建分段音频")
        metadata["split_points"] = split_points
        metadata["segments"] = [*existing_segments, *new_segments]
        updated = await _cut_segment_files_async(project_id, metadata)
        await _write_metadata(project_id, payload.job_id, updated)
        return updated
    except RuntimeError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="更新分割点失败") from exc


@router.post("/{project_id}/episodes/audio-pipeline/generate-segments")
async def generate_episode_audio_segments(
    project_id: str,
    payload: EpisodeAudioGenerateSegmentsRequest,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
):
    project = await get_project(db, user_id, project_id)
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    try:
        metadata = await _read_metadata(project_id, payload.job_id)
        updated = await _cut_segment_files_async(project_id, metadata)
        await _write_metadata(project_id, payload.job_id, updated)
        return updated
    except RuntimeError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="生成分段配音失败") from exc


@router.post("/{project_id}/episodes/audio-pipeline/s2s")
async def generate_episode_segment_s2s(
    project_id: str,
    payload: EpisodeAudioS2SRequest,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
):
    project = await get_project(db, user_id, project_id)
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    try:
        metadata = await _read_metadata(project_id, payload.job_id)
        segments = metadata.get("segments")
        if not isinstance(segments, list):
            raise RuntimeError("任务分段数据无效")
        target_segment = None
        for item in segments:
            if isinstance(item, dict) and str(item.get("id") or "").strip() == payload.segment_id:
                target_segment = item
                break
        if not target_segment:
            raise RuntimeError("未找到对应分段")
        source_url = str(target_segment.get("source_audio_url") or "").strip()
        if not (
            source_url.startswith("/static/")
            or source_url.startswith(("http://", "https://"))
        ):
            raise RuntimeError("请先应用分割点生成分段音频")
        source_audio = await load_media_bytes(source_url)
        if not source_audio:
            raise RuntimeError("分段音频为空")
        audio_content = await eleven_labs_service.speech_to_speech(
            audio_bytes=source_audio,
            voice_id=payload.voice_id,
            filename=f"{payload.segment_id}.wav",
            model_id=str(payload.model_id or "eleven_v3").strip() or "eleven_v3",
            settings=payload.settings if isinstance(payload.settings, dict) else {},
        )
        job_id = str(metadata.get("job_id") or "").strip()
        segment_dir = os.path.join(_job_dir(project_id, job_id), "segments")
        os.makedirs(segment_dir, exist_ok=True)
        dubbed_path = os.path.join(segment_dir, f"{payload.segment_id}_dubbed.mp3")
        async with aiofiles.open(dubbed_path, "wb") as file:
            await file.write(audio_content)
        dubbed_url = await _publish_static_file(project_id, dubbed_path)
        target_segment["dubbed_audio_url"] = dubbed_url
        await _write_metadata(project_id, payload.job_id, metadata)
        return metadata
    except RuntimeError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=_format_elevenlabs_runtime_error(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="分段音色生成失败") from exc


@router.post("/{project_id}/episodes/audio-pipeline/extract-original-vocal")
async def extract_episode_original_vocal(
    project_id: str,
    payload: EpisodeAudioOriginalVocalExtractRequest,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
):
    project = await get_project(db, user_id, project_id)
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    try:
        metadata = await _read_metadata(project_id, payload.job_id)
        source_url = str(metadata.get("source_audio_url") or "").strip()
        if not (
            source_url.startswith("/static/")
            or source_url.startswith(("http://", "https://"))
        ):
            raise RuntimeError("请先提取原始音轨")
        source_audio = await load_media_bytes(source_url)
        if not source_audio:
            raise RuntimeError("原始音轨为空")
        isolated_audio = await eleven_labs_service.isolate_audio(
            audio_bytes=source_audio,
            filename="original.wav",
            file_format="other",
        )
        job_id = str(metadata.get("job_id") or "").strip()
        if not job_id:
            raise RuntimeError("任务数据缺少 job_id")
        job_dir = _job_dir(project_id, job_id)
        os.makedirs(job_dir, exist_ok=True)
        isolated_mp3_path = os.path.join(job_dir, "original_isolated.mp3")
        isolated_wav_path = os.path.join(job_dir, "original_isolated.wav")
        async with aiofiles.open(isolated_mp3_path, "wb") as file:
            await file.write(isolated_audio)
        await asyncio.to_thread(
            _run_subprocess,
            [
                "ffmpeg",
                "-i",
                isolated_mp3_path,
                "-ac",
                "1",
                "-ar",
                "44100",
                "-c:a",
                "pcm_s16le",
                "-y",
                isolated_wav_path,
            ],
            "转换原始人声音频失败",
        )
        isolated_url = await _publish_static_file(project_id, isolated_wav_path)
        metadata["original_isolated_audio_url"] = isolated_url
        metadata["vocal_audio_url"] = isolated_url
        metadata["waveform"] = _generate_waveform_peaks(isolated_wav_path)
        await _write_metadata(project_id, payload.job_id, metadata)
        return metadata
    except RuntimeError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="原始音轨人声提取失败") from exc


@router.post("/{project_id}/episodes/audio-pipeline/delete-segment")
async def delete_episode_audio_segment(
    project_id: str,
    payload: EpisodeAudioSegmentDeleteRequest,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
):
    project = await get_project(db, user_id, project_id)
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    try:
        metadata = await _read_metadata(project_id, payload.job_id)
        segments = metadata.get("segments")
        if not isinstance(segments, list):
            raise RuntimeError("任务分段数据无效")
        target_index = -1
        target_segment: Optional[dict[str, Any]] = None
        for index, item in enumerate(segments):
            if isinstance(item, dict) and str(item.get("id") or "").strip() == payload.segment_id:
                target_index = index
                target_segment = item
                break
        if target_index < 0 or not target_segment:
            raise RuntimeError("未找到对应分段")
        segment_root = os.path.join(_job_dir(project_id, payload.job_id), "segments")
        _safe_remove_static_file(str(target_segment.get("source_audio_url") or ""), segment_root)
        _safe_remove_static_file(str(target_segment.get("isolated_audio_url") or ""), segment_root)
        _safe_remove_static_file(str(target_segment.get("dubbed_audio_url") or ""), segment_root)
        segments.pop(target_index)
        metadata["segments"] = segments
        await _write_metadata(project_id, payload.job_id, metadata)
        return metadata
    except RuntimeError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="删除分段音频失败") from exc


@router.post("/{project_id}/episodes/audio-pipeline/merge-dubbed")
async def merge_episode_dubbed_audio(
    project_id: str,
    payload: EpisodeAudioMergeDubbedRequest,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
):
    project = await get_project(db, user_id, project_id)
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    try:
        metadata = await _read_metadata(project_id, payload.job_id)
        segments = metadata.get("segments")
        if not isinstance(segments, list):
            raise RuntimeError("任务分段数据无效")
        duration_sec = float(metadata.get("duration_sec") or 0.0)
        if duration_sec <= 0:
            raise RuntimeError("原始人声音轨时长无效")
        dubbed_candidates: list[tuple[float, str]] = []
        for item in segments:
            if not isinstance(item, dict):
                continue
            dubbed_url = str(item.get("dubbed_audio_url") or "").strip()
            if not dubbed_url:
                continue
            start_sec = float(item.get("start_sec") or 0.0)
            safe_start = max(0.0, min(duration_sec, start_sec))
            dubbed_path = _resolve_static_audio_path(dubbed_url)
            dubbed_candidates.append((safe_start, dubbed_path))
        if not dubbed_candidates:
            raise RuntimeError("请先完成至少一个分段 S2S")
        _ensure_ffmpeg()
        job_dir = _job_dir(project_id, payload.job_id)
        os.makedirs(job_dir, exist_ok=True)
        merged_path = os.path.join(job_dir, "dubbed_merged.wav")
        input_args: list[str] = [
            "-f",
            "lavfi",
            "-i",
            "anullsrc=r=44100:cl=mono",
        ]
        for _, path in dubbed_candidates:
            input_args.extend(["-i", path])
        filter_parts: list[str] = []
        mix_inputs = ["[0:a]"]
        for index, (start_sec, _) in enumerate(dubbed_candidates, start=1):
            delay_ms = max(0, int(round(start_sec * 1000)))
            label = f"s{index}"
            filter_parts.append(
                f"[{index}:a]aformat=channel_layouts=mono,aresample=44100,"
                f"adelay={delay_ms}|{delay_ms},atrim=0:{duration_sec:.3f}[{label}]"
            )
            mix_inputs.append(f"[{label}]")
        mix_count = len(mix_inputs)
        filter_parts.append(
            f"{''.join(mix_inputs)}amix=inputs={mix_count}:normalize=0:dropout_transition=0[mix]"
        )
        filter_complex = ";".join(filter_parts)
        cmd = [
            "ffmpeg",
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            *input_args,
            "-filter_complex",
            filter_complex,
            "-map",
            "[mix]",
            "-t",
            f"{duration_sec:.3f}",
            "-ac",
            "1",
            "-ar",
            "44100",
            "-c:a",
            "pcm_s16le",
            "-y",
            merged_path,
        ]
        await asyncio.to_thread(_run_subprocess, cmd, "合并配音失败")
        if not os.path.exists(merged_path) or os.path.getsize(merged_path) <= 0:
            raise RuntimeError("合并配音失败：未生成有效音频文件")
        previous_url = str(metadata.get("merged_dubbed_audio_url") or "").strip()
        _safe_remove_static_file(previous_url, job_dir)
        metadata["merged_dubbed_audio_url"] = await _publish_static_file(project_id, merged_path)
        await _write_metadata(project_id, payload.job_id, metadata)
        return metadata
    except RuntimeError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="一键合并配音失败") from exc


@router.post("/{project_id}/episodes/audio-pipeline/mux-dubbed-video")
async def mux_episode_dubbed_video(
    project_id: str,
    payload: EpisodeAudioMuxDubbedVideoRequest,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
):
    project = await get_project(db, user_id, project_id)
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    try:
        metadata = await _read_metadata(project_id, payload.job_id)
        merged_video_url = str(metadata.get("merged_video_url") or "").strip()
        merged_dubbed_audio_url = str(metadata.get("merged_dubbed_audio_url") or "").strip()
        if not merged_video_url:
            raise RuntimeError("未找到可替换音轨的合并视频")
        if not merged_dubbed_audio_url:
            raise RuntimeError("请先执行一键合并配音")
        source_video_path = _resolve_static_video_path(merged_video_url)
        dubbed_audio_path = _resolve_static_audio_path(merged_dubbed_audio_url)
        _ensure_ffmpeg()
        duration_sec = _probe_duration_seconds(source_video_path)
        if duration_sec <= 0:
            raise RuntimeError("合并视频时长无效")
        job_dir = _job_dir(project_id, payload.job_id)
        os.makedirs(job_dir, exist_ok=True)
        mixed_video_path = os.path.join(job_dir, "dubbed_video.mp4")
        cmd = [
            "ffmpeg",
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            source_video_path,
            "-i",
            dubbed_audio_path,
            "-map",
            "0:v:0",
            "-map",
            "1:a:0",
            "-c:v",
            "copy",
            "-c:a",
            "aac",
            "-ac",
            "1",
            "-ar",
            "44100",
            "-af",
            "apad",
            "-t",
            f"{duration_sec:.3f}",
            "-movflags",
            "+faststart",
            "-y",
            mixed_video_path,
        ]
        await asyncio.to_thread(_run_subprocess, cmd, "音视频合成失败")
        if not os.path.exists(mixed_video_path) or os.path.getsize(mixed_video_path) <= 0:
            raise RuntimeError("音视频合成失败：未生成有效视频文件")
        previous_url = str(metadata.get("merged_dubbed_video_url") or "").strip()
        _safe_remove_static_file(previous_url, job_dir)
        metadata["merged_dubbed_video_url"] = await _publish_static_file(project_id, mixed_video_path)
        await _write_metadata(project_id, payload.job_id, metadata)
        return metadata
    except RuntimeError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="音视频合成失败") from exc


@router.post("/{project_id}/episodes/audio-pipeline/generate-sfx")
async def generate_episode_sfx(
    project_id: str,
    payload: EpisodeAudioGenerateSfxRequest,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
):
    project = await get_project(db, user_id, project_id)
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    try:
        metadata = await _read_metadata(project_id, payload.job_id)
        source_video_url = str(payload.source_video_url or "").strip()
        if source_video_url:
            source_video_path = _resolve_static_video_path(source_video_url)
            metadata["merged_video_url"] = source_video_url
            metadata["duration_sec"] = max(
                float(metadata.get("duration_sec") or 0.0),
                _probe_duration_seconds(source_video_path),
            )
        segment_index = max(0, int(payload.segment_index or 0))
        background_sound_prompt = str(payload.background_sound_prompt or "").strip()
        if not background_sound_prompt:
            raise RuntimeError("背景音提示词不能为空")
        if len(background_sound_prompt) > 200:
            raise RuntimeError("背景音提示词不能超过 200 字符")
        job_dir = _job_dir(project_id, payload.job_id)
        sfx_dir = os.path.join(job_dir, "sfx")
        os.makedirs(sfx_dir, exist_ok=True)
        _, clip_static_url = await _clip_sfx_video(
            project_id,
            metadata,
            payload.job_id,
            payload.start_sec,
            payload.end_sec,
        )
        clip_duration = round(max(0.0, float(payload.end_sec) - float(payload.start_sec)), 3)
        if clip_duration < SFX_MIN_DURATION_SEC or clip_duration > SFX_MAX_DURATION_SEC:
            raise RuntimeError(f"截取时长需在 {SFX_MIN_DURATION_SEC} 到 {SFX_MAX_DURATION_SEC} 秒之间")
        LOGGER.warning(
            "Step5 generate-sfx request project_id=%s job_id=%s segment_index=%s start_sec=%s end_sec=%s duration=%s prompt=%s",
            project_id,
            payload.job_id,
            segment_index,
            payload.start_sec,
            payload.end_sec,
            clip_duration,
            background_sound_prompt,
        )
        audio_bytes, content_type = await eleven_labs_service.text_to_sound_effect(
            text=background_sound_prompt,
            duration_seconds=clip_duration,
            model_id="eleven_text_to_sound_v2",
            loop=False,
            prompt_influence=0.3,
        )
        LOGGER.warning(
            "Step5 generate-sfx response project_id=%s job_id=%s segment_index=%s bytes=%s content_type=%s",
            project_id,
            payload.job_id,
            segment_index,
            len(audio_bytes or b""),
            content_type,
        )
        if not audio_bytes:
            raise RuntimeError("ElevenLabs 音效生成失败：未返回音频内容")
        audio_ext = ".mp3"
        if "wav" in content_type:
            audio_ext = ".wav"
        elif "mpeg" in content_type or "mp3" in content_type:
            audio_ext = ".mp3"
        version_suffix = datetime.utcnow().strftime("%Y%m%d%H%M%S%f")
        sfx_audio_path = os.path.join(sfx_dir, f"sfx_audio_{segment_index}_{version_suffix}{audio_ext}")
        async with aiofiles.open(sfx_audio_path, "wb") as file:
            await file.write(audio_bytes)
        next_segment_results: list[dict[str, Any]] = []
        for item in metadata.get("sfx_segment_results") if isinstance(metadata.get("sfx_segment_results"), list) else []:
            if isinstance(item, dict):
                next_segment_results.append(item)
        latest_segment_version = 0
        for item in next_segment_results:
            item_index = max(0, int(item.get("segment_index") or 0))
            if item_index != segment_index:
                continue
            item_version = 1
            try:
                item_version = max(1, int(item.get("version") or 1))
            except Exception:
                item_version = 1
            latest_segment_version = max(latest_segment_version, item_version)
        current_segment_version = latest_segment_version + 1
        sfx_published_url = await _publish_static_file(project_id, sfx_audio_path)
        current_segment_result = {
            "segment_index": segment_index,
            "version": current_segment_version,
            "start_sec": round(float(payload.start_sec), 3),
            "end_sec": round(float(payload.end_sec), 3),
            "duration_sec": round(max(0.0, float(payload.end_sec) - float(payload.start_sec)), 3),
            "clip_video_url": clip_static_url,
            "audio_url": sfx_published_url,
            "background_sound_prompt": background_sound_prompt,
            "updated_at": datetime.utcnow().isoformat(),
        }
        next_segment_results.append(current_segment_result)
        next_segment_results.sort(
            key=lambda item: (
                int(item.get("segment_index") or 0),
                int(item.get("version") or 1),
                str(item.get("updated_at") or ""),
            )
        )
        metadata["sfx_clip_video_url"] = clip_static_url
        metadata["sfx_audio_url"] = sfx_published_url
        metadata["sfx_video_url"] = ""
        metadata["sfx_segment_results"] = next_segment_results
        metadata["sfx_background_sound_prompt"] = background_sound_prompt
        metadata["sfx_soundtrack_prompt"] = ""
        metadata["sfx_asmr_mode"] = False
        metadata["sfx_task_id"] = ""
        metadata["sfx_segment_index"] = segment_index
        metadata["sfx_start_sec"] = round(float(payload.start_sec), 3)
        metadata["sfx_end_sec"] = round(float(payload.end_sec), 3)
        metadata["sfx_status"] = "completed"
        metadata["sfx_task_created_at"] = ""
        metadata["sfx_task_updated_at"] = datetime.utcnow().isoformat()
        await _write_metadata(project_id, payload.job_id, metadata)
        return metadata
    except RuntimeError as exc:
        LOGGER.error(
            "Step5 generate-sfx runtime_error project_id=%s job_id=%s segment_index=%s detail=%s",
            project_id,
            payload.job_id,
            payload.segment_index,
            str(exc),
        )
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except Exception as exc:
        LOGGER.exception(
            "Step5 generate-sfx unexpected_error project_id=%s job_id=%s segment_index=%s",
            project_id,
            payload.job_id,
            payload.segment_index,
        )
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="生成音效失败") from exc


@router.post("/{project_id}/episodes/audio-pipeline/delete-sfx-version")
async def delete_episode_sfx_version(
    project_id: str,
    payload: EpisodeAudioDeleteSfxVersionRequest,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
):
    project = await get_project(db, user_id, project_id)
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    try:
        metadata = await _read_metadata(project_id, payload.job_id)
        raw_results = metadata.get("sfx_segment_results")
        if not isinstance(raw_results, list):
            raise RuntimeError("音效版本数据无效")
        target_segment_index = max(0, int(payload.segment_index or 0))
        target_version = max(1, int(payload.version or 1))
        target_index = -1
        target_item: Optional[dict[str, Any]] = None
        sfx_results: list[dict[str, Any]] = []
        for item in raw_results:
            if isinstance(item, dict):
                sfx_results.append(item)
        for index, item in enumerate(sfx_results):
            item_segment_index = max(0, int(item.get("segment_index") or 0))
            item_version = max(1, int(item.get("version") or 1))
            if item_segment_index == target_segment_index and item_version == target_version:
                target_index = index
                target_item = item
                break
        if target_index < 0 or not target_item:
            raise RuntimeError("未找到对应音效版本")
        job_dir = _job_dir(project_id, payload.job_id)
        sfx_dir = os.path.join(job_dir, "sfx")
        target_audio_url = str(target_item.get("audio_url") or "").strip()
        target_clip_url = str(target_item.get("clip_video_url") or "").strip()
        _safe_remove_static_file(target_audio_url, sfx_dir)
        clip_in_use = any(
            str(item.get("clip_video_url") or "").strip() == target_clip_url
            for idx, item in enumerate(sfx_results)
            if idx != target_index and isinstance(item, dict)
        )
        if target_clip_url and not clip_in_use:
            _safe_remove_static_file(target_clip_url, sfx_dir)
        sfx_results.pop(target_index)
        sfx_results.sort(
            key=lambda item: (
                int(item.get("segment_index") or 0),
                int(item.get("version") or 1),
                str(item.get("updated_at") or ""),
            )
        )
        metadata["sfx_segment_results"] = sfx_results
        if sfx_results:
            latest = sfx_results[-1]
            metadata["sfx_audio_url"] = str(latest.get("audio_url") or "").strip()
            metadata["sfx_clip_video_url"] = str(latest.get("clip_video_url") or "").strip()
            metadata["sfx_segment_index"] = max(0, int(latest.get("segment_index") or 0))
            metadata["sfx_start_sec"] = round(float(latest.get("start_sec") or 0.0), 3)
            metadata["sfx_end_sec"] = round(float(latest.get("end_sec") or 0.0), 3)
            metadata["sfx_status"] = "completed"
        else:
            metadata["sfx_audio_url"] = ""
            metadata["sfx_clip_video_url"] = ""
            metadata["sfx_segment_index"] = 0
            metadata["sfx_start_sec"] = 0.0
            metadata["sfx_end_sec"] = 0.0
            metadata["sfx_status"] = ""
        metadata["sfx_task_updated_at"] = datetime.utcnow().isoformat()
        await _write_metadata(project_id, payload.job_id, metadata)
        return metadata
    except RuntimeError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="删除音效版本失败") from exc


@router.post("/{project_id}/episodes/audio-pipeline/clip-sfx-video")
async def clip_episode_sfx_video(
    project_id: str,
    payload: EpisodeAudioClipSfxRequest,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
):
    project = await get_project(db, user_id, project_id)
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    try:
        metadata = await _read_metadata(project_id, payload.job_id)
        source_video_url = str(payload.source_video_url or "").strip()
        if source_video_url:
            source_video_path = _resolve_static_video_path(source_video_url)
            metadata["merged_video_url"] = source_video_url
            metadata["duration_sec"] = max(
                float(metadata.get("duration_sec") or 0.0),
                _probe_duration_seconds(source_video_path),
            )
        job_dir = _job_dir(project_id, payload.job_id)
        sfx_dir = os.path.join(job_dir, "sfx")
        os.makedirs(sfx_dir, exist_ok=True)
        _, clip_static_url = await _clip_sfx_video(
            project_id,
            metadata,
            payload.job_id,
            payload.start_sec,
            payload.end_sec,
        )
        previous_clip_url = str(metadata.get("sfx_clip_video_url") or "").strip()
        if previous_clip_url and previous_clip_url != clip_static_url:
            _safe_remove_static_file(previous_clip_url, sfx_dir)
        metadata["sfx_clip_video_url"] = clip_static_url
        metadata["sfx_status"] = "clip_ready"
        await _write_metadata(project_id, payload.job_id, metadata)
        return metadata
    except RuntimeError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="截取音效视频失败") from exc


@router.post("/{project_id}/episodes/audio-pipeline/apply-sfx-segments")
async def apply_episode_sfx_segments(
    project_id: str,
    payload: EpisodeAudioApplySfxSegmentsRequest,
    request: Request,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
):
    project = await get_project(db, user_id, project_id)
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    try:
        metadata = await _read_metadata(project_id, payload.job_id)
        source_video_url = str(payload.source_video_url or "").strip()
        if source_video_url:
            source_video_path = _resolve_static_video_path(source_video_url)
            metadata["merged_video_url"] = source_video_url
            metadata["duration_sec"] = max(
                float(metadata.get("duration_sec") or 0.0),
                _probe_duration_seconds(source_video_path),
            )
        duration_sec = float(metadata.get("duration_sec") or 0.0)
        if duration_sec <= 0:
            merged_video_url = str(metadata.get("merged_video_url") or "").strip()
            if not merged_video_url:
                raise RuntimeError("请先生成可截取的合并视频")
            merged_video_path = _resolve_static_video_path(merged_video_url)
            duration_sec = _probe_duration_seconds(merged_video_path)
            metadata["duration_sec"] = duration_sec
        if duration_sec <= 0:
            raise RuntimeError("当前视频时长无效")
        normalized_points = _normalize_sfx_split_points(payload.split_points or [], duration_sec)
        sfx_segments = _build_sfx_segments_from_points(normalized_points, duration_sec)
        if not sfx_segments:
            raise RuntimeError("请先在进度条上设置至少一个截取点")
        for segment in sfx_segments:
            segment_duration = float(segment.get("duration_sec") or 0.0)
            if segment_duration < SFX_MIN_DURATION_SEC or segment_duration > SFX_MAX_DURATION_SEC:
                segment_display = int(float(segment.get("segment_index") or 0.0)) + 1
                raise RuntimeError(
                    f"第{segment_display}段截取时长需在 {SFX_MIN_DURATION_SEC} 到 {SFX_MAX_DURATION_SEC} 秒之间"
                )
        now_iso = datetime.utcnow().isoformat()
        applied_results: list[dict[str, Any]] = []
        for segment in sfx_segments:
            segment_index = int(float(segment.get("segment_index") or 0.0))
            start_sec = float(segment.get("start_sec") or 0.0)
            end_sec = float(segment.get("end_sec") or 0.0)
            duration = float(segment.get("duration_sec") or 0.0)
            _, clip_static_url = await _clip_sfx_video_with_name(
                project_id,
                metadata,
                payload.job_id,
                start_sec,
                end_sec,
                f"sfx_apply_segment_{segment_index}.mp4",
            )
            public_video_url = clip_static_url
            try:
                public_video_url = _public_static_url(request, clip_static_url)
            except Exception:
                public_video_url = clip_static_url
            applied_results.append(
                {
                    "segment_index": segment_index,
                    "start_sec": round(start_sec, 3),
                    "end_sec": round(end_sec, 3),
                    "duration_sec": round(duration, 3),
                    "clip_video_url": clip_static_url,
                    "video_url": clip_static_url,
                    "public_video_url": public_video_url,
                    "updated_at": now_iso,
                }
            )
        metadata["sfx_applied_split_points"] = normalized_points
        metadata["sfx_applied_segment_results"] = applied_results
        metadata["sfx_status"] = "segments_applied"
        metadata["sfx_task_updated_at"] = now_iso
        await _write_metadata(project_id, payload.job_id, metadata)
        return metadata
    except RuntimeError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="应用截取点失败") from exc


@router.post("/{project_id}/episodes/audio-pipeline/upload-bgm")
async def upload_episode_bgm(
    project_id: str,
    job_id: str = Form(...),
    source_video_url: str = Form(""),
    segment_index: int = Form(0),
    start_sec: float = Form(...),
    end_sec: float = Form(...),
    file: UploadFile = File(...),
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
):
    project = await get_project(db, user_id, project_id)
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    try:
        metadata = await _read_metadata(project_id, job_id)
        normalized_source_video_url = str(source_video_url or "").strip()
        if normalized_source_video_url:
            source_video_path = _resolve_static_video_path(normalized_source_video_url)
            metadata["merged_video_url"] = normalized_source_video_url
            metadata["duration_sec"] = max(
                float(metadata.get("duration_sec") or 0.0),
                _probe_duration_seconds(source_video_path),
            )
        duration_sec = float(metadata.get("duration_sec") or 0.0)
        if duration_sec <= 0:
            merged_video_url = str(metadata.get("merged_video_url") or "").strip()
            if merged_video_url:
                merged_video_path = _resolve_static_video_path(merged_video_url)
                duration_sec = _probe_duration_seconds(merged_video_path)
                metadata["duration_sec"] = duration_sec
        if duration_sec <= 0:
            raise RuntimeError("当前视频时长无效")
        safe_start = max(0.0, min(duration_sec, float(start_sec)))
        safe_end = max(0.0, min(duration_sec, float(end_sec)))
        if safe_end - safe_start <= 0.05:
            raise RuntimeError("所选音轨分段时长过短")
        audio_bytes = await file.read()
        if not audio_bytes:
            raise RuntimeError("上传音频不能为空")
        if len(audio_bytes) > 50 * 1024 * 1024:
            raise RuntimeError("上传音频不能超过 50MB")
        safe_segment_index = max(0, int(segment_index or 0))
        now_iso = datetime.utcnow().isoformat()
        version_suffix = datetime.utcnow().strftime("%Y%m%d%H%M%S%f")
        ext = _audio_extension_from_upload(file.filename or "", file.content_type or "")
        job_dir = _job_dir(project_id, job_id)
        bgm_dir = os.path.join(job_dir, "bgm")
        os.makedirs(bgm_dir, exist_ok=True)
        bgm_audio_path = os.path.join(bgm_dir, f"bgm_audio_{safe_segment_index}_{version_suffix}{ext}")
        async with aiofiles.open(bgm_audio_path, "wb") as output_file:
            await output_file.write(audio_bytes)
        next_segment_results: list[dict[str, Any]] = []
        for item in metadata.get("bgm_segment_results") if isinstance(metadata.get("bgm_segment_results"), list) else []:
            if isinstance(item, dict):
                next_segment_results.append(item)
        latest_segment_version = 0
        for item in next_segment_results:
            item_segment_index = max(0, int(item.get("segment_index") or 0))
            if item_segment_index != safe_segment_index:
                continue
            item_version = 1
            try:
                item_version = max(1, int(item.get("version") or 1))
            except Exception:
                item_version = 1
            latest_segment_version = max(latest_segment_version, item_version)
        current_segment_result = {
            "segment_index": safe_segment_index,
            "version": latest_segment_version + 1,
            "start_sec": round(safe_start, 3),
            "end_sec": round(safe_end, 3),
            "duration_sec": round(max(0.0, safe_end - safe_start), 3),
            "audio_url": await _publish_static_file(project_id, bgm_audio_path),
            "original_filename": str(file.filename or "").strip(),
            "content_type": str(file.content_type or "").strip(),
            "updated_at": now_iso,
        }
        next_segment_results.append(current_segment_result)
        next_segment_results.sort(
            key=lambda item: (
                int(item.get("segment_index") or 0),
                int(item.get("version") or 1),
                str(item.get("updated_at") or ""),
            )
        )
        metadata["bgm_audio_url"] = str(current_segment_result.get("audio_url") or "").strip()
        metadata["bgm_segment_results"] = next_segment_results
        metadata["bgm_segment_index"] = safe_segment_index
        metadata["bgm_start_sec"] = round(safe_start, 3)
        metadata["bgm_end_sec"] = round(safe_end, 3)
        metadata["bgm_status"] = "uploaded"
        metadata["bgm_task_updated_at"] = now_iso
        await _write_metadata(project_id, job_id, metadata)
        return metadata
    except RuntimeError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="上传 BGM 失败") from exc


@router.get("/{project_id}/episodes/audio-pipeline/freesound-tags")
async def list_freesound_tags(
    project_id: str,
    query: str = "",
    page_size: int = 24,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
):
    project = await get_project(db, user_id, project_id)
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    safe_page_size = max(1, min(100, int(page_size or 24)))
    normalized_query = str(query or "").strip()
    fallback_tags = [
        "whoosh",
        "wind",
        "rain",
        "thunder",
        "footsteps",
        "door",
        "explosion",
        "water",
        "crowd",
        "car",
        "city",
        "nature",
        "fire",
        "magic",
        "drone",
        "impact",
    ]
    try:
        headers = _freesound_headers()
        params = {
            "query": normalized_query,
            "page_size": safe_page_size,
            "fields": "name,count",
        }
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.get("https://freesound.org/apiv2/tags/", headers=headers, params=params)
        if response.is_error:
            raise RuntimeError(str(response.text or "").strip() or f"HTTP {response.status_code}")
        raw = response.json()
        items = raw.get("results") if isinstance(raw, dict) else []
        tags: list[dict[str, Any]] = []
        for item in items if isinstance(items, list) else []:
            if not isinstance(item, dict):
                continue
            name = str(item.get("name") or "").strip()
            if not name:
                continue
            tags.append(
                {
                    "name": name,
                    "count": max(0, int(item.get("count") or 0)),
                }
            )
        if tags:
            return {"items": tags[:safe_page_size]}
    except Exception:
        pass
    normalized_fallback = [item for item in fallback_tags if not normalized_query or normalized_query.lower() in item.lower()]
    return {
        "items": [{"name": tag, "count": 0} for tag in normalized_fallback[:safe_page_size]]
    }


@router.post("/{project_id}/episodes/audio-pipeline/freesound-search")
async def search_freesound_sounds(
    project_id: str,
    payload: FreeSoundSearchRequest,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
):
    project = await get_project(db, user_id, project_id)
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    query = str(payload.query or "").strip()
    tag = str(payload.tag or "").strip()
    if not query and not tag:
        query = "sound effect"
    safe_page = max(1, int(payload.page or 1))
    safe_page_size = max(1, min(40, int(payload.page_size or 20)))
    filter_parts: list[str] = []
    if tag:
        escaped = tag.replace('"', "")
        filter_parts.append(f'tag:"{escaped}"')
    search_params = {
        "query": query,
        "page": safe_page,
        "page_size": safe_page_size,
        "fields": "id,name,duration,previews,tags,username",
        "sort": "score",
    }
    if filter_parts:
        search_params["filter"] = " ".join(filter_parts)
    fallback_payload = {
        "items": [],
        "count": 0,
        "page": safe_page,
        "page_size": safe_page_size,
        "warning": "",
    }
    try:
        headers = _freesound_headers()
        async with httpx.AsyncClient(timeout=45.0) as client:
            response = await client.get("https://freesound.org/apiv2/search/text/", headers=headers, params=search_params)
        if response.is_error:
            error_text = str(response.text or "").strip() or f"HTTP {response.status_code}"
            fallback_payload["warning"] = f"Freesound 搜索失败：{error_text}"
            return fallback_payload
        raw = response.json()
        results = raw.get("results") if isinstance(raw, dict) else []
        items: list[dict[str, Any]] = []
        for item in results if isinstance(results, list) else []:
            if not isinstance(item, dict):
                continue
            previews = item.get("previews") if isinstance(item.get("previews"), dict) else {}
            preview_url = str(previews.get("preview-hq-mp3") or previews.get("preview-lq-mp3") or "").strip()
            if not preview_url:
                continue
            tags_raw = item.get("tags")
            tags = [str(tag_item).strip() for tag_item in tags_raw if str(tag_item).strip()] if isinstance(tags_raw, list) else []
            items.append(
                {
                    "id": int(item.get("id") or 0),
                    "name": str(item.get("name") or "").strip() or f"sound-{item.get('id')}",
                    "duration": round(float(item.get("duration") or 0.0), 3),
                    "preview_url": preview_url,
                    "tags": tags[:8],
                    "username": str(item.get("username") or "").strip(),
                }
            )
        return {
            "items": items,
            "count": max(0, int(raw.get("count") or 0)) if isinstance(raw, dict) else 0,
            "page": safe_page,
            "page_size": safe_page_size,
            "warning": "",
        }
    except RuntimeError as exc:
        fallback_payload["warning"] = str(exc)
        return fallback_payload
    except Exception:
        fallback_payload["warning"] = "Freesound 搜索失败"
        return fallback_payload


@router.post("/{project_id}/merge", response_model=StatusResponse)
async def merge_final(
    project_id: str,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
) -> StatusResponse:
    project = await get_project(db, user_id, project_id)
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    return StatusResponse(status="queued")


@router.post("/{project_id}/episodes/audio-pipeline/transcribe-segment")
async def transcribe_episode_audio_segment(
    project_id: str,
    payload: EpisodeAudioTranscribeRequest,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
):
    """将指定分段音频转为文字，使用 ElevenLabs Scribe API。"""
    project = await get_project(db, user_id, project_id)
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    try:
        metadata = await _read_metadata(project_id, payload.job_id)
        segments = metadata.get("segments")
        if not isinstance(segments, list):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="任务分段数据无效")
        target_segment = None
        for item in segments:
            if isinstance(item, dict) and str(item.get("id") or "").strip() == payload.segment_id:
                target_segment = item
                break
        if not target_segment:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="未找到对应分段")

        # 优先使用 S2S 后的配音文件，其次使用原始切分段音频
        dubbed_url = str(target_segment.get("dubbed_audio_url") or "").strip()
        source_url = str(target_segment.get("source_audio_url") or "").strip()
        audio_url = dubbed_url if dubbed_url else source_url

        if not audio_url:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="该分段暂无音频，请先完成 S2S 音色生成后再转写"
            )

        audio_bytes = await load_media_bytes(audio_url)
        parsed_audio = urlparse(audio_url) if audio_url.startswith(("http://", "https://")) else None
        audio_ext = (
            os.path.splitext(parsed_audio.path)[1].strip().lower() if parsed_audio and parsed_audio.path else ""
        ) or ".wav"
        safe_filename = f"stt_{payload.segment_id}{audio_ext}"
        if not audio_bytes:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="分段音频为空，无法转写")

        stt_result = await eleven_labs_service.speech_to_text(
            audio_bytes=audio_bytes,
            filename=safe_filename,
            model_id="scribe_v1",
        )

        transcript_text = str(stt_result.get("text", "")).strip()
        detected_language = str(stt_result.get("language", "")).strip()

        # 追加转写结果到分段元数据
        if "transcription" not in target_segment:
            target_segment["transcription"] = ""
        target_segment["transcription"] = transcript_text
        target_segment["transcription_language"] = detected_language
        await _write_metadata(project_id, payload.job_id, metadata)

        return {
            "job_id": payload.job_id,
            "segment_id": payload.segment_id,
            "text": transcript_text,
            "language": detected_language,
            "segments": segments,
        }
    except HTTPException:
        raise
    except RuntimeError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except Exception as exc:
        LOGGER.exception("transcribe_episode_audio_segment failed project_id=%s job_id=%s", project_id, payload.job_id)
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="转写失败") from exc


@router.post("/{project_id}/episodes/audio-pipeline/transcribe-episode")
async def transcribe_episode_audio(
    project_id: str,
    payload: EpisodeEpisodeTranscribeRequest,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
):
    """将整集人声音轨转为文字（不限分段），使用 ElevenLabs Scribe API。"""
    project = await get_project(db, user_id, project_id)
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    try:
        metadata = await _read_metadata(project_id, payload.job_id)

        # 优先使用人声分离后的音频，其次使用原始音频
        vocal_url = str(metadata.get("vocal_audio_url") or "").strip()
        source_url = str(metadata.get("source_audio_url") or "").strip()
        audio_url = vocal_url if vocal_url else source_url

        if not audio_url:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="该集暂无音频，请先提取人声音轨"
            )

        audio_bytes = await load_media_bytes(audio_url)
        parsed_audio = urlparse(audio_url) if audio_url.startswith(("http://", "https://")) else None
        audio_ext = (
            os.path.splitext(parsed_audio.path)[1].strip().lower() if parsed_audio and parsed_audio.path else ""
        ) or ".wav"
        safe_filename = f"stt_episode_{payload.job_id[:8]}{audio_ext}"
        if not audio_bytes:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="音频为空，无法转写")

        stt_result = await eleven_labs_service.speech_to_text(
            audio_bytes=audio_bytes,
            filename=safe_filename,
            model_id="scribe_v1",
        )

        transcript_text = str(stt_result.get("text", "")).strip()
        detected_language = str(stt_result.get("language", "")).strip()

        # 保存到顶层 metadata
        metadata["episode_transcription"] = transcript_text
        metadata["episode_transcription_language"] = detected_language
        await _write_metadata(project_id, payload.job_id, metadata)

        return {
            "job_id": payload.job_id,
            "text": transcript_text,
            "language": detected_language,
        }
    except HTTPException:
        raise
    except RuntimeError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except Exception as exc:
        LOGGER.exception("transcribe_episode_audio failed project_id=%s job_id=%s", project_id, payload.job_id)
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="转写失败") from exc
