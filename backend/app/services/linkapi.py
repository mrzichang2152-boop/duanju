from typing import Any
import os
import socket
import asyncio
import base64
import json
import logging
import re

import httpx
from sqlalchemy.ext.asyncio import AsyncSession

from app.services.settings import get_api_key, get_or_create_settings

logger = logging.getLogger(__name__)


def _get_auto_proxy() -> str | None:
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
        socket.gethostbyname(host)
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(0.1)
        if sock.connect_ex((host, 7897)) == 0:
            sock.close()
            return f"http://{host}:7897"
        sock.close()
    except:
        pass

    return None


async def fetch_models(session: AsyncSession, user_id: str) -> dict[str, Any]:
    # Volcengine API Key
    api_key = "6002c554-3d7f-4293-80e9-c217758ba983"
    
    settings = await get_or_create_settings(session, user_id)
    
    # Endpoint for Volcengine
    endpoint = "https://ark.cn-beijing.volces.com/api/v3"

    async with httpx.AsyncClient(timeout=60.0) as client:
        # Volcengine doesn't have a standard /models endpoint that returns OpenAI format exactly the same way,
        # but we can mock it or try to call it. 
        # For now, we'll return a fixed list or try to fetch if supported.
        # Since the user only wants to use one model, we can return a mocked response.
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
    payload["model"] = "doubao-seed-2-0-pro-260215"

    # Use auto-detected proxy
    proxies = _get_auto_proxy()
    
    transport = httpx.AsyncHTTPTransport(retries=2, proxy=proxies)

    async with httpx.AsyncClient(timeout=300.0, transport=transport) as client:
        async def send(url: str, request_payload: dict[str, Any]) -> httpx.Response:
            headers = {
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            }
            return await client.post(
                url,
                headers=headers,
                json=request_payload,
            )

        async def send_with_retries(url: str, request_payload: dict[str, Any]) -> httpx.Response:
            last_exc: httpx.HTTPError | None = None
            for attempt in range(5):
                try:
                    return await send(url, request_payload)
                except httpx.HTTPError as exc:
                    last_exc = exc
                    if attempt < 4:
                        await asyncio.sleep(0.6 * (attempt + 1))
            assert last_exc is not None
            raise last_exc

        try:
            # Volcengine Endpoint
            endpoint = "https://ark.cn-beijing.volces.com/api/v3"
            url = f"{endpoint}/chat/completions"

            # Volcengine requires a specific payload format that might differ slightly or require cleanup
            
            # 1. Remove parameters not supported by Volcengine if present
            if "provider" in payload:
                del payload["provider"]
            if "transforms" in payload:
                del payload["transforms"]
            if "models" in payload:
                del payload["models"]
            if "route" in payload:
                del payload["route"]
                
            # 2. Ensure model is correct
            payload["model"] = "doubao-seed-2-0-pro-260215"
            
            # 3. Log the payload for debugging
            logger.info("Sending payload to Volcengine: %s", json.dumps(payload, ensure_ascii=False))

            response = await send_with_retries(
                url,
                payload,
            )

        except httpx.HTTPError as exc:
            payload_size = len(json.dumps(payload, ensure_ascii=False))
            logger.warning("Volcengine chat completion transport error: %s", exc)
            raise ValueError(
                f"Volcengine 连接异常：{type(exc).__name__}（payload={payload_size}）"
            ) from exc
    try:
        response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        detail = response.text.strip() or "Volcengine 请求失败"
        logger.warning("Volcengine chat completion failed: %s %s", response.status_code, detail)
        raise ValueError(f"{response.status_code} {detail}") from exc
    
    json_response = response.json()
    logger.info("Volcengine response received. Status: %s", response.status_code)
    return json_response


async def create_chat_completion_stream(
    session: AsyncSession, user_id: str, payload: dict[str, Any]
):
    # Volcengine API Key
    api_key = "6002c554-3d7f-4293-80e9-c217758ba983"

    settings = await get_or_create_settings(session, user_id)
    
    logger.info("Using Volcengine Key for stream: %s... (len=%d)", api_key[:10], len(api_key))

    # Force model to Volcengine model
    payload["model"] = "doubao-seed-2-0-pro-260215"
    payload["stream"] = True

    # Use auto-detected proxy
    proxies = _get_auto_proxy()
    transport = httpx.AsyncHTTPTransport(retries=2, proxy=proxies)

    # Volcengine Endpoint
    endpoint = "https://ark.cn-beijing.volces.com/api/v3"
    url = f"{endpoint}/chat/completions"

    # Cleanup payload
    if "provider" in payload: del payload["provider"]
    if "transforms" in payload: del payload["transforms"]
    if "models" in payload: del payload["models"]
    if "route" in payload: del payload["route"]

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    async with httpx.AsyncClient(timeout=120.0, transport=transport) as client:
        try:
            async with client.stream("POST", url, headers=headers, json=payload) as response:
                if response.status_code != 200:
                    error_text = await response.read()
                    logger.error(f"Stream error: {response.status_code} {error_text}")
                    yield {"error": f"Error {response.status_code}: {error_text.decode()}"}
                    return

                async for line in response.aiter_lines():
                    if line.startswith("data: "):
                        data = line[6:].strip()
                        if data == "[DONE]":
                            break
                        try:
                            chunk = json.loads(data)
                            yield chunk
                        except json.JSONDecodeError:
                            pass
        except Exception as e:
            logger.error(f"Stream exception: {e}")
            yield {"error": str(e)}



async def create_image(
    session: AsyncSession, user_id: str, payload: dict[str, Any]
) -> dict[str, Any]:
    # Volcengine API Key
    api_key = "6002c554-3d7f-4293-80e9-c217758ba983"
    
    settings = await get_or_create_settings(session, user_id)
    
    # Volcengine Endpoint
    endpoint = "https://ark.cn-beijing.volces.com/api/v3"
    
    prompt = (payload.get("prompt") or "").strip()
    # Extract prompt from messages if present (OpenAI chat format compatibility)
    if not prompt and payload.get("messages"):
        for msg in reversed(payload["messages"]):
            if msg.get("content"):
                prompt = msg["content"]
                if isinstance(prompt, list):
                    # Handle multimodal content list
                    for part in prompt:
                        if isinstance(part, dict) and part.get("type") == "text":
                            prompt = part.get("text", "")
                            break
                        elif isinstance(part, str):
                            prompt = part
                            break
                break

    # Default to a generic Doubao image model if not specified
    # Note: User should replace this with their specific Endpoint ID for Doubao-Image (Seedream)
    model = payload.get("model")
    # If model is explicitly a text model, force to image model
    if model and ("seed-2-0" in model or "flash" in model or "gpt-3" in model or "gpt-4" in model):
         model = "doubao-seedream-4-5-251128"
         
    if not model or "gemini" in model or "gpt" in model:
        model = "doubao-seedream-4-5-251128" 

    # Construct OpenAI-compatible image generation payload
    request_payload: dict[str, Any] = {
        "model": model,
        "prompt": prompt,
        "n": payload.get("n", 1),
    }
    
    # Handle size logic for Volcengine
    size = payload.get("size", "1024x1024")
    # If size is "2K", pass it directly as string, Volcengine supports it
    # If size is standard resolution like "1024x1024", pass it
    request_payload["size"] = size
    
    # Pass through Volcengine specific parameters
    for key in ["sequential_image_generation", "response_format", "watermark", "image_url"]:
        if key in payload:
            # Special handling for image_url: Convert to Base64 if it's a remote URL
            # This ensures we are "sending the image directly" as requested, avoiding access issues with remote URLs
            if key == "image_url":
                img_url = payload[key]
                final_img_url = img_url
                
                if isinstance(img_url, str) and img_url.startswith("http"):
                    try:
                        logger.info(f"Downloading image for img2img: {img_url}")
                        # Use a new client for download to avoid proxy/config issues
                        async with httpx.AsyncClient(timeout=60.0) as downloader:
                            img_resp = await downloader.get(img_url)
                            img_resp.raise_for_status()
                            content_type = img_resp.headers.get("Content-Type", "image/jpeg")
                            b64_data = base64.b64encode(img_resp.content).decode("utf-8")
                            final_img_url = f"data:{content_type};base64,{b64_data}"
                            logger.info(f"Converted input image to Base64 (len={len(b64_data)})")
                    except Exception as e:
                        logger.warning(f"Failed to convert input image to Base64, falling back to URL: {e}")
                        final_img_url = img_url
                
                # Volcengine Seedream model uses 'image_urls' (list) instead of 'image_url'
                if "doubao-seedream" in model:
                    request_payload["image_urls"] = [final_img_url]
                    # Clean up the singular key if it was set by mistake or default
                    if "image_url" in request_payload:
                        del request_payload["image_url"]
                else:
                    request_payload[key] = final_img_url
            else:
                request_payload[key] = payload[key]
            
    # Hardcode defaults for Doubao Seedream model as requested
    if model == "doubao-seedream-4-5-251128":
        request_payload.setdefault("sequential_image_generation", "disabled")
        request_payload.setdefault("response_format", "url")
        request_payload.setdefault("watermark", True)
        
        # Relaxed size logic: Allow custom dimensions (WIDTHxHEIGHT) or standard aliases
        current_size = request_payload.get("size")
        
        # Check for invalid small sizes and upgrade them
        # 1024x1024 = 1MP (Too small, min 3.6MP)
        # 1024x1536 = 1.5MP (Too small)
        if current_size in ["1024x1024", "1024x1536", "1536x1024"]:
            if current_size == "1024x1024":
                request_payload["size"] = "2048x2048" # 2K Square
            elif current_size == "1024x1536":
                request_payload["size"] = "2048x3072" # Portrait
            elif current_size == "1536x1024":
                request_payload["size"] = "3072x2048" # Landscape
            logger.info(f"Upgraded size from {current_size} to {request_payload['size']} for Seedream model")
            
        elif not current_size:
             request_payload["size"] = "2K"
        elif current_size not in ["2K", "1k", "4k"] and "x" not in str(current_size) and "*" not in str(current_size):
             # If it's some unknown format, default to 2K to be safe
             request_payload["size"] = "2K"
    
    # Use auto-detected proxy
    proxies = _get_auto_proxy()
    transport = httpx.AsyncHTTPTransport(retries=2, proxy=proxies)

    async with httpx.AsyncClient(timeout=120.0, transport=transport) as client:
        try:
            response = await client.post(
                f"{endpoint}/images/generations",
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {api_key}",
                },
                json=request_payload,
                timeout=120.0,
            )
            if response.status_code != 200:
                logger.error(f"Volcengine Image Generation Failed: {response.text}")
                try:
                    error_data = response.json()
                    error_msg = error_data.get("error", {}).get("message", response.text)
                    error_code = error_data.get("error", {}).get("code", "")
                except:
                    error_msg = response.text
                    error_code = ""
                
                # Friendly error message for content safety rejection
                if (
                    "sensitive" in error_msg.lower() 
                    or "blocked" in error_msg.lower() 
                    or "compliance" in error_msg.lower()
                    or error_code == "OutputImageSensitiveContentDetected"
                ):
                     raise ValueError("图片生成失败：内容包含敏感信息，请修改提示词后重试。")
                
                raise Exception(f"Volcengine Error: {error_msg}")
                
            response.raise_for_status()
            result = _normalize_image_response(response.json())

            # User Requirement: Store image content (Base64), not URL
            # Download the generated image URL and convert to Base64 Data URI
            if "data" in result:
                for item in result["data"]:
                    if "url" in item:
                        try:
                            # Use a separate client for downloading to avoid reusing the API client configuration
                            # and to ensure we don't have proxy issues if the URL is accessible directly
                            async with httpx.AsyncClient(timeout=60.0) as downloader:
                                img_resp = await downloader.get(item["url"])
                                img_resp.raise_for_status()
                                content_type = img_resp.headers.get("Content-Type", "image/jpeg")
                                b64_data = base64.b64encode(img_resp.content).decode("utf-8")
                                item["url"] = f"data:{content_type};base64,{b64_data}"
                                logger.info(f"Converted generated image to Base64 (len={len(b64_data)})")
                        except Exception as e:
                            logger.error(f"Failed to convert image to Base64: {e}")
                            # Fallback: keep the URL, but log the error
            
            return result
            
        except httpx.HTTPError as exc:
            logger.error("Volcengine image generation failed: %s", exc)
            if hasattr(exc, "response") and exc.response:
                 logger.error("Response: %s", exc.response.text)
            raise ValueError(f"Volcengine 绘图失败：{type(exc).__name__}") from exc


def _normalize_image_response(data: dict[str, Any]) -> dict[str, Any]:
    if data.get("data"):
        return data
    images = data.get("images") or data.get("output")
    if isinstance(images, list):
        for item in images:
            if isinstance(item, str):
                return {"data": [{"url": item}]}
            if isinstance(item, dict):
                url = item.get("url") or item.get("image_url")
                if url:
                    return {"data": [{"url": url}]}
    choices = data.get("choices") or []
    for choice in choices:
        message = choice.get("message") or {}
        content = message.get("content")
        images = message.get("images")
        if isinstance(images, list) and images:
            first = images[0]
            if isinstance(first, str):
                return {"data": [{"url": first}]}
            if isinstance(first, dict):
                url = first.get("url") or first.get("image_url")
                if url:
                    return {"data": [{"url": url}]}
        if isinstance(content, list):
            for part in content:
                part_type = part.get("type")
                if part_type in {"image_url", "image", "output_image", "output_image_url"}:
                    image_url: str | dict[str, Any] | None = (
                        part.get("image_url", {}).get("url")
                        or part.get("image")
                        or part.get("url")
                    )
                    if isinstance(image_url, dict):
                        image_url = image_url.get("url") or image_url.get("image_url")
                    if image_url:
                        return {"data": [{"url": image_url}]}
        elif isinstance(content, str):
            if content.startswith("http") or content.startswith("data:image/"):
                return {"data": [{"url": content}]}
    return data


async def _load_image_bytes(image_url: str) -> tuple[bytes, str, str]:
    if image_url.startswith("data:image/"):
        match = re.match(r"data:(image/[^;]+);base64,(.+)", image_url, re.DOTALL)
        if not match:
            raise ValueError("图片数据解析失败")
        content_type = match.group(1)
        data = base64.b64decode(match.group(2))
        ext = content_type.split("/")[-1]
        filename = f"image.{ext}"
        return data, filename, content_type
    async with httpx.AsyncClient(timeout=60.0) as client:
        response = await client.get(image_url)
        response.raise_for_status()
        content_type = response.headers.get("Content-Type") or "image/png"
        ext = content_type.split("/")[-1]
        filename = f"image.{ext}"
        return response.content, filename, content_type


async def create_image_edit(
    session: AsyncSession,
    user_id: str,
    image_url: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    request_payload = {**payload, "image_url": image_url}
    return await create_image(session, user_id, request_payload)


async def create_image_with_reference(
    session: AsyncSession,
    user_id: str,
    image_url: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    request_payload = {**payload, "image_url": image_url}
    return await create_image(session, user_id, request_payload)


async def create_video(
    session: AsyncSession, user_id: str, payload: dict[str, Any]
) -> dict[str, Any]:
    # Volcengine API Key
    api_key = "6002c554-3d7f-4293-80e9-c217758ba983"
    
    settings = await get_or_create_settings(session, user_id)
    
    # Volcengine Endpoint
    endpoint = "https://ark.cn-beijing.volces.com/api/v3"

    # Default to a generic Doubao video model
    # Note: User should replace this with their specific Endpoint ID for Doubao-Video (PixelDance)
    model = payload.get("model")
    if not model or "sora" in model:
        model = "doubao-video-pro"
        
    request_payload = payload.copy()
    request_payload["model"] = model

    # Use auto-detected proxy
    proxies = _get_auto_proxy()
    transport = httpx.AsyncHTTPTransport(retries=2, proxy=proxies)
    
    async with httpx.AsyncClient(timeout=180.0, transport=transport) as client:
        try:
            # Volcengine Video Generation Endpoint (Hypothetical OpenAI compatible or specific)
            # Currently Volcengine might not support /v1/videos standard. 
            # We will try a common path or log warning.
            url = f"{endpoint}/videos/generations" 
            
            logger.info("Sending video generation request to Volcengine: %s", url)
            
            response = await client.post(
                url,
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json=request_payload,
            )
            
            response.raise_for_status()
            return response.json()
        except httpx.HTTPError as exc:
             logger.error("Volcengine video generation failed: %s", exc)
             raise ValueError(f"Volcengine 视频生成失败：{type(exc).__name__}") from exc
