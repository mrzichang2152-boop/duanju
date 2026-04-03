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
import uuid
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
from app.models.character_voice import CharacterVoice
from app.models.kling_subject import KlingSubject
from app.services.settings import get_api_key, get_or_create_settings

logger = logging.getLogger(__name__)

_KLING_ELEMENT_CACHE_TTL_SECONDS = 24 * 60 * 60
_KLING_ELEMENT_CACHE: dict[str, tuple[str, float]] = {}
_OPENROUTER_TEXT_MODEL = "gemini-3.1-pro"
_OPENROUTER_IMAGE_MODEL = "nano-banana-2"

# GRSAI /v1/draw/nano-banana 文档列出的绘画 model 值（用于 /linkapi/models 与前端 datalist）
_GRSAI_DRAW_MODEL_ENTRIES: tuple[tuple[str, str], ...] = (
    ("nano-banana-2", "Nano Banana 2（4K 请选 imageSize，勿用 -4k-cl 专线）"),
    ("nano-banana-2-cl", "Nano Banana 2 CL（仅 1K/2K）"),
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
    env_key = (
        str(getattr(app_settings, "grsai_api_key", "") or "").strip()
        or os.getenv("GRSAI_API_KEY", "").strip()
        or app_settings.suchuang_api_key.strip()
        or os.getenv("SUCHUANG_API_KEY", "").strip()
    )
    if env_key:
        return env_key
    try:
        configured_key = await get_api_key(session, user_id)
    except Exception as exc:
        logger.warning("读取用户配置 API Key 失败，回退到环境变量: %s", exc)
        configured_key = ""
    return str(configured_key or "").strip()


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
                    reasoning_text = _extract_suchuang_text(message.get("reasoning_content"))
                    if reasoning_text:
                        return reasoning_text
                delta = item.get("delta")
                if isinstance(delta, dict):
                    delta_text = _extract_suchuang_text(delta.get("content"))
                    if delta_text:
                        return delta_text
                    delta_reasoning = _extract_suchuang_text(delta.get("reasoning_content"))
                    if delta_reasoning:
                        return delta_reasoning
                item_text = _extract_suchuang_text(item.get("text"))
                if item_text:
                    return item_text
                item_reasoning = _extract_suchuang_text(item.get("reasoning_content"))
                if item_reasoning:
                    return item_reasoning
        for key in ("content", "text", "result", "output", "answer", "reasoning_content", "data", "message"):
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
    # 统一走 nano-banana-2 + imageSize（含 4K）：任意 nano-banana-2-4k* 变体（含 -4k-cl）均不得透传
    if lower.startswith("nano-banana-2-4k") or lower in {"nano-banana2-4k", "nanobanana2-4k"}:
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


def _outgoing_grsai_draw_model_must_be_nano_banana_2(model: str, payload: dict[str, Any]) -> str:
    """HTTP 发出前最后一道闸：禁止对 GRSAI 提交 nano-banana-2-4k-cl（产品约定）。"""
    m = (model or "").strip().lower().replace("_", "-")
    if m == "nano-banana-2-4k-cl" or m.startswith("nano-banana-2-4k"):
        payload.setdefault("size", "4K")
        return "nano-banana-2"
    return (model or "").strip() or _OPENROUTER_IMAGE_MODEL


def _coerce_grsai_draw_image_size(model: str, payload: dict[str, Any]) -> str:
    """按 GRSAI 文档约束 imageSize；错误组合易导致任务卡住或久不返回终态。"""
    m = (model or "").strip().lower()
    base = _resolve_suchuang_size(payload)
    # 临时策略：nano-banana-2 统一压到 2K，避免上游按 4K 专线归类为 -4k-cl
    if m == "nano-banana-2":
        return "2K"
    # 仅支持 4K
    if m in {"nano-banana-pro-4k-vip"}:
        return "4K"
    # 仅支持 1K、2K（文档：nano-banana-2-cl / nano-banana-pro-vip）
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
        max_wall_seconds = float(str(os.getenv("GRSAI_POLL_MAX_WALL_SECONDS", "480")).strip() or "480")
    except Exception:
        max_wall_seconds = 480.0
    max_wall_seconds = max(60.0, min(1800.0, max_wall_seconds))
    # running 状态下 progress 可能长时间不变（例如上游排队），默认不要早于总墙钟超时判失败。
    default_stall_polls = int(max_wall_seconds // 2)  # 轮询间隔 2s
    try:
        stall_poll_threshold = int(
            str(os.getenv("GRSAI_POLL_STALL_POLLS", str(default_stall_polls))).strip()
            or str(default_stall_polls)
        )
    except Exception:
        stall_poll_threshold = default_stall_polls
    stall_poll_threshold = max(30, min(300, stall_poll_threshold))
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
                    stall_warned = False
                    last_running_progress = pr
                if stall_polls >= stall_poll_threshold and not stall_warned:
                    logger.warning(
                        "GRSAI 任务长时间进度不变（约 %ss，status=%s progress=%s task_id=%s），继续轮询直到终态或墙钟超时",
                        stall_poll_threshold * 2,
                        status_text,
                        pr,
                        task_id,
                    )
                    stall_warned = True
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
    draw_model = _normalize_grsai_draw_model(raw_model_str or None)
    draw_model = _outgoing_grsai_draw_model_must_be_nano_banana_2(draw_model, payload)
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
        "GRSAI draw 请求 user_id=%s raw_model=%s outgoing_model=%s imageSize=%s aspectRatio=%s ref_count=%d ref_preview=%s",
        user_id,
        raw_model_str or "(empty)",
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


def _resolve_system_kling_key_text() -> str:
    jwt_token = (
        str(getattr(app_settings, "kling_api_key", "") or "").strip()
        or os.getenv("KLING_API_KEY", "").strip()
        or os.getenv("KLING_JWT", "").strip()
        or os.getenv("KLING_AUTH_TOKEN", "").strip()
    )
    if jwt_token:
        return jwt_token
    access_key = (
        str(getattr(app_settings, "kling_access_key", "") or "").strip()
        or str(getattr(app_settings, "kling_ak", "") or "").strip()
        or os.getenv("KLING_ACCESS_KEY", "").strip()
        or os.getenv("KLING_AK", "").strip()
    )
    secret_key = (
        str(getattr(app_settings, "kling_secret_key", "") or "").strip()
        or str(getattr(app_settings, "kling_sk", "") or "").strip()
        or os.getenv("KLING_SECRET_KEY", "").strip()
        or os.getenv("KLING_SK", "").strip()
    )
    if access_key and secret_key:
        return f"{access_key}|{secret_key}"
    return ""


def _resolve_kling_auth_token_from_key_text(raw_key_text: str) -> tuple[str, str]:
    normalized = str(raw_key_text or "").strip()
    if not normalized:
        return "", ""
    ak, sk = _parse_kling_ak_sk(normalized)
    if ak and sk:
        return _build_kling_jwt(ak, sk), "aksk_jwt"
    if normalized.count(".") == 2 and " " not in normalized:
        return normalized, "jwt"
    return "", ""


async def resolve_kling_auth_token(session: AsyncSession, user_id: str) -> tuple[str, str]:
    configured_key = str(await get_api_key(session, user_id) or "").strip()
    token, token_mode = _resolve_kling_auth_token_from_key_text(configured_key)
    if token:
        return token, f"configured_{token_mode}"
    system_key_text = _resolve_system_kling_key_text()
    token, token_mode = _resolve_kling_auth_token_from_key_text(system_key_text)
    if token:
        return token, f"system_{token_mode}"
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


def _normalize_role_key(name: str) -> str:
    value = str(name or "").strip()
    for sep in ["·", "：", ":", "-", "—", "｜", "|"]:
        if sep in value:
            left = value.split(sep, 1)[0].strip()
            if left:
                return left
    return value


def _normalize_subject_name_key(name: str) -> str:
    value = str(name or "").replace("\u3000", " ").strip()
    value = re.sub(r"\s+", " ", value)
    return value.lower()


async def _delete_kling_subject_remote(
    client: httpx.AsyncClient,
    api_key: str,
    subject_id: str,
) -> bool:
    element_id = str(subject_id or "").strip()
    if not element_id:
        return True

    endpoint_candidates = [
        str(os.getenv("KLING_SUBJECT_DELETE_ENDPOINT") or "").strip(),
        "https://api-beijing.klingai.com/v1/general/delete-elements",
        "https://api.magic666.cn/api/v1/general/delete-elements",
    ]
    endpoint_candidates = [item for item in endpoint_candidates if item]

    payload = {"element_id": element_id}

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    for endpoint in endpoint_candidates:
        try:
            response = await client.post(endpoint, headers=headers, json=payload)
        except Exception as exc:
            logger.warning("Delete kling subject request failed endpoint=%s err=%s", endpoint, exc)
            continue
        if response.status_code != 200:
            continue
        try:
            body = response.json()
        except Exception:
            body = {}
        if isinstance(body, dict) and body.get("code") not in (None, 0, "0", 200, "200"):
            continue
        data_obj = body.get("data") if isinstance(body, dict) and isinstance(body.get("data"), dict) else {}
        task_status = str(data_obj.get("task_status") or "").strip().lower()
        if not task_status or task_status in {"submitted", "processing", "succeed", "success"}:
            return True
    return False


def _pick_character_voice_for_subject_name(
    subject_name: str,
    voices: list[CharacterVoice],
) -> CharacterVoice | None:
    name = str(subject_name or "").strip()
    if not name:
        return None

    normalized_name = _normalize_role_key(name)
    compact_name = name.replace(" ", "")
    compact_normalized_name = normalized_name.replace(" ", "")

    exact_match: CharacterVoice | None = None
    normalized_match: CharacterVoice | None = None
    prefix_candidates: list[tuple[int, CharacterVoice]] = []

    for voice in voices:
        raw_name = str(voice.character_name or "").strip()
        if not raw_name:
            continue
        raw_normalized = _normalize_role_key(raw_name)

        if raw_name == name:
            exact_match = exact_match or voice
            continue
        if raw_name == normalized_name or raw_normalized == normalized_name:
            normalized_match = normalized_match or voice
            continue

        compact_raw = raw_name.replace(" ", "")
        compact_raw_normalized = raw_normalized.replace(" ", "")
        for candidate in [compact_raw, compact_raw_normalized]:
            if not candidate:
                continue
            if compact_name.startswith(candidate) or compact_normalized_name.startswith(candidate):
                prefix_candidates.append((len(candidate), voice))
                break

    if exact_match:
        return exact_match
    if normalized_match:
        return normalized_match
    if prefix_candidates:
        prefix_candidates.sort(key=lambda item: item[0], reverse=True)
        return prefix_candidates[0][1]
    return None


async def _attach_character_voice_ids(
    session: AsyncSession,
    project_id: str,
    items: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    if not items:
        return items
    has_character_item = any(
        str(item.get("role", "")).strip().lower() == "character"
        for item in items
    )
    if not has_character_item:
        return items

    voice_rows = await session.execute(
        select(CharacterVoice).where(CharacterVoice.project_id == project_id)
    )
    voices = list(voice_rows.scalars().all())
    if not voices:
        return items

    voices.sort(
        key=lambda row: (row.updated_at or row.created_at or 0, row.created_at or 0),
        reverse=True,
    )

    for item in items:
        if str(item.get("role", "")).strip().lower() != "character":
            continue
        matched = _pick_character_voice_for_subject_name(str(item.get("name", "")), voices)
        if not matched:
            continue
        voice_id = str(matched.voice_id or "").strip()
        if voice_id:
            item["voice_id"] = voice_id
    return items


async def _cleanup_redundant_character_subject_rows(
    session: AsyncSession,
    client: httpx.AsyncClient,
    api_key: str,
    project_id: str,
    asset_id: str,
    subject_name: str,
    keep_subject_id: str,
) -> str:
    keep_sid = str(keep_subject_id or "").strip()
    if not keep_sid:
        return ""

    subject_key = _normalize_subject_name_key(subject_name)
    existing_q = await session.execute(
        select(KlingSubject).where(
            KlingSubject.project_id == project_id,
            KlingSubject.role == "character",
        )
    )
    existing_rows = list(existing_q.scalars().all())
    candidates = [
        row
        for row in existing_rows
        if (subject_key and _normalize_subject_name_key(str(row.subject_name or "")) == subject_key)
        or str(row.asset_id or "").strip() == asset_id
    ]
    if not candidates:
        return keep_sid

    candidates.sort(
        key=lambda row: (row.updated_at or row.created_at or 0, row.created_at or 0),
        reverse=True,
    )

    keep_row = next(
        (row for row in candidates if str(row.subject_id or "").strip() == keep_sid),
        candidates[0],
    )
    remote_delete_ids: set[str] = set()
    for row in candidates:
        if row is keep_row:
            continue
        old_sid = str(row.subject_id or "").strip()
        if old_sid and old_sid != keep_sid:
            remote_delete_ids.add(old_sid)
        await session.delete(row)

    for old_sid in remote_delete_ids:
        deleted = await _delete_kling_subject_remote(client, api_key, old_sid)
        if not deleted:
            logger.warning(
                "删除冗余角色主体失败 project_id=%s asset_id=%s subject_id=%s",
                project_id,
                asset_id,
                old_sid,
            )
    return str(keep_row.subject_id or keep_sid).strip()


async def _get_or_create_character_subject_id(
    session: AsyncSession,
    client: httpx.AsyncClient,
    api_key: str,
    project_id: str,
    item: dict[str, Any],
    force_create: bool = False,
    allow_voice_fallback: bool = True,
) -> str:
    asset_id = str(item.get("asset_id", "")).strip()
    if not asset_id:
        return ""

    subject_name = str(item.get("name", "")).strip()[:64]
    subject_key = _normalize_subject_name_key(subject_name)
    voice_id = str(item.get("voice_id", "")).strip()
    image_url = str(item.get("image_url", "")).strip()[:1024]

    existing_q = await session.execute(
        select(KlingSubject).where(
            KlingSubject.project_id == project_id,
            KlingSubject.role == "character",
        )
    )
    existing_rows = list(existing_q.scalars().all())

    same_name_rows = [
        row
        for row in existing_rows
        if subject_key and _normalize_subject_name_key(str(row.subject_name or "")) == subject_key
    ]
    if not same_name_rows:
        same_name_rows = [row for row in existing_rows if str(row.asset_id or "").strip() == asset_id]

    same_name_rows.sort(
        key=lambda row: (row.updated_at or row.created_at or 0, row.created_at or 0),
        reverse=True,
    )
    latest = same_name_rows[0] if same_name_rows else None

    if latest and str(latest.subject_id or "").strip() and not force_create:
        latest_voice = str(latest.voice_id or "").strip()
        if (voice_id and latest_voice == voice_id) or (not voice_id):
            keep_sid = str(latest.subject_id).strip()
            keep_sid = await _cleanup_redundant_character_subject_rows(
                session,
                client,
                api_key,
                project_id,
                asset_id,
                subject_name,
                keep_sid,
            )
            await session.flush()
            return keep_sid

    created_subject_id = await _create_kling_element(
        client,
        api_key,
        project_id,
        item,
        force_new=force_create,
        allow_voice_fallback=allow_voice_fallback,
    )
    if not created_subject_id:
        return ""

    target_row = latest
    if not target_row:
        target_row = next((row for row in existing_rows if str(row.asset_id or "").strip() == asset_id), None)

    if target_row:
        target_row.asset_id = asset_id
        target_row.subject_id = created_subject_id
        target_row.subject_name = subject_name
        target_row.image_url = image_url
        target_row.voice_id = voice_id[:128]
    else:
        target_row = KlingSubject(
            project_id=project_id,
            asset_id=asset_id,
            role="character",
            subject_id=created_subject_id,
            subject_name=subject_name,
            image_url=image_url,
            voice_id=voice_id[:128],
        )
        session.add(target_row)

    await session.flush()
    created_subject_id = await _cleanup_redundant_character_subject_rows(
        session,
        client,
        api_key,
        project_id,
        asset_id,
        subject_name,
        created_subject_id,
    )
    await session.flush()
    return created_subject_id


async def _create_kling_element(
    client: httpx.AsyncClient,
    api_key: str,
    project_id: str,
    item: dict[str, Any],
    force_new: bool = False,
    allow_voice_fallback: bool = True,
) -> str:
    image_url = str(item.get("image_url", "")).strip()
    if not image_url:
        return ""
    role = str(item.get("role", "")).strip().lower()
    if role not in {"character", "scene", "prop"}:
        return ""
    asset_id = str(item.get("asset_id", "")).strip()
    voice_id = str(item.get("voice_id", "")).strip() if role == "character" else ""
    image_hash = hashlib.sha1(image_url.encode("utf-8")).hexdigest()[:16]
    cache_key = f"{project_id}:{asset_id}:{role}:{image_hash}:{voice_id}"
    cached = _KLING_ELEMENT_CACHE.get(cache_key)
    now_ts = time.time()
    if force_new:
        _KLING_ELEMENT_CACHE.pop(cache_key, None)
    elif cached and now_ts - cached[1] <= _KLING_ELEMENT_CACHE_TTL_SECONDS:
        return cached[0]
    elif cached and now_ts - cached[1] > _KLING_ELEMENT_CACHE_TTL_SECONDS:
        _KLING_ELEMENT_CACHE.pop(cache_key, None)
    name = str(item.get("name", "")).strip() or f"asset-{asset_id[:8]}"
    desc = str(item.get("description", "")).strip()

    def _new_external_task_id() -> str:
        return f"{project_id}-{asset_id}-{uuid.uuid4().hex[:16]}"

    base_payload = {
        "element_name": name[:20],
        "element_description": desc[:100],
        "reference_type": "image_refer",
        "element_image_list": {
            "frontal_image": image_url,
            "refer_images": [{"image_url": image_url}],
        },
        "tag_list": [{"tag_id": _kling_element_tag_id(role)}],
        "external_task_id": _new_external_task_id(),
    }

    payload_candidates: list[dict[str, Any]] = []
    if role == "character" and voice_id:
        payload_candidates.append({**base_payload, "element_voice_id": voice_id})
        if voice_id.isdigit():
            try:
                payload_candidates.append({**base_payload, "element_voice_id": int(voice_id)})
            except Exception:
                pass
        if allow_voice_fallback:
            payload_candidates.append(base_payload)
    else:
        payload_candidates.append(base_payload)

    endpoint_candidates = [
        str(os.getenv("KLING_SUBJECT_ENDPOINT") or "").strip(),
        "https://api-beijing.klingai.com/v1/general/advanced-custom-elements",
        "https://api.magic666.cn/api/v1/general/advanced-custom-elements",
    ]
    endpoint_candidates = [item for item in endpoint_candidates if item]

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    async def _poll_element_id(task_id: str, endpoint: str) -> str:
        query_url = f"{endpoint.rstrip('/')}/{quote(str(task_id).strip())}"
        for _ in range(30):
            try:
                query_resp = await client.get(query_url, headers=headers)
            except Exception:
                await asyncio.sleep(2.0)
                continue
            if query_resp.status_code != 200:
                await asyncio.sleep(2.0)
                continue
            try:
                body = query_resp.json()
            except Exception:
                await asyncio.sleep(2.0)
                continue
            if isinstance(body, dict) and body.get("code") not in (None, 0, "0", 200, "200"):
                await asyncio.sleep(2.0)
                continue
            data_obj = body.get("data") if isinstance(body, dict) and isinstance(body.get("data"), dict) else {}
            task_status = str(data_obj.get("task_status") or "").strip().lower()
            task_result = data_obj.get("task_result") if isinstance(data_obj.get("task_result"), dict) else {}
            elements = task_result.get("elements") if isinstance(task_result.get("elements"), list) else []
            if elements and isinstance(elements[0], dict):
                element_id = str(elements[0].get("element_id") or elements[0].get("id") or "").strip()
                if element_id:
                    return element_id
            if task_status in {"failed", "error", "canceled", "cancelled"}:
                return ""
            await asyncio.sleep(2.0)
        return ""

    for endpoint in endpoint_candidates:
        for payload in payload_candidates:
            try:
                response = await client.post(endpoint, headers=headers, json=payload)
            except Exception as exc:
                logger.warning("Create kling element request failed endpoint=%s err=%s", endpoint, exc)
                continue
            if response.status_code != 200:
                if response.status_code == 400:
                    try:
                        bad_data = response.json()
                    except Exception:
                        bad_data = {}
                    bad_code = str(bad_data.get("code") or "").strip() if isinstance(bad_data, dict) else ""
                    if bad_code == "1201":
                        payload["external_task_id"] = _new_external_task_id()
                        logger.warning(
                            "Create kling element got 400 duplicate external_task_id, retry once endpoint=%s new_external_task_id=%s",
                            endpoint,
                            payload.get("external_task_id"),
                        )
                        try:
                            retry_response = await client.post(endpoint, headers=headers, json=payload)
                        except Exception as exc:
                            logger.warning("Create kling element retry failed endpoint=%s err=%s", endpoint, exc)
                            continue
                        if retry_response.status_code != 200:
                            logger.warning("Create kling element retry failed endpoint=%s status=%s body=%s", endpoint, retry_response.status_code, retry_response.text)
                            continue
                        try:
                            data = retry_response.json()
                        except Exception:
                            logger.warning("Create kling element retry failed endpoint=%s non-json body=%s", endpoint, retry_response.text)
                            continue
                    else:
                        logger.warning("Create kling element failed endpoint=%s status=%s body=%s", endpoint, response.status_code, response.text)
                        continue
                else:
                    logger.warning("Create kling element failed endpoint=%s status=%s body=%s", endpoint, response.status_code, response.text)
                    continue
            else:
                try:
                    data = response.json()
                except Exception:
                    logger.warning("Create kling element failed endpoint=%s non-json body=%s", endpoint, response.text)
                    continue
            if isinstance(data, dict) and data.get("code") not in (None, 0, "0", 200, "200"):
                api_code = str(data.get("code") or "").strip()
                if api_code == "1201":
                    payload["external_task_id"] = _new_external_task_id()
                    logger.warning(
                        "Create kling element duplicate external_task_id, retry once endpoint=%s new_external_task_id=%s",
                        endpoint,
                        payload.get("external_task_id"),
                    )
                    try:
                        retry_response = await client.post(endpoint, headers=headers, json=payload)
                    except Exception as exc:
                        logger.warning("Create kling element retry failed endpoint=%s err=%s", endpoint, exc)
                        continue
                    if retry_response.status_code != 200:
                        logger.warning("Create kling element retry failed endpoint=%s status=%s body=%s", endpoint, retry_response.status_code, retry_response.text)
                        continue
                    try:
                        data = retry_response.json()
                    except Exception:
                        logger.warning("Create kling element retry failed endpoint=%s non-json body=%s", endpoint, retry_response.text)
                        continue
                    if isinstance(data, dict) and data.get("code") not in (None, 0, "0", 200, "200"):
                        logger.warning(
                            "Create kling element retry api code failed endpoint=%s code=%s message=%s has_voice=%s",
                            endpoint,
                            data.get("code"),
                            data.get("message") or data.get("msg") or "",
                            bool(payload.get("element_voice_id")),
                        )
                        continue
                else:
                    logger.warning(
                        "Create kling element api code failed endpoint=%s code=%s message=%s has_voice=%s",
                        endpoint,
                        data.get("code"),
                        data.get("message") or data.get("msg") or "",
                        bool(payload.get("element_voice_id")),
                    )
                    continue
            element_id = ""
            task_id = ""
            if isinstance(data, dict):
                body = data.get("data") if isinstance(data.get("data"), dict) else data
                # 创建接口常见返回是 task_id（或 data.id 作为任务ID），不能直接当 element_id。
                element_id = str(
                    body.get("element_id")
                    or body.get("custom_element_id")
                    or ""
                ).strip()
                task_id = str(body.get("task_id") or body.get("id") or "").strip()
            if not element_id and task_id:
                element_id = await _poll_element_id(task_id, endpoint)
            if element_id:
                _KLING_ELEMENT_CACHE[cache_key] = (element_id, now_ts)
                return element_id
    if role == "character" and voice_id:
        logger.warning(
            "Create kling element failed after voice-bind attempts project_id=%s asset_id=%s subject=%s voice_id=%s",
            project_id,
            asset_id,
            name[:20],
            voice_id,
        )
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
    previous_segment_video_url = str(payload.get("previous_segment_video_url") or "").strip()
    reference_video_url = str(payload.get("reference_video_url") or payload.get("base_video_url") or "").strip()
    reference_video_refer_type = str(payload.get("refer_type") or "base").strip().lower() or "base"
    reference_video_keep_original_sound = str(payload.get("keep_original_sound") or "yes").strip().lower() or "yes"
    raw_video_list = payload.get("video_list")
    if isinstance(raw_video_list, list) and raw_video_list:
        first_video_item = raw_video_list[0] if isinstance(raw_video_list[0], dict) else {}
        if isinstance(first_video_item, dict):
            if not reference_video_url:
                reference_video_url = str(first_video_item.get("video_url") or "").strip()
            if "refer_type" in first_video_item:
                reference_video_refer_type = str(first_video_item.get("refer_type") or reference_video_refer_type).strip().lower() or "base"
            if "keep_original_sound" in first_video_item:
                reference_video_keep_original_sound = str(first_video_item.get("keep_original_sound") or reference_video_keep_original_sound).strip().lower() or "yes"
    if not previous_segment_video_url and reference_video_refer_type == "feature":
        previous_segment_video_url = reference_video_url
    model_text = str(model or "").strip()
    model_text_lower = model_text.lower()
    is_kling_model = model_text_lower.startswith("kling")
    is_seedance_model = ("seedance" in model_text_lower) or model_text_lower.startswith("doubao-seedance")
    if is_seedance_model and model_text_lower in {"seedance2.0", "seedance2", "seedance"}:
        model = "doubao-seedance-2-0-260128"
    is_kling_o1_model = model_text_lower == "kling-video-o1"
    is_video_edit_mode = bool(reference_video_url)
    system_prompt = str(payload.get("system_prompt", "") or "").strip()
    raw_sound = str(payload.get("sound") or "").strip().lower()
    with_audio_requested = bool(payload.get("with_audio", False))
    require_character_voice = with_audio_requested or raw_sound == "on"
    default_kling_endpoint = "https://api-beijing.klingai.com/v1/videos/omni-video"
    if is_kling_model:
        if "kling-v1" in model_text_lower:
            has_ref_image = bool(payload.get("reference_images")) or bool(payload.get("image_list")) or bool(payload.get("image_url"))
            if has_ref_image:
                default_kling_endpoint = "https://api-beijing.klingai.com/v1/videos/multi-image2video"
            else:
                default_kling_endpoint = "https://api-beijing.klingai.com/v1/videos/text2video"
    
    default_video_endpoint = "https://api.magic666.cn/api/v1/video/generations"
    default_seedance_endpoint = "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks"
    configured_endpoint = str(settings.endpoint or "").strip()
    endpoint = default_kling_endpoint if is_kling_model else (default_seedance_endpoint if is_seedance_model else default_video_endpoint)
    use_configured_video_provider = False
    configured_key_normalized = str(configured_key or "").strip()
    use_official_kling = is_kling_model
    if is_kling_model and configured_endpoint:
        normalized_endpoint = configured_endpoint.strip().rstrip("/")
        normalized_lower = normalized_endpoint.lower()
        if "klingai.com" in normalized_lower:
            import urllib.parse
            parsed_conf = urllib.parse.urlparse(normalized_endpoint)
            parsed_def = urllib.parse.urlparse(default_kling_endpoint)
            endpoint = f"{parsed_conf.scheme}://{parsed_conf.netloc}{parsed_def.path}"
    elif is_seedance_model and configured_endpoint:
        normalized_endpoint = configured_endpoint.strip().rstrip("/")
        normalized_lower = normalized_endpoint.lower()
        if "contents/generations/tasks" in normalized_lower:
            endpoint = normalized_endpoint
        elif "volces.com" in normalized_lower or "ark." in normalized_lower:
            endpoint = f"{normalized_endpoint}/api/v3/contents/generations/tasks"
        else:
            logger.warning(
                "Configured endpoint is not seedance provider, fallback to default seedance endpoint. configured_endpoint=%s",
                configured_endpoint,
            )
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
        kling_token, kling_key_source = await resolve_kling_auth_token(session, user_id)
        if kling_token:
            api_key = kling_token
            key_source = kling_key_source
        else:
            raise RuntimeError("Kling 鉴权未配置，请联系管理员配置系统 Key（KLING_AK/KLING_SK 或 KLING_API_KEY）")
    elif is_seedance_model:
        env_seedance_key = str(os.getenv("ARK_API_KEY") or os.getenv("VOLCENGINE_ARK_API_KEY") or "").strip()
        configured_seedance_key = configured_key_normalized
        if configured_seedance_key.startswith("sk-") or configured_seedance_key.startswith("eyJ"):
            configured_seedance_key = ""
        seedance_key = env_seedance_key or configured_seedance_key
        if not seedance_key:
            raise RuntimeError("Seedance 鉴权未配置，请在设置页填写 API Key，或配置环境变量 ARK_API_KEY")
        api_key = seedance_key
        key_source = "env" if env_seedance_key else "configured"
    elif use_configured_video_provider and configured_key_normalized:
        if configured_key_normalized.startswith("sk-"):
            api_key = configured_key_normalized
            key_source = "configured"
        else:
            logger.warning(
                "Configured video key format is invalid for bearer token, fallback to default key. key_prefix=%s",
                configured_key_normalized[:8],
            )
    fallback_api_key = default_video_api_key if (api_key != default_video_api_key and not is_seedance_model) else ""
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
        raw_reference_images = payload.get("reference_images")
        direct_reference_images: list[dict[str, Any]] = []
        if isinstance(raw_reference_images, list):
            for item in raw_reference_images:
                if isinstance(item, str):
                    resolved_ref_url = await _resolve_image_url(item)
                    normalized_ref_url = _normalize_kling_image_value(str(resolved_ref_url or ""))
                    if normalized_ref_url:
                        direct_reference_images.append({"image_url": normalized_ref_url})
                elif isinstance(item, dict):
                    ref_url = str(item.get("image_url") or "").strip()
                    if not ref_url:
                        continue
                    resolved_ref_url = await _resolve_image_url(ref_url)
                    normalized_ref_url = _normalize_kling_image_value(str(resolved_ref_url or ""))
                    if not normalized_ref_url:
                        continue
                    ref_obj: dict[str, Any] = {"image_url": normalized_ref_url}
                    ref_type = str(item.get("type") or "").strip().lower()
                    if ref_type in {"first_frame", "last_frame", "end_frame"}:
                        ref_obj["type"] = "last_frame" if ref_type in {"last_frame", "end_frame"} else "first_frame"
                    direct_reference_images.append(ref_obj)
        if direct_reference_images:
            data["reference_images"] = direct_reference_images
            data["image_list"] = direct_reference_images
            prompt_lines = ["【参考图片映射】"]
            for index, _ in enumerate(direct_reference_images, start=1):
                prompt_lines.append(f"参考图{index}：<<<image_{index}>>>")
            data["prompt"] = f"{str(data.get('prompt', '')).strip()}\n" + "\n".join(prompt_lines)

    resolved_assets: list[dict[str, Any]] = []
    if (is_kling_model or is_seedance_model) and project_id and asset_bindings:
        resolved_assets = await _resolve_asset_bindings(session, project_id, asset_bindings)
        if is_kling_model and resolved_assets:
            resolved_assets = await _attach_character_voice_ids(session, project_id, resolved_assets)
        if is_kling_model and not resolved_assets:
            logger.warning(
                "检测到素材绑定但未解析到可用素材图片，回退为无参考图生成。project_id=%s user_id=%s asset_count=%s",
                project_id,
                user_id,
                len(asset_bindings),
            )

    if resolved_assets and is_kling_model:
        # 确保被选中的角色在当前项目下已配置 Kling 音色；否则 Kling 会静默回退为默认音色，
        # 容易让用户误以为使用了自定义音色，这里直接中断并给出明确错误提示。
        missing_voice_roles = [
            (str(item.get("name") or "").strip() or str(item.get("asset_id") or "").strip())
            for item in resolved_assets
            if str(item.get("role") or "").strip().lower() == "character"
            and not str(item.get("voice_id") or "").strip()
        ]
        if require_character_voice and missing_voice_roles:
            raise RuntimeError(
                "Kling 视频生成失败：以下角色未配置音色，将回退为默认音色。"
                "请先在 Step3 上传角色音频并生成 Kling 音色后再重试："
                + "、".join(missing_voice_roles)
            )
        prepared_refs: list[dict[str, str]] = []
        character_elements: list[dict[str, Any]] = []
        character_prompt_items: list[dict[str, str]] = []
        async with httpx.AsyncClient(timeout=120.0, trust_env=True) as subject_client:
            for item in resolved_assets:
                role = str(item.get("role", "")).strip().lower()
                asset_id = str(item.get("asset_id", "")).strip()
                prepared_image_url = _normalize_kling_image_value(str(item.get("image_url", "")))
                if not prepared_image_url:
                    continue
                if role == "character":
                    item["image_url"] = prepared_image_url
                    subject_id = await _get_or_create_character_subject_id(
                        session,
                        subject_client,
                        api_key,
                        project_id,
                        item,
                    )
                    if subject_id:
                        character_elements.append({"element_id": subject_id})
                        character_prompt_items.append(
                            {
                                "name": str(item.get("name", "")).strip(),
                                "description": str(item.get("description", "")).strip(),
                            }
                        )
                        continue
                    raise RuntimeError(
                        "角色主体创建失败：当前 Step4 已启用仅主体生成模式，禁止回退为角色图片参考。"
                        f"请先在 Step3 确保该角色主体创建成功后再重试（角色：{str(item.get('name', '')).strip() or asset_id}）。"
                    )
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
            role_name = "场景" if item.get("role") == "scene" else "道具" if item.get("role") == "prop" else "主体"
            prompt_lines.append(f"{role_name}{index}: {item.get('name', '')}；描述：{item.get('description', '')}；引用：<<<image_{index}>>>")
        for index, item in enumerate(character_prompt_items, start=1):
            prompt_lines.append(
                f"角色主体{index}: {item.get('name', '')}；描述：{item.get('description', '')}；引用：<<<element_{index}>>>"
            )
        if reference_images:
            data["reference_images"] = reference_images
            data["image_list"] = reference_images
            if not image_url:
                image_url = reference_images[0].get("image_url", "")
        if character_elements:
            data["element_list"] = character_elements
            if not reference_images and image_url:
                logger.info("角色已走主体引用，忽略顶层 image_url 以避免重复传角色图")
                image_url = ""
        if not reference_images and not character_elements:
            raise RuntimeError("已解析到素材绑定，但未构造出有效角色主体/参考图")
        if prompt_lines:
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

        if is_video_edit_mode:
            resolved_video_url = await _resolve_image_url(reference_video_url)
            if not resolved_video_url:
                raise RuntimeError("视频修改失败：当前分镜视频地址无效")
            data["video_list"] = [
                {
                    "video_url": str(resolved_video_url).strip(),
                    "refer_type": reference_video_refer_type if reference_video_refer_type in {"base", "feature"} else "base",
                    "keep_original_sound": "yes" if reference_video_keep_original_sound == "yes" else "no",
                }
            ]
            data["mode"] = "pro"
            data["sound"] = "off"
            data.pop("duration", None)
            existing_refs = [item for item in existing_refs if str(item.get("type", "")).strip().lower() not in {"first_frame", "last_frame"}]
            if "<<<video_1>>>" not in str(data.get("prompt", "")):
                data["prompt"] = f"{str(data.get('prompt', '')).strip()}\n待编辑视频引用：<<<video_1>>>".strip()
        if existing_refs:
            data["reference_images"] = existing_refs
            data["image_list"] = existing_refs
        elif image_url and not data.get("reference_images"):
            single_image_ref = {"image_url": image_url}
            data["reference_images"] = [single_image_ref]
            data["image_list"] = [single_image_ref]

    else:
        sound_value = str(payload.get("sound") or "").strip().lower()
        if sound_value not in {"on", "off"}:
            sound_value = "on" if bool(payload.get("with_audio", False)) else "off"
        with_audio_value = sound_value == "on"

        if is_seedance_model:
            ratio = str(payload.get("aspect_ratio") or payload.get("ratio") or "16:9").strip() or "16:9"
            duration_raw = payload.get("duration", payload.get("seconds", 5))
            try:
                duration_value = int(round(float(duration_raw)))
            except (TypeError, ValueError):
                duration_value = 5
            duration_value = max(4, min(15, duration_value))

            reference_images: list[dict[str, Any]] = []

            async def _append_seedance_reference(image_src: str, role: str = "reference_image") -> None:
                resolved = await _resolve_image_url(image_src)
                if not resolved:
                    return
                reference_images.append({
                    "type": "image_url",
                    "image_url": {"url": str(resolved).strip()},
                    "role": role,
                })

            if custom_first_frame_url:
                await _append_seedance_reference(custom_first_frame_url, "reference_image")
            if custom_last_frame_url:
                await _append_seedance_reference(custom_last_frame_url, "reference_image")
            if previous_segment_video_url and not custom_first_frame_url:
                tail_frame_b64 = await _extract_video_tail_frame_base64(previous_segment_video_url)
                if tail_frame_b64:
                    await _append_seedance_reference(f"data:image/jpeg;base64,{tail_frame_b64}", "reference_image")
            for item in resolved_assets:
                image_ref = str(item.get("image_url") or "").strip()
                if image_ref:
                    await _append_seedance_reference(image_ref, "reference_image")

            raw_reference_images = payload.get("reference_images")
            if isinstance(raw_reference_images, list):
                for item in raw_reference_images:
                    if isinstance(item, dict):
                        ref_url = str(item.get("image_url") or "").strip()
                        if ref_url:
                            await _append_seedance_reference(ref_url, "reference_image")
                    elif isinstance(item, str) and item.strip():
                        await _append_seedance_reference(item.strip(), "reference_image")

            if image_url:
                await _append_seedance_reference(str(image_url), "reference_image")

            if reference_video_url:
                resolved_video_url = await _resolve_image_url(reference_video_url)
                if resolved_video_url:
                    reference_images.append(
                        {
                            "type": "video_url",
                            "video_url": {"url": str(resolved_video_url).strip()},
                            "role": "reference_video",
                        }
                    )

            dedup_content: list[dict[str, Any]] = []
            seen_ref_keys: set[str] = set()
            for item in reference_images:
                item_type = str(item.get("type") or "").strip().lower()
                role = str(item.get("role") or "").strip().lower()
                if item_type == "image_url":
                    ref_url = str((item.get("image_url") or {}).get("url") or "").strip()
                    key = f"image|{role}|{ref_url}"
                elif item_type == "video_url":
                    ref_url = str((item.get("video_url") or {}).get("url") or "").strip()
                    key = f"video|{role}|{ref_url}"
                else:
                    continue
                if not ref_url or key in seen_ref_keys:
                    continue
                seen_ref_keys.add(key)
                dedup_content.append(item)

            content_items: list[dict[str, Any]] = [{"type": "text", "text": str(data.get("prompt") or "").strip()}]
            content_items.extend(dedup_content)

            data = {
                "model": model,
                "content": content_items,
                "generate_audio": with_audio_value,
                "ratio": ratio,
                "duration": duration_value,
                "watermark": False,
            }
            if bool(payload.get("return_last_frame", False)):
                data["return_last_frame"] = True
        else:
            data["size"] = payload.get("size", "1280x720")
            data["seconds"] = payload.get("seconds", 5)
            data["with_audio"] = with_audio_value
            data["generate_audio"] = with_audio_value
            data["sound"] = sound_value
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
                if is_kling_model and project_id and resolved_assets and "magic666.cn" in endpoint.lower() and not data.get("element_list"):
                    element_refs: list[dict[str, Any]] = []
                    for item in resolved_assets:
                        element_id = await _create_kling_element(client, api_key, project_id, item)
                        if not element_id:
                            continue
                        element_refs.append({"element_id": element_id})
                    if element_refs:
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
                    has_strict_constraints = str(data.get("sound") or "off").strip().lower() == "on" or bool(data.get("reference_images")) or bool(data.get("image_list")) or bool(data.get("element_list")) or bool(data.get("reference_video")) or bool(data.get("reference_video_url"))
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
                            if is_seedance_model:
                                task_id = str(result.get("id") or "").strip()
                                if task_id:
                                    return {
                                        "data": {
                                            "task_id": f"seedance|{task_id}",
                                            "task_result": result,
                                        }
                                    }
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
