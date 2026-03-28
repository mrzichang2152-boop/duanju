from __future__ import annotations
import json
import ast
import re
import os
import base64
import logging
import uuid
import httpx
import aiofiles

logger = logging.getLogger(__name__)

from typing import Optional, Union, Any
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
from urllib.parse import urlparse

from app.models.asset import Asset
from app.models.asset_version import AssetVersion
from app.models.script import Script
from app.models.project import Project
from app.services.linkapi import create_chat_completion


def _extract_json_payload(text: str) -> Optional[dict[str, Any]]:
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
    normalized = re.sub(r"[\s\u3000]+", " ", value).strip()
    return normalized.strip("*")


def _normalize_look_label(value: str) -> str:
    normalized = re.sub(r"[\s\u3000]+", "", value).strip()
    return normalized.strip("*")


def _split_colon(text: str) -> tuple[str, str]:
    if "：" in text:
        return text.split("：", 1)
    if ":" in text:
        return text.split(":", 1)
    return text, ""


def _has_colon(text: str) -> bool:
    return "：" in text or ":" in text


def _normalize_image_model(model: Optional[str]) -> Optional[str]:
    if model is None:
        return None
    text = str(model).strip()
    if not text:
        return text
    lower = text.lower().replace("_", "-")
    if lower in {"nanobanana2", "nano-banana2", "nanobanana-2"}:
        return "nano-banana-2"
    if lower.startswith("nano-banana-2-4k") or lower in {"nano-banana2-4k", "nanobanana2-4k"}:
        return "nano-banana-2"
    return text


async def download_image_as_local_file(image_url: str, filename_base: Optional[str] = None) -> str:
    """
    Download image from URL and save to local static directory.
    Returns the local relative URL (e.g. /static/assets/xxx.png).
    If download fails, raises RuntimeError.
    If filename_base is provided, it uses that as the filename (plus extension).
    """
    if not image_url:
        raise RuntimeError("图片地址为空")

    # Handle base64 data URI
    if image_url.startswith("data:image"):
        try:
            header, encoded = image_url.split(",", 1)
        except ValueError as exc:
            raise RuntimeError("图片数据格式无效") from exc
        mime = "image/png"
        if ";" in header and ":" in header:
            mime = header.split(":", 1)[1].split(";", 1)[0].strip().lower() or mime
        ext = ".png"
        if "jpeg" in mime or "jpg" in mime:
            ext = ".jpg"
        elif "webp" in mime:
            ext = ".webp"
        elif "gif" in mime:
            ext = ".gif"
        elif "bmp" in mime:
            ext = ".bmp"
        try:
            image_bytes = base64.b64decode(encoded, validate=False)
        except Exception as exc:
            raise RuntimeError("图片数据解码失败") from exc
        if not image_bytes:
            raise RuntimeError("图片数据为空")
        base_dir = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
        static_dir = os.path.join(base_dir, "static", "assets")
        os.makedirs(static_dir, exist_ok=True)
        filename = f"{filename_base}{ext}" if filename_base else f"{uuid.uuid4()}{ext}"
        filepath = os.path.join(static_dir, filename)
        async with aiofiles.open(filepath, "wb") as f:
            await f.write(image_bytes)
        return f"/static/assets/{filename}"

    if image_url.startswith("/static/"):
        return image_url
    if not image_url.startswith("http"):
        raise RuntimeError("图片地址格式不支持")

    try:
        # Determine static directory
        # backend/app/services/assets.py -> backend/app/services -> backend/app -> backend
        base_dir = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
        static_dir = os.path.join(base_dir, "static", "assets")
        os.makedirs(static_dir, exist_ok=True)

        async with httpx.AsyncClient(verify=False, trust_env=False, follow_redirects=True) as client:
            resp = await client.get(image_url, timeout=60.0)
            if resp.status_code != 200:
                raise RuntimeError(f"下载图片失败，状态码: {resp.status_code}")
            
            content_type = (resp.headers.get("content-type") or "").lower()
            if "image/" not in content_type:
                raise RuntimeError(f"下载结果不是图片: {content_type or 'unknown'}")
            if not resp.content:
                raise RuntimeError("下载结果为空")
            ext = ".png"
            if "jpeg" in content_type or "jpg" in content_type:
                ext = ".jpg"
            elif "webp" in content_type:
                ext = ".webp"
            
            if filename_base:
                filename = f"{filename_base}{ext}"
            else:
                filename = f"{uuid.uuid4()}{ext}"
            
            filepath = os.path.join(static_dir, filename)
            
            async with aiofiles.open(filepath, "wb") as f:
                await f.write(resp.content)
            
            return f"/static/assets/{filename}"
    except Exception as e:
        raise RuntimeError(f"下载图片失败: {e!r}") from e


# Fields to exclude from character descriptions and looks
EXCLUDED_FIELDS = ["性格", "小传", "人物小传", "角色基础信息", "信息来源", "引用", "备注"]


def _extract_role_descriptions(body: str) -> dict[str, str]:
    roles: dict[str, str] = {}
    current_role: Optional[str] = None
    buffer: list[str] = []
    
    for raw_line in body.splitlines():
        line = raw_line.strip()
        if not line:
            continue
            
        clean_line = line.lstrip("#*").strip()
        
        # Detect start of other sections to close current role
        if clean_line.startswith("通用道具") or clean_line.startswith("场景"):
            if current_role:
                roles[current_role] = "；".join(buffer).strip("；")
            current_role = None
            buffer = []
            continue

        # Detect role definition
        if (clean_line.startswith("角色名") or clean_line.startswith("角色")) and _has_colon(clean_line):
            # Check if it's really a role definition line (start with "角色名" or "角色" followed by colon)
            # Handle cases like "角色名：xxx" or "角色: xxx"
            parts = _split_colon(clean_line)
            if len(parts) != 2:
                continue
                
            label, val = parts
            label = label.strip()
            val = val.strip()
            
            # STRICT CHECK: Only treat as new role if label is exactly "角色" or "角色名"
            if label not in ["角色", "角色名"]:
                # If it's "角色形象", skip it (it's handled by _extract_role_looks)
                if label == "角色形象":
                    continue

                # This is a description property (e.g. "角色基础信息"), fall through to description handling
                if current_role:
                    # Filter out unwanted fields
                    if label in EXCLUDED_FIELDS:
                        continue

                    # Use original line to preserve formatting if needed, or reconstructed
                    # Here we reconstruct to ensure consistent colon
                    if _has_colon(clean_line):
                        buffer.append(f"{label}：{val}")
                    else:
                        buffer.append(clean_line)
                continue
            
            # If value is empty, it might be a header like "角色列表："
            if not val:
                continue
            
            if current_role:
                roles[current_role] = "；".join(buffer).strip("；")
            
            # Normalize name (preserve parens for dual-role distinction)
            name = val.strip()
            normalized = _normalize_role_name(name)
            current_role = normalized if normalized else None
            buffer = []
            continue
            
        # Description lines
        if current_role:
            # Skip nested "Role Looks" section lines
            if clean_line.startswith("角色形象") or clean_line.startswith("-") or clean_line.startswith("•"):
                continue

            if _has_colon(line):
                label, value = _split_colon(line)
                label = label.strip()
                value = value.strip()
                
                # Filter out unwanted fields
                if label in EXCLUDED_FIELDS:
                    continue

                if value:
                    buffer.append(f"{label}：{value}")
            else:
                # Plain text description
                buffer.append(line)
                
    if current_role:
        roles[current_role] = "；".join(buffer).strip("；")
    return roles


def _extract_role_looks(body: str) -> dict[str, list[tuple[str, str]]]:
    looks: dict[str, list[tuple[str, str]]] = {}
    current_role: Optional[str] = None
    
    for raw_line in body.splitlines():
        line = raw_line.strip()
        if not line:
            continue
            
        clean_line = line.lstrip("#*").strip()
        
        # Reset current_role if entering other sections
        if clean_line.startswith("通用道具") or clean_line.startswith("场景"):
            current_role = None
            continue
        
        # Context switch by role definition
        if (clean_line.startswith("角色名") or clean_line.startswith("角色")) and _has_colon(clean_line) and "角色形象" not in clean_line:
            parts = _split_colon(clean_line)
            if len(parts) == 2:
                label = parts[0].strip()
                # STRICT CHECK: Only treat as new role if label is exactly "角色" or "角色名"
                if label in ["角色", "角色名"]:
                    val = parts[1].strip()
                    if val:
                        name = val.strip()
                        normalized = _normalize_role_name(name)
                        current_role = normalized if normalized else None
                    continue
            pass
            
        # Look definitions
        if clean_line.startswith("-") or clean_line.startswith("•"):
            content = re.sub(r"^[-•\s]+", "", clean_line)
            
            # Try to split by colon
            parts = []
            if "：" in content:
                parts = content.split("：")
            elif ":" in content:
                parts = content.split(":")
            else:
                parts = [content]
                
            parts = [p.strip() for p in parts if p.strip()]

            # Special handling: if line starts with "角色形象" (e.g. "- 角色形象：现代装：Desc"), remove it
            if parts and parts[0] == "角色形象":
                parts.pop(0)
            
            # Check for exclusions in the first part (label or potential role name)
            if parts and parts[0] in EXCLUDED_FIELDS:
                continue
            
            if len(parts) >= 3:
                # Role：Look：Desc
                r_name = _normalize_role_name(parts[0])
                l_name = _normalize_look_label(parts[1])
                # Join the rest with Chinese colon for consistency
                desc = "：".join(parts[2:])
                looks.setdefault(r_name, []).append((l_name, desc))
            elif len(parts) == 2:
                # Look：Desc (use current_role)
                if current_role:
                    l_name = _normalize_look_label(parts[0])
                    if l_name.startswith("形象"):
                        l_name = l_name.replace("形象", "", 1).strip()
                    desc = parts[1]
                    looks.setdefault(current_role, []).append((l_name, desc))
            elif len(parts) == 1 and current_role:
                # Just Look name? or Description?
                pass
            
    return looks


def _extract_props_with_desc(body: str) -> list[tuple[str, str]]:
    props: list[tuple[str, str]] = []
    in_props_section = False
    
    for raw_line in body.splitlines():
        line = raw_line.strip()
        if not line:
            continue
            
        clean_line = line.lstrip("#*").strip()
        
        # Detect start of other sections
        if clean_line.startswith("角色") or clean_line.startswith("场景"):
            in_props_section = False
            continue
            
        if clean_line.startswith("通用道具") or clean_line.startswith("角色专属道具"):
            in_props_section = True
            if "：" in clean_line:
                value = clean_line.split("：", 1)[1].strip()
                if value:
                    if "：" in value:
                        n, d = value.split("：", 1)
                        props.append((n.strip(), d.strip()))
                    else:
                        props.append(_split_name_desc(value))
            continue
            
        if in_props_section:
            # Clean list markers
            clean_line = re.sub(r"^[-•\d]+[\\.、\s]*", "", line).strip()
            if not clean_line:
                continue
                
            if "：" in clean_line:
                name, desc = clean_line.split("：", 1)
                props.append((name.strip(), desc.strip()))
            else:
                props.append(_split_name_desc(clean_line))
    return props


def _extract_scenes_with_desc(body: str) -> dict[str, str]:
    scenes: dict[str, str] = {}
    current_scene: Optional[str] = None
    buffer: list[str] = []
    
    for raw_line in body.splitlines():
        line = raw_line.strip()
        if not line:
            continue
            
        clean_line = line.lstrip("#*").strip()

        # Detect start of other sections
        if clean_line.startswith("角色") or clean_line.startswith("通用道具"):
            if current_scene:
                scenes[current_scene] = "；".join(buffer).strip("；")
            current_scene = None
            buffer = []
            continue

        if clean_line.startswith("场景") and "：" in clean_line:
            val = clean_line.split("：", 1)[1].strip()
            # Header like "场景列表："
            if not val:
                continue
                
            if current_scene:
                scenes[current_scene] = "；".join(buffer).strip("；")
            
            if "：" in val:
                s_name, s_desc = val.split("：", 1)
                current_scene = s_name.strip()
                buffer = [s_desc.strip()]
            else:
                name, desc = _split_name_desc(val)
                current_scene = name
                buffer = []
                if desc:
                    buffer.append(desc)
            continue
            
        if current_scene:
            if "：" in line:
                label, value = line.split("：", 1)
                buffer.append(f"{label.strip()}：{value.strip()}")
            else:
                buffer.append(line)
                
    if current_scene:
        scenes[current_scene] = "；".join(buffer).strip("；")
    return scenes


def _split_name_desc(value: str) -> tuple[str, str]:
    if "（" in value and "）" in value:
        name, desc = value.split("（", 1)
        return name.strip(), desc.rstrip("）").strip()
    return value.strip(), ""


async def list_assets(session: AsyncSession, project_id: str) -> list[Asset]:
    result = await session.execute(
        select(Asset).where(Asset.project_id == project_id).order_by(Asset.created_at.asc())
    )
    return list(result.scalars().all())


def _asset_identity_key(asset_type: str, name: str) -> tuple[str, str]:
    normalized_name = re.sub(r"[\s\u3000]+", " ", (name or "")).strip()
    if asset_type == "CHARACTER":
        normalized_name = _normalize_role_name(normalized_name)
    elif asset_type == "CHARACTER_LOOK":
        normalized_name = normalized_name.replace(" ", "")
    return asset_type, normalized_name


async def _merge_duplicate_assets(
    session: AsyncSession, project_id: str, existing_assets: list[Asset]
) -> list[Asset]:
    grouped: dict[tuple[str, str], list[Asset]] = {}
    for asset in existing_assets:
        grouped.setdefault(_asset_identity_key(asset.type, asset.name), []).append(asset)

    canonical_ids: set[str] = set()
    changed = False
    for asset_group in grouped.values():
        if len(asset_group) <= 1:
            continue
        ordered_group = sorted(asset_group, key=lambda item: (item.created_at, item.id))
        canonical = ordered_group[0]
        canonical_ids.add(canonical.id)
        for duplicate in ordered_group[1:]:
            await session.execute(
                update(AssetVersion)
                .where(AssetVersion.asset_id == duplicate.id)
                .values(asset_id=canonical.id)
            )
            if not canonical.description and duplicate.description:
                canonical.description = duplicate.description
            if not canonical.prompt and duplicate.prompt:
                canonical.prompt = duplicate.prompt
            if not canonical.model and duplicate.model:
                canonical.model = duplicate.model
            if not canonical.size and duplicate.size:
                canonical.size = duplicate.size
            if not canonical.style and duplicate.style:
                canonical.style = duplicate.style
            await session.delete(duplicate)
            changed = True

    if not changed:
        return existing_assets

    await session.commit()

    for canonical_id in canonical_ids:
        versions = await list_asset_versions(session, canonical_id)
        selected_versions = [item for item in versions if item.is_selected]
        if len(selected_versions) <= 1:
            continue
        keep_selected = selected_versions[-1]
        for item in selected_versions:
            item.is_selected = item.id == keep_selected.id
    await session.commit()
    return await list_assets(session, project_id)


async def list_asset_versions(session: AsyncSession, asset_id: str) -> list[AssetVersion]:
    result = await session.execute(
        select(AssetVersion)
        .where(AssetVersion.asset_id == asset_id)
        .order_by(AssetVersion.created_at.asc())
    )
    return list(result.scalars().all())


async def get_asset(session: AsyncSession, asset_id: str) -> Optional[Asset]:
    return await session.scalar(select(Asset).where(Asset.id == asset_id))


from app.core.script_prompts import PROMPT_EXTRACT_RESOURCES

async def extract_assets_from_script(
    session: AsyncSession, project_id: str, user_id: Optional[str] = None, manual_only: bool = False
) -> list[Asset]:
    script = await session.scalar(
        select(Script).where(Script.project_id == project_id, Script.is_active == True)
    )
    if not script:
        return []

    SEPARATOR = "\n\n=== 原文剧本 (请勿删除此行) ===\n\n"
    data = {}

    # Try to extract from manually edited resources first
    if script.content and SEPARATOR in script.content:
        resources_content = script.content.split(SEPARATOR)[0]
        
        # Characters
        char_map = _extract_role_descriptions(resources_content)
        data["characters"] = [{"name": k, "description": v} for k, v in char_map.items()]
        
        # Looks
        looks_map = _extract_role_looks(resources_content)
        looks_list = []
        for role, items in looks_map.items():
            for label, val in items:
                looks_list.append({"role": role, "look": label, "description": val})
        data["character_looks"] = looks_list
        
        # Props
        props_list = _extract_props_with_desc(resources_content)
        data["props"] = [{"name": n, "description": d} for n, d in props_list]
        
        # Scenes
        scenes_map = _extract_scenes_with_desc(resources_content)
        data["scenes"] = [{"name": k, "description": v} for k, v in scenes_map.items()]
        
    else:
        if manual_only:
            return []

        if not user_id:
            project = await session.scalar(select(Project).where(Project.id == project_id))
            if project:
                user_id = project.user_id
        
        if not user_id:
            # Should not happen ideally, but as fallback
            return []

        # Use the centralized prompt from script_prompts.py
        system_prompt = PROMPT_EXTRACT_RESOURCES
        
        # Append JSON format instruction as it might not be in the prompt or we want to enforce it for the code parser
        # The PROMPT_EXTRACT_RESOURCES tells the LLM to output a structured list (Markdown), 
        # but here we need JSON for the code to parse it easily?
        # WAIT. PROMPT_EXTRACT_RESOURCES outputs Markdown list format (Role Name: ...).
        # But this function expects `data` to be a dict/JSON from `_extract_json_payload`.
        # The existing code (lines 454-473) asks for JSON.
        # The `PROMPT_EXTRACT_RESOURCES` (lines 406-463 in script_prompts.py) asks for "Standard Markdown Format".
        
        # If I switch to PROMPT_EXTRACT_RESOURCES, the output will be Markdown, not JSON.
        # And `_extract_json_payload` (line 25) will fail or return None.
        
        # However, `extract_assets_from_script` also has logic to parse "manually edited resources" (lines 418-440) 
        # which parses the Markdown format!
        
        # So if the LLM returns Markdown (matching PROMPT_EXTRACT_RESOURCES), 
        # we can feed that output into the SAME parsing logic as the manual extraction!
        
        # Let's verify the parsing logic `_extract_role_descriptions` etc.
        # They take `body: str`.
        
        # So the plan should be:
        # 1. Use PROMPT_EXTRACT_RESOURCES.
        # 2. Get the LLM output (Markdown).
        # 3. Instead of trying `_extract_json_payload`, use the Markdown parsers (`_extract_role_descriptions`, etc.) on the LLM output.
        
        try:
            response = await create_chat_completion(
                session,
                user_id,
                {
                    "model": "gemini-3.1-pro",
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
            
            # Log the raw content for debugging
            logger.info(f"LLM Extraction Response (Markdown): {content[:200]}...")
            
            # Parse the Markdown output using the same logic as manual extraction
            # Characters
            char_map = _extract_role_descriptions(content)
            data["characters"] = [{"name": k, "description": v} for k, v in char_map.items()]
            
            # Looks
            looks_map = _extract_role_looks(content)
            looks_list = []
            for role, items in looks_map.items():
                for label, val in items:
                    looks_list.append({"role": role, "look": label, "description": val})
            data["character_looks"] = looks_list
            
            # Props
            props_list = _extract_props_with_desc(content)
            data["props"] = [{"name": n, "description": d} for n, d in props_list]
            
            # Scenes
            scenes_map = _extract_scenes_with_desc(content)
            data["scenes"] = [{"name": k, "description": v} for k, v in scenes_map.items()]
            
        except Exception as e:
            # Fallback or error logging
            logger.error(f"LLM Extraction Failed: {e}")
            return []

    extracted_characters = data.get("characters", [])
    if not isinstance(extracted_characters, list):
        extracted_characters = []
        
    extracted_looks = data.get("character_looks", [])
    if not isinstance(extracted_looks, list):
        extracted_looks = []
        
    extracted_props = data.get("props", [])
    if not isinstance(extracted_props, list):
        extracted_props = []
        
    extracted_scenes = data.get("scenes", [])
    if not isinstance(extracted_scenes, list):
        extracted_scenes = []

    assets: list[Asset] = []
    existing = await list_assets(session, project_id)
    existing_map: dict[tuple[str, str], list[Asset]] = {}
    for asset in existing:
        existing_map.setdefault(_asset_identity_key(asset.type, asset.name), []).append(asset)
    planned_keys = set()

    # Process Characters
    logger.info(f"Extracted {len(extracted_characters)} characters, {len(extracted_looks)} looks, {len(extracted_props)} props, {len(extracted_scenes)} scenes")

    for item in extracted_characters:
        if not isinstance(item, dict):
            continue
        name = _normalize_role_name(item.get("name", ""))

        desc = item.get("description", "")
        if not name:
            continue
        key = _asset_identity_key("CHARACTER", name)
        
        if key in planned_keys:
            continue
        planned_keys.add(key)
        if key in existing_map:
            latest_asset = sorted(existing_map[key], key=lambda item: (item.created_at, item.id))[-1]
            latest_desc = (latest_asset.description or "").strip()
            incoming_desc = (desc or "").strip()
            if incoming_desc and incoming_desc != latest_desc:
                assets.append(
                    Asset(
                        project_id=project_id,
                        type="CHARACTER",
                        name=name,
                        description=desc,
                    )
                )
            elif incoming_desc and not latest_desc:
                latest_asset.description = desc
        else:
            assets.append(
                Asset(
                    project_id=project_id,
                    type="CHARACTER",
                    name=name,
                    description=desc,
                )
            )

    # Process Character Looks
    for item in extracted_looks:
        if not isinstance(item, dict):
            continue
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
        
        key = _asset_identity_key("CHARACTER_LOOK", look_name)
        
        if key in planned_keys:
            continue
        planned_keys.add(key)
        if key in existing_map:
            latest_asset = sorted(existing_map[key], key=lambda item: (item.created_at, item.id))[-1]
            latest_desc = (latest_asset.description or "").strip()
            incoming_desc = (full_desc or "").strip()
            if incoming_desc and incoming_desc != latest_desc:
                assets.append(
                    Asset(
                        project_id=project_id,
                        type="CHARACTER_LOOK",
                        name=look_name,
                        description=full_desc,
                    )
                )
            elif incoming_desc and not latest_desc:
                latest_asset.description = full_desc
        else:
            assets.append(
                Asset(
                    project_id=project_id,
                    type="CHARACTER_LOOK",
                    name=look_name,
                    description=full_desc,
                )
            )

    # Process Props
    for item in extracted_props:
        if not isinstance(item, dict):
            continue
        name = item.get("name", "").strip()
        desc = item.get("description", "")
        if not name:
            continue
        key = _asset_identity_key("PROP", name)
        
        if key in planned_keys:
            continue
        planned_keys.add(key)
        if key in existing_map:
            latest_asset = sorted(existing_map[key], key=lambda item: (item.created_at, item.id))[-1]
            latest_desc = (latest_asset.description or "").strip()
            incoming_desc = (desc or "").strip()
            if incoming_desc and incoming_desc != latest_desc:
                assets.append(
                    Asset(
                        project_id=project_id,
                        type="PROP",
                        name=name,
                        description=desc,
                    )
                )
            elif incoming_desc and not latest_desc:
                latest_asset.description = desc
        else:
            assets.append(
                Asset(
                    project_id=project_id,
                    type="PROP",
                    name=name,
                    description=desc,
                )
            )

    # Process Scenes
    for item in extracted_scenes:
        if not isinstance(item, dict):
            continue
        name = item.get("name", "").strip()
        desc = item.get("description", "")
        if not name:
            continue
        key = _asset_identity_key("SCENE", name)
        
        if key in planned_keys:
            continue
        planned_keys.add(key)
        if key in existing_map:
            latest_asset = sorted(existing_map[key], key=lambda item: (item.created_at, item.id))[-1]
            latest_desc = (latest_asset.description or "").strip()
            incoming_desc = (desc or "").strip()
            if incoming_desc and incoming_desc != latest_desc:
                assets.append(
                    Asset(
                        project_id=project_id,
                        type="SCENE",
                        name=name,
                        description=desc,
                    )
                )
            elif incoming_desc and not latest_desc:
                latest_asset.description = desc
        else:
            assets.append(
                Asset(
                    project_id=project_id,
                    type="SCENE",
                    name=name,
                    description=desc,
                )
            )

    if assets:
        session.add_all(assets)
    await session.commit()
    for item in assets:
        await session.refresh(item)
    return assets


async def create_asset_version(
    session: AsyncSession, asset_id: str, image_url: str, prompt: Optional[str] = None
) -> AssetVersion:
    version = AssetVersion(asset_id=asset_id, image_url=image_url, prompt=prompt, is_selected=False)
    session.add(version)
    await session.commit()
    await session.refresh(version)
    await select_asset_version(session, asset_id, version.id)
    await session.refresh(version)
    return version


async def select_asset_version(
    session: AsyncSession, asset_id: str, version_id: str, project_id: Optional[str] = None
) -> None:
    asset = await get_asset(session, asset_id)
    if not asset:
        return
    target_project_id = project_id or asset.project_id
    same_key = _asset_identity_key(asset.type, asset.name)
    project_assets = await list_assets(session, target_project_id)
    same_key_asset_ids = [
        item.id for item in project_assets if _asset_identity_key(item.type, item.name) == same_key
    ]
    if not same_key_asset_ids:
        same_key_asset_ids = [asset_id]
    result = await session.execute(
        select(AssetVersion).where(AssetVersion.asset_id.in_(same_key_asset_ids))
    )
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


async def update_asset_config(
    session: AsyncSession,
    asset_id: str,
    prompt: Optional[str] = None,
    model: Optional[str] = None,
    size: Optional[str] = None,
    style: Optional[str] = None,
) -> Optional[Asset]:
    stmt = select(Asset).where(Asset.id == asset_id)
    result = await session.execute(stmt)
    asset = result.scalar_one_or_none()
    
    if not asset:
        return None
    
    if prompt is not None:
        asset.prompt = prompt
    if model is not None:
        asset.model = _normalize_image_model(model) or "nano-banana-2"
    if size is not None:
        asset.size = size
    if style is not None:
        asset.style = style
        
    await session.commit()
    await session.refresh(asset)
    return asset
