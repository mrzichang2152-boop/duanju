import json
import mimetypes
import os
import logging
import base64
import uuid
import asyncio
import httpx
from pydantic import BaseModel
from fastapi import APIRouter, Depends, HTTPException, status, UploadFile, File
from fastapi.responses import Response, RedirectResponse, FileResponse

logger = logging.getLogger(__name__)
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user_id
from app.core.db import SessionLocal, get_db
from app.schemas.assets import AssetGenerateRequest, AssetResponse, AssetSelectRequest, AssetUpdateRequest
from app.schemas.script import AsyncTaskStatusResponse
from app.schemas.common import StatusResponse
from app.services.projects import get_project
from app.models.asset import Asset
from app.models.asset_version import AssetVersion
from app.models.character_voice import CharacterVoice
from app.services.assets import (
    create_asset_version,
    extract_assets_from_script,
    get_asset,
    list_assets,
    list_asset_versions,
    delete_asset_version,
    select_asset_version,
    download_image_as_local_file,
    update_asset_config,
    _normalize_character_look_payload,
    _sanitize_step2_metadata,
)
from app.services import media_storage
from app.services.linkapi import (
    _get_or_create_character_subject_id,
    _normalize_role_key,
    _resolve_image_url,
    create_image,
    create_image_edit,
    create_image_with_reference,
    resolve_kling_auth_token,
)
from app.services.async_tasks import (
    create_async_task,
    get_async_task,
    mark_async_task_running,
    mark_async_task_completed,
    mark_async_task_failed,
    parse_task_result,
)

router = APIRouter()
OPENROUTER_IMAGE_MODEL = "nano-banana-2"
_ASSET_GENERATE_TASK_TYPE = "ASSET_GENERATE"


def _get_style_prompts():
    # Use relative path to load style prompts from app/core/style_prompts.json
    try:
        current_dir = os.path.dirname(os.path.abspath(__file__))
        # Go up one level to app, then into core
        json_path = os.path.join(os.path.dirname(current_dir), "core", "style_prompts.json")
        
        if os.path.exists(json_path):
            with open(json_path, "r", encoding="utf-8") as f:
                return json.load(f)
        else:
            logger.warning(f"Style prompts file not found at {json_path}")
            return []
    except Exception as e:
        logger.error(f"Failed to load style prompts: {e}")
        return []


def _extract_role_name_from_look(look_name: str) -> str:
    name = (look_name or "").strip()
    for sep in ["·", "：", ":", "-", "—", "｜", "|"]:
        if sep in name:
            left = name.split(sep, 1)[0].strip()
            if left:
                return left
    return name


def _resolve_role_name_from_look(look_name: str, character_names: list[str]) -> str:
    base = _extract_role_name_from_look(look_name)
    if base and base != (look_name or "").strip():
        return base
    compact_look = (look_name or "").replace(" ", "")
    for candidate in sorted(character_names, key=len, reverse=True):
        compact_candidate = (candidate or "").replace(" ", "")
        if compact_candidate and compact_look.startswith(compact_candidate):
            return candidate
    return base


async def _continue_asset_generation_after_disconnect(
    project_id: str,
    asset_id: str,
    payload_snapshot: dict,
    user_id: str,
) -> None:
    try:
        payload = AssetGenerateRequest(**payload_snapshot)
    except Exception:
        logger.exception("恢复素材生成失败：payload 反序列化异常 asset_id=%s", asset_id)
        return
    try:
        async with SessionLocal() as background_db:
            await _generate_asset_sync(project_id, asset_id, payload, user_id, background_db)
    except Exception:
        logger.exception("恢复素材生成失败：后台任务执行异常 asset_id=%s", asset_id)


@router.post("/{project_id}/assets/extract", response_model=StatusResponse)
async def extract_assets(
    project_id: str,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
) -> StatusResponse:
    project = await get_project(db, user_id, project_id)
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    try:
        await extract_assets_from_script(db, project_id, user_id)
    except Exception as e:
        logger.error(f"Failed to extract assets for project {project_id}: {e}", exc_info=True)
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"提取失败: {str(e)}")
    return StatusResponse(status="ready")


@router.get("/{project_id}/assets", response_model=list[AssetResponse])
async def fetch_assets(
    project_id: str,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
) -> list[AssetResponse]:
    project = await get_project(db, user_id, project_id)
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    
    # Always try to sync from manually edited resources (Step 2) to ensure assets are up-to-date
    # This handles the case where user modifies Step 2 text and returns to Step 3.
    # manual_only=True means we parse the project.resources_content (Step 2 text) via regex (fast),
    # instead of calling LLM.
    try:
        await extract_assets_from_script(db, project_id, user_id, manual_only=True)
    except Exception as e:
        await db.rollback()
        logger.warning(f"Failed to sync assets from script: {e}")

    assets = await list_assets(db, project_id)
    character_names = [str(item.name or "").strip() for item in assets if item.type == "CHARACTER"]

    responses: list[AssetResponse] = []
    has_version_url_updated = False
    has_asset_meta_updated = False
    for asset in assets:
        versions = await list_asset_versions(db, asset.id)
        if len(versions) > 30:
            selected_version = next((item for item in versions if item.is_selected), None)
            tail_versions = versions[-30:]
            if selected_version and all(item.id != selected_version.id for item in tail_versions):
                versions = [selected_version, *tail_versions[-29:]]
            else:
                versions = tail_versions
        version_payloads: list[dict[str, object]] = []
        for version in versions:
            image_url = str(version.image_url or "").strip()
            if image_url.startswith("data:image"):
                try:
                    image_url = await download_image_as_local_file(
                        image_url, filename_base=f"{asset.id}_{version.id}"
                    )
                    if image_url != version.image_url:
                        version.image_url = image_url
                        has_version_url_updated = True
                except Exception as convert_exc:
                    logger.warning(
                        f"Failed to convert base64 version image for asset={asset.id}, version={version.id}: {convert_exc}"
                    )
                    image_url = ""

            if media_storage.cos_enabled() and image_url:
                try:
                    if image_url.startswith("/static/"):
                        rel = image_url.replace("/static/", "", 1).lstrip("/")
                        abs_img = os.path.join(media_storage.backend_static_dir(), rel)
                        if os.path.isfile(abs_img):
                            cos_url = await media_storage.publish_local_file_under_static(project_id, abs_img)
                            if cos_url and cos_url != image_url:
                                image_url = cos_url
                                version.image_url = cos_url
                                has_version_url_updated = True
                    elif image_url.startswith(("http://", "https://")) and "myqcloud.com" not in image_url:
                        mirrored = await media_storage.mirror_http_url_to_cos(project_id, "assets", image_url)
                        if mirrored and mirrored != image_url:
                            image_url = mirrored
                            version.image_url = mirrored
                            has_version_url_updated = True
                except Exception as cos_exc:
                    logger.warning(
                        f"Failed to migrate asset image to COS for asset={asset.id}, version={version.id}: {cos_exc}"
                    )
            elif image_url.startswith(("http://", "https://")) and "/static/" not in image_url:
                # 未启用 COS 时，保留原有兜底：将远程图落到本地 static，避免图床防盗链。
                try:
                    localized_url = await download_image_as_local_file(
                        image_url, filename_base=f"{asset.id}_{version.id}"
                    )
                    if localized_url and localized_url != image_url:
                        image_url = localized_url
                        version.image_url = localized_url
                        has_version_url_updated = True
                except Exception as localize_exc:
                    logger.warning(
                        f"Failed to localize remote version image for asset={asset.id}, version={version.id}: {localize_exc}"
                    )

            if (
                image_url.startswith(("http://", "https://"))
                and "myqcloud.com" not in image_url
                and "openpt.wuyinkeji.com" in image_url
            ):
                fallback_cos_url = next(
                    (
                        str(item.image_url or "").strip()
                        for item in versions
                        if str(item.id) != str(version.id)
                        and "myqcloud.com" in str(item.image_url or "")
                    ),
                    "",
                )
                if fallback_cos_url:
                    image_url = fallback_cos_url
                    version.image_url = fallback_cos_url
                    has_version_url_updated = True

            version_payloads.append(
                {
                    "id": version.id,
                    "image_url": image_url,
                    "prompt": version.prompt,
                    "is_selected": version.is_selected,
                }
            )
        response_name = asset.name
        response_description = asset.description
        if asset.type == "CHARACTER_LOOK":
            role_name = _resolve_role_name_from_look(str(asset.name or ""), character_names)
            normalized_name, normalized_desc = _normalize_character_look_payload(
                role_name,
                str(asset.name or ""),
                str(asset.description or ""),
            )
            normalized_desc = _sanitize_step2_metadata(normalized_desc)
            response_name = normalized_name
            response_description = normalized_desc
            if normalized_name != (asset.name or "") or normalized_desc != (asset.description or ""):
                asset.name = normalized_name
                asset.description = normalized_desc
                has_asset_meta_updated = True

        responses.append(
            AssetResponse(
                id=asset.id,
                type=asset.type,
                name=response_name,
                description=response_description,
                prompt=asset.prompt,
                model=asset.model,
                size=asset.size,
                style=asset.style,
                versions=version_payloads,
                created_at=asset.created_at,
            )
        )
    if has_version_url_updated or has_asset_meta_updated:
        await db.commit()
    return responses


@router.get("/{project_id}/assets/{asset_id}/image")
async def get_asset_image(
    project_id: str,
    asset_id: str,
    db: AsyncSession = Depends(get_db),
):
    """
    Get the image for an asset.
    Prioritizes selected version, then latest version.
    Returns the image data (if base64) or redirect (if URL).
    """
    # 1. Check if asset belongs to project (security check)
    stmt = select(Asset).where(Asset.id == asset_id, Asset.project_id == project_id)
    result = await db.execute(stmt)
    asset = result.scalar_one_or_none()
    if not asset:
        return Response(content=b"", status_code=404)

    # 2. Find selected version
    stmt = select(AssetVersion).where(
        AssetVersion.asset_id == asset_id, 
        AssetVersion.is_selected == True
    ).order_by(AssetVersion.created_at.desc()).limit(1)
    result = await db.execute(stmt)
    version = result.scalar_one_or_none()
    
    selected_image_url = (str(version.image_url).strip() if version and version.image_url else "")

    # 3. If selected has no image, fallback to latest version with image
    if not version or not selected_image_url:
        stmt = select(AssetVersion).where(
            AssetVersion.asset_id == asset_id,
            AssetVersion.image_url.isnot(None),
            AssetVersion.image_url != "",
        ).order_by(AssetVersion.created_at.desc()).limit(1)
        result = await db.execute(stmt)
        version = result.scalar_one_or_none()
        
    if not version:
        return Response(content=b"", status_code=404)

    image_url = str(version.image_url or "").strip()
    if not image_url:
        return Response(content=b"", status_code=404)
    
    # 4. Handle Base64
    if image_url.startswith("data:image"):
        try:
            # Format: data:image/png;base64,.....
            header, encoded = image_url.split(",", 1)
            data = base64.b64decode(encoded)
            # Extract content type
            content_type = header.split(":")[1].split(";")[0]
            return Response(content=data, media_type=content_type)
        except Exception as e:
            logger.error(f"Failed to decode base64 image for asset {asset_id}: {e}")
            return Response(content=b"", status_code=500)
            
    # 5. Handle local static path
    if image_url.startswith("/static/"):
        current_dir = os.path.dirname(os.path.abspath(__file__))
        static_root = os.path.join(os.path.dirname(os.path.dirname(current_dir)), "static")
        relative_path = image_url[len("/static/"):]
        file_path = os.path.join(static_root, relative_path)
        if not os.path.exists(file_path):
            return Response(content=b"", status_code=404)
        media_type = mimetypes.guess_type(file_path)[0] or "application/octet-stream"
        return FileResponse(file_path, media_type=media_type)

    # 6. Handle URL (redirect)
    return RedirectResponse(url=image_url)


@router.put("/{project_id}/assets/{asset_id}", response_model=AssetResponse)
async def update_asset(
    project_id: str,
    asset_id: str,
    payload: AssetUpdateRequest,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
) -> AssetResponse:
    project = await get_project(db, user_id, project_id)
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
        
    updated_asset = await update_asset_config(
        db, 
        asset_id, 
        prompt=payload.prompt,
        model=payload.model,
        size=payload.size,
        style=payload.style
    )
    
    if not updated_asset:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="素材不存在")
        
    versions = await list_asset_versions(db, updated_asset.id)
    return AssetResponse(
        id=updated_asset.id,
        type=updated_asset.type,
        name=updated_asset.name,
        description=updated_asset.description,
        prompt=updated_asset.prompt,
        model=updated_asset.model,
        size=updated_asset.size,
        style=updated_asset.style,
        versions=[
            {
                "id": version.id,
                "image_url": version.image_url,
                "prompt": version.prompt,
                "is_selected": version.is_selected,
            }
            for version in versions
        ],
    )


async def _generate_asset_sync(
    project_id: str,
    asset_id: str,
    payload: AssetGenerateRequest,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
) -> StatusResponse:
    payload_snapshot = payload.model_dump() if hasattr(payload, "model_dump") else payload.dict()
    project = await get_project(db, user_id, project_id)
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    asset = await get_asset(db, asset_id)
    if not asset or asset.project_id != project_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="素材不存在")
    if payload.prompt:
        prompt = payload.prompt
    else:
        prompt = f"{asset.type}:{asset.name}"
        if asset.description:
            prompt = f"{prompt}，{asset.description}"
    
    request_payload = payload.options.copy() if payload.options else {}
    # 透传前端 model，由 linkapi.create_image 映射为 GRSAI draw 文档中的合法 model
    request_payload["model"] = (payload.model or "").strip() or OPENROUTER_IMAGE_MODEL
    request_payload.setdefault("size", "4K")
    request_payload.setdefault("aspect_ratio", "16:9")
    
    # Resolve reference image and construct prompt
    ref_image_url = payload.ref_image_url
    if ref_image_url:
        logger.info(f"Asset Generation with Ref Image: {ref_image_url}")
    else:
        logger.info("Asset Generation: No Ref Image")

    async def _resolve_remote_reference_url(candidate_url: str) -> str:
        raw = str(candidate_url or "").strip()
        if not raw:
            return ""

        async def _publish_local_like_to_cos(url_text: str) -> str:
            if not media_storage.cos_enabled():
                return ""
            normalized = str(url_text or "").strip()
            static_path = ""
            if normalized.startswith("/static/"):
                static_path = normalized
            elif normalized.startswith(("http://", "https://")) and "/static/" in normalized:
                static_path = normalized[normalized.find("/static/") :]
            elif normalized.startswith("data:image"):
                try:
                    localized = await download_image_as_local_file(
                        normalized,
                        filename_base=f"{asset.id}_{uuid.uuid4().hex[:8]}_ref",
                    )
                    if localized.startswith("/static/"):
                        static_path = localized
                except Exception as exc:
                    logger.warning(f"Failed to persist data ref image before COS publish: {exc}")
                    return ""
            if not static_path.startswith("/static/"):
                return ""
            rel = static_path.replace("/static/", "", 1).lstrip("/")
            abs_img = os.path.join(media_storage.backend_static_dir(), rel)
            if not os.path.isfile(abs_img):
                return ""
            try:
                return await media_storage.publish_local_file_under_static(project_id, abs_img)
            except Exception as exc:
                logger.warning(f"Failed to publish reference image to COS, fallback to original URL: {exc}")
                return ""

        is_local_like = (
            raw.startswith("data:image")
            or raw.startswith("/static/")
            or (
                raw.startswith(("http://", "https://"))
                and "/static/" in raw
                and ("localhost" in raw or "127.0.0.1" in raw or ":8003" in raw)
            )
        )
        if not is_local_like:
            return raw

        cos_ref_url = await _publish_local_like_to_cos(raw)
        if cos_ref_url:
            return cos_ref_url

        versions = await list_asset_versions(db, asset.id)
        selected_remote = ""
        latest_remote = ""
        for version in versions:
            version_url = str(version.image_url or "").strip()
            if not version_url.startswith(("http://", "https://")):
                continue
            if "/static/" in version_url and (
                "localhost" in version_url or "127.0.0.1" in version_url or ":8003" in version_url
            ):
                continue
            latest_remote = version_url
            if version.is_selected:
                selected_remote = version_url
        # 无历史纯外链版本时仍返回原地址，由 linkapi.create_image 内 _resolve_image_url（PUBLIC_BASE_URL 等）解析
        return selected_remote or latest_remote or raw

    # --- Style resolution ---
    style_prompts = _get_style_prompts()
    # Default to "真人电影写实" if style is not provided or not found
    selected_style_name = payload.style or "真人电影写实"
    logger.info(f"Asset Generation: Asset={asset.name} ({asset.type}), Style={selected_style_name}, PayloadStyle={payload.style}")
    
    selected_style = next((p for p in style_prompts if p["style"] == selected_style_name), None)
    if not selected_style and style_prompts:
        logger.warning(f"Style '{selected_style_name}' not found in prompts. Defaulting to first style.")
        selected_style = style_prompts[0]
        
    style_system_prompt = ""
    if selected_style:
        if asset.type in ["CHARACTER", "CHARACTER_LOOK"]:
            style_system_prompt = selected_style.get("character_prompt", "")
        elif asset.type == "PROP":
            style_system_prompt = selected_style.get("prop_prompt", "")
        elif asset.type == "SCENE":
            style_system_prompt = selected_style.get("scene_front_view", "")
    
    logger.info(f"Selected Style Prompt: {style_system_prompt[:50]}...")
    
    # Special handling for CHARACTER_LOOK prompt and reference
    if asset.type == "CHARACTER_LOOK":
        role_name = _extract_role_name_from_look(asset.name)
        character_result = await db.execute(
            select(Asset).where(
                Asset.project_id == project_id,
                Asset.type == "CHARACTER",
            )
        )
        character_assets = list(character_result.scalars().all())
        matched = [item for item in character_assets if item.name == role_name]
        if not matched:
            prefix_matched = [
                item
                for item in character_assets
                if any(
                    asset.name.startswith(f"{item.name}{sep}")
                    for sep in ["·", "：", ":", "-", "—", "｜", "|"]
                )
            ]
            if prefix_matched:
                max_len = max(len(item.name) for item in prefix_matched)
                matched = [item for item in prefix_matched if len(item.name) == max_len]

        base_assets = []
        if matched:
            base_name = matched[0].name
            base_assets = [item for item in character_assets if item.name == base_name]

        if not ref_image_url and base_assets:
            selected_url = ""
            for base_asset in base_assets:
                base_versions = await list_asset_versions(db, base_asset.id)
                if not base_versions:
                    continue
                selected = next(
                    (item for item in base_versions if item.is_selected and item.image_url),
                    None,
                )
                if selected:
                    selected_url = selected.image_url
                    break
            ref_image_url = selected_url

        base_desc = next((item.description for item in base_assets if item.description), "")
        if not ref_image_url:
            logger.warning(f"No reference image found for role: {role_name}")
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"未找到角色参考图：{role_name}，请先在对应角色素材中选中参考图",
            )

    if ref_image_url:
        resolved_ref = await _resolve_remote_reference_url(ref_image_url)
        if not resolved_ref:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="参考图地址无效，请重新选择参考图或上传图片。",
            )
        if resolved_ref != ref_image_url:
            logger.warning(f"Reference image switched to remote URL for edit: {resolved_ref}")
        ref_image_url = resolved_ref
        if asset.type == "CHARACTER_LOOK":
            logger.info(f"Found reference image for {role_name}: {ref_image_url}")

    if asset.type == "CHARACTER_LOOK":
        if not payload.prompt:
            look_desc = asset.description or ""
            parts = [
                style_system_prompt,
                "在同一角色基础上生成新的形象。",
                f"角色描述：{base_desc}" if base_desc else "",
                f"形象要求：{look_desc}" if look_desc else "",
            ]
            prompt = " ".join(part for part in parts if part)
        else:
            prompt = f"{style_system_prompt}, {payload.prompt}"

    # Special handling for CHARACTER prompt suffix
    elif asset.type == "CHARACTER":
        if not payload.prompt:
            prompt = f"{style_system_prompt}, {asset.name}, {asset.description or ''}"
        else:
            prompt = f"{style_system_prompt}, {payload.prompt}"

    elif asset.type == "PROP":
        if not payload.prompt:
            prompt = f"{style_system_prompt}, {asset.name}, {asset.description or ''}"
        else:
            prompt = f"{style_system_prompt}, {payload.prompt}"
            
    elif asset.type == "SCENE":
        if not payload.prompt:
            prompt = f"{style_system_prompt}, {asset.name}, {asset.description or ''}"
        else:
            prompt = f"{style_system_prompt}, {payload.prompt}"

    # Sanitize prompt to remove potential control characters
    if prompt:
        import re
        # Remove C0 control characters (00-1F, except tabs/newlines which are handled by split), DEL (7F)
        # Also remove common invisible formatting characters:
        # \u200b (Zero Width Space), \u200c (ZWNJ), \u200d (ZWJ), \u200e (LRM), \u200f (RLM), \ufeff (BOM)
        # \xa0 (NBSP) is handled by split() as whitespace in Python 3
        prompt = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u200b\u200c\u200d\u200e\u200f\ufeff]', '', prompt)
        # Normalize whitespace (handles \n, \t, \r, \xa0, etc.)
        prompt = " ".join(prompt.split())

    # Limit prompt length to 800 characters to prevent API errors
    if len(prompt) > 800:
        logger.warning(f"Prompt truncated from {len(prompt)} to 800 chars")
        prompt = prompt[:800]

    request_payload["prompt"] = prompt

    logger.info(
        "Generating image with model=%s, aspect_ratio=%s, prompt_len=%s",
        request_payload.get("model"),
        request_payload.get("aspect_ratio"),
        len(prompt),
    )
    logger.info(f"Request Payload Keys: {list(request_payload.keys())}")
    
    try:
        if ref_image_url:
            image_payload = request_payload.copy()
            image_payload["image_url"] = ref_image_url
            
            try:
                result = await create_image_edit(
                    db,
                    user_id,
                    ref_image_url,
                    image_payload,
                )
            except asyncio.CancelledError:
                logger.warning("素材生成请求中断，转后台继续：asset_id=%s", asset_id)
                asyncio.create_task(
                    _continue_asset_generation_after_disconnect(
                        project_id,
                        asset_id,
                        payload_snapshot,
                        user_id,
                    )
                )
                raise
            except Exception as edit_exc:
                logger.error(f"create_image_edit failed: {edit_exc}", exc_info=True)
                raise ValueError(f"AI修改生成失败：{edit_exc}") from edit_exc
        else:
            if asset.type == "CHARACTER_LOOK":
                 pass

            try:
                result = await create_image(
                    db,
                    user_id,
                    request_payload,
                )
            except asyncio.CancelledError:
                logger.warning("素材生成请求中断，转后台继续：asset_id=%s", asset_id)
                asyncio.create_task(
                    _continue_asset_generation_after_disconnect(
                        project_id,
                        asset_id,
                        payload_snapshot,
                        user_id,
                    )
                )
                raise
            except Exception as create_exc:
                raise create_exc
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        detail = str(exc).strip()
        logger.error(f"Asset generation failed: {exc}", exc_info=True)
        # Pass the detailed error message to the frontend
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=detail if detail else "生成失败",
        ) from exc
    
    image_url = ""

    if isinstance(result, dict):
        if "error" in result:
            error = result["error"]
            msg = error.get("message") if isinstance(error, dict) else str(error)
            code = error.get("code") if isinstance(error, dict) else ""
            code_lower = str(code).lower()

            logger.error(f"Volcengine API returned error: {msg} (Code: {code})")

            is_sensitive_error = (
                "sensitivecontent" in code_lower
                or "sensitive_content" in code_lower
                or "safety" in code_lower
                or "risk" in code_lower
                or "输入图片包含敏感内容" in msg
            )
            detail_msg = f"生成失败: {msg}" if msg else "生成失败"
            if is_sensitive_error:
                detail_msg = "输入图片包含敏感内容，请更换图片重试。"
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=detail_msg)
             
        data = result.get("data") or []
        if data:
            first = data[0]
            image_url = first.get("url") or ""
            if not image_url and first.get("b64_json"):
                image_url = f"data:image/png;base64,{first.get('b64_json')}"
    
    if isinstance(image_url, dict):
        image_url = image_url.get("url") or image_url.get("image_url") or ""
    if not image_url:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="生成失败")

    # Download image to local static file
    # Use asset_id + random suffix as filename base to ensure uniqueness and preserve history
    # This satisfies "name by ID" (ID is part of filename) while allowing versioning
    filename_base = f"{asset_id}_{uuid.uuid4().hex[:8]}"
    image_url_text = str(image_url or "").strip()
    version_image_url = image_url_text
    if image_url_text.startswith(("http://", "https://")):
        try:
            # 优先落本地静态文件，避免第三方图床防盗链导致前端白图/无法预览
            version_image_url = await download_image_as_local_file(image_url_text, filename_base=filename_base)
        except Exception as exc:
            logger.warning(f"Image download skipped, keep remote URL for version: {exc}")
    else:
        try:
            version_image_url = await download_image_as_local_file(image_url_text, filename_base=filename_base)
        except Exception as exc:
            logger.error(f"Image download failed after generation: {exc}", exc_info=True)
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=f"图片下载失败，请重试: {exc}",
            ) from exc
    if media_storage.cos_enabled():
        try:
            if version_image_url.startswith("/static/"):
                rel = version_image_url.replace("/static/", "", 1).lstrip("/")
                abs_img = os.path.join(media_storage.backend_static_dir(), rel)
                version_image_url = await media_storage.publish_local_file_under_static(project_id, abs_img)
            elif version_image_url.startswith(("http://", "https://")):
                version_image_url = await media_storage.mirror_http_url_to_cos(
                    project_id, "assets", version_image_url
                )
        except Exception as exc:
            # 镜像/发布失败不应让整次生成报错，保留原始可访问 URL 继续落库
            logger.warning(f"COS mirror/publish skipped, keep original image URL: {exc}")
    await create_asset_version(db, asset_id, version_image_url, prompt)
    
    return StatusResponse(status="ready")


async def _run_asset_generate_task(task_id: str) -> None:
    async with SessionLocal() as db:
        task = await get_async_task(db, task_id=task_id)
        if not task:
            return
        try:
            await mark_async_task_running(db, task)
            payload_data = json.loads(task.payload_json or "{}") if task.payload_json else {}
            project_id = str(task.project_id)
            user_id = str(task.user_id)
            asset_id = str(payload_data.get("asset_id") or "")
            req_payload = AssetGenerateRequest(**(payload_data.get("payload") or {}))
            await _generate_asset_sync(project_id, asset_id, req_payload, user_id, db)
            await mark_async_task_completed(
                db,
                task,
                {
                    "asset_id": asset_id,
                },
            )
        except Exception as exc:
            await mark_async_task_failed(db, task, str(exc))


@router.post("/{project_id}/assets/{asset_id}/generate", response_model=AsyncTaskStatusResponse)
async def generate_asset(
    project_id: str,
    asset_id: str,
    payload: AssetGenerateRequest,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
) -> AsyncTaskStatusResponse:
    project = await get_project(db, user_id, project_id)
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    asset = await get_asset(db, asset_id)
    if not asset or asset.project_id != project_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="素材不存在")
    task = await create_async_task(
        db,
        project_id=project_id,
        user_id=user_id,
        task_type=_ASSET_GENERATE_TASK_TYPE,
        payload={
            "asset_id": asset_id,
            "payload": payload.model_dump() if hasattr(payload, "model_dump") else payload.dict(),
        },
    )
    asyncio.create_task(_run_asset_generate_task(task.id))
    return AsyncTaskStatusResponse(
        task_id=task.id,
        project_id=project_id,
        task_type=_ASSET_GENERATE_TASK_TYPE,
        status="RUNNING",
        result=None,
        error=None,
    )


@router.get("/{project_id}/assets/generate-tasks/{task_id}", response_model=AsyncTaskStatusResponse)
async def get_asset_generate_task_status(
    project_id: str,
    task_id: str,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
) -> AsyncTaskStatusResponse:
    project = await get_project(db, user_id, project_id)
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    task = await get_async_task(
        db,
        task_id=task_id,
        project_id=project_id,
        user_id=user_id,
        task_type=_ASSET_GENERATE_TASK_TYPE,
    )
    if not task:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="任务不存在")
    return AsyncTaskStatusResponse(
        task_id=task.id,
        project_id=project_id,
        task_type=task.task_type,
        status=str(task.status or "PENDING").upper(),
        result=parse_task_result(task),
        error=(str(task.error or "").strip() or None),
    )


@router.post("/{project_id}/assets/{asset_id}/upload", response_model=StatusResponse)
async def upload_asset_image(
    project_id: str,
    asset_id: str,
    file: UploadFile = File(...),
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
) -> StatusResponse:
    project = await get_project(db, user_id, project_id)
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    asset = await get_asset(db, asset_id)
    if not asset or asset.project_id != project_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="素材不存在")
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="仅支持图片文件")
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="上传文件为空")
    if len(raw) > 15 * 1024 * 1024:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="图片大小不能超过15MB")
    ext_map = {
        "image/jpeg": ".jpg",
        "image/jpg": ".jpg",
        "image/png": ".png",
        "image/webp": ".webp",
        "image/gif": ".gif",
        "image/bmp": ".bmp",
    }
    ext = ext_map.get((file.content_type or "").lower(), "")
    if not ext and file.filename and "." in file.filename:
        ext = os.path.splitext(file.filename)[1].lower()
    if ext not in {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"}:
        ext = ".png"
    current_dir = os.path.dirname(os.path.abspath(__file__))
    static_dir = os.path.join(os.path.dirname(os.path.dirname(current_dir)), "static", "assets")
    os.makedirs(static_dir, exist_ok=True)
    filename = f"{asset_id}_{uuid.uuid4().hex[:8]}{ext}"
    filepath = os.path.join(static_dir, filename)
    with open(filepath, "wb") as out:
        out.write(raw)
    upload_url = f"/static/assets/{filename}"
    if media_storage.cos_enabled():
        upload_url = await media_storage.publish_local_file_under_static(project_id, filepath)
    await create_asset_version(db, asset_id, upload_url, f"upload:{file.filename or ''}")
    await file.close()
    return StatusResponse(status="ready")


class GenerateSubjectResponse(StatusResponse):
    subject_id: str


class GenerateSubjectRequest(BaseModel):
    allow_without_voice: bool = False


@router.post("/{project_id}/assets/{asset_id}/generate-subject", response_model=GenerateSubjectResponse)
async def generate_asset_subject(
    project_id: str,
    asset_id: str,
    payload: GenerateSubjectRequest | None = None,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
) -> GenerateSubjectResponse:
    project = await get_project(db, user_id, project_id)
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")

    asset = await get_asset(db, asset_id)
    if not asset or asset.project_id != project_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="素材不存在")
    if str(asset.type or "").upper() != "CHARACTER_LOOK":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="仅角色形象支持生成主体")

    versions = await list_asset_versions(db, asset.id)
    selected_version = next(
        (item for item in versions if bool(item.is_selected) and str(item.image_url or "").strip()),
        None,
    )
    if not selected_version:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="请先选中角色形象图片，再生成主体")
    raw_image_url = str(selected_version.image_url or "").strip()
    if not raw_image_url:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="角色形象图片地址无效，请重新选择")

    image_url = ""
    if media_storage.cos_enabled():
        try:
            if raw_image_url.startswith("data:image"):
                localized = await download_image_as_local_file(
                    raw_image_url,
                    filename_base=f"{asset.id}_{uuid.uuid4().hex[:8]}_subject",
                )
                raw_image_url = localized
            if raw_image_url.startswith("/static/"):
                rel = raw_image_url.replace("/static/", "", 1).lstrip("/")
                abs_img = os.path.join(media_storage.backend_static_dir(), rel)
                image_url = await media_storage.publish_local_file_under_static(project_id, abs_img)
            elif raw_image_url.startswith(("http://", "https://")):
                if "myqcloud.com" in raw_image_url:
                    image_url = raw_image_url
                else:
                    image_url = await media_storage.mirror_http_url_to_cos(project_id, "assets", raw_image_url)
        except Exception as exc:
            logger.warning(f"主体参考图自动发布 COS 失败，回退公共 URL 解析: {exc}")

    if not image_url:
        image_url = str(await _resolve_image_url(raw_image_url)).strip()

    if not image_url.startswith(("http://", "https://")):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="主体参考图未解析为可公网访问 URL，请检查 COS 配置或重选图片",
        )

    if image_url != str(selected_version.image_url or "").strip():
        selected_version.image_url = image_url

    character_rows = await db.execute(
        select(Asset).where(
            Asset.project_id == project_id,
            Asset.type == "CHARACTER",
        )
    )
    character_assets = list(character_rows.scalars().all())
    character_names = [str(item.name or "").strip() for item in character_assets if str(item.name or "").strip()]
    resolved_role_name = _resolve_role_name_from_look(str(asset.name or ""), character_names)

    voice_rows = await db.execute(select(CharacterVoice).where(CharacterVoice.project_id == project_id))
    voices = list(voice_rows.scalars().all())

    matched_voice = None
    compact_role_name = resolved_role_name.replace(" ", "")
    for voice in voices:
        voice_name = str(voice.character_name or "").strip()
        if not voice_name:
            continue
        if voice_name == resolved_role_name:
            matched_voice = voice
            break
        if _normalize_role_key(voice_name) == _normalize_role_key(resolved_role_name):
            matched_voice = voice
            break
        compact_voice_name = voice_name.replace(" ", "")
        compact_voice_role = _normalize_role_key(voice_name).replace(" ", "")
        if compact_voice_name and compact_role_name.startswith(compact_voice_name):
            matched_voice = voice
            break
        if compact_voice_role and compact_role_name.startswith(compact_voice_role):
            matched_voice = voice
            break

    if not matched_voice or not str(matched_voice.voice_id or "").strip():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"请先为角色“{resolved_role_name or str(asset.name or '')}”上传音频并创建 Kling 音色，再生成主体",
        )
    if str(matched_voice.voice_type or "").strip().upper() != "KLING_CUSTOM":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"角色“{resolved_role_name or str(asset.name or '')}”尚未完成 Kling 自定义音色创建，请先在 Step3 上传角色音频",
        )

    kling_jwt, _kling_key_source = await resolve_kling_auth_token(db, user_id)
    if not kling_jwt:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="系统未配置 Kling 鉴权 Key，请联系管理员配置",
        )

    allow_without_voice = bool(payload.allow_without_voice) if payload else False
    subject_item = {
        "asset_id": str(asset.id),
        "role": "character",
        "name": str(asset.name or "").strip(),
        "description": str(asset.description or "").strip(),
        "image_url": image_url,
        "voice_id": "" if allow_without_voice else str(matched_voice.voice_id or "").strip(),
    }
    async with httpx.AsyncClient(timeout=120.0, trust_env=True) as client:
        subject_id = await _get_or_create_character_subject_id(
            db,
            client,
            kling_jwt,
            project_id,
            subject_item,
            force_create=True,
            allow_voice_fallback=False,
        )

    if not subject_id and not allow_without_voice:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "VOICE_BIND_OPTIONAL_CONFIRM",
                "message": "当前角色图未通过“音色绑定主体”检测。你可以继续生成“不绑定音色”的主体（成功率更高），或先更换更清晰的角色图后再试。",
            },
        )
    if not subject_id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="不绑定音色生成主体仍失败，请更换更清晰的角色图后重试")

    await db.commit()
    return GenerateSubjectResponse(status="ready", subject_id=subject_id)


@router.put("/{project_id}/assets/{asset_id}/select", response_model=StatusResponse)
async def select_asset(
    project_id: str,
    asset_id: str,
    payload: AssetSelectRequest,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
) -> StatusResponse:
    project = await get_project(db, user_id, project_id)
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    await select_asset_version(db, asset_id, payload.version_id, project_id=project_id)
    return StatusResponse(status="ready")


@router.delete(
    "/{project_id}/assets/{asset_id}/versions/{version_id}",
    response_model=StatusResponse,
)
async def delete_asset_version_route(
    project_id: str,
    asset_id: str,
    version_id: str,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
) -> StatusResponse:
    project = await get_project(db, user_id, project_id)
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    asset = await get_asset(db, asset_id)
    if not asset or asset.project_id != project_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="素材不存在")
    deleted = await delete_asset_version(db, asset_id, version_id)
    if not deleted:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="版本不存在")
    return StatusResponse(status="ready")
