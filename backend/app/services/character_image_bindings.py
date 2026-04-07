from __future__ import annotations

from datetime import datetime
import logging

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.asset import Asset
from app.models.asset_version import AssetVersion
from app.models.character_image_binding import CharacterImageBinding

logger = logging.getLogger(__name__)


def normalize_base_character_name(name: str) -> str:
    value = str(name or "").strip()
    for sep in ["·", "：", ":", "-", "—", "｜", "|"]:
        if sep in value:
            left = value.split(sep, 1)[0].strip()
            if left:
                return left
    return value


def extract_role_name_from_look(look_name: str) -> str:
    return normalize_base_character_name(look_name)


def derive_base_character_name_from_asset(asset_type: str, asset_name: str) -> str:
    normalized_type = str(asset_type or "").strip().upper()
    normalized_name = str(asset_name or "").strip()
    if normalized_type == "CHARACTER":
        return normalize_base_character_name(normalized_name.strip("*"))
    if normalized_type == "CHARACTER_LOOK":
        return extract_role_name_from_look(normalized_name)
    return ""


async def list_character_image_bindings_by_urls(
    session: AsyncSession,
    project_id: str,
    image_urls: list[str],
) -> dict[str, CharacterImageBinding]:
    normalized_urls = [str(item or "").strip() for item in image_urls if str(item or "").strip()]
    if not normalized_urls:
        return {}
    result = await session.execute(
        select(CharacterImageBinding).where(
            CharacterImageBinding.project_id == project_id,
            CharacterImageBinding.image_url.in_(list(dict.fromkeys(normalized_urls))),
        )
    )
    rows = list(result.scalars().all())
    return {str(row.image_url or "").strip(): row for row in rows if str(row.image_url or "").strip()}


async def resolve_image_bound_base_character_name(
    session: AsyncSession,
    project_id: str,
    image_url: str,
    *,
    asset_id: str = "",
    asset_type: str = "",
    asset_name: str = "",
) -> str:
    normalized_image_url = str(image_url or "").strip()
    if not normalized_image_url:
        return ""

    binding = await session.scalar(
        select(CharacterImageBinding).where(
            CharacterImageBinding.project_id == project_id,
            CharacterImageBinding.image_url == normalized_image_url,
        )
    )
    if binding and str(binding.base_character_name or "").strip():
        return normalize_base_character_name(str(binding.base_character_name or ""))

    normalized_asset_id = str(asset_id or "").strip()
    if normalized_asset_id:
        asset = await session.scalar(
            select(Asset).where(Asset.project_id == project_id, Asset.id == normalized_asset_id)
        )
        if asset:
            derived = derive_base_character_name_from_asset(str(asset.type or ""), str(asset.name or ""))
            if derived:
                return derived

    derived_from_fields = derive_base_character_name_from_asset(asset_type, asset_name)
    if derived_from_fields:
        return derived_from_fields

    version_rows = await session.execute(
        select(AssetVersion, Asset)
        .join(Asset, Asset.id == AssetVersion.asset_id)
        .where(
            Asset.project_id == project_id,
            AssetVersion.image_url == normalized_image_url,
        )
        .order_by(AssetVersion.is_selected.desc(), AssetVersion.created_at.desc())
    )
    for version, asset in version_rows.all():
        del version
        derived = derive_base_character_name_from_asset(str(asset.type or ""), str(asset.name or ""))
        if derived:
            return derived
    return ""


async def infer_base_character_name_from_references(
    session: AsyncSession,
    project_id: str,
    reference_image_urls: list[str],
) -> str:
    ordered_candidates: list[str] = []
    for image_url in reference_image_urls:
        candidate = await resolve_image_bound_base_character_name(session, project_id, image_url)
        normalized_candidate = normalize_base_character_name(candidate)
        if normalized_candidate and normalized_candidate not in ordered_candidates:
            ordered_candidates.append(normalized_candidate)
    if len(ordered_candidates) > 1:
        logger.warning(
            "Detected multiple base character bindings for one generated role image. project_id=%s candidates=%s",
            project_id,
            ordered_candidates,
        )
    return ordered_candidates[0] if ordered_candidates else ""


async def upsert_character_image_binding(
    session: AsyncSession,
    project_id: str,
    image_url: str,
    base_character_name: str,
    *,
    asset_id: str = "",
    source_image_url: str = "",
) -> CharacterImageBinding | None:
    normalized_image_url = str(image_url or "").strip()
    normalized_base_character_name = normalize_base_character_name(base_character_name)
    if not normalized_image_url or not normalized_base_character_name:
        return None

    binding = await session.scalar(
        select(CharacterImageBinding).where(
            CharacterImageBinding.project_id == project_id,
            CharacterImageBinding.image_url == normalized_image_url,
        )
    )
    normalized_asset_id = str(asset_id or "").strip() or None
    normalized_source_image_url = str(source_image_url or "").strip() or None
    if binding:
        binding.base_character_name = normalized_base_character_name
        if normalized_asset_id:
            binding.asset_id = normalized_asset_id
        if normalized_source_image_url:
            binding.source_image_url = normalized_source_image_url
        binding.updated_at = datetime.utcnow()
    else:
        binding = CharacterImageBinding(
            project_id=project_id,
            image_url=normalized_image_url,
            base_character_name=normalized_base_character_name,
            asset_id=normalized_asset_id,
            source_image_url=normalized_source_image_url,
        )
        session.add(binding)
    await session.flush()
    return binding
