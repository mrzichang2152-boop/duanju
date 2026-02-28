from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.asset import Asset
from app.models.asset_version import AssetVersion
from app.models.script import Script
from app.services.script_validation import (
    _extract_props,
    _extract_roles,
    _extract_scenes,
    _extract_sections,
    _find_section,
)
import re


def _normalize_role_name(value: str) -> str:
    normalized = re.sub(r"[\\s\\u3000]+", " ", value).strip()
    return normalized


def _normalize_look_label(value: str) -> str:
    normalized = re.sub(r"[\\s\\u3000]+", "", value).strip()
    return normalized


def _extract_role_descriptions(body: str) -> dict[str, str]:
    roles: dict[str, str] = {}
    current_role: str | None = None
    buffer: list[str] = []
    for raw_line in body.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith("角色") and "：" in line and "角色形象" not in line:
            if current_role and buffer:
                roles[current_role] = "；".join(buffer).strip("；")
            name = line.split("：", 1)[1].split("（", 1)[0].strip()
            normalized = _normalize_role_name(name)
            current_role = normalized if normalized else None
            buffer = []
            continue
        if current_role and "：" in line:
            if "形象" in line:
                continue
            label, value = line.split("：", 1)
            value = value.strip()
            if not value:
                continue
            buffer.append(f"{label.strip()}：{value}")
    if current_role and buffer:
        roles[current_role] = "；".join(buffer).strip("；")
    return roles


def _extract_role_looks(body: str) -> dict[str, list[tuple[str, str]]]:
    looks: dict[str, list[tuple[str, str]]] = {}
    current_role: str | None = None
    for raw_line in body.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith("角色") and "：" in line and "角色形象" not in line:
            name = line.split("：", 1)[1].split("（", 1)[0].strip()
            normalized = _normalize_role_name(name)
            current_role = normalized if normalized else None
            if current_role:
                looks.setdefault(current_role, [])
            continue
        if not current_role:
            continue
        normalized = line.lstrip("-").strip()
        if normalized.startswith("形象") and "：" in normalized:
            label, value = normalized.split("：", 1)
            label = _normalize_look_label(label)
            value = value.strip()
            if label and value:
                looks[current_role].append((label, value))
    return looks


def _extract_props_with_desc(body: str) -> list[tuple[str, str]]:
    props: list[tuple[str, str]] = []
    for raw_line in body.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith("通用道具") or line.startswith("角色专属道具"):
            if "：" in line:
                value = line.split("：", 1)[1].strip()
                if value:
                    name, desc = _split_name_desc(value)
                    props.append((name, desc))
            continue
        if line[0].isdigit() or line.startswith("- "):
            value = re.sub(r"^[-\\d]+[\\.、\\s]+", "", line).strip()
            if value:
                name, desc = _split_name_desc(value)
                props.append((name, desc))
            continue
        if "专属" in line and "：" in line:
            value = line.split("：", 1)[1].strip()
            if value:
                name, desc = _split_name_desc(value)
                props.append((name, desc))
    return props


def _extract_scenes_with_desc(body: str) -> dict[str, str]:
    scenes: dict[str, str] = {}
    current_scene: str | None = None
    buffer: list[str] = []
    for raw_line in body.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith("场景") and "：" in line:
            if current_scene and buffer:
                scenes[current_scene] = "；".join(buffer).strip("；")
            value = line.split("：", 1)[1].strip()
            name, desc = _split_name_desc(value)
            current_scene = name if name else None
            buffer = []
            if desc:
                buffer.append(desc)
            continue
        if current_scene and "：" in line:
            label, value = line.split("：", 1)
            value = value.strip()
            if value:
                buffer.append(f"{label.strip()}：{value}")
    if current_scene and buffer:
        scenes[current_scene] = "；".join(buffer).strip("；")
    return scenes


def _split_name_desc(value: str) -> tuple[str, str]:
    if "（" in value and "）" in value:
        name, desc = value.split("（", 1)
        return name.strip(), desc.rstrip("）").strip()
    return value.strip(), ""


async def list_assets(session: AsyncSession, project_id: str) -> list[Asset]:
    result = await session.execute(select(Asset).where(Asset.project_id == project_id))
    return list(result.scalars().all())


async def list_asset_versions(session: AsyncSession, asset_id: str) -> list[AssetVersion]:
    result = await session.execute(select(AssetVersion).where(AssetVersion.asset_id == asset_id))
    return list(result.scalars().all())


async def get_asset(session: AsyncSession, asset_id: str) -> Asset | None:
    return await session.scalar(select(Asset).where(Asset.id == asset_id))


async def extract_assets_from_script(session: AsyncSession, project_id: str) -> list[Asset]:
    script = await session.scalar(
        select(Script).where(Script.project_id == project_id, Script.is_active == True)
    )
    if not script:
        return []
    sections = _extract_sections(script.content)
    roles_body = _find_section(sections, "【人物小传")
    props_body = _find_section(sections, "【道具清单")
    scenes_body = _find_section(sections, "【场景清单")
    assets: list[Asset] = []
    existing = await list_assets(session, project_id)
    existing_map: dict[tuple[str, str], list[Asset]] = {}
    for asset in existing:
        existing_map.setdefault((asset.type, asset.name), []).append(asset)
    planned_keys = set(existing_map.keys())

    if roles_body:
        roles = _extract_roles(roles_body)
        role_descriptions = _extract_role_descriptions(roles_body)
        role_looks = _extract_role_looks(roles_body)
        for role_name in roles.keys():
            normalized_role = _normalize_role_name(role_name)
            if not normalized_role:
                continue
            description = role_descriptions.get(normalized_role) or role_descriptions.get(role_name)
            key = ("CHARACTER", normalized_role)
            if key in existing_map:
                for item in existing_map[key]:
                    if description and description != item.description:
                        item.description = description
            elif key not in planned_keys:
                assets.append(
                    Asset(
                        project_id=project_id,
                        type="CHARACTER",
                        name=normalized_role,
                        description=description,
                    )
                )
                planned_keys.add(key)
            for label, look_desc in role_looks.get(normalized_role, []):
                look_label = _normalize_look_label(label)
                if not look_label:
                    continue
                look_name = f"{normalized_role}·{look_label}"
                full_desc = look_desc
                if description and look_desc:
                    full_desc = f"角色描述：{description}；形象要求：{look_desc}"
                look_key = ("CHARACTER_LOOK", look_name)
                if look_key in existing_map:
                    for item in existing_map[look_key]:
                        if full_desc and full_desc != item.description:
                            item.description = full_desc
                elif look_key not in planned_keys:
                    assets.append(
                        Asset(
                            project_id=project_id,
                            type="CHARACTER_LOOK",
                            name=look_name,
                            description=full_desc or None,
                        )
                    )
                    planned_keys.add(look_key)

    if props_body:
        for prop_name, prop_desc in _extract_props_with_desc(props_body):
            if not prop_name:
                continue
            key = ("PROP", prop_name)
            if key in existing_map:
                for item in existing_map[key]:
                    if prop_desc and prop_desc != item.description:
                        item.description = prop_desc
            elif key not in planned_keys:
                assets.append(
                    Asset(
                        project_id=project_id,
                        type="PROP",
                        name=prop_name,
                        description=prop_desc or None,
                    )
                )
                planned_keys.add(key)

    if scenes_body:
        scene_descriptions = _extract_scenes_with_desc(scenes_body)
        for scene in _extract_scenes(scenes_body):
            if not scene:
                continue
            description = scene_descriptions.get(scene)
            key = ("SCENE", scene)
            if key in existing_map:
                for item in existing_map[key]:
                    if description and description != item.description:
                        item.description = description
            elif key not in planned_keys:
                assets.append(
                    Asset(
                        project_id=project_id,
                        type="SCENE",
                        name=scene,
                        description=description,
                    )
                )
                planned_keys.add(key)

    if assets:
        session.add_all(assets)
    await session.commit()
    for item in assets:
        await session.refresh(item)
    return assets


async def create_asset_version(
    session: AsyncSession, asset_id: str, image_url: str, prompt: str | None = None
) -> AssetVersion:
    version = AssetVersion(asset_id=asset_id, image_url=image_url, prompt=prompt, is_selected=False)
    session.add(version)
    await session.commit()
    await session.refresh(version)
    return version


async def select_asset_version(session: AsyncSession, asset_id: str, version_id: str) -> None:
    result = await session.execute(select(AssetVersion).where(AssetVersion.asset_id == asset_id))
    versions = list(result.scalars().all())
    for version in versions:
        version.is_selected = version.id == version_id
    await session.commit()


async def delete_asset_version(session: AsyncSession, asset_id: str, version_id: str) -> bool:
    version = await session.scalar(
        select(AssetVersion).where(
            AssetVersion.asset_id == asset_id,
            AssetVersion.id == version_id,
        )
    )
    if not version:
        return False
    was_selected = version.is_selected
    await session.delete(version)
    await session.commit()
    if was_selected:
        result = await session.execute(select(AssetVersion).where(AssetVersion.asset_id == asset_id))
        remaining = list(result.scalars().all())
        for item in remaining:
            item.is_selected = False
        await session.commit()
    return True
