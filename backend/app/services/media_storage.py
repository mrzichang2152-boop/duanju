"""
用户生成媒体可选上传腾讯云 COS；密钥仅通过环境变量配置，禁止写入代码库。
未配置完整 COS 变量时行为与历史一致（仅本地 /static）。
"""

from __future__ import annotations

import asyncio
import logging
import mimetypes
import os
import uuid
from typing import Optional
from urllib.parse import quote

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


async def publish_local_file_under_static(project_id: str, abs_path: str) -> str:
    """
    将已写入 backend/static 下的文件发布为可访问 URL。
    未启用 COS 时返回 /static/ 相对路径（与历史一致）。
    """
    static_root = os.path.abspath(backend_static_dir())
    abs_norm = os.path.abspath(abs_path)
    if not abs_norm.startswith(static_root + os.sep):
        raise ValueError("文件不在 static 目录内")
    rel = os.path.relpath(abs_norm, static_root).replace("\\", "/")
    rel_url = f"/static/{rel}"
    if not cos_enabled():
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

    return await asyncio.to_thread(_run)


async def mirror_http_url_to_cos(project_id: str, category: str, source_url: str) -> str:
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
        logger.warning("镜像外链到 COS 失败，保留原 URL: %s", exc)
        return url
    if not body:
        return url
    ct = (resp.headers.get("content-type") or "").split(";")[0].strip() or "application/octet-stream"
    ext = mimetypes.guess_extension(ct) or ""
    if not ext:
        if "video" in ct:
            ext = ".mp4"
        elif "audio" in ct:
            ext = ".mp3"
        elif "image" in ct:
            ext = ".jpg"
        else:
            ext = ".bin"
    safe_cat = category.strip().strip("/") or "media"
    prefix = _cos_prefix()
    key = f"{prefix}/{project_id}/{safe_cat}/{uuid.uuid4().hex}{ext}"

    def _run() -> str:
        return upload_bytes_to_cos_sync(key, body, ct)

    return await asyncio.to_thread(_run)


async def upload_script_snapshot_to_cos(project_id: str, script_version: int, text: str) -> None:
    """剧本快照上传（UTF-8 文本），失败仅记日志不阻断保存。"""
    if not cos_enabled() or not text:
        return
    body = text.encode("utf-8")
    prefix = _cos_prefix()
    key = f"{prefix}/{project_id}/scripts/script_v{script_version}_{uuid.uuid4().hex[:8]}.md"

    def _run() -> None:
        upload_bytes_to_cos_sync(key, body, "text/markdown")

    try:
        await asyncio.to_thread(_run)
    except Exception as exc:
        logger.warning("剧本快照上传 COS 失败 project_id=%s: %s", project_id, exc)


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
