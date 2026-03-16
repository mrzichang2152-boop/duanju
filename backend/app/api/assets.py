import json
import os
import logging
import base64
import uuid
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import Response, RedirectResponse

logger = logging.getLogger(__name__)
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user_id
from app.core.db import get_db
from app.schemas.assets import AssetGenerateRequest, AssetResponse, AssetSelectRequest, AssetUpdateRequest
from app.schemas.common import StatusResponse
from app.services.projects import get_project
from app.models.asset import Asset
from app.models.asset_version import AssetVersion
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
)
from app.services.linkapi import create_image, create_image_edit, create_image_with_reference
from app.services.settings import get_or_create_settings

router = APIRouter()


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
        logger.warning(f"Failed to sync assets from script: {e}")

    assets = await list_assets(db, project_id)
    
    responses: list[AssetResponse] = []
    for asset in assets:
        versions = await list_asset_versions(db, asset.id)
        responses.append(
            AssetResponse(
                id=asset.id,
                type=asset.type,
                name=asset.name,
                description=asset.description,
                prompt=asset.prompt,
                model=asset.model,
                size=asset.size,
                style=asset.style,
                versions=[
                    {
                        "id": version.id,
                        "image_url": version.image_url,
                        "prompt": version.prompt,
                        "is_selected": version.is_selected,
                    }
                    for version in versions
                ],
                created_at=asset.created_at,
            )
        )
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
    ).limit(1)
    result = await db.execute(stmt)
    version = result.scalar_one_or_none()
    
    # 3. If no selected, find latest
    if not version:
        stmt = select(AssetVersion).where(
            AssetVersion.asset_id == asset_id
        ).order_by(AssetVersion.created_at.desc()).limit(1)
        result = await db.execute(stmt)
        version = result.scalar_one_or_none()
        
    if not version or not version.image_url:
        return Response(content=b"", status_code=404)
        
    image_url = version.image_url
    
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
            
    # 5. Handle URL (redirect)
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


@router.post("/{project_id}/assets/{asset_id}/generate", response_model=StatusResponse)
async def generate_asset(
    project_id: str,
    asset_id: str,
    payload: AssetGenerateRequest,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
) -> StatusResponse:
    project = await get_project(db, user_id, project_id)
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    asset = await get_asset(db, asset_id)
    if not asset or asset.project_id != project_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="素材不存在")
    settings = await get_or_create_settings(db, user_id)
    if payload.prompt:
        prompt = payload.prompt
    else:
        prompt = f"{asset.type}:{asset.name}"
        if asset.description:
            prompt = f"{prompt}，{asset.description}"
    
    # Default model logic
    model = payload.model or settings.default_model_image
    
    # Force Doubao Seedream for image generation if:
    # 1. No model provided
    # 2. Known text-only models (gpt, dall-e, gemini, doubao-seed-2-0-pro)
    # 3. Model doesn't contain "seedream" but contains "doubao" (likely text model)
    if not model or \
       "gpt" in model or \
       "dall-e" in model or \
       "gemini" in model or \
       ("doubao" in model and "seedream" not in model):
         model = "doubao-seedream-4-5-251128"
         
    request_payload = payload.options.copy() if payload.options else {}
    request_payload["model"] = model
    request_payload.setdefault("n", 1)
    
    # Default size logic
    model_key = (model or "").lower()
    nano_square_only = any(
        key in model_key
        for key in [
            "nanobanana",
            "gemini-2.5-flash-image-preview",
        ]
    )
    if nano_square_only:
        default_size = "1024x1024"
    elif asset.type in {"CHARACTER", "CHARACTER_LOOK", "SCENE", "PROP"}:
        # User requested Landscape (2304x1792) for all these types
        default_size = "2304x1792"
    else:
        default_size = "2048x2048"
            
    request_payload.setdefault("size", default_size)
    
    # Resolve reference image and construct prompt
    ref_image_url = payload.ref_image_url
    if ref_image_url:
        logger.info(f"Asset Generation with Ref Image: {ref_image_url}")
    else:
        logger.info("Asset Generation: No Ref Image")

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
        
        logger.info(f"Found reference image for {role_name}: {ref_image_url}")

        # Construct detailed prompt
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

    logger.info(f"Generating image with model={model}, size={request_payload.get('size')}, prompt_len={len(prompt)}")
    logger.info(f"Request Payload Keys: {list(request_payload.keys())}")
    
    try:
        if ref_image_url:
            # If we have a reference image, use Img2Img or ControlNet flow
            # Ensure we pass the image_url to the payload
            image_payload = request_payload.copy()
            image_payload["image_url"] = ref_image_url

            # Do NOT remove size here.
            # If size is invalid for image-to-image, the model should complain,
            # or we should ensure valid sizes. But removing it forces default size.
            # We trust the user/frontend provided a valid size.
            
            # However, if size IS removed, the model might default to something else (e.g. square).
            # The issue described is "chose portrait (vertical) but got square".
            # This suggests size was being removed or ignored.
            
            # The previous code had: image_payload.pop("size", None)
            # This line REMOVED the size parameter for image-to-image calls.
            # This is likely the cause of the size issue.
            
            try:
                result = await create_image_edit(
                    db,
                    user_id,
                    ref_image_url,
                    image_payload,
                )
            except Exception as edit_exc:
                logger.error(f"create_image_edit failed: {edit_exc}", exc_info=True)
                # If editing fails, do NOT fallback to text-to-image for Character Look.
                # The user expects the reference to be used.
                # We raise the error directly so the user knows something is wrong with the image or API.
                raise ValueError(f"AI修改生成失败：{edit_exc}")
        else:
            # Check if it was CHARACTER_LOOK but we failed to find a reference
            if asset.type == "CHARACTER_LOOK":
                 # Use the detailed prompt but warn/log? 
                 # Or just proceed as Text-to-Image with the detailed description
                 pass

            try:
                result = await create_image(
                    db,
                    user_id,
                    request_payload,
                )
            except Exception as create_exc:
                raise create_exc
    except Exception as exc:
        detail = str(exc).strip()
        logger.error(f"Asset generation failed: {exc}", exc_info=True)
        # Pass the detailed error message to the frontend
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=detail if detail else "生成失败",
        ) from exc
    
    # Process successful result
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
            if ref_image_url and is_sensitive_error:
                fallback_payload = request_payload.copy()
                fallback_prompt = prompt
                if asset.type == "CHARACTER_LOOK":
                    fallback_prompt = f"{prompt} 保持人物身份一致，保持发型与面部特征一致。"
                fallback_payload["prompt"] = fallback_prompt[:800]
                fallback_payload.pop("image", None)
                fallback_payload.pop("image_url", None)
                fallback_payload.pop("image_urls", None)
                try:
                    logger.warning("Image edit blocked by moderation, fallback to text-to-image generation")
                    fallback_result = await create_image(
                        db,
                        user_id,
                        fallback_payload,
                    )
                    result = fallback_result
                except Exception as fallback_exc:
                    logger.error(f"Fallback text-to-image failed: {fallback_exc}", exc_info=True)
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail="参考图触发安全拦截，且兜底生成失败，请稍后重试。",
                    ) from fallback_exc
            else:
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
    local_url = await download_image_as_local_file(image_url, filename_base=filename_base)
    await create_asset_version(db, asset_id, local_url, prompt)
    
    return StatusResponse(status="ready")


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
    await select_asset_version(db, asset_id, payload.version_id)
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
