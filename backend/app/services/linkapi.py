from __future__ import annotations
from typing import Optional, Union, Any
import os
import socket
import asyncio
import base64
import json
import logging
import re
import io
from PIL import Image

import httpx
import aiofiles
from sqlalchemy.ext.asyncio import AsyncSession

from app.services.settings import get_api_key, get_or_create_settings

logger = logging.getLogger(__name__)


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
    # Volcengine API Key
    api_key = "6002c554-3d7f-4293-80e9-c217758ba983"
    
    settings = await get_or_create_settings(session, user_id)
    
    # Endpoint for Volcengine
    endpoint = "https://ark.cn-beijing.volces.com/api/v3"

    # We return a fixed list as per previous implementation to avoid complex probing
    return {
        "data": [
            {"id": "doubao-seed-2-0-pro-260215", "name": "Doubao Seed 2.0 Pro (Text)"},
            {"id": "doubao-seedream-4-5-251128", "name": "Doubao Seedream 4.5 (Image)"}
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


async def create_image(
    session: AsyncSession, user_id: str, payload: dict[str, Any]
) -> dict[str, Any]:
    # Volcengine API Key
    api_key = "6002c554-3d7f-4293-80e9-c217758ba983"
    endpoint = "https://ark.cn-beijing.volces.com/api/v3/images/generations"
    
    # Create a copy of payload to avoid side effects on the original dictionary
    payload = payload.copy()
    
    model = payload.get("model", "doubao-seedream-4-5-251128")
    # Map alias to real model ID
    if model == "doubao-seedream":
        model = "doubao-seedream-4-5-251128"
    payload["model"] = model
    
    # Handle 'size' parameter -> width/height
    # This is critical because Volcengine API expects width/height integers, but frontend/assets.py sends 'size' string
    if "size" in payload and ("width" not in payload or "height" not in payload):
        try:
            size_str = str(payload["size"]).lower()
            if "x" in size_str:
                w, h = size_str.split("x")
                payload["width"] = int(w)
                payload["height"] = int(h)
            elif "*" in size_str:
                w, h = size_str.split("*")
                payload["width"] = int(w)
                payload["height"] = int(h)
            logger.info(f"Parsed size '{payload['size']}' to width={payload.get('width')}, height={payload.get('height')}")
            
            # Remove 'size' parameter as it might be in invalid format (e.g. '*') for the API
            # The API expects 'width' and 'height' as integers, or 'size' as specific enum strings.
            payload.pop("size", None)
        except Exception as e:
            logger.warning(f"Failed to parse size '{payload.get('size')}': {e}")

    resolved_references: list[str] = []
    
    # 1. Handle 'image_url' (single string)
    if "image_url" in payload and payload["image_url"]:
        resolved_single = await _resolve_image_url(str(payload["image_url"]))
        if resolved_single:
            resolved_references.append(resolved_single)
            # Remove original key to avoid conflicts
            payload.pop("image_url", None)

    # 2. Handle 'image_urls' (list of strings)
    if "image_urls" in payload and isinstance(payload["image_urls"], list):
        for url in payload["image_urls"]:
            resolved = await _resolve_image_url(str(url))
            if resolved:
                resolved_references.append(resolved)
        # Remove original key to avoid conflicts
        payload.pop("image_urls", None)

    # 3. Handle 'image' (string or list)
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
        # Remove original key to avoid conflicts
        payload.pop("image", None)

    # 4. Construct payload for Doubao Seedream
    if "doubao" in model:
        if resolved_references:
            payload["image"] = resolved_references[0] if len(resolved_references) == 1 else resolved_references

        payload.pop("image_urls", None)
        payload.pop("binary_data_base64", None)
        payload["return_url"] = True
        payload.pop("image_url", None)

        logger.info(
            "Seedream Payload Check: image_count=%d keys=%s",
            len(resolved_references),
            list(payload.keys())
        )
        
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json"
    }
    
    # Debug: Print headers (mask key)
    masked_headers = headers.copy()
    masked_headers["Authorization"] = "Bearer " + api_key[:5] + "..."
    logger.info(f"Sending request to {endpoint} with headers: {masked_headers}")

    is_image_to_image = bool(resolved_references)
    client_modes = [False, True]
    last_error: Exception | None = None
    for trust_env_mode in client_modes:
        attempt_payload = payload.copy()
        async with httpx.AsyncClient(timeout=300.0, trust_env=trust_env_mode) as client:
            max_retries = 2
            for attempt in range(max_retries + 1):
                try:
                    response = await client.post(
                        endpoint,
                        headers=headers,
                        json=attempt_payload
                    )
                    
                    if response.status_code != 200:
                        error_text = response.text
                        logger.error(f"Volcengine Image API error (Attempt {attempt+1}/{max_retries+1}, trust_env={trust_env_mode}): {error_text}")
                        error_text_lower = error_text.lower()
                        should_retry_without_size = (
                            attempt < max_retries
                            and is_image_to_image
                            and ("width" in attempt_payload or "height" in attempt_payload)
                            and (
                                "width" in error_text_lower
                                or "height" in error_text_lower
                                or "size" in error_text_lower
                                or "resolution" in error_text_lower
                                or "invalid_parameter" in error_text_lower
                                or "invalid parameter" in error_text_lower
                                or "invalid_request_error" in error_text_lower
                            )
                        )
                        if should_retry_without_size:
                            adjusted_payload = attempt_payload.copy()
                            adjusted_payload.pop("width", None)
                            adjusted_payload.pop("height", None)
                            adjusted_payload.pop("size", None)
                            attempt_payload = adjusted_payload
                            logger.warning("Retrying image edit without explicit width/height due to parameter validation error")
                            continue
                        if attempt < max_retries:
                            logger.warning(f"Retrying request due to failure... trust_env={trust_env_mode}")
                            continue
                             
                        try:
                            error_data = response.json()
                            if "error" in error_data:
                                err_code = error_data["error"].get("code", "")
                                err_msg = error_data["error"].get("message", "")
                                if "risk" in err_msg.lower() or "safety" in err_msg.lower() or "policy" in err_msg.lower():
                                    logger.warning(f"Safety Filter Triggered! Code: {err_code}, Msg: {err_msg}")
                            return error_data
                        except:
                            response.raise_for_status()
                            
                    return response.json()
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


async def create_video(
    session: AsyncSession, user_id: str, payload: dict[str, Any]
) -> dict[str, Any]:
    api_key = "sk-FasceV0bEbOdg88TFa7FpIlLubCftqTmvZJretK3fgR81cTP"
    model = payload.get("model", "veo_3_1-4K")
    prompt = payload.get("prompt", "")
    image_url = payload.get("image_url")
    model_text = str(model or "").strip()
    model_text_lower = model_text.lower()
    is_kling_model = model_text_lower.startswith("kling")
    endpoint = "https://api.magic666.cn/api/v1/video/generations"

    logger.info(f"Creating video with model={model}, prompt={prompt[:20]}..., image_url={'yes' if image_url else 'no'}")

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json"
    }

    data: dict[str, Any] = {
        "model": model,
        "prompt": prompt,
    }

    if is_kling_model:
        data["mode"] = payload.get("mode", "pro")
        data["duration"] = payload.get("duration", 1)
        data["reference_video"] = payload.get("reference_video", False)
        data["with_audio"] = payload.get("with_audio", False)
        if payload.get("reference_video_url"):
            data["reference_video_url"] = payload["reference_video_url"]
        elif image_url and data["reference_video"]:
            data["reference_video_url"] = image_url
        elif image_url:
            data["image_url"] = image_url
    else:
        data["size"] = payload.get("size", "1280x720")
        data["seconds"] = payload.get("seconds", 5)
        if image_url:
            data["image_url"] = image_url

    async with httpx.AsyncClient(timeout=120.0) as client:
        try:
            response = await client.post(
                endpoint,
                headers=headers,
                json=data
            )
            
            if response.status_code != 200:
                logger.error(f"Magic666 API error: {response.text}")
                response.raise_for_status()
                
            result = response.json()
            
            video_url = ""
            if "data" in result and isinstance(result["data"], list) and len(result["data"]) > 0:
                 video_url = result["data"][0].get("url")
            elif "url" in result:
                 video_url = result["url"]
            elif "video_url" in result:
                 video_url = result["video_url"]
            elif "output" in result and isinstance(result["output"], dict):
                 output = result["output"]
                 video_url = output.get("url") or output.get("video_url") or ""
                 
            if video_url:
                return { "data": [ { "url": video_url } ] }
            else:
                return result

        except Exception as e:
            logger.error(f"Failed to create video: {e}")
            raise e
