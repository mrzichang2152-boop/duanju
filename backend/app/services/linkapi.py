from __future__ import annotations
from typing import Optional, Union, Any
import os
import socket
import asyncio
import base64
import hmac
import json
import logging
import re
import time
import hashlib
import tempfile
import subprocess
import ipaddress
import shlex
from urllib.parse import urlparse, quote

import httpx
import aiofiles
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings as app_settings
from app.models.asset import Asset
from app.models.asset_version import AssetVersion
from app.services.settings import get_api_key, get_or_create_settings

logger = logging.getLogger(__name__)

_KLING_ELEMENT_CACHE_TTL_SECONDS = 24 * 60 * 60
_KLING_ELEMENT_CACHE: dict[str, tuple[str, float]] = {}
_OPENROUTER_TEXT_MODEL = "gemini-3.1-pro"
_OPENROUTER_IMAGE_MODEL = "nano-banana-2"

# GRSAI /v1/draw/nano-banana 文档列出的绘画 model 值（用于 /linkapi/models 与前端 datalist）
_GRSAI_DRAW_MODEL_ENTRIES: tuple[tuple[str, str], ...] = (
    ("nano-banana-2", "Nano Banana 2"),
    ("nano-banana-2-cl", "Nano Banana 2 CL（仅 1K/2K）"),
    ("nano-banana-2-4k-cl", "Nano Banana 2 4K CL（仅 4K）"),
    ("nano-banana-fast", "Nano Banana Fast"),
    ("nano-banana", "Nano Banana"),
    ("nano-banana-pro", "Nano Banana Pro"),
    ("nano-banana-pro-vt", "Nano Banana Pro VT"),
    ("nano-banana-pro-cl", "Nano Banana Pro CL"),
    ("nano-banana-pro-vip", "Nano Banana Pro VIP（仅 1K/2K）"),
    ("nano-banana-pro-4k-vip", "Nano Banana Pro 4K VIP（仅 4K）"),
)


def _get_auto_proxy() -> Optional[str]:
    # 1. Environment variables
    if os.environ.get("HTTPS_PROXY"):
        return os.environ.get("HTTPS_PROXY")
    if os.environ.get("HTTP_PROXY"):
        return os.environ.get("HTTP_PROXY")

    # 2. Check local proxy (Clash/V2Ray on 7897)
    # Check 127.0.0.1:7897
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(0.1)
        if sock.connect_ex(("127.0.0.1", 7897)) == 0:
            sock.close()
            return "http://127.0.0.1:7897"
        sock.close()
    except:
        pass

    # 3. Check Docker host (host.docker.internal:7897)
    try:
        host = "host.docker.internal"
        try:
            socket.gethostbyname(host)
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(0.1)
            if sock.connect_ex((host, 7897)) == 0:
                sock.close()
                return f"http://{host}:7897"
            sock.close()
        except:
            pass
    except:
        pass

    return None


async def fetch_models(session: AsyncSession, user_id: str) -> dict[str, Any]:
    await get_or_create_settings(session, user_id)
    data: list[dict[str, Any]] = [
        {
            "id": _OPENROUTER_TEXT_MODEL,
            "name": "Gemini 3.1 Pro (Text)",
            "kind": "chat",
        },
    ]
    for mid, label in _GRSAI_DRAW_MODEL_ENTRIES:
        data.append({"id": mid, "name": label, "kind": "draw"})
    return {"data": data}


def _map_openrouter_model(model: str) -> str:
    return _OPENROUTER_TEXT_MODEL


async def _resolve_openrouter_key(session: AsyncSession, user_id: str) -> str:
    configured_key = await get_api_key(session, user_id)
    return (
        str(getattr(app_settings, "grsai_api_key", "") or "").strip()
        or os.getenv("GRSAI_API_KEY", "").strip()
        or app_settings.suchuang_api_key.strip()
        or os.getenv("SUCHUANG_API_KEY", "").strip()
        or str(configured_key or "").strip()
    )


def _normalize_message_content(content: Any) -> str:
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, dict):
        for key in ("text", "content", "value"):
            value = content.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        return ""
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, str):
                value = item.strip()
                if value:
                    parts.append(value)
                continue
            if not isinstance(item, dict):
                continue
            item_type = str(item.get("type") or "").strip().lower()
            if item_type == "text":
                value = str(item.get("text") or "").strip()
                if value:
                    parts.append(value)
                continue
            if item_type == "input_text":
                value = str(item.get("input_text") or "").strip()
                if value:
                    parts.append(value)
                continue
            text_value = str(item.get("text") or "").strip()
            if text_value:
                parts.append(text_value)
        return "\n".join(parts).strip()
    return ""


def _build_suchuang_content(payload: dict[str, Any]) -> str:
    messages = payload.get("messages")
    lines: list[str] = []
    if isinstance(messages, list):
        for message in messages:
            if not isinstance(message, dict):
                continue
            role = str(message.get("role") or "user").strip()
            text = _normalize_message_content(message.get("content"))
            if not text:
                continue
            lines.append(f"{role}:\n{text}")
    content = "\n\n".join(lines).strip()
    if content:
        return content
    fallback = str(payload.get("content") or payload.get("prompt") or "").strip()
    return fallback


def _extract_suchuang_text(value: Any) -> str:
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, list):
        parts = [_extract_suchuang_text(item) for item in value]
        return "\n".join([item for item in parts if item]).strip()
    if isinstance(value, dict):
        choices = value.get("choices")
        if isinstance(choices, list):
            for item in choices:
                if not isinstance(item, dict):
                    continue
                message = item.get("message")
                if isinstance(message, dict):
                    content_text = _extract_suchuang_text(message.get("content"))
                    if content_text:
                        return content_text
                delta = item.get("delta")
                if isinstance(delta, dict):
                    delta_text = _extract_suchuang_text(delta.get("content"))
                    if delta_text:
                        return delta_text
                item_text = _extract_suchuang_text(item.get("text"))
                if item_text:
                    return item_text
        for key in ("content", "text", "result", "output", "answer", "data", "message"):
            if key not in value:
                continue
            extracted = _extract_suchuang_text(value.get(key))
            if extracted:
                return extracted
    return ""


async def create_chat_completion(
    session: AsyncSession, user_id: str, payload: dict[str, Any]
) -> dict[str, Any]:
    await get_or_create_settings(session, user_id)
    api_key = await _resolve_openrouter_key(session, user_id)
    if not api_key:
        raise RuntimeError("GRSAI_API_KEY 未配置，请先在后端环境变量中设置")
    request_model = _map_openrouter_model(str(payload.get("model") or ""))
    endpoint = str(os.getenv("GRSAI_TEXT_ENDPOINT", "https://grsai.dakka.com.cn/v1/chat/completions")).strip()
    request_messages = payload.get("messages")
    if not isinstance(request_messages, list) or len(request_messages) == 0:
        content = _build_suchuang_content(payload)
        if not content:
            raise RuntimeError("请求内容为空，无法调用 Gemini3.1Pro")
        request_messages = [{"role": "user", "content": content}]
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    request_payload: dict[str, Any] = {
        "model": request_model,
        "stream": False,
        "messages": request_messages,
    }
    if payload.get("temperature") is not None:
        request_payload["temperature"] = payload.get("temperature")
    if payload.get("max_tokens") is not None:
        request_payload["max_tokens"] = payload.get("max_tokens")
    timeout_seconds_raw = str(
        os.getenv("GRSAI_TIMEOUT_SECONDS", os.getenv("SUCHUANG_TIMEOUT_SECONDS", "900"))
    ).strip()
    try:
        timeout_seconds = float(timeout_seconds_raw)
    except Exception:
        timeout_seconds = 900.0
    timeout_seconds = max(60.0, timeout_seconds)
    timeout = httpx.Timeout(timeout_seconds, connect=15.0)
    last_exc: Exception | None = None
    for _ in range(2):
        try:
            async with httpx.AsyncClient(timeout=timeout, trust_env=True) as client:
                response = await client.post(endpoint, headers=headers, json=request_payload)
            break
        except (httpx.ReadTimeout, httpx.ConnectTimeout) as exc:
            last_exc = exc
            await asyncio.sleep(1.0)
    else:
        raise RuntimeError(f"Gemini3Pro 调用超时（>{int(timeout_seconds)}秒）") from last_exc
    if response.status_code != 200:
        raise RuntimeError(f"Gemini3.1Pro 调用失败：HTTP {response.status_code} {response.text}")
    try:
        response_json = response.json()
    except Exception as exc:
        raise RuntimeError(f"Gemini3.1Pro 返回非 JSON 响应：{response.text}") from exc
    code = response_json.get("code")
    if code not in (None, 0, 200):
        raise RuntimeError(str(response_json.get("msg") or response_json))
    if isinstance(response_json, dict) and not response_json.get("choices"):
        data_obj = response_json.get("data")
        if isinstance(data_obj, dict) and data_obj.get("choices"):
            response_json = data_obj
    content_text = _extract_suchuang_text(response_json)
    if not content_text and isinstance(response_json, dict):
        content_text = _extract_suchuang_text(response_json.get("data"))
    if not content_text:
        logger.warning("Gemini3.1Pro empty content response: %s", str(response_json)[:600])
        raise RuntimeError("Gemini3.1Pro 未返回可用内容")
    return {
        "choices": [
            {
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": content_text,
                },
                "finish_reason": "stop",
            }
        ]
    }


async def create_chat_completion_stream(
    session: AsyncSession, user_id: str, payload: dict[str, Any]
):
    try:
        result = await create_chat_completion(session, user_id, payload)
        content = (
            result.get("choices", [{}])[0]
            .get("message", {})
            .get("content", "")
        )
        if not content:
            return
        yield {
            "choices": [
                {
                    "delta": {
                        "content": content,
                    }
                }
            ]
        }
    except Exception as exc:
        yield f"Error: {str(exc)}"


def _backend_static_dir() -> str:
    return os.path.abspath(os.path.join(os.path.dirname(os.path.dirname(__file__)), "static"))


def _resolve_public_base_url() -> str:
    return str(os.getenv("PUBLIC_BASE_URL") or os.getenv("KLING_PUBLIC_BASE_URL") or "").strip().rstrip("/")


def _run_remote_command(command: list[str], error_prefix: str, timeout_seconds: int) -> None:
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=timeout_seconds)
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"{error_prefix}: 执行超时") from exc
    except Exception as exc:
        raise RuntimeError(f"{error_prefix}: {exc}") from exc
    if result.returncode == 0:
        return
    stderr = str(result.stderr or "").strip()
    stdout = str(result.stdout or "").strip()
    detail = stderr or stdout or f"exit={result.returncode}"
    raise RuntimeError(f"{error_prefix}: {detail[:300]}")


def _publish_static_path_to_remote(static_path: str) -> str:
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
        raise RuntimeError(f"远程上传配置不完整，请补齐：{'、'.join(missing_items)}")
    try:
        port = int(port_raw)
    except ValueError as exc:
        raise RuntimeError("远程上传端口配置无效，请检查 SFX_REMOTE_UPLOAD_PORT") from exc
    normalized = str(static_path or "").strip()
    if not normalized.startswith("/static/"):
        raise RuntimeError("静态文件地址无效")
    static_rel = normalized.replace("/static/", "", 1).strip("/")
    if not static_rel:
        raise RuntimeError("静态文件地址无效")
    local_abs = os.path.abspath(os.path.join(_backend_static_dir(), static_rel))
    static_root = _backend_static_dir()
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
    _run_remote_command(mkdir_cmd, "远程创建目录失败", 25)
    _run_remote_command(copy_cmd, "远程上传图片失败", 40)
    encoded_rel = "/".join(quote(part) for part in static_rel.split("/"))
    return f"{remote_base_url}/{encoded_rel}"


async def _persist_data_image_to_static(data_url: str) -> str:
    text = str(data_url or "").strip()
    if not text.startswith("data:image"):
        raise RuntimeError("图片数据格式不支持")
    try:
        header, encoded = text.split(",", 1)
    except ValueError as exc:
        raise RuntimeError("图片数据格式无效") from exc
    mime = "image/png"
    if ";" in header and ":" in header:
        mime = header.split(":", 1)[1].split(";", 1)[0].strip().lower() or mime
    ext = ".png"
    if "jpeg" in mime or "jpg" in mime:
        ext = ".jpg"
    elif "webp" in mime:
        ext = ".webp"
    elif "gif" in mime:
        ext = ".gif"
    elif "bmp" in mime:
        ext = ".bmp"
    try:
        image_bytes = base64.b64decode(encoded, validate=False)
    except Exception as exc:
        raise RuntimeError("图片数据解码失败") from exc
    if not image_bytes:
        raise RuntimeError("图片数据为空")
    static_assets_dir = os.path.join(_backend_static_dir(), "assets")
    os.makedirs(static_assets_dir, exist_ok=True)
    filename = f"i2i_ref_{int(time.time() * 1000)}_{hashlib.md5(image_bytes).hexdigest()[:10]}{ext}"
    file_path = os.path.join(static_assets_dir, filename)
    async with aiofiles.open(file_path, "wb") as f:
        await f.write(image_bytes)
    return f"/static/assets/{filename}"


async def _resolve_image_url(url: str) -> str:
    normalized = str(url or "").strip()
    if not normalized:
        return normalized
    public_base_url = _resolve_public_base_url()
    if normalized.startswith("data:image"):
        static_path = await _persist_data_image_to_static(normalized)
        if public_base_url:
            return f"{public_base_url}{static_path}"
        uploaded_url = _publish_static_path_to_remote(static_path)
        if uploaded_url:
            return uploaded_url
        raise RuntimeError(
            "图生图参考图为历史内嵌Base64地址，且未配置可公网访问地址。请配置 PUBLIC_BASE_URL / KLING_PUBLIC_BASE_URL，或配置 SFX_REMOTE_UPLOAD_* 自动上传阿里云后重试。"
        )
    if normalized.startswith(("http://", "https://")):
        parsed = urlparse(normalized)
        host = str(parsed.hostname or "").strip().lower()
        if "/static/" not in parsed.path:
            return normalized
        if host and host not in {"localhost", "127.0.0.1", "0.0.0.0"}:
            try:
                ip = ipaddress.ip_address(host)
                if not (ip.is_private or ip.is_loopback or ip.is_link_local):
                    return normalized
            except ValueError:
                if "." in host:
                    return normalized
        static_path = parsed.path[parsed.path.find("/static/") :]
        if public_base_url:
            return f"{public_base_url}{static_path}"
        uploaded_url = _publish_static_path_to_remote(static_path)
        if uploaded_url:
            return uploaded_url
        raise RuntimeError(
            "图生图参考图为本地静态地址，速创无法访问。请配置 PUBLIC_BASE_URL / KLING_PUBLIC_BASE_URL，或配置 SFX_REMOTE_UPLOAD_* 自动上传阿里云后重试。"
        )
    if normalized.startswith("/static/"):
        if public_base_url:
            return f"{public_base_url}{normalized}"
        uploaded_url = _publish_static_path_to_remote(normalized)
        if uploaded_url:
            return uploaded_url
        raise RuntimeError(
            "图生图参考图为本地静态地址，速创无法访问。请配置 PUBLIC_BASE_URL / KLING_PUBLIC_BASE_URL，或配置 SFX_REMOTE_UPLOAD_* 自动上传阿里云后重试。"
        )
    return normalized


def _normalize_kling_image_value(image_value: str) -> str:
    value = str(image_value or "").strip()
    if not value:
        return ""
    marker = ";base64,"
    if value.startswith("data:") and marker in value:
        return value.split(marker, 1)[1].strip()
    return value


async def _download_video_bytes(video_url: str) -> bytes:
    normalized = str(video_url or "").strip()
    if not normalized:
        return b""
    async with httpx.AsyncClient(timeout=120.0, trust_env=False, follow_redirects=True) as client:
        response = await client.get(normalized)
    if response.status_code != 200:
        raise RuntimeError(f"下载参考视频失败: status={response.status_code}")
    content = response.content
    if not content:
        raise RuntimeError("下载参考视频失败: 空内容")
    return content


async def _extract_video_tail_frame_base64(video_url: str) -> str:
    video_bytes = await _download_video_bytes(video_url)
    temp_dir = tempfile.mkdtemp(prefix="tailframe_")
    video_path = os.path.join(temp_dir, "source.mp4")
    frame_path = os.path.join(temp_dir, "tail.jpg")
    try:
        async with aiofiles.open(video_path, "wb") as f:
            await f.write(video_bytes)
        try:
            probe = await asyncio.to_thread(subprocess.run, ["ffmpeg", "-version"], capture_output=True, text=True)
            if probe.returncode != 0:
                raise RuntimeError("未检测到 ffmpeg，无法提取视频尾帧")
        except FileNotFoundError:
            raise RuntimeError("未检测到 ffmpeg，无法提取视频尾帧")
        
        try:
            cmd = [
                "ffmpeg",
                "-sseof",
                "-0.1",
                "-i",
                video_path,
                "-frames:v",
                "1",
                "-q:v",
                "2",
                "-y",
                frame_path,
            ]
            result = await asyncio.to_thread(subprocess.run, cmd, capture_output=True, text=True)
        except FileNotFoundError:
            raise RuntimeError("未检测到 ffmpeg，无法提取视频尾帧")
        if result.returncode != 0 or (not os.path.exists(frame_path)):
            stderr = str(result.stderr or "").strip()
            raise RuntimeError(f"提取视频尾帧失败: {stderr[:300]}")
        async with aiofiles.open(frame_path, "rb") as f:
            image_bytes = await f.read()
        if not image_bytes:
            raise RuntimeError("提取视频尾帧失败: 帧图片为空")
        return base64.b64encode(image_bytes).decode("utf-8")
    finally:
        try:
            if os.path.exists(frame_path):
                os.remove(frame_path)
            if os.path.exists(video_path):
                os.remove(video_path)
            if os.path.isdir(temp_dir):
                os.rmdir(temp_dir)
        except Exception:
            pass


def _extract_suchuang_image_urls(value: Any) -> list[str]:
    urls: list[str] = []
    if isinstance(value, str):
        text = value.strip()
        if text.startswith("http://") or text.startswith("https://") or text.startswith("data:image"):
            urls.append(text)
        return urls
    if isinstance(value, list):
        for item in value:
            urls.extend(_extract_suchuang_image_urls(item))
        return urls
    if isinstance(value, dict):
        for key in ("url", "image_url", "image", "src"):
            if key in value:
                urls.extend(_extract_suchuang_image_urls(value.get(key)))
        for nested_key in ("data", "result", "output", "images", "items", "list", "results"):
            if nested_key in value:
                urls.extend(_extract_suchuang_image_urls(value.get(nested_key)))
    return urls


def _pick_preferred_image_url(urls: list[str]) -> str:
    for url in urls:
        text = str(url or "").strip()
        if text.startswith(("http://", "https://")):
            return text
    for url in urls:
        text = str(url or "").strip()
        if text:
            return text
    return ""


def _resolve_suchuang_size(payload: dict[str, Any]) -> str:
    raw_size = str(payload.get("size") or "").strip().upper()
    if raw_size in {"1K", "2K", "4K"}:
        return raw_size
    width = payload.get("width")
    height = payload.get("height")
    try:
        w = int(width) if width is not None else 0
        h = int(height) if height is not None else 0
    except Exception:
        w, h = 0, 0
    max_edge = max(w, h)
    if max_edge >= 3000:
        return "4K"
    if max_edge >= 1800:
        return "2K"
    return "1K"


def _normalize_grsai_draw_model(raw: Optional[str]) -> str:
    """将前端/设置里的别名映射为 GRSAI /v1/draw/nano-banana 文档中的 model 值。"""
    s = (raw or "").strip()
    if not s:
        return _OPENROUTER_IMAGE_MODEL
    lower = s.lower().replace("_", "-")
    # Step3 前端默认 nanoBanana2
    if s == "nanoBanana2" or lower in {"nanobanana2", "nano-banana2"}:
        return "nano-banana-2"
    # 统一走 nano-banana-2 + imageSize（含 4K），不向 GRSAI 提交 nano-banana-2-4k-cl（与产品约定一致）
    if lower in {"nano-banana-2-4k", "nano-banana2-4k", "nano-banana-2-4k-cl"}:
        return "nano-banana-2"
    # 文档：Gemini 画图类名称应对应 nano-banana-fast 等绘画模型，勿把 chat 模型名传给 draw 接口
    if "gemini" in lower and "image" in lower:
        return "nano-banana-fast"
    if lower.startswith("google/") and ("image" in lower or "flash" in lower):
        return "nano-banana-fast"
    if lower == "nano-banana":
        return "nano-banana"
    if lower.startswith("nano-banana-"):
        return lower
    return _OPENROUTER_IMAGE_MODEL


def _coerce_grsai_draw_image_size(model: str, payload: dict[str, Any]) -> str:
    """按 GRSAI 文档约束 imageSize；错误组合易导致任务卡住或久不返回终态。"""
    m = (model or "").strip().lower()
    base = _resolve_suchuang_size(payload)
    # 仅支持 4K
    if m in {"nano-banana-pro-4k-vip"}:
        return "4K"
    # 仅支持 1K、2K（文档：nano-banana-2-cl / nano-banana-pro-vip；nano-banana-2 未标注限制）
    if m in {"nano-banana-2-cl", "nano-banana-pro-vip"}:
        if base == "4K":
            return "2K"
        return base if base in {"1K", "2K"} else "1K"
    return base


async def _poll_suchuang_image_result(
    client: httpx.AsyncClient,
    api_key: str,
    task_id: str,
    result_endpoint: str | None = None,
) -> str:
    endpoint = str(
        result_endpoint
        or os.getenv("GRSAI_DRAW_RESULT_ENDPOINT", "https://grsai.dakka.com.cn/v1/draw/result")
    ).strip()
    last_message = ""
    headers_get = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    try:
        max_attempts = int(str(os.getenv("GRSAI_POLL_MAX_ATTEMPTS", os.getenv("SUCHUANG_POLL_MAX_ATTEMPTS", "180"))).strip())
    except Exception:
        max_attempts = 180
    if max_attempts <= 0:
        max_attempts = 180
    try:
        max_wall_seconds = float(str(os.getenv("GRSAI_POLL_MAX_WALL_SECONDS", "200")).strip() or "200")
    except Exception:
        max_wall_seconds = 200.0
    max_wall_seconds = max(60.0, min(300.0, max_wall_seconds))
    try:
        stall_poll_threshold = int(str(os.getenv("GRSAI_POLL_STALL_POLLS", "30")).strip() or "30")
    except Exception:
        stall_poll_threshold = 30
    stall_poll_threshold = max(15, min(90, stall_poll_threshold))
    # 用于检测 running 且 progress 长期不变（上游拉参考图失败/队列卡住常见表现）
    last_running_progress: Any = object()
    stall_polls = 0
    poll_started = time.monotonic()
    for attempt in range(max_attempts):
        if time.monotonic() - poll_started > max_wall_seconds:
            raise RuntimeError(
                f"Nano Banana 结果轮询超过墙上时限 {int(max_wall_seconds)}s（task_id={task_id}）"
            )
        response = await client.post(endpoint, headers=headers_get, json={"id": task_id})
        logger.info(
            "GRSAI poll attempt=%d status=%s body=%s",
            attempt + 1,
            response.status_code,
            response.text[:1000],
        )
        if response.status_code != 200:
            last_message = f"HTTP {response.status_code}"
            await asyncio.sleep(2.0)
            continue
        try:
            body = response.json()
        except Exception:
            last_message = response.text[:200]
            await asyncio.sleep(2.0)
            continue
        # 文档格式：{ code, msg, data: { id, results, progress, status, failure_reason, error } }
        if isinstance(body, dict):
            message = str(body.get("msg") or body.get("message") or "").strip()
            if message:
                last_message = message
            code = body.get("code")
            if code not in (None, 0, 200):
                raise RuntimeError(f"Nano Banana 查询失败：{message or body}")
            data_obj = body.get("data") if isinstance(body.get("data"), dict) else {}
            # 优先检查 data.error/failure_reason：GRSAI 可能在 status=running 时就已在 data 层返回错误
            # 如 "google gemini timeout..."，此时 status 不会立即变成 failed，需立即捕获
            data_error = str(data_obj.get("error") or "").strip()
            data_failure = str(data_obj.get("failure_reason") or "").strip()
            if data_error or (data_failure and data_failure.lower() not in ("", "none", "null", "running")):
                raise RuntimeError(
                    f"Nano Banana 任务异常：{data_error or data_failure or body}"
                )
            # status 在 data 层，与文档一致
            status = data_obj.get("status") if isinstance(data_obj, dict) else body.get("status")
            status_text = str(status or "").strip().lower()
            if status_text in {"failed", "error"}:
                detail = str(
                    data_obj.get("error")
                    or data_obj.get("failure_reason")
                    or message
                    or body
                ).strip()
                raise RuntimeError(f"Nano Banana 任务失败：{detail}")
            if status_text in {"succeeded", "success", "completed"}:
                urls = _extract_suchuang_image_urls(body)
                preferred = _pick_preferred_image_url(urls)
                if preferred:
                    return preferred
                detail = str(
                    data_obj.get("failure_reason")
                    or message or body
                ).strip()
                raise RuntimeError(f"Nano Banana 成功但未返回图片地址：{detail or task_id}")
            if status in (-1, "-1", 4, "4", "failed", "FAIL", "FAILED"):
                raise RuntimeError(f"Nano Banana 任务失败：{message or body}")
            pr = data_obj.get("progress") if isinstance(data_obj, dict) else None
            if status_text == "running":
                if pr == last_running_progress:
                    stall_polls += 1
                else:
                    stall_polls = 0
                    last_running_progress = pr
                if stall_polls >= stall_poll_threshold:
                    raise RuntimeError(
                        f"GRSAI 任务长时间无进展（约 {stall_poll_threshold * 2}s 内 progress 未变化）："
                        f"status={status_text} progress={pr} task_id={task_id}。"
                        f"常见原因：参考图 URL 外网不可访问、COS 未公有读、上游排队异常，或 Google Gemini 侧超时；"
                        f"可换 nano-banana-fast 等模型重试，并以 /v1/draw/result 返回的 error 字段为准。"
                    )
        urls = _extract_suchuang_image_urls(body)
        preferred = _pick_preferred_image_url(urls)
        if preferred:
            return preferred
        await asyncio.sleep(2.0)
    if last_message:
        raise RuntimeError(f"Nano Banana 结果轮询超时：{last_message}（task_id={task_id}）")
    raise RuntimeError(f"Nano Banana 结果轮询超时（task_id={task_id}）")


def _is_retryable_grsai_image_error(exc: BaseException) -> bool:
    """上游 Gemini/GRSAI 偶发超时、限流等，可整单重试。"""
    text = str(exc).strip().lower()
    if not text:
        return False
    markers = (
        "timeout",
        "timed out",
        "time out",
        "gemini",
        "deadline",
        "temporarily",
        "overload",
        "503",
        "502",
        "429",
        "rate limit",
        "try again",
        "empty response",
        "connection reset",
        "broken pipe",
    )
    return any(m in text for m in markers)


async def create_image(
    session: AsyncSession, user_id: str, payload: dict[str, Any]
) -> dict[str, Any]:
    api_key = await _resolve_openrouter_key(session, user_id)
    if not api_key:
        raise RuntimeError("GRSAI_API_KEY 未配置，请先在后端环境变量中设置")
    endpoint = str(os.getenv("GRSAI_DRAW_ENDPOINT", "https://grsai.dakka.com.cn/v1/draw/nano-banana")).strip()
    payload = payload.copy()

    resolved_references: list[str] = []
    unresolved_reference_errors: list[str] = []
    has_reference_input = False
    if "image_url" in payload and payload["image_url"]:
        has_reference_input = True
        try:
            resolved_single = await _resolve_image_url(str(payload["image_url"]))
            if resolved_single:
                resolved_references.append(resolved_single)
        except Exception as exc:
            unresolved_reference_errors.append(str(exc))
        payload.pop("image_url", None)
    if "image_urls" in payload and isinstance(payload["image_urls"], list):
        has_reference_input = has_reference_input or len(payload["image_urls"]) > 0
        for url in payload["image_urls"]:
            try:
                resolved = await _resolve_image_url(str(url))
                if resolved:
                    resolved_references.append(resolved)
            except Exception as exc:
                unresolved_reference_errors.append(str(exc))
        payload.pop("image_urls", None)
    if "image" in payload:
        image_value = payload["image"]
        if isinstance(image_value, str):
            has_reference_input = True
            try:
                resolved = await _resolve_image_url(image_value)
                if resolved:
                    resolved_references.append(resolved)
            except Exception as exc:
                unresolved_reference_errors.append(str(exc))
        elif isinstance(image_value, list):
            has_reference_input = has_reference_input or len(image_value) > 0
            for value in image_value:
                try:
                    resolved = await _resolve_image_url(str(value))
                    if resolved:
                        resolved_references.append(resolved)
                except Exception as exc:
                    unresolved_reference_errors.append(str(exc))
        payload.pop("image", None)
    if has_reference_input and not resolved_references:
        if unresolved_reference_errors:
            raise RuntimeError(unresolved_reference_errors[0])
        raise RuntimeError("图生图参考图无可用远程地址，请先生成可公网访问的参考图后重试。")
    if unresolved_reference_errors and resolved_references:
        logger.warning("部分图生图参考图已忽略，继续使用可用参考图: %s", unresolved_reference_errors[0])

    # resolved_references 已是经过 _resolve_image_url 处理过的公网可访问 URL，
    # 直接透传给 GRSAI（GRSAI 文档：urls 支持 http(s) URL，不做 Base64 内联，
    # 避免 GRSAI 侧处理 data URL 异常导致任务卡在 running 状态）。

    prompt = str(payload.get("prompt") or "").strip() or "生成一张高质量图片"
    ratio = _resolve_image_aspect_ratio(payload) or "auto"
    raw_model_str = str(payload.get("model") or "").strip()
    raw_lower = raw_model_str.lower().replace("_", "-")
    draw_model = _normalize_grsai_draw_model(raw_model_str or None)
    # 旧素材/设置里存 nano-banana-2-4k-cl 或别名时，映射为 nano-banana-2 且补全 4K 意图
    if raw_lower in {"nano-banana-2-4k", "nano-banana2-4k", "nano-banana-2-4k-cl"}:
        payload.setdefault("size", "4K")
    image_size = _coerce_grsai_draw_image_size(draw_model, payload)
    request_payload: dict[str, Any] = {
        "model": draw_model,
        "prompt": prompt,
        "aspectRatio": ratio,
        "imageSize": image_size,
        "webHook": "-1",
        "shutProgress": False,
    }
    ref_preview = ""
    if resolved_references:
        u0 = str(resolved_references[0] or "").strip()
        ref_preview = (u0[:160] + "…") if len(u0) > 160 else u0
    logger.info(
        "GRSAI draw 请求 user_id=%s model=%s imageSize=%s aspectRatio=%s ref_count=%d ref_preview=%s",
        user_id,
        draw_model,
        image_size,
        ratio,
        len(resolved_references),
        ref_preview,
    )
    if resolved_references:
        request_payload["urls"] = resolved_references[:14]

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    poll_result_endpoint = str(os.getenv("GRSAI_DRAW_RESULT_ENDPOINT", "https://grsai.dakka.com.cn/v1/draw/result")).strip()
    # 单次请求读超时：GRSAI 文生图/图生图一般 1~3 分钟完成，默认 3 分钟
    _draw_timeout = float(str(os.getenv("GRSAI_DRAW_TIMEOUT_SECONDS", "180")).strip() or "180")
    _draw_timeout = max(120.0, min(300.0, _draw_timeout))
    max_retries = 1  # 图生图失败直接展示错误，不重试
    try:
        retry_base_delay = float(str(os.getenv("GRSAI_IMAGE_RETRY_DELAY_SECONDS", "8")).strip() or "8")
    except Exception:
        retry_base_delay = 8.0
    retry_base_delay = max(2.0, min(60.0, retry_base_delay))

    last_exc: Optional[BaseException] = None
    for attempt in range(max_retries):
        try:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(_draw_timeout, connect=30.0),
                trust_env=True,
            ) as client:
                response = await client.post(endpoint, headers=headers, json=request_payload)
                logger.info(
                    "GRSAI draw 响应 status=%s body=%s",
                    response.status_code,
                    response.text[:2000],
                )
                if response.status_code != 200:
                    raise RuntimeError(f"Nano Banana 调用失败：HTTP {response.status_code} {response.text}")
                try:
                    start_json = response.json()
                except Exception as exc:
                    raise RuntimeError(f"Nano Banana 返回非 JSON 响应：{response.text}") from exc
                code = start_json.get("code")
                if code not in (None, 0, 200):
                    raise RuntimeError(str(start_json.get("msg") or start_json))
                direct_urls = _extract_suchuang_image_urls(start_json)
                preferred_direct_url = _pick_preferred_image_url(direct_urls)
                if preferred_direct_url:
                    return {"data": [{"url": preferred_direct_url}]}
                data = start_json.get("data") if isinstance(start_json, dict) else {}
                task_id = ""
                if isinstance(data, dict):
                    task_id = str(data.get("id") or data.get("task_id") or data.get("taskId") or "").strip()
                if not task_id:
                    raise RuntimeError(f"Nano Banana 未返回任务ID：{start_json}")
                result_url = await _poll_suchuang_image_result(
                    client,
                    api_key,
                    task_id,
                    result_endpoint=poll_result_endpoint,
                )
                return {"data": [{"url": result_url}]}
        except RuntimeError:
            raise
        except Exception as exc:
            raise RuntimeError(f"Nano Banana 请求异常：{exc}") from exc
    raise RuntimeError("Nano Banana 失败")


def _resolve_image_aspect_ratio(payload: dict[str, Any]) -> str:
    direct_ratio = str(payload.get("aspect_ratio") or "").strip()
    if direct_ratio in {"1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"}:
        return direct_ratio

    width = payload.get("width")
    height = payload.get("height")
    size = payload.get("size")

    def _parse_int(text: Any) -> int:
        if isinstance(text, int):
            return text
        return int(str(text).strip())

    try:
        if (not width or not height) and size:
            size_text = str(size).lower().strip()
            if "x" in size_text:
                w_text, h_text = size_text.split("x", 1)
                width = _parse_int(w_text)
                height = _parse_int(h_text)
            elif "*" in size_text:
                w_text, h_text = size_text.split("*", 1)
                width = _parse_int(w_text)
                height = _parse_int(h_text)
        if not width or not height:
            return ""
        w = _parse_int(width)
        h = _parse_int(height)
        if w <= 0 or h <= 0:
            return ""
        ratio = w / h
        if abs(ratio - 1.0) <= 0.08:
            return "1:1"
        if abs(ratio - (16 / 9)) <= 0.12:
            return "16:9"
        if abs(ratio - (9 / 16)) <= 0.12:
            return "9:16"
        if abs(ratio - (4 / 3)) <= 0.1:
            return "4:3"
        if abs(ratio - (3 / 4)) <= 0.1:
            return "3:4"
        if abs(ratio - (3 / 2)) <= 0.1:
            return "3:2"
        if abs(ratio - (2 / 3)) <= 0.1:
            return "2:3"
        return ""
    except Exception:
        return ""


def _extract_openrouter_image_url(result: dict[str, Any]) -> str:
    data = result.get("data")
    if isinstance(data, list):
        for item in data:
            if not isinstance(item, dict):
                continue
            url = str(item.get("url") or "").strip()
            if url:
                return url

    output = result.get("output")
    if isinstance(output, list):
        for item in output:
            if not isinstance(item, dict):
                continue
            if item.get("type") != "image":
                continue
            image_url_obj = item.get("image_url")
            if isinstance(image_url_obj, dict):
                url = str(image_url_obj.get("url") or "").strip()
                if url:
                    return url

    choices = result.get("choices")
    if not isinstance(choices, list):
        return ""
    for choice in choices:
        if not isinstance(choice, dict):
            continue
        message = choice.get("message")
        if not isinstance(message, dict):
            continue
        images = message.get("images")
        if isinstance(images, list):
            for image in images:
                if not isinstance(image, dict):
                    continue
                image_url_obj = image.get("image_url")
                if isinstance(image_url_obj, dict):
                    url = str(image_url_obj.get("url") or "").strip()
                    if url:
                        return url
                url = str(image.get("url") or "").strip()
                if url:
                    return url
        content = message.get("content")
        if isinstance(content, list):
            for block in content:
                if not isinstance(block, dict):
                    continue
                if str(block.get("type") or "").strip().lower() != "image_url":
                    continue
                image_url_obj = block.get("image_url")
                if isinstance(image_url_obj, dict):
                    url = str(image_url_obj.get("url") or "").strip()
                    if url:
                        return url
    return ""


def _extract_openrouter_image_b64(result: dict[str, Any]) -> str:
    data = result.get("data")
    if isinstance(data, list):
        for item in data:
            if not isinstance(item, dict):
                continue
            b64_value = str(item.get("b64_json") or "").strip()
            if b64_value:
                return b64_value
    choices = result.get("choices")
    if isinstance(choices, list):
        for choice in choices:
            if not isinstance(choice, dict):
                continue
            message = choice.get("message")
            if not isinstance(message, dict):
                continue
            images = message.get("images")
            if isinstance(images, list):
                for image in images:
                    if not isinstance(image, dict):
                        continue
                    b64_value = str(image.get("b64_json") or image.get("base64") or "").strip()
                    if b64_value:
                        return b64_value
            content = message.get("content")
            if isinstance(content, list):
                for block in content:
                    if not isinstance(block, dict):
                        continue
                    b64_value = str(block.get("b64_json") or block.get("base64") or "").strip()
                    if b64_value:
                        return b64_value
    return ""


async def create_image_edit(
    session: AsyncSession, user_id: str, ref_image_url: str, payload: dict[str, Any]
) -> dict[str, Any]:
    # Wrapper for Image-to-Image
    payload["image_url"] = ref_image_url
    return await create_image(session, user_id, payload)


async def create_image_with_reference(
    session: AsyncSession, user_id: str, ref_image_url: str, payload: dict[str, Any]
) -> dict[str, Any]:
    # Wrapper for Image-to-Image
    payload["image_url"] = ref_image_url
    return await create_image(session, user_id, payload)


def _kling_element_tag_id(role: str) -> str:
    role_text = (role or "").strip().lower()
    if role_text == "character":
        return "o_102"
    if role_text == "scene":
        return "o_106"
    if role_text == "prop":
        return "o_104"
    return "o_108"


def _kling_image_type(role: str) -> str:
    role_text = (role or "").strip().lower()
    if role_text in {"character", "scene", "prop", "first_frame"}:
        return role_text
    return "character"


def _base64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("utf-8").rstrip("=")


def _build_kling_jwt(access_key: str, secret_key: str) -> str:
    now_ts = int(time.time())
    header_bytes = json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode("utf-8")
    payload_bytes = json.dumps(
        {
            "iss": access_key,
            "exp": now_ts + 1800,
            "nbf": now_ts - 5,
        },
        separators=(",", ":"),
    ).encode("utf-8")
    signing_input = f"{_base64url_encode(header_bytes)}.{_base64url_encode(payload_bytes)}"
    signature = hmac.new(secret_key.encode("utf-8"), signing_input.encode("utf-8"), hashlib.sha256).digest()
    return f"{signing_input}.{_base64url_encode(signature)}"


def _kling_auth_probe_url(omni_endpoint: str) -> str:
    base_endpoint = str(omni_endpoint or "").strip().rstrip("/")
    marker = "/v1/videos/omni-video"
    lower_base = base_endpoint.lower()
    if lower_base.endswith(marker):
        return f"{base_endpoint[:-len(marker)]}/v1/videos/text2video?page_num=1&page_size=1"
    if lower_base.endswith("/v1"):
        return f"{base_endpoint}/videos/text2video?page_num=1&page_size=1"
    return f"{base_endpoint}/v1/videos/text2video?page_num=1&page_size=1"


def _kling_task_query_url(omni_endpoint: str, task_id: str) -> str:
    base_endpoint = str(omni_endpoint or "").strip().rstrip("/")
    normalized_task_id = str(task_id or "").strip()
    return f"{base_endpoint}/{normalized_task_id}"


def _extract_kling_task_id(result: dict[str, Any]) -> str:
    data = result.get("data")
    if isinstance(data, dict):
        return str(data.get("task_id") or "").strip()
    return ""


def _sanitize_kling_prompt_text(text: str) -> str:
    normalized = str(text or "").strip()
    if not normalized:
        return ""
    normalized = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u200b\u200c\u200d\u200e\u200f\ufeff]", "", normalized)
    normalized = re.sub(r"\r\n?", "\n", normalized)
    normalized = re.sub(r"\n{3,}", "\n\n", normalized)
    return normalized.strip()


def _truncate_kling_prompt(prompt_text: str, max_chars: int = 2500) -> str:
    sanitized = _sanitize_kling_prompt_text(prompt_text)
    if len(sanitized) <= max_chars:
        return sanitized
    return sanitized[:max_chars].strip()


def _compose_kling_prompt(system_prompt: str, user_prompt: str, max_chars: int = 2500) -> str:
    normalized_system = _sanitize_kling_prompt_text(system_prompt)
    normalized_user = _sanitize_kling_prompt_text(user_prompt)
    if not normalized_system:
        return _truncate_kling_prompt(normalized_user, max_chars)
    prefix = f"【系统提示词】\n{normalized_system}\n\n【用户提示词】\n"
    if len(prefix) >= max_chars:
        fallback_prefix = "【系统提示词】\n\n【用户提示词】\n"
        keep_system = max(0, max_chars - len(fallback_prefix))
        compact_prefix = f"【系统提示词】\n{normalized_system[:keep_system]}\n\n【用户提示词】\n"
        return compact_prefix[:max_chars].strip()
    remain = max_chars - len(prefix)
    return f"{prefix}{normalized_user[:remain]}".strip()


async def _poll_kling_video_url(
    client: httpx.AsyncClient,
    query_url: str,
    api_key: str,
    max_attempts: int = 180,
    poll_interval_seconds: float = 2.0,
) -> str:
    headers = {"Authorization": f"Bearer {api_key}"}
    for attempt in range(max_attempts):
        response = await client.get(query_url, headers=headers)
        if response.status_code != 200:
            raise RuntimeError(
                f"Kling 视频任务查询失败：status={response.status_code} body={response.text.strip() or '(empty)'}"
            )
        payload = response.json()
        if not isinstance(payload, dict):
            raise RuntimeError(f"Kling 视频任务查询返回格式异常：{payload}")
        payload_code = payload.get("code")
        if payload_code not in {0, "0", None, ""}:
            raise RuntimeError(
                f"Kling 视频任务查询失败：code={payload_code} message={payload.get('message') or '(empty)'}"
            )
        data = payload.get("data")
        task_status = ""
        if isinstance(data, dict):
            task_status = str(data.get("task_status") or "").strip().lower()
        video_url = ""
        if isinstance(data, dict):
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
            return video_url
        if task_status in {"failed", "error", "canceled", "cancelled"}:
            raise RuntimeError(f"Kling 视频生成失败：task_status={task_status}")
        if attempt < max_attempts - 1:
            await asyncio.sleep(poll_interval_seconds)
    raise RuntimeError("Kling 视频生成超时：任务长时间未产出视频，请稍后重试")


def _parse_kling_ak_sk(raw_key_text: str) -> tuple[str, str]:
    raw = str(raw_key_text or "").strip()
    if not raw:
        return "", ""
    if raw.startswith("sk-") or raw.count(".") == 2:
        return "", ""
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, dict):
            access_key = str(
                parsed.get("access_key")
                or parsed.get("accessKey")
                or parsed.get("ak")
                or parsed.get("access")
                or parsed.get("AccessKey")
                or ""
            ).strip()
            secret_key = str(
                parsed.get("secret_key")
                or parsed.get("secretKey")
                or parsed.get("sk")
                or parsed.get("secret")
                or parsed.get("SecretKey")
                or ""
            ).strip()
            if access_key and secret_key:
                return access_key, secret_key
    except Exception:
        pass
    access_key_match = re.search(r"access\s*key\s*[:：=]\s*([A-Za-z0-9_-]{8,})", raw, flags=re.IGNORECASE)
    secret_key_match = re.search(r"secret\s*key\s*[:：=]\s*([A-Za-z0-9_-]{8,})", raw, flags=re.IGNORECASE)
    if access_key_match and secret_key_match:
        return access_key_match.group(1).strip(), secret_key_match.group(1).strip()
    if "|" in raw:
        parts = [part.strip() for part in raw.split("|") if part.strip()]
        if len(parts) == 2:
            return parts[0], parts[1]
    for delimiter in [";", ","]:
        if delimiter in raw and "=" in raw:
            part_map: dict[str, str] = {}
            for chunk in raw.split(delimiter):
                chunk_text = chunk.strip()
                if "=" not in chunk_text:
                    continue
                key_part, value_part = chunk_text.split("=", 1)
                part_map[key_part.strip().lower()] = value_part.strip()
            ak = part_map.get("ak") or part_map.get("access_key") or part_map.get("accesskey") or part_map.get("access")
            sk = part_map.get("sk") or part_map.get("secret_key") or part_map.get("secretkey") or part_map.get("secret")
            if ak and sk:
                return ak, sk
    lines = [line.strip() for line in raw.splitlines() if line.strip()]
    if len(lines) == 2 and all(" " not in item for item in lines):
        return lines[0], lines[1]
    token_pairs = re.findall(r"[A-Za-z0-9_-]{24,}", raw)
    if len(token_pairs) == 2:
        return token_pairs[0], token_pairs[1]
    return "", ""


async def _resolve_asset_bindings(
    session: AsyncSession,
    project_id: str,
    asset_bindings: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    asset_ids = [str(item.get("asset_id", "")).strip() for item in asset_bindings if item.get("asset_id")]
    if not asset_ids:
        return []
    asset_ids = list(dict.fromkeys(asset_ids))

    def identity_key(asset_type: str, name: str) -> tuple[str, str]:
        normalized_type = str(asset_type or "").strip().upper()
        normalized_name = re.sub(r"[\s\u3000]+", " ", str(name or "")).strip()
        if normalized_type == "CHARACTER":
            normalized_name = normalized_name.strip("*")
        elif normalized_type == "CHARACTER_LOOK":
            normalized_name = normalized_name.replace(" ", "")
        return normalized_type, normalized_name

    result = await session.execute(
        select(Asset).where(Asset.project_id == project_id, Asset.id.in_(asset_ids))
    )
    assets = list(result.scalars().all())
    if not assets:
        return []
    requested_asset_map = {item.id: item for item in assets}
    requested_keys = {identity_key(item.type, item.name) for item in assets}

    all_project_asset_result = await session.execute(select(Asset).where(Asset.project_id == project_id))
    all_project_assets = list(all_project_asset_result.scalars().all())
    grouped_asset_map = {
        asset.id: asset
        for asset in all_project_assets
        if identity_key(asset.type, asset.name) in requested_keys
    }
    if not grouped_asset_map:
        return []
    asset_key_map = {asset_id: identity_key(asset.type, asset.name) for asset_id, asset in grouped_asset_map.items()}

    version_result = await session.execute(
        select(AssetVersion)
        .where(AssetVersion.asset_id.in_(list(grouped_asset_map.keys())))
        .order_by(AssetVersion.created_at.desc())
    )
    versions = list(version_result.scalars().all())
    selected_by_asset: dict[str, AssetVersion] = {}
    latest_by_asset: dict[str, AssetVersion] = {}
    selected_by_key: dict[tuple[str, str], AssetVersion] = {}
    latest_by_key: dict[tuple[str, str], AssetVersion] = {}
    for version in versions:
        asset_id = str(version.asset_id or "").strip()
        if not asset_id:
            continue
        key = asset_key_map.get(version.asset_id)
        if not key:
            continue
        image_url = str(version.image_url or "").strip()
        if not image_url:
            continue
        if asset_id not in latest_by_asset:
            latest_by_asset[asset_id] = version
        if version.is_selected and asset_id not in selected_by_asset:
            selected_by_asset[asset_id] = version
        if key not in latest_by_key:
            latest_by_key[key] = version
        if version.is_selected and key not in selected_by_key:
            selected_by_key[key] = version

    resolved: list[dict[str, Any]] = []
    for binding in asset_bindings:
        asset_id = str(binding.get("asset_id", "")).strip()
        if not asset_id or asset_id not in requested_asset_map:
            continue
        key = asset_key_map.get(asset_id)
        if not key:
            continue
        version = (
            selected_by_asset.get(asset_id)
            or latest_by_asset.get(asset_id)
            or selected_by_key.get(key)
            or latest_by_key.get(key)
        )
        if not version or not version.image_url:
            continue
        resolved_image_url = await _resolve_image_url(str(version.image_url))
        if not resolved_image_url:
            continue
        asset = requested_asset_map[asset_id]
        resolved.append(
            {
                "asset_id": asset_id,
                "role": str(binding.get("role", "")).strip().lower() or "character",
                "name": str(binding.get("name", "")).strip() or asset.name,
                "description": str(binding.get("description", "")).strip() or (asset.description or ""),
                "image_url": resolved_image_url,
            }
        )
    return resolved


async def _create_kling_element(
    client: httpx.AsyncClient,
    api_key: str,
    project_id: str,
    item: dict[str, Any],
) -> str:
    image_url = str(item.get("image_url", "")).strip()
    if not image_url:
        return ""
    role = str(item.get("role", "")).strip().lower()
    if role not in {"character", "scene", "prop"}:
        return ""
    asset_id = str(item.get("asset_id", "")).strip()
    image_hash = hashlib.sha1(image_url.encode("utf-8")).hexdigest()[:16]
    cache_key = f"{project_id}:{asset_id}:{role}:{image_hash}"
    cached = _KLING_ELEMENT_CACHE.get(cache_key)
    now_ts = time.time()
    if cached and now_ts - cached[1] <= _KLING_ELEMENT_CACHE_TTL_SECONDS:
        return cached[0]
    if cached and now_ts - cached[1] > _KLING_ELEMENT_CACHE_TTL_SECONDS:
        _KLING_ELEMENT_CACHE.pop(cache_key, None)
    name = str(item.get("name", "")).strip() or f"asset-{asset_id[:8]}"
    desc = str(item.get("description", "")).strip()
    payload = {
        "name": name[:20],
        "description": desc[:100],
        "reference_type": "image_refer",
        "element_image_list": {
            "frontal_image": {"image_url": image_url},
            "image_list": [{"image_url": image_url}],
        },
        "tag_list": [{"tag_id": _kling_element_tag_id(role)}],
        "external_task_id": f"{project_id}-{asset_id}-{int(asyncio.get_event_loop().time() * 1000)}",
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    try:
        response = await client.post(
            "https://api.magic666.cn/api/v1/general/advanced-custom-elements",
            headers=headers,
            json=payload,
        )
        if response.status_code != 200:
            logger.warning("Create kling element failed: status=%s body=%s", response.status_code, response.text)
            return ""
        data = response.json()
        if isinstance(data, dict):
            if isinstance(data.get("data"), dict):
                body = data["data"]
                element_id = str(body.get("id") or body.get("element_id") or body.get("custom_element_id") or "")
                if element_id:
                    _KLING_ELEMENT_CACHE[cache_key] = (element_id, now_ts)
                return element_id
            element_id = str(data.get("id") or data.get("element_id") or data.get("custom_element_id") or "")
            if element_id:
                _KLING_ELEMENT_CACHE[cache_key] = (element_id, now_ts)
            return element_id
    except Exception as exc:
        logger.warning("Create kling element failed: %s", exc)
    return ""


async def create_video(
    session: AsyncSession, user_id: str, payload: dict[str, Any], wait_for_result: bool = True
) -> dict[str, Any]:
    settings = await get_or_create_settings(session, user_id)
    configured_key = await get_api_key(session, user_id)
    default_video_api_key = "sk-FasceV0bEbOdg88TFa7FpIlLubCftqTmvZJretK3fgR81cTP"
    model = payload.get("model", "veo_3_1-4K")
    prompt = payload.get("prompt", "")
    image_url = payload.get("image_url")
    project_id = str(payload.get("project_id", "")).strip()
    first_frame_asset_id = str(payload.get("first_frame_asset_id", "")).strip()
    custom_first_frame_url = str(payload.get("custom_first_frame_url") or "").strip()
    custom_last_frame_url = str(payload.get("custom_last_frame_url") or "").strip()
    previous_segment_video_url = str(payload.get("previous_segment_video_url") or payload.get("reference_video_url") or "").strip()
    model_text = str(model or "").strip()
    model_text_lower = model_text.lower()
    is_kling_model = model_text_lower.startswith("kling")
    is_kling_o1_model = model_text_lower == "kling-video-o1"
    system_prompt = str(payload.get("system_prompt", "") or "").strip()
    default_kling_endpoint = "https://api-beijing.klingai.com/v1/videos/omni-video"
    if is_kling_model:
        if "kling-v1" in model_text_lower:
            has_ref_image = bool(payload.get("reference_images")) or bool(payload.get("image_list")) or bool(payload.get("image_url"))
            if has_ref_image:
                default_kling_endpoint = "https://api-beijing.klingai.com/v1/videos/multi-image2video"
            else:
                default_kling_endpoint = "https://api-beijing.klingai.com/v1/videos/text2video"
    
    default_video_endpoint = "https://api.magic666.cn/api/v1/video/generations"
    configured_endpoint = str(settings.endpoint or "").strip()
    endpoint = default_kling_endpoint if is_kling_model else default_video_endpoint
    use_configured_video_provider = False
    configured_key_normalized = str(configured_key or "").strip()
    kling_access_key, kling_secret_key = _parse_kling_ak_sk(configured_key_normalized)
    use_official_kling = is_kling_model
    if is_kling_model and configured_endpoint:
        normalized_endpoint = configured_endpoint.strip().rstrip("/")
        normalized_lower = normalized_endpoint.lower()
        if "klingai.com" in normalized_lower:
            import urllib.parse
            parsed_conf = urllib.parse.urlparse(normalized_endpoint)
            parsed_def = urllib.parse.urlparse(default_kling_endpoint)
            endpoint = f"{parsed_conf.scheme}://{parsed_conf.netloc}{parsed_def.path}"
    elif configured_endpoint:
        normalized_endpoint = configured_endpoint.strip().rstrip("/")
        normalized_lower = normalized_endpoint.lower()
        if "magic666.cn" in normalized_lower:
            use_configured_video_provider = True
            if normalized_lower.endswith("/video/generations"):
                endpoint = normalized_endpoint
            elif normalized_lower.endswith("/api/v1"):
                endpoint = f"{normalized_endpoint}/video/generations"
            else:
                endpoint = f"{normalized_endpoint}/api/v1/video/generations"
        else:
            logger.warning(
                "Configured endpoint is non-video provider, fallback to default video endpoint. configured_endpoint=%s",
                configured_endpoint,
            )
    api_key = default_video_api_key
    key_source = "default"
    if is_kling_model:
        if kling_access_key and kling_secret_key:
            api_key = _build_kling_jwt(kling_access_key, kling_secret_key)
            key_source = "configured_aksk_jwt"
        elif configured_key_normalized.count(".") == 2 and " " not in configured_key_normalized:
            api_key = configured_key_normalized
            key_source = "configured_jwt"
        else:
            raise RuntimeError(
                f"Kling v3 Omni 仅支持官方鉴权：请在设置页 Key 填写 AK|SK 或 Access Key/Secret Key（JSON也可）"
                f"（current_user={user_id} has_saved_key={bool(configured_key_normalized)} key_len={len(configured_key_normalized)}）"
            )
    elif use_configured_video_provider and configured_key_normalized:
        if configured_key_normalized.startswith("sk-"):
            api_key = configured_key_normalized
            key_source = "configured"
        else:
            logger.warning(
                "Configured video key format is invalid for bearer token, fallback to default key. key_prefix=%s",
                configured_key_normalized[:8],
            )
    fallback_api_key = default_video_api_key if api_key != default_video_api_key else ""
    if is_kling_model:
        fallback_api_key = ""
    asset_bindings_raw = payload.get("asset_bindings")
    asset_bindings = (
        [item for item in asset_bindings_raw if isinstance(item, dict)]
        if isinstance(asset_bindings_raw, list)
        else []
    )

    if not api_key:
        raise RuntimeError("未配置视频接口 API Key，请先在设置页填写后重试")
    logger.info(f"Creating video with model={model}, prompt={prompt[:20]}..., image_url={'yes' if image_url else 'no'}")
    logger.info("Video endpoint=%s key_source=%s has_custom_key=%s use_official_kling=%s", endpoint, key_source, bool(configured_key), use_official_kling)
    logger.info("Video request raw payload=%s", json.dumps(payload, ensure_ascii=False, default=str))

    data: dict[str, Any] = {
        "model": model,
        "prompt": _compose_kling_prompt(system_prompt, prompt, 2500) if is_kling_model else (f"【系统提示词】\n{system_prompt}\n\n【用户提示词】\n{prompt}" if system_prompt else prompt),
    }
    if is_kling_model:
        data["model_name"] = model_text_lower or "kling-v3-omni"
        data.pop("model", None)
        if image_url:
            resolved_image_url = await _resolve_image_url(str(image_url))
            if resolved_image_url:
                image_url = _normalize_kling_image_value(resolved_image_url)

    resolved_assets: list[dict[str, Any]] = []
    if is_kling_model and project_id and asset_bindings:
        resolved_assets = await _resolve_asset_bindings(session, project_id, asset_bindings)
        if not resolved_assets:
            raise RuntimeError("检测到已选择素材，但未解析到可用素材图片，请确认素材版本已生成并被选中后重试")

    if resolved_assets and is_kling_model:
        prepared_refs: list[dict[str, str]] = []
        for item in resolved_assets:
            role = str(item.get("role", "")).strip().lower()
            asset_id = str(item.get("asset_id", "")).strip()
            prepared_image_url = _normalize_kling_image_value(str(item.get("image_url", "")))
            if not prepared_image_url:
                continue
            mapped_type = ""
            if first_frame_asset_id and asset_id == first_frame_asset_id:
                mapped_type = "first_frame"
            prepared_refs.append(
                {
                    "role": role,
                    "name": str(item.get("name", "")).strip(),
                    "description": str(item.get("description", "")).strip(),
                    "image_url": prepared_image_url,
                    "type": mapped_type,
                }
            )

        prompt_lines = ["【主体语义映射】"]
        reference_images: list[dict[str, Any]] = []
        for index, item in enumerate(prepared_refs, start=1):
            image_item: dict[str, Any] = {"image_url": item["image_url"]}
            if item.get("type"):
                image_item["type"] = item["type"]
            reference_images.append(image_item)
            role_name = "角色" if item.get("role") == "character" else "场景" if item.get("role") == "scene" else "道具" if item.get("role") == "prop" else "主体"
            prompt_lines.append(f"{role_name}{index}: {item.get('name', '')}；描述：{item.get('description', '')}；引用：<<<image_{index}>>>")
        if not reference_images:
            raise RuntimeError("已解析到素材绑定，但未构造出有效 reference_images，请检查素材图片地址是否可访问")
        if reference_images:
            data["reference_images"] = reference_images
            data["image_list"] = reference_images
            if not image_url:
                image_url = reference_images[0].get("image_url", "")
        data["prompt"] = f"{str(data.get('prompt', '')).strip()}\n" + "\n".join(prompt_lines)

    if is_kling_model:
        original_prompt = str(data.get("prompt", ""))
        truncated_prompt = _truncate_kling_prompt(original_prompt, 2500)
        if len(original_prompt) > len(truncated_prompt):
            logger.warning("Kling prompt truncated from %s to %s characters", len(original_prompt), len(truncated_prompt))
        data["prompt"] = truncated_prompt
        data["mode"] = payload.get("mode", "pro")
        raw_duration = payload.get("duration", 5)
        try:
            duration_value = int(round(float(raw_duration)))
        except (TypeError, ValueError):
            duration_value = 5
        data["duration"] = max(3, min(15, duration_value))
        data["aspect_ratio"] = str(payload.get("aspect_ratio") or "16:9")
        data["reference_video"] = payload.get("reference_video", False)
        sound_value = str(payload.get("sound") or "").strip().lower()
        if sound_value not in {"on", "off"}:
            sound_value = "on" if bool(payload.get("with_audio", False)) else "off"
        data["sound"] = sound_value
        max_duration = 10 if is_kling_o1_model and sound_value == "on" else 15
        data["duration"] = max(3, min(max_duration, duration_value))
        has_start_or_end_frame = bool(first_frame_asset_id or custom_first_frame_url or custom_last_frame_url)
        has_image_reference = bool(data.get("reference_images")) or bool(data.get("image_list")) or bool(image_url)
        if not (is_kling_o1_model and has_image_reference and not has_start_or_end_frame):
            data["aspect_ratio"] = str(payload.get("aspect_ratio") or "16:9")
        else:
            data.pop("aspect_ratio", None)
        if payload.get("multi_shot") is not None:
            data["multi_shot"] = payload.get("multi_shot")
        if payload.get("shot_type"):
            data["shot_type"] = payload.get("shot_type")
        if payload.get("multi_prompt"):
            data["multi_prompt"] = payload.get("multi_prompt")
        data.pop("reference_video", None)
        data.pop("reference_video_url", None)
        data.pop("refer_type", None)
        data.pop("keep_original_sound", None)

        existing_refs = data.get("reference_images")
        if isinstance(existing_refs, list):
            existing_refs = [item for item in existing_refs if isinstance(item, dict)]
        else:
            existing_refs = []

        async def _append_custom_frame(frame_url: str, frame_type: str) -> str:
            nonlocal existing_refs
            resolved = await _resolve_image_url(frame_url)
            if not resolved:
                return ""
            normalized = _normalize_kling_image_value(str(resolved))
            if not normalized:
                return ""
            existing_refs = [item for item in existing_refs if str(item.get("type", "")).strip().lower() != frame_type]
            existing_refs.append({"image_url": normalized, "type": frame_type})
            return normalized

        if custom_first_frame_url:
            resolved_first_frame = await _append_custom_frame(custom_first_frame_url, "first_frame")
            if resolved_first_frame:
                image_url = resolved_first_frame
        if custom_last_frame_url:
            await _append_custom_frame(custom_last_frame_url, "last_frame")
        if previous_segment_video_url and not custom_first_frame_url:
            tail_frame_b64 = await _extract_video_tail_frame_base64(previous_segment_video_url)
            if not tail_frame_b64:
                raise RuntimeError("上一条分镜视频尾帧提取失败，无法作为首帧")
            tail_frame_ref = {"image_url": tail_frame_b64, "type": "first_frame"}
            existing_refs = [item for item in existing_refs if str(item.get("type", "")).strip().lower() != "first_frame"]
            existing_refs.insert(0, tail_frame_ref)
            image_url = tail_frame_b64
        if existing_refs:
            data["reference_images"] = existing_refs
            data["image_list"] = existing_refs
        elif image_url and not data.get("reference_images"):
            single_image_ref = {"image_url": image_url}
            data["reference_images"] = [single_image_ref]
            data["image_list"] = [single_image_ref]
    else:
        data["size"] = payload.get("size", "1280x720")
        data["seconds"] = payload.get("seconds", 5)
        if image_url:
            data["image_url"] = image_url

    async def _extract_video_url(result: dict[str, Any]) -> str:
        if "data" in result and isinstance(result["data"], list) and len(result["data"]) > 0:
            return result["data"][0].get("url") or ""
        if "data" in result and isinstance(result["data"], dict):
            task_result = result["data"].get("task_result")
            if isinstance(task_result, dict):
                videos = task_result.get("videos")
                if isinstance(videos, list) and len(videos) > 0 and isinstance(videos[0], dict):
                    return videos[0].get("url") or ""
                return task_result.get("url") or task_result.get("video_url") or ""
        if "url" in result:
            return result["url"] or ""
        if "video_url" in result:
            return result["video_url"] or ""
        if "output" in result and isinstance(result["output"], dict):
            output = result["output"]
            return output.get("url") or output.get("video_url") or ""
        return ""

    endpoint_candidates = [endpoint]
    if (not is_kling_model) and "magic666.cn" in endpoint.lower() and endpoint.endswith("/video/generations"):
        endpoint_candidates.append(endpoint.replace("/video/generations", "/videos/omni-video"))
    dedup_endpoint_candidates: list[str] = []
    endpoint_seen: set[str] = set()
    for item in endpoint_candidates:
        if item in endpoint_seen:
            continue
        endpoint_seen.add(item)
        dedup_endpoint_candidates.append(item)

    client_modes = [False, True]
    last_error: Exception | None = None
    for trust_env_mode in client_modes:
        try:
            async with httpx.AsyncClient(timeout=120.0, trust_env=trust_env_mode) as client:
                if is_kling_model and project_id and resolved_assets and "magic666.cn" in endpoint.lower():
                    element_refs: list[dict[str, Any]] = []
                    for item in resolved_assets:
                        element_id = await _create_kling_element(client, api_key, project_id, item)
                        if not element_id:
                            continue
                        element_refs.append(
                            {
                                "element_id": element_id,
                                "type": _kling_image_type(str(item.get("role", ""))),
                                "asset_id": item.get("asset_id"),
                            }
                        )
                    if element_refs:
                        data["elements"] = element_refs
                        data["element_list"] = element_refs
                logger.info(
                    "Video request final payload trust_env=%s payload=%s",
                    trust_env_mode,
                    json.dumps(data, ensure_ascii=False, default=str),
                )
                if is_kling_model:
                    probe_url = _kling_auth_probe_url(endpoint)
                    probe_response = await client.get(
                        probe_url,
                        headers={"Authorization": f"Bearer {api_key}"},
                    )
                    if probe_response.status_code in {401, 403}:
                        probe_code = ""
                        probe_message = probe_response.text.strip() or "(empty)"
                        try:
                            probe_payload = probe_response.json()
                            if isinstance(probe_payload, dict):
                                probe_code = str(probe_payload.get("code", "")).strip()
                                probe_message = str(probe_payload.get("message", "")).strip() or probe_message
                        except Exception:
                            pass
                        raise RuntimeError(
                            "Kling 官方鉴权失败：当前账号的 Access Key / Secret Key 无效、已禁用或与站点不匹配。"
                            f"请到开发者控制台重新生成并保存后重试（auth_code={probe_code or 'unknown'} auth_message={probe_message}）"
                        )
                payload_candidates: list[tuple[str, dict[str, Any]]] = [("primary", data)]
                if is_kling_model:
                    has_strict_constraints = str(data.get("sound") or "off").strip().lower() == "on" or bool(data.get("reference_images")) or bool(data.get("image_list")) or bool(data.get("elements")) or bool(data.get("element_list")) or bool(data.get("reference_video")) or bool(data.get("reference_video_url"))
                    if has_strict_constraints:
                        lower_model_payload = dict(data)
                        if "model" in lower_model_payload:
                            lower_model_payload["model"] = model_text_lower
                        else:
                            lower_model_payload["model_name"] = model_text_lower
                        payload_candidates.append(("primary_lower_model", lower_model_payload))
                        if is_kling_o1_model and str(data.get("sound") or "").strip().lower() == "on":
                            o1_compat_payload = dict(data)
                            if bool(o1_compat_payload.get("reference_images")) or bool(o1_compat_payload.get("image_list")):
                                if not bool(first_frame_asset_id):
                                    o1_compat_payload.pop("aspect_ratio", None)
                            raw_o1_duration = o1_compat_payload.get("duration", 5)
                            try:
                                parsed_o1_duration = int(round(float(raw_o1_duration)))
                            except (TypeError, ValueError):
                                parsed_o1_duration = 5
                            o1_compat_payload["duration"] = max(3, min(10, parsed_o1_duration))
                            payload_candidates.append(("o1_audio_compat", o1_compat_payload))
                    else:
                        compact_payload = dict(data)
                        for key in [
                            "reference_images",
                            "image_list",
                            "elements",
                            "element_list",
                            "sound",
                            "reference_video",
                            "multi_shot",
                            "shot_type",
                            "multi_prompt",
                            "reference_video_url",
                        ]:
                            compact_payload.pop(key, None)
                        compact_payload["mode"] = "pro"
                        compact_payload.pop("system_prompt", None)
                        payload_candidates.append(("compact", compact_payload))
                        lower_model_payload = dict(compact_payload)
                        if "model" in lower_model_payload:
                            lower_model_payload["model"] = model_text_lower
                        else:
                            lower_model_payload["model_name"] = model_text_lower
                        payload_candidates.append(("compact_lower_model", lower_model_payload))
                        ultra_min_payload: dict[str, Any] = {
                            "prompt": str(compact_payload.get("prompt", "")),
                            "duration": int(compact_payload.get("duration", 5)),
                            "mode": "pro",
                        }
                        if use_official_kling:
                            ultra_min_payload["model_name"] = model_text_lower or "kling-v3-omni"
                        else:
                            ultra_min_payload["model"] = model_text_lower or "kling-v3-omni"
                        if compact_payload.get("aspect_ratio"):
                            ultra_min_payload["aspect_ratio"] = compact_payload["aspect_ratio"]
                        payload_candidates.append(("ultra_min", ultra_min_payload))
                        if not use_official_kling:
                            doc_payload = dict(ultra_min_payload)
                            doc_payload["model_name"] = model_text_lower or "kling-v3-omni"
                            doc_payload.pop("model", None)
                            payload_candidates.append(("doc_model_name", doc_payload))

                last_error_text = ""
                attempt_errors: list[str] = []
                for endpoint_try in dedup_endpoint_candidates:
                    for label, request_data in payload_candidates:
                        logger.info(
                            "Video request endpoint=%s attempt=%s trust_env=%s payload=%s",
                            endpoint_try,
                            label,
                            trust_env_mode,
                            json.dumps(request_data, ensure_ascii=False, default=str),
                        )
                        key_candidates = [("primary_key", api_key)]
                        if fallback_api_key:
                            key_candidates.append(("fallback_default_key", fallback_api_key))
                        for key_label, key_value in key_candidates:
                            headers = {
                                "Authorization": f"Bearer {key_value}",
                                "Content-Type": "application/json"
                            }
                            try:
                                response = await client.post(
                                    endpoint_try,
                                    headers=headers,
                                    json=request_data
                                )
                            except Exception as req_exc:
                                req_error = f"{endpoint_try}|{label}<{key_label}> exception={type(req_exc).__name__}:{repr(req_exc)}"
                                last_error_text = req_error
                                attempt_errors.append(req_error)
                                continue
                            logger.info(
                                "Video response endpoint=%s attempt=%s key=%s trust_env=%s status=%s body=%s",
                                endpoint_try,
                                label,
                                key_label,
                                trust_env_mode,
                                response.status_code,
                                response.text,
                            )
                            if response.status_code != 200:
                                error_body = response.text.strip() or "(empty)"
                                last_error_text = f"{endpoint_try}|{label}<{key_label}> status={response.status_code} body={error_body}"
                                attempt_errors.append(last_error_text)
                                if response.status_code in {401, 403} and key_label == "primary_key" and fallback_api_key:
                                    continue
                                break
                            result = response.json()
                            video_url = await _extract_video_url(result)
                            if video_url:
                                return {"data": [{"url": video_url}]}
                            if is_kling_model and wait_for_result:
                                task_id = _extract_kling_task_id(result)
                                if task_id:
                                    query_url = _kling_task_query_url(endpoint_try, task_id)
                                    queried_video_url = await _poll_kling_video_url(client, query_url, key_value)
                                    if queried_video_url:
                                        return {"data": [{"url": queried_video_url}]}
                            elif is_kling_model and not wait_for_result:
                                task_id = _extract_kling_task_id(result)
                                if task_id:
                                    result["_kling_endpoint"] = endpoint_try
                            return result
                if attempt_errors:
                    last_error = RuntimeError(" | ".join(attempt_errors))
                else:
                    last_error = RuntimeError(last_error_text or "视频生成失败")
        except Exception as e:
            logger.error("Failed to create video trust_env=%s error=%s", trust_env_mode, e)
            last_error = e
            continue
    if last_error:
        raise last_error
    raise RuntimeError("视频生成失败")
