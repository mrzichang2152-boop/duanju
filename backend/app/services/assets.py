import json
import ast
import re
from typing import Any
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.asset import Asset
from app.models.asset_version import AssetVersion
from app.models.script import Script
from app.models.project import Project
from app.services.linkapi import create_chat_completion


def _extract_json_payload(text: str) -> dict[str, Any] | None:
    if not text:
        return None
    fenced_match = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", text)
    candidate = fenced_match.group(1) if fenced_match else text
    start = candidate.find("{")
    end = candidate.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return None
    snippet = candidate[start : end + 1]
    try:
        return json.loads(snippet)
    except json.JSONDecodeError:
        try:
            parsed = ast.literal_eval(snippet)
            return parsed if isinstance(parsed, dict) else None
        except (ValueError, SyntaxError):
            return None


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


async def extract_assets_from_script(
    session: AsyncSession, project_id: str, user_id: str | None = None
) -> list[Asset]:
    script = await session.scalar(
        select(Script).where(Script.project_id == project_id, Script.is_active == True)
    )
    if not script:
        return []

    if not user_id:
        project = await session.scalar(select(Project).where(Project.id == project_id))
        if project:
            user_id = project.user_id
    
    if not user_id:
        # Should not happen ideally, but as fallback
        return []

    system_prompt = (
        "你是专业的短剧剧本分析助手。请仔细阅读剧本，提取出所有的【角色】、【角色形象】、【道具】、【场景】信息。\n"
        "请严格输出标准的 JSON 格式，不要包含任何 Markdown 代码块标记或其他文字。\n"
        "JSON 结构如下：\n"
        "{\n"
        '  "characters": [{"name": "角色名", "description": "角色描述"}],\n'
        '  "character_looks": [{"role": "角色名", "look": "形象名称", "description": "形象描述"}],\n'
        '  "props": [{"name": "道具名", "description": "道具描述"}],\n'
        '  "scenes": [{"name": "场景名", "description": "场景描述"}]\n'
        "}\n"
        "注意：\n"
        "1. 角色名应去除括号备注。\n"
        "2. 角色形象通常格式为“角色名：形象名”，请拆分。\n"
        "3. 描述应尽可能详细，包含外貌、穿着、材质、光影等信息。\n"
        "4. 如果剧本中没有某类信息，请返回空列表。"
    )

    try:
        response = await create_chat_completion(
            session,
            user_id,
            {
                "model": "doubao-seed-2-0-pro-260215",  # Explicitly request Doubao 2.0
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": script.content},
                ],
                "temperature": 0.1,
            },
        )
        content = ""
        if isinstance(response, dict):
             choices = response.get("choices") or []
             if choices:
                 content = choices[0].get("message", {}).get("content", "")
        
        data = _extract_json_payload(content) or {}
    except Exception as e:
        # Fallback or error logging
        # For now, return empty if LLM fails, or maybe raise error?
        # Returning empty means no assets extracted.
        return []

    extracted_characters = data.get("characters", [])
    extracted_looks = data.get("character_looks", [])
    extracted_props = data.get("props", [])
    extracted_scenes = data.get("scenes", [])

    assets: list[Asset] = []
    existing = await list_assets(session, project_id)
    existing_map: dict[tuple[str, str], list[Asset]] = {}
    for asset in existing:
        existing_map.setdefault((asset.type, asset.name), []).append(asset)
    planned_keys = set(existing_map.keys())

    # Process Characters
    for item in extracted_characters:
        name = _normalize_role_name(item.get("name", ""))
        desc = item.get("description", "")
        if not name:
            continue
        key = ("CHARACTER", name)
        if key in existing_map:
            for asset in existing_map[key]:
                if desc and desc != asset.description:
                    asset.description = desc
        elif key not in planned_keys:
            assets.append(
                Asset(
                    project_id=project_id,
                    type="CHARACTER",
                    name=name,
                    description=desc,
                )
            )
            planned_keys.add(key)

    # Process Character Looks
    for item in extracted_looks:
        role = _normalize_role_name(item.get("role", ""))
        look = item.get("look", "").strip()
        desc = item.get("description", "")
        if not role or not look:
            continue
        
        # Ensure base character exists or is planned? 
        # Actually we just add the look asset.
        look_name = f"{role}·{look}"
        
        # Combine descriptions if needed, but LLM usually gives full description
        full_desc = desc
        
        key = ("CHARACTER_LOOK", look_name)
        if key in existing_map:
            for asset in existing_map[key]:
                if full_desc and full_desc != asset.description:
                    asset.description = full_desc
        elif key not in planned_keys:
            assets.append(
                Asset(
                    project_id=project_id,
                    type="CHARACTER_LOOK",
                    name=look_name,
                    description=full_desc,
                )
            )
            planned_keys.add(key)

    # Process Props
    for item in extracted_props:
        name = item.get("name", "").strip()
        desc = item.get("description", "")
        if not name:
            continue
        key = ("PROP", name)
        if key in existing_map:
            for asset in existing_map[key]:
                if desc and desc != asset.description:
                    asset.description = desc
        elif key not in planned_keys:
            assets.append(
                Asset(
                    project_id=project_id,
                    type="PROP",
                    name=name,
                    description=desc,
                )
            )
            planned_keys.add(key)

    # Process Scenes
    for item in extracted_scenes:
        name = item.get("name", "").strip()
        desc = item.get("description", "")
        if not name:
            continue
        key = ("SCENE", name)
        if key in existing_map:
            for asset in existing_map[key]:
                if desc and desc != asset.description:
                    asset.description = desc
        elif key not in planned_keys:
            assets.append(
                Asset(
                    project_id=project_id,
                    type="SCENE",
                    name=name,
                    description=desc,
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
