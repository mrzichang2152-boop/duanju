from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user_id
from app.core.db import get_db
from app.schemas.assets import AssetGenerateRequest, AssetResponse, AssetSelectRequest
from app.schemas.common import StatusResponse
from app.services.projects import get_project
from app.models.asset import Asset
from app.services.assets import (
    create_asset_version,
    extract_assets_from_script,
    get_asset,
    list_assets,
    list_asset_versions,
    delete_asset_version,
    select_asset_version,
)
from app.services.linkapi import create_image, create_image_edit, create_image_with_reference
from app.services.settings import get_or_create_settings

router = APIRouter()


@router.post("/{project_id}/assets/extract", response_model=StatusResponse)
async def extract_assets(
    project_id: str,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
) -> StatusResponse:
    project = await get_project(db, user_id, project_id)
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    await extract_assets_from_script(db, project_id, user_id)
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
        )
    return responses


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
    if not model or "gpt" in model or "dall-e" in model or "gemini" in model:
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
    elif asset.type in {"CHARACTER", "CHARACTER_LOOK"}:
        default_size = "1024x1536"
    elif asset.type == "SCENE":
        default_size = "1536x1024"
    else:
        default_size = "1024x1024"
            
    request_payload.setdefault("size", default_size)
    try:
        if payload.ref_image_url:
            request_payload["prompt"] = prompt
            image_payload = request_payload.copy()
            image_payload.pop("size", None)
            try:
                result = await create_image_edit(
                    db,
                    user_id,
                    payload.ref_image_url,
                    image_payload,
                )
            except Exception as edit_exc:
                try:
                    result = await create_image_with_reference(
                        db,
                        user_id,
                        payload.ref_image_url,
                        image_payload,
                    )
                except Exception as gen_exc:
                    try:
                        url_payload = request_payload.copy()
                        url_payload["image_url"] = payload.ref_image_url
                        result = await create_image(
                            db,
                            user_id,
                            url_payload,
                        )
                    except Exception as url_exc:
                        try:
                            url_payload_no_size = url_payload.copy()
                            url_payload_no_size.pop("size", None)
                            result = await create_image(
                                db,
                                user_id,
                                url_payload_no_size,
                            )
                        except Exception as url_size_exc:
                            raise ValueError(
                                "AI修改生成失败："
                                f"{edit_exc}；参考图生成失败：{gen_exc}；"
                                f"图片URL生成失败：{url_exc}；"
                                f"去掉尺寸后仍失败：{url_size_exc}"
                            ) from url_size_exc
        elif asset.type == "CHARACTER_LOOK":
            base_role = asset.name.split("·", 1)[0].strip()
            base_asset = await db.scalar(
                select(Asset).where(
                    Asset.project_id == project_id,
                    Asset.type == "CHARACTER",
                    Asset.name == base_role,
                )
            )
            if not base_asset:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="未找到角色基础形象")
            base_versions = await list_asset_versions(db, base_asset.id)
            if not base_versions:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="请先生成角色基础形象")
            selected = next((item for item in base_versions if item.is_selected), None)
            if not selected:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="请先在角色中选择模板")
            base_image_url = selected.image_url
            if not request_payload.get("prompt"):
                look_desc = asset.description or ""
                base_desc = base_asset.description or ""
                prompt = " ".join(
                    part
                    for part in [
                        "在同一角色基础上生成新的形象。",
                        f"角色描述：{base_desc}" if base_desc else "",
                        f"形象要求：{look_desc}" if look_desc else "",
                        "(character sheet, three views, front view, side view, back view:1.5), (full body shot:1.5), (detailed skin texture:1.3), (skin pores:1.1), glowing skin, accentuate body figure, white background, standing, 三视图, 正视图, 侧视图, 背视图, 全身图片, 皮肤细节, 突出身材",
                    ]
                    if part
                )
            request_payload["prompt"] = prompt
            image_payload = request_payload.copy()
            image_payload.pop("size", None)
            try:
                result = await create_image_edit(
                    db,
                    user_id,
                    base_image_url,
                    image_payload,
                )
            except Exception as edit_exc:
                try:
                    result = await create_image_with_reference(
                        db,
                        user_id,
                        base_image_url,
                        image_payload,
                    )
                except Exception as gen_exc:
                    try:
                        url_payload = request_payload.copy()
                        url_payload["image_url"] = base_image_url
                        result = await create_image(
                            db,
                            user_id,
                            url_payload,
                        )
                    except Exception as url_exc:
                        try:
                            url_payload_no_size = url_payload.copy()
                            url_payload_no_size.pop("size", None)
                            result = await create_image(
                                db,
                                user_id,
                                url_payload_no_size,
                            )
                        except Exception as url_size_exc:
                            raise ValueError(
                                "角色形象生成失败："
                                f"{edit_exc}；参考图生成失败：{gen_exc}；"
                                f"图片URL生成失败：{url_exc}；"
                                f"去掉尺寸后仍失败：{url_size_exc}"
                            ) from url_size_exc
        else:
            if asset.type == "CHARACTER":
                suffix = ", (character sheet, three views, front view, side view, back view:1.5), (full body shot:1.5), (feet included:1.2), wearing simple clothes, (detailed skin texture:1.3), (skin pores:1.1), glowing skin, white background, standing, 三视图, 正视图, 侧视图, 背视图, 全身图片, 包含脚部, 穿着简单, 皮肤细节"
                if suffix not in prompt:
                    prompt = f"{prompt}{suffix}"
            request_payload["prompt"] = prompt
            try:
                result = await create_image(
                    db,
                    user_id,
                    request_payload,
                )
            except Exception as create_exc:
                if model == "doubao-seedream-4-5-251128":
                     raise create_exc
                try:
                    payload_no_size = request_payload.copy()
                    payload_no_size.pop("size", None)
                    result = await create_image(
                        db,
                        user_id,
                        payload_no_size,
                    )
                except Exception as size_exc:
                    raise ValueError(f"生成失败：{create_exc}；去掉尺寸后仍失败：{size_exc}") from size_exc
    except Exception as exc:
        detail = str(exc).strip()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=detail or "生成失败",
        ) from exc
    image_url: str | dict[str, str] = ""
    if isinstance(result, dict):
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
    await create_asset_version(db, asset_id, image_url, prompt)
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
