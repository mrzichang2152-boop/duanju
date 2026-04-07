"""
用户生成媒体可选上传腾讯云 COS；密钥仅通过环境变量配置，禁止写入代码库。
未配置完整 COS 变量时行为与历史一致（仅本地 /static）。
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import mimetypes
import os
import uuid
from typing import Optional
from urllib.parse import quote, unquote, urlparse

import aiofiles
import httpx

from app.core.config import settings

logger = logging.getLogger(__name__)


def _setting(name: str, default: str = "") -> str:
    value = getattr(settings, name, "")
    if value is None or str(value).strip() == "":
        value = os.getenv(name.upper(), os.getenv(name, default))
    return str(value or "")


def _backend_root() -> str:
    return os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def backend_static_dir() -> str:
    return os.path.join(_backend_root(), "static")


def cos_enabled() -> bool:
    return bool(
        _setting("tencent_cos_secret_id").strip()
        and _setting("tencent_cos_secret_key").strip()
        and _setting("tencent_cos_region").strip()
        and _setting("tencent_cos_bucket").strip()
    )


def _cos_prefix() -> str:
    p = _setting("tencent_cos_prefix", "duanju").strip().strip("/")
    return p or "duanju"


def _encode_cos_key_for_url(key: str) -> str:
    return "/".join(quote(part, safe="") for part in key.split("/") if part != "")


def build_cos_object_public_url(object_key: str) -> str:
    key = str(object_key or "").strip().lstrip("/")
    custom = _setting("tencent_cos_public_base_url").strip().rstrip("/")
    if custom:
        return f"{custom}/{_encode_cos_key_for_url(key)}"
    bucket = _setting("tencent_cos_bucket").strip()
    region = _setting("tencent_cos_region").strip()
    return f"https://{bucket}.cos.{region}.myqcloud.com/{_encode_cos_key_for_url(key)}"


def build_cos_public_url_for_static_relative(project_id: str, rel_path: str) -> str:
    normalized = os.path.normpath(str(rel_path or "").strip().lstrip("/")).replace("\\", "/")
    if not normalized or normalized == "." or normalized.startswith("../"):
        raise ValueError("static 相对路径无效")
    return build_cos_object_public_url(f"{_cos_prefix()}/{project_id}/{normalized}")


def _extract_cos_key_from_url(url: str) -> str:
    raw = str(url or "").strip()
    if not raw:
        return ""
    parsed = urlparse(raw)
    if parsed.scheme not in {"http", "https"}:
        return ""
    custom = _setting("tencent_cos_public_base_url").strip().rstrip("/")
    bucket = _setting("tencent_cos_bucket").strip()
    region = _setting("tencent_cos_region").strip()
    default_host = f"{bucket}.cos.{region}.myqcloud.com".lower() if bucket and region else ""
    custom_host = urlparse(custom).netloc.lower() if custom else ""
    host = parsed.netloc.lower()
    if host and host == default_host:
        return unquote(parsed.path.lstrip("/"))
    if custom_host and host == custom_host:
        return unquote(parsed.path.lstrip("/"))
    return ""


def is_cos_public_url(url: str) -> bool:
    return bool(_extract_cos_key_from_url(url))


def _cos_client():
    from qcloud_cos import CosConfig, CosS3Client

    cfg = CosConfig(
        Region=_setting("tencent_cos_region").strip(),
        SecretId=_setting("tencent_cos_secret_id").strip(),
        SecretKey=_setting("tencent_cos_secret_key").strip(),
        Scheme="https",
    )
    return CosS3Client(cfg)


def upload_bytes_to_cos_sync(object_key: str, body: bytes, content_type: Optional[str] = None) -> str:
    """同步上传，供 asyncio.to_thread 调用；对象 ACL 设为 public-read 便于前端直链（若控制台策略禁止需调整桶策略）。"""
    client = _cos_client()
    bucket = _setting("tencent_cos_bucket").strip()
    kwargs: dict = {
        "Bucket": bucket,
        "Body": body,
        "Key": object_key.lstrip("/"),
        "ACL": "public-read",
    }
    if content_type:
        kwargs["ContentType"] = content_type
    try:
        client.put_object(**kwargs)
    except Exception as exc:
        err_text = str(exc).lower()
        if "acl" in err_text or "access" in err_text:
            logger.warning("COS 公有读 ACL 被拒绝，尝试不带 ACL 上传: %s", exc)
            kwargs.pop("ACL", None)
            client.put_object(**kwargs)
        else:
            raise
    return build_cos_object_public_url(object_key.lstrip("/"))


async def upload_bytes_to_cos(object_key: str, body: bytes, content_type: Optional[str] = None) -> str:
    if not cos_enabled():
        raise RuntimeError("未配置腾讯云 COS")
    if not body:
        raise ValueError("空文件无法上传 COS")

    def _run() -> str:
        return upload_bytes_to_cos_sync(object_key, body, content_type)

    return await asyncio.to_thread(_run)


def _guess_extension_from_content_type(content_type: str) -> str:
    ct = str(content_type or "").split(";", 1)[0].strip().lower()
    if not ct:
        return ""
    ext = mimetypes.guess_extension(ct) or ""
    if ext == ".jpe":
        return ".jpg"
    if ext:
        return ext
    if "jpeg" in ct or "jpg" in ct:
        return ".jpg"
    if "png" in ct:
        return ".png"
    if "webp" in ct:
        return ".webp"
    if "gif" in ct:
        return ".gif"
    if "bmp" in ct:
        return ".bmp"
    if "markdown" in ct:
        return ".md"
    if "json" in ct:
        return ".json"
    if "video" in ct:
        return ".mp4"
    if "audio" in ct:
        return ".mp3"
    return ".bin"


def decode_data_image_url(data_url: str) -> tuple[bytes, str]:
    raw = str(data_url or "").strip()
    if not raw.startswith("data:image"):
        raise ValueError("不是图片 Data URL")
    try:
        header, encoded = raw.split(",", 1)
    except ValueError as exc:
        raise ValueError("图片 Data URL 格式无效") from exc
    content_type = "image/png"
    if ";" in header and ":" in header:
        content_type = header.split(":", 1)[1].split(";", 1)[0].strip().lower() or content_type
    try:
        body = base64.b64decode(encoded, validate=False)
    except Exception as exc:
        raise ValueError("图片 Data URL 解码失败") from exc
    if not body:
        raise ValueError("图片 Data URL 为空")
    return body, content_type


async def upload_bytes_under_project_to_cos(
    project_id: str,
    category: str,
    body: bytes,
    content_type: Optional[str] = None,
    filename_hint: str = "",
) -> str:
    safe_cat = str(category or "media").strip().strip("/") or "media"
    hint_ext = os.path.splitext(str(filename_hint or "").strip())[1].lower()
    ext = hint_ext or _guess_extension_from_content_type(content_type or "")
    key = f"{_cos_prefix()}/{project_id}/{safe_cat}/{uuid.uuid4().hex}{ext}"
    return await upload_bytes_to_cos(key, body, content_type or "application/octet-stream")


def delete_cos_object_sync(object_key: str) -> None:
    key = str(object_key or "").strip().lstrip("/")
    if not key:
        return
    client = _cos_client()
    bucket = _setting("tencent_cos_bucket").strip()
    client.delete_object(Bucket=bucket, Key=key)


async def delete_cos_media_by_url(url: str) -> bool:
    if not cos_enabled():
        return False
    object_key = _extract_cos_key_from_url(url)
    if not object_key:
        return False

    def _run() -> None:
        delete_cos_object_sync(object_key)

    await asyncio.to_thread(_run)
    return True


async def publish_local_file_under_static(
    project_id: str,
    abs_path: str,
    *,
    strict: bool = False,
    delete_local: bool = False,
) -> str:
    """
    将已写入 backend/static 下的文件发布为可访问 URL。
    未启用 COS 时返回 /static/ 相对路径；strict=True 时直接报错。
    delete_local=True 时，上传成功后自动删除本地 static 文件，避免继续占用服务器磁盘。
    """
    static_root = os.path.abspath(backend_static_dir())
    abs_norm = os.path.abspath(abs_path)
    if not abs_norm.startswith(static_root + os.sep):
        raise ValueError("文件不在 static 目录内")
    rel = os.path.relpath(abs_norm, static_root).replace("\\", "/")
    rel_url = f"/static/{rel}"
    if not cos_enabled():
        if strict:
            raise RuntimeError("未配置腾讯云 COS")
        return rel_url
    prefix = _cos_prefix()
    key = f"{prefix}/{project_id}/{rel}"
    async with aiofiles.open(abs_norm, "rb") as f:
        body = await f.read()
    if not body:
        raise ValueError("空文件无法上传 COS")
    ct = mimetypes.guess_type(abs_norm)[0] or "application/octet-stream"

    def _run() -> str:
        return upload_bytes_to_cos_sync(key, body, ct)

    uploaded_url = await asyncio.to_thread(_run)
    if delete_local:
        try:
            os.remove(abs_norm)
        except FileNotFoundError:
            pass
        except Exception as exc:
            logger.warning("上传 COS 成功后删除本地文件失败 %s: %s", abs_norm, exc)
    return uploaded_url


async def mirror_http_url_to_cos(project_id: str, category: str, source_url: str, strict: bool = False) -> str:
    """将外链（如 Kling 返回）拉取后存入 COS，返回 COS 公网 URL；未启用或非 http 则原样返回。"""
    url = str(source_url or "").strip()
    if not cos_enabled() or not url.startswith(("http://", "https://")):
        return url
    try:
        async with httpx.AsyncClient(timeout=300.0, follow_redirects=True, verify=True) as client:
            resp = await client.get(url)
            resp.raise_for_status()
            body = resp.content
    except Exception as exc:
        if strict:
            raise RuntimeError(f"拉取源文件失败: {exc}") from exc
        logger.warning("镜像外链到 COS 失败，保留原 URL: %s", exc)
        return url
    if not body:
        if strict:
            raise RuntimeError("拉取源文件为空")
        return url
    ct = (resp.headers.get("content-type") or "").split(";", 1)[0].strip() or "application/octet-stream"
    try:
        return await upload_bytes_under_project_to_cos(project_id, category, body, ct)
    except Exception as exc:
        if strict:
            raise RuntimeError(f"上传 COS 失败: {exc}") from exc
        logger.warning("镜像外链到 COS 失败，保留原 URL: %s", exc)
        return url


def _script_markdown_object_key(project_id: str, script_version: int) -> str:
    return f"{_cos_prefix()}/{project_id}/scripts/script_v{script_version}.md"


def _script_state_object_key(project_id: str, script_version: int) -> str:
    return f"{_cos_prefix()}/{project_id}/scripts/script_v{script_version}.json"


def build_script_markdown_public_url(project_id: str, script_version: int) -> str:
    if not cos_enabled() or not script_version:
        return ""
    return build_cos_object_public_url(_script_markdown_object_key(project_id, script_version))


def build_script_state_public_url(project_id: str, script_version: int) -> str:
    if not cos_enabled() or not script_version:
        return ""
    return build_cos_object_public_url(_script_state_object_key(project_id, script_version))


async def upload_script_snapshot_to_cos(project_id: str, script_version: int, text: str) -> str:
    """剧本 Markdown 快照上传（UTF-8 文本），失败仅记日志不阻断保存。"""
    if not cos_enabled() or not text:
        return ""
    body = text.encode("utf-8")
    try:
        return await upload_bytes_to_cos(_script_markdown_object_key(project_id, script_version), body, "text/markdown; charset=utf-8")
    except Exception as exc:
        logger.warning("剧本快照上传 COS 失败 project_id=%s: %s", project_id, exc)
        return ""


async def upload_script_state_to_cos(project_id: str, script_version: int, payload: dict) -> str:
    if not cos_enabled() or not payload:
        return ""
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    try:
        return await upload_bytes_to_cos(_script_state_object_key(project_id, script_version), body, "application/json; charset=utf-8")
    except Exception as exc:
        logger.warning("剧本状态上传 COS 失败 project_id=%s: %s", project_id, exc)
        return ""


async def load_media_bytes(url: str) -> bytes:
    """读取 /static 本地或 https 远程媒体字节（供转写等逻辑）。"""
    u = str(url or "").strip()
    if u.startswith("/static/"):
        path = os.path.join(backend_static_dir(), u.replace("/static/", "", 1))
        path = os.path.abspath(path)
        root = os.path.abspath(backend_static_dir())
        if os.path.commonpath([path, root]) != root:
            raise RuntimeError("媒体路径越界")
        async with aiofiles.open(path, "rb") as f:
            return await f.read()
    if u.startswith(("http://", "https://")):
        async with httpx.AsyncClient(timeout=120.0, follow_redirects=True, verify=True) as client:
            resp = await client.get(u)
            resp.raise_for_status()
            data = resp.content
        if not data:
            raise RuntimeError("远程媒体为空")
        return data
    raise RuntimeError("不支持的媒体地址")
