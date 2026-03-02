from __future__ import annotations
import json
import re
from typing import Optional, Union, Any
import ast

from sqlalchemy.ext.asyncio import AsyncSession

from app.services.linkapi import create_chat_completion
from app.services.settings import get_or_create_settings


class ValidationResult:
    def __init__(self, valid: bool, errors: list[str], warnings: list[str]):
        self.valid = valid
        self.errors = errors
        self.warnings = warnings


def _normalize_list(value: str) -> list[str]:
    tokens = re.split(r"[、,，/\\s]+", value)
    return [token.strip() for token in tokens if token.strip()]


def _extract_sections(content: str) -> dict[str, str]:
    matches = list(re.finditer(r"【[^】]+】", content))
    sections: dict[str, str] = {}
    for index, match in enumerate(matches):
        title = match.group(0)
        start = match.end()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(content)
        sections[title] = content[start:end].strip()
    return sections


def _normalize_title(value: str) -> str:
    return re.sub(r"[\\s\\u3000]+", "", value)


def _find_section(sections: dict[str, str], prefix: str) -> Optional[str]:
    normalized_prefix = _normalize_title(prefix)
    for title, body in sections.items():
        if _normalize_title(title).startswith(normalized_prefix):
            return body
    return None


def _extract_roles(body: str) -> dict[str, list[str]]:
    roles: dict[str, list[str]] = {}
    current_role: Optional[str] = None
    for raw_line in body.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith("角色") and "：" in line and "角色形象" not in line:
            name = line.split("：", 1)[1].split("（", 1)[0].strip()
            if name:
                current_role = name
                roles.setdefault(name, [])
            continue
        if current_role and line.startswith("形象") and "：" in line:
            label = line.split("：", 1)[0].strip()
            shape = line.split("：", 1)[1].split("（", 1)[0].strip()
            if label:
                roles[current_role].append(label)
            if shape:
                roles[current_role].append(shape)
    return roles


def _extract_props(body: str) -> list[str]:
    props: list[str] = []
    for raw_line in body.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith("通用道具") or line.startswith("角色专属道具"):
            if "：" in line:
                value = line.split("：", 1)[1].strip()
                if value:
                    props.append(value.split("（", 1)[0].strip())
            continue
        if line[0].isdigit():
            value = re.sub(r"^\\d+[\\.、\\s]+", "", line).strip()
            if value:
                props.append(value.split("（", 1)[0].strip())
        if "专属" in line and "：" in line:
            value = line.split("：", 1)[1].strip()
            if value:
                props.append(value.split("（", 1)[0].strip())
    return [item for item in props if item]


def _extract_scenes(body: str) -> list[str]:
    scenes: list[str] = []
    for raw_line in body.splitlines():
        line = raw_line.strip()
        if line.startswith("场景") and "：" in line:
            value = line.split("：", 1)[1].split("（", 1)[0].strip()
            if value:
                scenes.append(value)
    return scenes


def _extract_scenes_blocks(body: str) -> list[tuple[str, str]]:
    matches = list(re.finditer(r"【第[^】]+场】", body))
    blocks: list[tuple[str, str]] = []
    for index, match in enumerate(matches):
        title = match.group(0)
        start = match.end()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(body)
        blocks.append((title, body[start:end]))
    return blocks


def _extract_field(block: str, label: str) -> Optional[str]:
    match = re.search(rf"{re.escape(label)}[:：]\\s*(.+)", block)
    if not match:
        return None
    return match.group(1).splitlines()[0].strip()


def validate_script(content: str) -> ValidationResult:
    sections = _extract_sections(content)
    errors: list[str] = []
    warnings: list[str] = []

    required_prefixes = [
        "【剧本基本信息】",
        "【人物小传",
        "【道具清单",
        "【场景清单",
        "【正文剧本",
        "【结尾钩子",
        "【AI生剧专属备注",
    ]
    required_sections: dict[str, str] = {}
    for prefix in required_prefixes:
        body = _find_section(sections, prefix)
        if body is None:
            errors.append(f"缺失段落：{prefix}")
        else:
            required_sections[prefix] = body

    if errors:
        return ValidationResult(False, errors, warnings)

    roles = _extract_roles(required_sections["【人物小传"])
    props = _extract_props(required_sections["【道具清单"])
    scenes = _extract_scenes(required_sections["【场景清单"])

    script_body = required_sections["【正文剧本"]
    scene_blocks = _extract_scenes_blocks(script_body)
    if not scene_blocks:
        errors.append("正文缺少场次分块")

    for title, block in scene_blocks:
        for label in ["出镜角色", "角色对应形象", "对应场景", "本场所需道具", "场记标", "镜头提示"]:
            value = _extract_field(block, label)
            if not value:
                errors.append(f"{title} 缺失字段：{label}")
        role_value = _extract_field(block, "出镜角色")
        if role_value:
            for role in _normalize_list(role_value):
                if role not in roles:
                    errors.append(f"{title} 出镜角色未定义：{role}")
        scene_value = _extract_field(block, "对应场景")
        if scene_value and scene_value not in scenes:
            errors.append(f"{title} 场景未定义：{scene_value}")
        prop_value = _extract_field(block, "本场所需道具")
        if prop_value:
            for prop in _normalize_list(prop_value):
                if prop not in props:
                    errors.append(f"{title} 道具未定义：{prop}")
        shape_value = _extract_field(block, "角色对应形象")
        if shape_value:
            shapes = _normalize_list(shape_value)
            available_shapes = {shape for values in roles.values() for shape in values}
            for shape in shapes:
                if shape not in available_shapes:
                    errors.append(f"{title} 形象未定义：{shape}")
        if role_value:
            role_set = set(_normalize_list(role_value))
            for voice_match in re.findall(r"【画外音·([^】]+)】", block):
                name = voice_match.strip()
                if name and name not in role_set:
                    errors.append(f"{title} 画外音角色不在出镜列表：{name}")

    remark_body = required_sections["【AI生剧专属备注"]
    duration = _extract_field(remark_body, "视频要求：生成时长")
    if not duration:
        warnings.append("未设置视频要求：生成时长")

    valid = len(errors) == 0
    return ValidationResult(valid, errors, warnings)


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


async def validate_script_with_model(
    session: AsyncSession, user_id: str, content: str, model: Optional[str]
) -> ValidationResult:
    settings = await get_or_create_settings(session, user_id)
    use_model = model or settings.default_model_text
    system_prompt = (
        "你是短剧剧本校验助手。只做校验，不改写内容。"
        "请严格输出 JSON，格式为："
        "{\"valid\":true|false,\"missing\":[\"...\"],\"warnings\":[\"...\"]}。"
        "missing 用于缺失的段落或关键结构，warnings 用于轻微问题。"
        "不要输出除 JSON 以外的任何内容。"
    )
    user_prompt = (
        "需要关注的结构：\n"
        "1. 段落标题是否包含：【剧本基本信息】、【人物小传】、【道具清单】、【场景清单】、【正文剧本】、【结尾钩子】、【AI生剧专属备注】。\n"
        "2. 正文是否有场次分块（例如【第一场】等）。\n"
        "3. 每个场次是否包含：出镜角色、角色对应形象、对应场景、本场所需道具、场记标、镜头提示。\n"
        "注意：标题存在即可视为有该段落，不要求填满占位符。\n"
        f"\n剧本内容如下：\n{content}"
    )
    result = await create_chat_completion(
        session,
        user_id,
        {
            "model": use_model,
            "temperature": 0.0,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
        },
    )
    content_text = ""
    if isinstance(result, dict):
        choices = result.get("choices") or []
        if choices:
            message = choices[0].get("message") or {}
            content_text = message.get("content") or ""
    payload = _extract_json_payload(content_text)
    if not isinstance(payload, dict):
        return ValidationResult(False, ["模型校验解析失败"], [])
    valid = bool(payload.get("valid"))
    missing = payload.get("missing") or []
    warnings = payload.get("warnings") or []
    if not isinstance(missing, list):
        missing = ["模型校验输出格式异常"]
    if not isinstance(warnings, list):
        warnings = []
    missing = [str(item) for item in missing if str(item).strip()]
    warnings = [str(item) for item in warnings if str(item).strip()]
    return ValidationResult(valid, missing, warnings)
