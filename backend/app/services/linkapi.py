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
import io
import time
import hashlib
import tempfile
import subprocess
from PIL import Image

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
    return {
        "data": [
            {"id": "doubao-seed-2-0-pro-260215", "name": "Doubao Seed 2.0 Pro (Text)"},
            {"id": "google/gemini-3.1-flash-image-preview", "name": "Gemini 3.1 Flash Image Preview (Image)"}
        ]
    }


def _map_openrouter_model(model: str) -> str:
    # Always use the Volcengine model
    return "doubao-seed-2-0-pro-260215"


async def create_chat_completion(
    session: AsyncSession, user_id: str, payload: dict[str, Any]
) -> dict[str, Any]:
    # Volcengine API Key
    api_key = "6002c554-3d7f-4293-80e9-c217758ba983"

    settings = await get_or_create_settings(session, user_id)
    
    logger.info("Using Volcengine Key: %s... (len=%d)", api_key[:10], len(api_key))

    # Force model to Volcengine model
    if "model" not in payload:
        payload["model"] = "doubao-seed-2-0-pro-260215"
    
    # Ensure max_tokens is set to a reasonable value to prevent truncation
    if "max_tokens" not in payload:
        payload["max_tokens"] = 120000
    
    # Volcengine Endpoint
    endpoint = "https://ark.cn-beijing.volces.com/api/v3/chat/completions"
    
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json"
    }
    
    timeout = httpx.Timeout(300.0, connect=10.0)
    client_modes = [False, True]
    max_retries = 2
    last_error: Exception | None = None
    attempt_payload = dict(payload)

    for trust_env_mode in client_modes:
        async with httpx.AsyncClient(timeout=timeout, trust_env=trust_env_mode) as client:
            for attempt in range(max_retries + 1):
                try:
                    response = await client.post(
                        endpoint,
                        headers=headers,
                        json=attempt_payload
                    )

                    if response.status_code != 200:
                        error_text = response.text
                        logger.error(
                            "Volcengine API error (Attempt %s/%s, trust_env=%s): %s",
                            attempt + 1,
                            max_retries + 1,
                            trust_env_mode,
                            error_text,
                        )
                        error_lower = error_text.lower()
                        should_retry_with_smaller_max_tokens = (
                            attempt < max_retries
                            and "max_tokens" in attempt_payload
                            and (
                                "max_tokens" in error_lower
                                or "max token" in error_lower
                                or "output token" in error_lower
                                or "invalid_parameter" in error_lower
                            )
                        )
                        if should_retry_with_smaller_max_tokens:
                            attempt_payload = dict(attempt_payload)
                            attempt_payload["max_tokens"] = min(int(attempt_payload.get("max_tokens", 120000)), 8192)
                            logger.warning("Retrying chat completion with reduced max_tokens=%s", attempt_payload["max_tokens"])
                            continue

                        if response.status_code in (408, 409, 425, 429) or response.status_code >= 500:
                            if attempt < max_retries:
                                continue
                            if not trust_env_mode:
                                logger.warning("Switching chat completion client to trust_env=True after upstream transient HTTP failure")
                                break
                        try:
                            return response.json()
                        except Exception:
                            response.raise_for_status()

                    return response.json()

                except Exception as e:
                    last_error = e
                    err_text = str(e).lower()
                    logger.error(
                        "Failed to create chat completion (Attempt %s/%s, trust_env=%s): %s",
                        attempt + 1,
                        max_retries + 1,
                        trust_env_mode,
                        e,
                    )
                    is_retryable = (
                        "timeout" in err_text
                        or "timed out" in err_text
                        or "temporarily unavailable" in err_text
                        or "connection reset" in err_text
                        or "server disconnected without sending a response" in err_text
                        or "remote protocol error" in err_text
                    )
                    if attempt < max_retries and is_retryable:
                        continue
                    if not trust_env_mode and is_retryable:
                        logger.warning("Switching chat completion client to trust_env=True due to transient connection failure")
                        break
                    raise e

    if last_error:
        raise last_error
    raise RuntimeError("Failed to create chat completion")


async def create_chat_completion_stream(
    session: AsyncSession, user_id: str, payload: dict[str, Any]
):
    # Volcengine API Key
    api_key = "6002c554-3d7f-4293-80e9-c217758ba983"
    
    settings = await get_or_create_settings(session, user_id)
    
    logger.info("Using Volcengine Key for Stream: %s...", api_key[:10])

    # Force model to Volcengine model
    if "model" not in payload:
        payload["model"] = "doubao-seed-2-0-pro-260215"
    
    # Ensure stream is True
    payload["stream"] = True
    
    # Volcengine Endpoint
    endpoint = "https://ark.cn-beijing.volces.com/api/v3/chat/completions"
    
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json"
    }
    
    timeout = httpx.Timeout(300.0, connect=10.0)
    client_modes = [False, True]
    max_retries = 2
    last_error: Exception | None = None
    attempt_payload = dict(payload)

    for trust_env_mode in client_modes:
        async with httpx.AsyncClient(timeout=timeout, trust_env=trust_env_mode) as client:
            for attempt in range(max_retries + 1):
                try:
                    async with client.stream("POST", endpoint, headers=headers, json=attempt_payload) as response:
                        if response.status_code != 200:
                            error_chunks = []
                            async for chunk in response.aiter_bytes():
                                error_chunks.append(chunk)
                            error_text = b"".join(error_chunks).decode("utf-8", errors="ignore")
                            error_lower = error_text.lower()
                            logger.error(
                                "Volcengine API Stream error (Attempt %s/%s, trust_env=%s): %s",
                                attempt + 1,
                                max_retries + 1,
                                trust_env_mode,
                                error_text,
                            )

                            should_retry_with_smaller_max_tokens = (
                                attempt < max_retries
                                and "max_tokens" in attempt_payload
                                and (
                                    "max_tokens" in error_lower
                                    or "max token" in error_lower
                                    or "output token" in error_lower
                                    or "invalid_parameter" in error_lower
                                )
                            )
                            if should_retry_with_smaller_max_tokens:
                                attempt_payload = dict(attempt_payload)
                                attempt_payload["max_tokens"] = min(int(attempt_payload.get("max_tokens", 120000)), 8192)
                                logger.warning("Retrying stream with reduced max_tokens=%s", attempt_payload["max_tokens"])
                                continue

                            is_retryable_status = response.status_code in (408, 409, 425, 429) or response.status_code >= 500
                            if is_retryable_status:
                                if attempt < max_retries:
                                    continue
                                if not trust_env_mode:
                                    logger.warning("Switching stream client to trust_env=True after transient upstream HTTP failure")
                                    break
                            yield f"Error: {response.status_code} {error_text}"
                            return

                        async for line in response.aiter_lines():
                            if line.startswith("data: "):
                                data = line[6:]
                                if data.strip() == "[DONE]":
                                    return
                                try:
                                    yield json.loads(data)
                                except json.JSONDecodeError:
                                    continue
                        return

                except Exception as e:
                    last_error = e
                    err_text = str(e).lower()
                    logger.error(
                        "Failed to create chat completion stream (Attempt %s/%s, trust_env=%s): %s",
                        attempt + 1,
                        max_retries + 1,
                        trust_env_mode,
                        e,
                    )
                    is_retryable = (
                        "timeout" in err_text
                        or "timed out" in err_text
                        or "temporarily unavailable" in err_text
                        or "connection reset" in err_text
                        or "server disconnected without sending a response" in err_text
                        or "remote protocol error" in err_text
                    )
                    if attempt < max_retries and is_retryable:
                        continue
                    if not trust_env_mode and is_retryable:
                        logger.warning("Switching stream client to trust_env=True due to transient connection failure")
                        break
                    yield f"Error: {str(e)}"
                    return

    if last_error:
        yield f"Error: {str(last_error)}"
        return
    yield "Error: Failed to create chat completion stream"



async def _resolve_image_url(url: str) -> str:
    # Handle both relative (/static/...) and absolute (http.../static/...) local URLs
    if not url:
        return url
        
    path_to_resolve = url
    if url.startswith("http"):
        # Check if it contains /static/
        if "/static/" in url:
            path_to_resolve = url[url.find("/static/"):]
        else:
            return url
    
    if not path_to_resolve.startswith("/static/"):
        return url
    
    try:
        # /static/assets/xxx.png -> backend/static/assets/xxx.png
        # path is relative to backend root
        base_dir = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
        # remove /static/ prefix
        rel_path = path_to_resolve[len("/static/"):]
        if rel_path.startswith("/"):
            rel_path = rel_path[1:]
        file_path = os.path.join(base_dir, "static", rel_path)
        
        if not os.path.exists(file_path):
            logger.error(f"Local file not found: {file_path} (original: {url})")
            # Return None or raise error instead of returning the path string
            # Returning the path string causes API errors because it's not a valid URL/Base64
            return None 
            
        async with aiofiles.open(file_path, "rb") as f:
            content = await f.read()

        # Compress image to ensure it meets Volcengine requirements:
        # 1. Max dimension 4096px (Doc says 6000px, but 4096 is safer for 4K)
        # 2. Max file size 10MB (Doc says 10MB)
        MAX_SIZE_BYTES = 9 * 1024 * 1024 # 9MB to be safe
        MAX_DIMENSION = 4096
        
        try:
            img = Image.open(io.BytesIO(content))
            
            # Determine output format (preserve PNG if original is PNG, otherwise JPEG)
            output_format = img.format if img.format in ["PNG", "JPEG"] else "JPEG"
            mime_type = f"image/{output_format.lower()}"
            
            # Check if processing is needed
            needs_processing = False
            
            if img.width > MAX_DIMENSION or img.height > MAX_DIMENSION:
                needs_processing = True
                
            if len(content) > MAX_SIZE_BYTES:
                needs_processing = True
                
            if img.format not in ["PNG", "JPEG"]:
                needs_processing = True
                output_format = "JPEG" # Convert others to JPEG
                mime_type = "image/jpeg"

            if needs_processing:
                # Resize if needed
                if img.width > MAX_DIMENSION or img.height > MAX_DIMENSION:
                    img.thumbnail((MAX_DIMENSION, MAX_DIMENSION), Image.Resampling.LANCZOS)
                
                # Convert mode if needed
                if output_format == "JPEG" and img.mode in ("RGBA", "P"):
                    img = img.convert("RGB")
                
                # Save to buffer
                buffer = io.BytesIO()
                quality = 95
                img.save(buffer, format=output_format, quality=quality)
                compressed_content = buffer.getvalue()
                
                # If still too large, reduce quality (only for JPEG)
                if len(compressed_content) > MAX_SIZE_BYTES and output_format == "JPEG":
                    while len(compressed_content) > MAX_SIZE_BYTES and quality > 50:
                        quality -= 10
                        buffer = io.BytesIO()
                        img.save(buffer, format=output_format, quality=quality)
                        compressed_content = buffer.getvalue()
                
                content = compressed_content
                logger.info(f"Processed local image {url}: Original Size={len(content)} -> New Size={len(compressed_content)} bytes (quality={quality})")
            
        except Exception as e:
            logger.warning(f"Failed to process image {url}: {e}")
            # Fallback to original content (might fail API if too large)
            # If original content is not JPEG/PNG, it might fail API too.
            # But we try our best.
            # Assume JPEG if we failed to detect/convert
            if "mime_type" not in locals():
                 mime_type = "image/jpeg"

        b64 = base64.b64encode(content).decode("utf-8")
        logger.info(f"Resolved local image {url} to base64 (len={len(b64)})")
            
        return f"data:{mime_type};base64,{b64}"
    except Exception as e:
        logger.error(f"Failed to resolve local image: {e}")
        return url


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


async def create_image(
    session: AsyncSession, user_id: str, payload: dict[str, Any]
) -> dict[str, Any]:
    configured_key = await get_api_key(session, user_id)
    api_key = (
        app_settings.openrouter_api_key.strip()
        or os.getenv("OPENROUTER_API_KEY", "").strip()
        or str(configured_key or "").strip()
    )
    if not api_key:
        raise RuntimeError("OPENROUTER_API_KEY 未配置，请先在后端环境变量中设置")
    endpoint = "https://openrouter.ai/api/v1/chat/completions"
    payload = payload.copy()

    model = str(payload.get("model") or "").strip() or "google/gemini-3.1-flash-image-preview"

    resolved_references: list[str] = []
    if "image_url" in payload and payload["image_url"]:
        resolved_single = await _resolve_image_url(str(payload["image_url"]))
        if resolved_single:
            resolved_references.append(resolved_single)
            payload.pop("image_url", None)

    if "image_urls" in payload and isinstance(payload["image_urls"], list):
        for url in payload["image_urls"]:
            resolved = await _resolve_image_url(str(url))
            if resolved:
                resolved_references.append(resolved)
        payload.pop("image_urls", None)

    if "image" in payload:
        image_value = payload["image"]
        if isinstance(image_value, str):
            resolved = await _resolve_image_url(image_value)
            if resolved:
                resolved_references.append(resolved)
        elif isinstance(image_value, list):
            for value in image_value:
                resolved = await _resolve_image_url(str(value))
                if resolved:
                    resolved_references.append(resolved)
        payload.pop("image", None)

    prompt = str(payload.get("prompt") or "").strip()
    if not prompt:
        prompt = "生成一张高质量图片"

    message_content: list[dict[str, Any]] = [{"type": "text", "text": prompt}]
    for ref_url in resolved_references[:4]:
        message_content.append({"type": "image_url", "image_url": {"url": ref_url}})

    image_config: dict[str, Any] = {}
    ratio = _resolve_image_aspect_ratio(payload)
    if ratio:
        image_config["aspect_ratio"] = ratio

    request_payload: dict[str, Any] = {
        "model": model,
        "messages": [{"role": "user", "content": message_content}],
        "modalities": ["image", "text"],
    }
    if image_config:
        request_payload["image_config"] = image_config

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    masked_headers = headers.copy()
    masked_headers["Authorization"] = "Bearer " + api_key[:5] + "..."
    logger.info(f"Sending request to {endpoint} with headers: {masked_headers}")

    client_modes = [False, True]
    last_error: Exception | None = None
    for trust_env_mode in client_modes:
        async with httpx.AsyncClient(timeout=300.0, trust_env=trust_env_mode) as client:
            max_retries = 2
            for attempt in range(max_retries + 1):
                try:
                    response = await client.post(
                        endpoint,
                        headers=headers,
                        json=request_payload,
                    )

                    if response.status_code != 200:
                        error_text = response.text
                        logger.error(f"OpenRouter Image API error (Attempt {attempt+1}/{max_retries+1}, trust_env={trust_env_mode}): {error_text}")
                        if attempt < max_retries:
                            logger.warning(f"Retrying request due to failure... trust_env={trust_env_mode}")
                            continue
                        try:
                            error_data = response.json()
                            return error_data
                        except Exception:
                            response.raise_for_status()

                    response_json = response.json()
                    image_url = _extract_openrouter_image_url(response_json)
                    if image_url:
                        return {"data": [{"url": image_url}]}
                    return response_json
                except Exception as e:
                    last_error = e
                    logger.error(f"Failed to create image (Attempt {attempt+1}/{max_retries+1}, trust_env={trust_env_mode}): {e}")
                    err_text = str(e).lower()
                    if attempt < max_retries:
                        continue
                    if (
                        not trust_env_mode
                        and "server disconnected without sending a response" in err_text
                    ):
                        logger.warning("Switching image generation client to trust_env=True due to disconnected response")
                        break
                    raise e

    if last_error:
        raise last_error
    raise RuntimeError("Failed to create image")


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

    result = await session.execute(
        select(Asset).where(Asset.project_id == project_id, Asset.id.in_(asset_ids))
    )
    assets = list(result.scalars().all())
    if not assets:
        return []
    asset_map = {item.id: item for item in assets}

    version_result = await session.execute(
        select(AssetVersion)
        .where(AssetVersion.asset_id.in_(list(asset_map.keys())))
        .order_by(AssetVersion.created_at.desc())
    )
    versions = list(version_result.scalars().all())
    selected_map: dict[str, AssetVersion] = {}
    latest_map: dict[str, AssetVersion] = {}
    for version in versions:
        if version.asset_id not in latest_map:
            latest_map[version.asset_id] = version
        if version.is_selected and version.asset_id not in selected_map:
            selected_map[version.asset_id] = version

    resolved: list[dict[str, Any]] = []
    for binding in asset_bindings:
        asset_id = str(binding.get("asset_id", "")).strip()
        if not asset_id or asset_id not in asset_map:
            continue
        version = selected_map.get(asset_id) or latest_map.get(asset_id)
        if not version or not version.image_url:
            continue
        resolved_image_url = await _resolve_image_url(str(version.image_url))
        if not resolved_image_url:
            continue
        asset = asset_map[asset_id]
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
    previous_segment_video_url = str(payload.get("previous_segment_video_url") or payload.get("reference_video_url") or "").strip()
    model_text = str(model or "").strip()
    model_text_lower = model_text.lower()
    is_kling_model = model_text_lower.startswith("kling")
    is_kling_o1_model = model_text_lower == "kling-video-o1"
    system_prompt = str(payload.get("system_prompt", "") or "").strip()
    default_kling_endpoint = "https://api-beijing.klingai.com/v1/videos/omni-video"
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
            if normalized_lower.endswith("/videos/omni-video"):
                endpoint = normalized_endpoint
            elif normalized_lower.endswith("/v1"):
                endpoint = f"{normalized_endpoint}/videos/omni-video"
            else:
                endpoint = f"{normalized_endpoint}/v1/videos/omni-video"
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
        "prompt": f"【系统提示词】\n{system_prompt}\n\n【用户提示词】\n{prompt}" if system_prompt else prompt,
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
        has_start_or_end_frame = bool(first_frame_asset_id)
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
        if previous_segment_video_url:
            tail_frame_b64 = await _extract_video_tail_frame_base64(previous_segment_video_url)
            if not tail_frame_b64:
                raise RuntimeError("上一条分镜视频尾帧提取失败，无法作为首帧")
            tail_frame_ref = {"image_url": tail_frame_b64, "type": "first_frame"}
            existing_refs = data.get("reference_images")
            if isinstance(existing_refs, list):
                existing_refs = [item for item in existing_refs if isinstance(item, dict)]
            else:
                existing_refs = []
            existing_refs = [item for item in existing_refs if str(item.get("type", "")).strip().lower() != "first_frame"]
            existing_refs.insert(0, tail_frame_ref)
            data["reference_images"] = existing_refs
            data["image_list"] = existing_refs
            image_url = tail_frame_b64
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
