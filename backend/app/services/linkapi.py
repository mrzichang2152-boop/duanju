from typing import Any
import asyncio
import base64
import json
import logging
import re

import httpx
from sqlalchemy.ext.asyncio import AsyncSession

from app.services.settings import get_api_key, get_or_create_settings

logger = logging.getLogger(__name__)


async def fetch_models(session: AsyncSession, user_id: str) -> dict[str, Any]:
    # DEBUG: 强制使用用户提供的 Key，排除数据库存储问题
    api_key = "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"
    
    settings = await get_or_create_settings(session, user_id)
    # api_key_db = await get_api_key(session, user_id)
    # if not api_key:
    #     raise ValueError("未配置 OpenRouter Key")
    
    # 清理 API Key
    api_key = api_key.strip()
    if api_key.lower().startswith("bearer "):
        api_key = api_key[7:].strip()

    # 强制修正 OpenRouter 的 Endpoint
    endpoint = settings.endpoint.rstrip("/")
    if "linkapi.ai" in endpoint or ("openrouter.ai" in endpoint and "/api/v1" not in endpoint):
        endpoint = "https://openrouter.ai/api/v1"

    async with httpx.AsyncClient(timeout=60.0) as client:
        response = await client.get(
            f"{endpoint}/models",
            headers={
                "Authorization": f"Bearer {api_key}",
                "HTTP-Referer": "http://localhost:3000",
                "X-OpenRouter-Title": "Video Gen App",
            },
        )
    response.raise_for_status()
    return response.json()


def _map_openrouter_model(model: str) -> str:
    # 强制映射：由于 Google 模型在当前区域不可用（403 Forbidden），
    # 且 Llama/Qwen 等模型存在速率限制（429），
    # 这里统一映射到已验证可用的 StepFun（阶跃星辰）模型。
    # 但允许用户指定的新模型 Gemini 3 Flash / 3.1 Pro 通过
    fallback_model = "stepfun/step-3.5-flash:free"
    
    model_alias = {
        "gpt-5.2": fallback_model,
        "gemini3flash": "google/gemini-3-flash-preview",
        "gemini3.1": "google/gemini-3.1-pro-preview",
        "gemini-3-flash": fallback_model,
        "gemini-3-flash-preview": fallback_model,
        "gemini3pro": fallback_model,
        "gemini-3-pro": fallback_model,
        "gemini-3-pro-preview": fallback_model,
        "nanobanana-pro": "google/gemini-3-pro-image-preview",
        "gemini-3-pro-image-preview": "google/gemini-3-pro-image-preview",
        "nanobanana": fallback_model,
        "gemini-2.5-flash-image-preview": fallback_model,
        "google/gemini-2.0-flash-001": fallback_model,
    }
    
    mapped = model_alias.get(model, model)
    
    # 允许的新模型列表
    allowed_models = [
        "google/gemini-3-flash-preview", 
        "google/gemini-3.1-pro-preview",
        "google/gemini-3-pro-image-preview"
    ]
    if mapped in allowed_models:
        return mapped

    # 额外的安全检查：如果包含 gemini，强制替换
    if "gemini" in mapped.lower():
        return fallback_model
    return mapped


async def create_chat_completion(
    session: AsyncSession, user_id: str, payload: dict[str, Any]
) -> dict[str, Any]:
    # DEBUG: 强制使用用户提供的 Key，排除数据库存储问题
    api_key = "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"

    settings = await get_or_create_settings(session, user_id)
    # api_key_db = await get_api_key(session, user_id)
    # if not api_key:
    #     raise ValueError("未配置 OpenRouter Key")
    
    # 清理 API Key：去除首尾空格，去除可能的 Bearer 前缀
    api_key = api_key.strip()
    if api_key.lower().startswith("bearer "):
        api_key = api_key[7:].strip()
        
    logger.info("Using OpenRouter Key: %s... (len=%d)", api_key[:10], len(api_key))

    model = (payload.get("model") or "").strip()
    mapped_model = _map_openrouter_model(model)
    if mapped_model:
        payload = {**payload, "model": mapped_model}

    # Detect local proxy (e.g. Clash/V2Ray) to ensure connectivity
    proxies = None
    import os
    # Prioritize env vars, then check common local ports if not set
    if os.environ.get("HTTPS_PROXY"):
        proxies = os.environ.get("HTTPS_PROXY")
    elif os.environ.get("HTTP_PROXY"):
        proxies = os.environ.get("HTTP_PROXY")
    else:
        # Hardcoded fallback for known user environment
        proxies = "http://127.0.0.1:7897"

    # 修复：httpx.AsyncClient 如果指定了 transport，proxies 必须配置在 transport 上
    # 另外，AsyncHTTPTransport 的参数是 proxy (单数) 或 proxies (复数，取决于具体实现，通常用 proxy=url)
    # httpx 0.28+ AsyncHTTPTransport 支持 proxy=url
    transport = httpx.AsyncHTTPTransport(retries=2, proxy=proxies)

    async with httpx.AsyncClient(timeout=300.0, transport=transport) as client:
        async def send(url: str, request_payload: dict[str, Any]) -> httpx.Response:
            # 临时移除 headers，避免 httpx 复用问题，或者确保 Content-Type 正确
            # 注意：httpx.AsyncClient 复用时，headers 会合并
            # 这里每次 request 都显式传递 headers
            headers = {
                "Authorization": f"Bearer {api_key}",
                "HTTP-Referer": "http://localhost:3000",
                "X-OpenRouter-Title": "Video Gen App",
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
            # 强制修正 OpenRouter 的 Endpoint
            endpoint = settings.endpoint.rstrip("/")
            # 如果是旧的 linkapi 地址，或者包含 openrouter 但没有 api/v1，强制修正
            if "linkapi.ai" in endpoint or ("openrouter.ai" in endpoint and "/api/v1" not in endpoint):
                endpoint = "https://openrouter.ai/api/v1"

            if endpoint.endswith("/chat/completions"):
                url = endpoint
            else:
                url = f"{endpoint}/chat/completions"

            response = await send_with_retries(
                url,
                payload,
            )

        except httpx.HTTPError as exc:
            payload_size = len(json.dumps(payload, ensure_ascii=False))
            logger.warning("OpenRouter chat completion transport error: %s", exc)
            raise ValueError(
                f"OpenRouter 连接异常：{type(exc).__name__}（payload={payload_size}）"
            ) from exc
    try:
        response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        detail = response.text.strip() or "OpenRouter 请求失败"
        logger.warning("OpenRouter chat completion failed: %s %s", response.status_code, detail)
        raise ValueError(f"{response.status_code} {detail}") from exc
    
    json_response = response.json()
    logger.info("OpenRouter response received. Status: %s. Body keys: %s", response.status_code, list(json_response.keys()))
    return json_response


async def create_image(
    session: AsyncSession, user_id: str, payload: dict[str, Any]
) -> dict[str, Any]:
    settings = await get_or_create_settings(session, user_id)
    api_key = await get_api_key(session, user_id)
    if not api_key:
        raise ValueError("未配置 OpenRouter Key")
    
    # 清理 API Key
    api_key = api_key.strip()
    if api_key.lower().startswith("bearer "):
        api_key = api_key[7:].strip()

    # DEBUG: 强制使用用户提供的 Key，排除数据库存储问题
    debug_key = "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"
    if api_key != debug_key:
        logger.warning("Replacing DB key with debug key provided by user")
        api_key = debug_key
        
    # 强制修正 OpenRouter 的 Endpoint
    endpoint = settings.endpoint.rstrip("/")
    if "linkapi.ai" in endpoint or ("openrouter.ai" in endpoint and "/api/v1" not in endpoint):
        endpoint = "https://openrouter.ai/api/v1"

    prompt = (payload.get("prompt") or "").strip()
    model = _map_openrouter_model((payload.get("model") or "").strip())
    image_url = payload.get("image_url")
    content: list[dict[str, Any]] = []
    if prompt:
        content.append({"type": "text", "text": prompt})
    if image_url:
        content.append({"type": "image_url", "image_url": {"url": image_url}})
    request_payload: dict[str, Any] = {
        "model": model,
        "messages": [{"role": "user", "content": content or prompt}],
        "modalities": ["image", "text"],
    }
    if payload.get("n"):
        request_payload["n"] = payload["n"]
    
    # Detect local proxy (e.g. Clash/V2Ray) to ensure connectivity
    proxies = None
    import os
    # Prioritize env vars, then check common local ports if not set
    if os.environ.get("HTTPS_PROXY"):
        proxies = os.environ.get("HTTPS_PROXY")
    elif os.environ.get("HTTP_PROXY"):
        proxies = os.environ.get("HTTP_PROXY")
    else:
        # Hardcoded fallback for known user environment
        proxies = "http://127.0.0.1:7897"

    transport = httpx.AsyncHTTPTransport(retries=2, proxy=proxies)
    async with httpx.AsyncClient(timeout=120.0, transport=transport) as client:
        async def send() -> httpx.Response:
            return await client.post(
                f"{endpoint}/chat/completions",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "HTTP-Referer": "http://localhost:3000",
                    "X-OpenRouter-Title": "Video Gen App",
                    "Content-Type": "application/json",
                },
                json=request_payload,
            )

        last_exc: httpx.HTTPError | None = None
        for attempt in range(4):
            try:
                response = await send()
                response.raise_for_status()
                return _normalize_image_response(response.json())
            except httpx.HTTPStatusError as exc:
                detail = response.text.strip() or "OpenRouter 请求失败"
                if response.status_code >= 500 and attempt < 3:
                    await asyncio.sleep(0.6 * (attempt + 1))
                    continue
                # 如果是 403 Forbidden，可能是区域限制或模型权限问题
                if response.status_code == 403:
                    logger.error("OpenRouter 403 Forbidden. Check model availability and region blocks.")
                raise ValueError(f"{response.status_code} {detail}") from exc
            except httpx.HTTPError as exc:
                last_exc = exc
                if attempt < 3:
                    await asyncio.sleep(0.6 * (attempt + 1))
        raise ValueError(f"OpenRouter 连接异常：{type(last_exc).__name__}") from last_exc


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
    settings = await get_or_create_settings(session, user_id)
    api_key = await get_api_key(session, user_id)
    if not api_key:
        raise ValueError("未配置 OpenRouter Key")
    async with httpx.AsyncClient(timeout=180.0) as client:
        response = await client.post(
            f"{settings.endpoint}/v1/videos",
            headers={"Authorization": f"Bearer {api_key}"},
            json=payload,
        )
    try:
        response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        detail = response.text.strip() or "OpenRouter 请求失败"
        raise ValueError(f"{response.status_code} {detail}") from exc
    return response.json()
