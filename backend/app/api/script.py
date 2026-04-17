import re
import asyncio
from fastapi import APIRouter, Depends, HTTPException, status, UploadFile, File
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession
import json
import logging
from typing import Optional, Any
from uuid import uuid4
from datetime import datetime

from app.api.deps import get_current_user_id
from app.core.db import get_db, SessionLocal
from app.schemas.script import (
    ScriptGenerateRequest,
    ScriptGenerateResponse,
    ScriptRequest,
    ScriptResponse,
    ScriptValidationRequest,
    ScriptValidationResponse,
    ScriptHistoryResponse,
    ScriptHistoryItem,
    ScriptParseResponse,
    StoryboardTaskStartRequest,
    StoryboardTaskStatusResponse,
    AsyncTaskStatusResponse,
    Step2TaskStartRequest,
    Step2TaskTarget,
)
from app.services.projects import get_project
from app.services.script_validation import validate_script_with_model as run_validation
from app.services.scripts import (
    get_active_script,
    get_latest_meaningful_script,
    has_meaningful_script_data,
    save_script,
    get_script_history,
    delete_script,
)
from app.services.assets import extract_assets_from_script
from app.services import media_storage
from app.services.settings import get_or_create_settings
from app.services.linkapi import create_chat_completion, create_chat_completion_stream
from app.services.file_parsing import read_file_content
from app.services.async_tasks import (
    create_async_task,
    get_async_task,
    mark_async_task_running,
    mark_async_task_completed,
    mark_async_task_failed,
    parse_task_result,
)

from app.core.script_prompts import (
    get_system_prompt,
    PROMPT_SUGGESTION_PAID,
    PROMPT_SUGGESTION_TRAFFIC,
    PROMPT_CONTINUATION_DEFAULT,
    PROMPT_CONTINUATION_TRAFFIC,
    PROMPT_CONTINUATION_PAID,
    PROMPT_EXTRACT_OUTLINE,
    PROMPT_SPLIT_SCRIPT,
    PROMPT_STORYBOARD,
    PROMPT_EXTRACT_RESOURCES,
    PROMPT_EXTRACT_PROPS,
    PROMPT_EXTRACT_SCENES,
    PROMPT_STEP2_MERGE_CHARACTERS,
    PROMPT_STEP2_MERGE_PROPS,
    PROMPT_STEP2_MERGE_SCENES,
)

router = APIRouter()
logger = logging.getLogger(__name__)
_storyboard_task_lock = asyncio.Lock()
_storyboard_tasks: dict[str, dict[str, Any]] = {}
_OPENROUTER_TEXT_MODEL = "gemini-3.1-pro-preview"


def _build_storyboard_text_from_episodes(episodes: list[dict[str, Any]]) -> str:
    return "\n\n".join([f"### {str(item.get('title') or '').strip()}\n\n{str(item.get('storyboard') or '').strip()}" for item in episodes])


def _build_script_response(
    script: Any,
    project_id: str,
    state_url: Optional[str] = None,
    markdown_url: Optional[str] = None,
) -> ScriptResponse:
    episodes = json.loads(script.episodes) if getattr(script, "episodes", None) else None
    version = getattr(script, "version", None)
    if state_url is None and version:
        state_url = media_storage.build_script_state_public_url(project_id, int(version))
    if markdown_url is None and version:
        markdown_url = media_storage.build_script_markdown_public_url(project_id, int(version))
    return ScriptResponse(
        id=script.id,
        project_id=project_id,
        content=script.content,
        thinking=script.thinking,
        storyboard=script.storyboard,
        outline=script.outline,
        episodes=episodes,
        version=version,
        is_active=script.is_active,
        created_at=script.created_at.isoformat() if script.created_at else None,
        state_url=state_url or None,
        markdown_url=markdown_url or None,
    )


_STORYBOARD_SYSTEM_COLUMNS = ["场景", "道具", "远景位置关系图", "首帧图片", "生成视频"]


def _split_markdown_table_line(line: str) -> list[str]:
    parts: list[str] = []
    current = ""
    bracket_depth = 0
    escaped = False
    for ch in str(line or ""):
        if escaped:
            current += ch
            escaped = False
            continue
        if ch == "\\":
            escaped = True
            current += ch
            continue
        if ch == "[":
            bracket_depth += 1
            current += ch
            continue
        if ch == "]":
            bracket_depth = max(0, bracket_depth - 1)
            current += ch
            continue
        if ch == "|" and bracket_depth == 0:
            parts.append(current)
            current = ""
            continue
        current += ch
    parts.append(current)
    if parts and parts[0].strip() == "":
        parts.pop(0)
    if parts and parts[-1].strip() == "":
        parts.pop()
    return parts


def _ensure_storyboard_system_columns(markdown: str) -> str:
    lines = str(markdown or "").splitlines()
    if not lines:
        return str(markdown or "")

    def _normalized(text: str) -> str:
        return str(text or "").replace(" ", "").replace("\t", "")

    result: list[str] = []
    i = 0
    while i < len(lines):
        current = lines[i]
        next_line = lines[i + 1] if i + 1 < len(lines) else ""
        stripped = current.strip()
        next_stripped = next_line.strip()
        is_table_header = stripped.startswith("|") and "|" in stripped and next_stripped.startswith("|") and set(next_stripped.replace("|", "").replace("-", "").replace(":", "").replace(" ", "")) == set()
        if not is_table_header:
            result.append(current)
            i += 1
            continue

        header_cells = [cell.strip() for cell in _split_markdown_table_line(current)]
        normalized_header_cells = [_normalized(cell) for cell in header_cells]
        if "角色形象" not in normalized_header_cells:
            role_index = next((index for index, cell in enumerate(header_cells) if _normalized(cell) == "角色"), -1)
            if role_index >= 0:
                header_cells[role_index] = "角色形象"
        row_lines: list[str] = []
        j = i + 2
        while j < len(lines):
            candidate = lines[j]
            candidate_stripped = candidate.strip()
            if not candidate_stripped.startswith("|") or "|" not in candidate_stripped:
                break
            row_lines.append(candidate)
            j += 1

        existing_headers = [_normalized(cell) for cell in header_cells]
        for required in _STORYBOARD_SYSTEM_COLUMNS:
            required_normalized = _normalized(required)
            if required_normalized not in existing_headers:
                header_cells.append(required)
                existing_headers.append(required_normalized)

        result.append(f"| {' | '.join(header_cells)} |")
        result.append(f"| {' | '.join(['---'] * len(header_cells))} |")
        for row_line in row_lines:
            row_cells = [cell.strip() for cell in _split_markdown_table_line(row_line)]
            if len(row_cells) < len(header_cells):
                row_cells.extend([""] * (len(header_cells) - len(row_cells)))
            elif len(row_cells) > len(header_cells):
                row_cells = row_cells[:len(header_cells)]
            result.append(f"| {' | '.join(row_cells)} |")
        i = j

    return "\n".join(result)


def _strip_storyboard_thinking_content(text: str) -> str:
    source = str(text or "")
    cleaned = re.sub(r"<think>[\s\S]*?</think>", "", source, flags=re.IGNORECASE)
    return re.sub(r"</?think>", "", cleaned, flags=re.IGNORECASE).strip()


def _contains_markdown_table(text: str) -> bool:
    source = str(text or "")
    return bool(re.search(r"^\s*\|.+\|\s*$\n\s*\|\s*[-: ]+\|", source, flags=re.MULTILINE))


def _extract_first_markdown_table(text: str) -> str:
    lines = str(text or "").splitlines()
    i = 0
    while i + 1 < len(lines):
        header = lines[i].strip()
        divider = lines[i + 1].strip()
        is_header = header.startswith("|") and "|" in header
        is_divider = divider.startswith("|") and set(divider.replace("|", "").replace("-", "").replace(":", "").replace(" ", "")) == set()
        if not (is_header and is_divider):
            i += 1
            continue
        block = [lines[i], lines[i + 1]]
        j = i + 2
        while j < len(lines):
            row = lines[j].strip()
            if not row.startswith("|") or "|" not in row:
                break
            block.append(lines[j])
            j += 1
        return "\n".join(block).strip()
    return ""


def _sanitize_storyboard_markdown(text: str) -> str:
    source = str(text or "")
    if not source.strip():
        return ""
    direct_table = _extract_first_markdown_table(source)
    if direct_table:
        return direct_table
    cleaned = _strip_storyboard_thinking_content(source)
    if not cleaned:
        return ""
    fenced_blocks = re.findall(r"```(?:markdown|md)?\s*([\s\S]*?)```", cleaned, flags=re.IGNORECASE)
    for block in fenced_blocks:
        candidate = str(block or "").strip()
        table = _extract_first_markdown_table(candidate)
        if table:
            return table
    table = _extract_first_markdown_table(cleaned)
    if table:
        return table
    return cleaned


def _extract_storyboard_thinking_text(content_text: str, reasoning_text: str) -> str:
    parts: list[str] = []
    direct_reasoning = str(reasoning_text or "").strip()
    if direct_reasoning:
        parts.append(direct_reasoning)
    source = str(content_text or "")
    think_blocks = re.findall(r"<think>([\s\S]*?)</think>", source, flags=re.IGNORECASE)
    for block in think_blocks:
        value = str(block or "").strip()
        if value:
            parts.append(value)
    merged = "\n\n".join(parts).strip()
    return re.sub(r"</?think>", "", merged, flags=re.IGNORECASE).strip()


def _normalize_mode_model(mode: str, model: Optional[str]) -> str:
    return _OPENROUTER_TEXT_MODEL


def _is_upstream_rate_limited(message: str) -> bool:
    text = str(message or "").strip().lower()
    if not text:
        return False
    return (
        "http 429" in text
        or " 429 " in f" {text} "
        or "quota exceeded" in text
        or "request limit per minute" in text
        or "rate limit" in text
        or "too many requests" in text
    )


async def _collect_storyboard_stream_output(
    session: AsyncSession,
    user_id: str,
    model: str,
    attempt_user_prompt: str,
    temperature: float,
) -> tuple[str, str]:
    content_chunks: list[str] = []
    reasoning_chunks: list[str] = []
    async for chunk in create_chat_completion_stream(
        session,
        user_id,
        {
            "model": model,
            "messages": [
                {"role": "system", "content": PROMPT_STORYBOARD},
                {"role": "user", "content": attempt_user_prompt},
            ],
            "temperature": temperature,
            "max_tokens": 120000,
            "thinking": {"type": "disabled"},
        },
    ):
        if isinstance(chunk, str):
            if chunk.startswith("Error:"):
                raise RuntimeError(chunk[6:].strip() or "分镜生成失败")
            continue
        if not isinstance(chunk, dict):
            continue
        choices = chunk.get("choices") if isinstance(chunk, dict) else None
        if not choices:
            continue
        first_choice = choices[0] if isinstance(choices[0], dict) else {}
        delta = first_choice.get("delta") if isinstance(first_choice, dict) else None
        piece = None
        reason_piece = None
        if isinstance(delta, dict):
            piece = delta.get("content")
            reason_piece = delta.get("reasoning_content")
        if isinstance(first_choice.get("message"), dict):
            msg_obj = first_choice.get("message")
            if not piece:
                piece = msg_obj.get("content")
            if not reason_piece:
                reason_piece = msg_obj.get("reasoning_content")
        if piece:
            content_chunks.append(str(piece))
        if reason_piece:
            reasoning_chunks.append(str(reason_piece))
    return "".join(content_chunks), "".join(reasoning_chunks)


async def _collect_storyboard_stream_output_with_retry(
    session: AsyncSession,
    user_id: str,
    model: str,
    attempt_user_prompt: str,
    temperature: float,
    max_retries: int = 3,
) -> tuple[str, str]:
    retries = max(1, int(max_retries))
    for index in range(retries):
        try:
            return await _collect_storyboard_stream_output(session, user_id, model, attempt_user_prompt, temperature)
        except Exception as exc:
            if not _is_upstream_rate_limited(str(exc)):
                raise
            if index >= retries - 1:
                raise RuntimeError(f"分镜生成失败：上游限流（429），请稍后重试。原始错误：{exc}") from exc
            delay_seconds = min(12, 2 * (index + 1))
            logger.warning(
                "Storyboard rate limit, retrying task user=%s attempt=%s/%s delay=%ss error=%s",
                user_id,
                index + 1,
                retries,
                delay_seconds,
                str(exc)[:300],
            )
            await asyncio.sleep(delay_seconds)
    raise RuntimeError("分镜生成失败：上游限流（429），请稍后重试")


def _cn_numeral_to_int(raw: str) -> Optional[int]:
    text = str(raw or "").strip()
    if not text:
        return None
    if text.isdigit():
        return int(text)

    mapping = {
        "零": 0,
        "〇": 0,
        "一": 1,
        "二": 2,
        "两": 2,
        "三": 3,
        "四": 4,
        "五": 5,
        "六": 6,
        "七": 7,
        "八": 8,
        "九": 9,
    }
    if text == "十":
        return 10
    if "十" in text:
        left, right = text.split("十", 1)
        tens = mapping.get(left, 1 if left == "" else None)
        if tens is None:
            return None
        ones = mapping.get(right, 0 if right == "" else None)
        if ones is None:
            return None
        return tens * 10 + ones

    total = 0
    for ch in text:
        if ch not in mapping:
            return None
        total = total * 10 + mapping[ch]
    return total if total > 0 else None


def _episode_text_mentions_all(text: str) -> bool:
    value = str(text or "")
    return any(k in value for k in ["跨集", "每集", "全程", "贯穿", "通篇", "多集"])


def _extract_episode_numbers(text: str) -> set[int]:
    source = str(text or "")
    values: set[int] = set()

    for match in re.finditer(r"第\s*([^\n\r，,；;。]{1,40})\s*集", source):
        token = (match.group(1) or "").strip()
        if not token:
            continue
        normalized = token.replace("至", "-").replace("~", "-").replace("～", "-")
        parts = re.split(r"[、，,/\s]+", normalized)
        for part in parts:
            part = part.strip()
            if not part:
                continue
            part = re.sub(r"^第", "", part)
            if "-" in part:
                left, right = [p.strip() for p in part.split("-", 1)]
                start = _cn_numeral_to_int(left)
                end = _cn_numeral_to_int(right)
                if start and end:
                    if start <= end:
                        values.update(range(start, end + 1))
                    else:
                        values.update(range(end, start + 1))
                continue
            parsed = _cn_numeral_to_int(part)
            if parsed:
                values.add(parsed)

    for match in re.finditer(r"(?<!第)(\d+)\s*集", source):
        try:
            values.add(int(match.group(1)))
        except Exception:
            continue

    return values


_STEP2_SEPARATOR = "\n\n=== 原文剧本 (请勿删除此行) ===\n\n"
_STEP2_TASK_TYPE = "STEP2"


def _strip_thinking_content(text: str) -> str:
    source = str(text or "")
    cleaned = re.sub(r"<think>[\s\S]*?</think>", "", source, flags=re.IGNORECASE)
    if re.search(r"<think>", cleaned, flags=re.IGNORECASE) and not re.search(r"</think>", cleaned, flags=re.IGNORECASE):
        idx = re.search(r"<think>", cleaned, flags=re.IGNORECASE)
        if idx:
            cleaned = cleaned[: idx.start()]
    cleaned = re.sub(r"</?think>", "", cleaned, flags=re.IGNORECASE)
    return cleaned.strip()


_STEP2_TARGET_LABELS: dict[Step2TaskTarget, str] = {
    "character": "角色",
    "prop": "道具",
    "scene": "场景",
}
_STEP2_SECTION_ALIASES: dict[Step2TaskTarget, tuple[str, ...]] = {
    "character": ("角色", "角色列表"),
    "prop": ("道具", "道具列表"),
    "scene": ("场景", "场景列表"),
}
_STEP2_TARGET_PROMPTS: dict[str, str] = {
    "character": PROMPT_EXTRACT_RESOURCES,
    "prop": PROMPT_EXTRACT_PROPS,
    "scene": PROMPT_EXTRACT_SCENES,
}
_STEP2_TARGET_MERGE_PROMPTS: dict[str, str] = {
    "character": PROMPT_STEP2_MERGE_CHARACTERS,
    "prop": PROMPT_STEP2_MERGE_PROPS,
    "scene": PROMPT_STEP2_MERGE_SCENES,
}
_STEP2_MAX_GROUP_CHARS = 24000
_STEP2_MAX_SINGLE_EPISODE_CHARS = 18000
_STEP2_MAX_MERGE_INPUT_CHARS = 90000
_step2_save_locks: dict[str, asyncio.Lock] = {}


def _normalize_step2_target(value: Any) -> str:
    raw = str(value or "").strip().lower()
    return raw if raw in _STEP2_TARGET_LABELS else ""


def _split_step2_resources_sections(text: str) -> dict[str, str]:
    sections = {key: "" for key in _STEP2_TARGET_LABELS}
    source = str(text or "").replace("\r\n", "\n").replace("\r", "\n")
    if not source.strip():
        return sections

    alias_to_target: dict[str, str] = {}
    for target, aliases in _STEP2_SECTION_ALIASES.items():
        for alias in aliases:
            alias_to_target[alias] = target

    current_target = ""
    buffer: list[str] = []
    found_section = False

    def _flush() -> None:
        nonlocal buffer, current_target
        if current_target:
            sections[current_target] = "\n".join(buffer).strip()
        buffer = []

    for raw_line in source.split("\n"):
        normalized = raw_line.strip().lstrip("#").strip()
        normalized = normalized.rstrip("：:").strip()
        target = alias_to_target.get(normalized, "")
        if target:
            found_section = True
            _flush()
            current_target = target
            continue
        if current_target:
            buffer.append(raw_line)
    _flush()

    if found_section:
        return sections
    sections["character"] = source.strip()
    return sections


def _compose_step2_resources_sections(sections: dict[str, str]) -> str:
    if not any(str(sections.get(target) or "").strip() for target in _STEP2_TARGET_LABELS):
        return ""
    blocks: list[str] = []
    for target in ("character", "prop", "scene"):
        label = _STEP2_TARGET_LABELS[target]
        body = str(sections.get(target) or "").strip()
        blocks.append(f"## {label}\n\n{body}".rstrip())
    return "\n\n".join(blocks).strip()


def _split_long_text_by_paragraphs(text: str, title: str, max_chars: int) -> list[dict[str, str]]:
    normalized = str(text or "").strip()
    if not normalized:
        return []
    paragraphs = [item.strip() for item in re.split(r"\n\s*\n", normalized) if item.strip()]
    if not paragraphs:
        paragraphs = [normalized]
    chunks: list[str] = []
    current = ""
    for paragraph in paragraphs:
        candidate = f"{current}\n\n{paragraph}".strip() if current else paragraph
        if current and len(candidate) > max_chars:
            chunks.append(current)
            current = paragraph
            continue
        if len(paragraph) <= max_chars:
            current = candidate
            continue
        lines = [line for line in paragraph.splitlines() if line.strip()]
        if not lines:
            lines = [paragraph]
        line_buffer = ""
        for line in lines:
            line_candidate = f"{line_buffer}\n{line}".strip() if line_buffer else line
            if line_buffer and len(line_candidate) > max_chars:
                chunks.append(line_buffer)
                line_buffer = line
                continue
            if len(line) <= max_chars:
                line_buffer = line_candidate
                continue
            for start in range(0, len(line), max_chars):
                piece = line[start : start + max_chars].strip()
                if piece:
                    if line_buffer:
                        chunks.append(line_buffer)
                        line_buffer = ""
                    chunks.append(piece)
        if line_buffer:
            if current:
                chunks.append(current)
                current = ""
            chunks.append(line_buffer)
    if current:
        chunks.append(current)
    return [
        {"title": f"{title}（片段{index}）", "content": chunk}
        for index, chunk in enumerate(chunks, start=1)
        if str(chunk or "").strip()
    ]


def _split_script_into_episode_units(text: str) -> list[dict[str, str]]:
    source = str(text or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    if not source:
        return []
    pattern = re.compile(r"(?m)^[ \t]*[【\[]?\s*第\s*[0-9一二三四五六七八九十百零〇两]+\s*集(?:[^\n\r]*)$")
    matches = list(pattern.finditer(source))
    if not matches:
        return [{"title": "全文剧本", "content": source}]

    units: list[dict[str, str]] = []
    prefix = source[: matches[0].start()].strip()
    if prefix:
        units.append({"title": "剧本前置信息", "content": prefix})
    for index, match in enumerate(matches):
        start = match.start()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(source)
        block = source[start:end].strip()
        title = match.group(0).strip() or f"第{index + 1}集"
        if not block:
            continue
        if len(block) > _STEP2_MAX_SINGLE_EPISODE_CHARS:
            units.extend(_split_long_text_by_paragraphs(block, title, _STEP2_MAX_SINGLE_EPISODE_CHARS))
        else:
            units.append({"title": title, "content": block})
    return units or [{"title": "全文剧本", "content": source}]


def _build_step2_episode_groups(text: str, max_chars: int = _STEP2_MAX_GROUP_CHARS) -> list[str]:
    units = _split_script_into_episode_units(text)
    if not units:
        return []
    groups: list[str] = []
    current_parts: list[str] = []
    current_len = 0
    for unit in units:
        piece = str(unit.get("content") or "").strip()
        if not piece:
            continue
        estimated = len(piece) + 2
        if current_parts and current_len + estimated > max_chars:
            groups.append("\n\n".join(current_parts).strip())
            current_parts = []
            current_len = 0
        current_parts.append(piece)
        current_len += estimated
    if current_parts:
        groups.append("\n\n".join(current_parts).strip())
    return groups


async def _call_text_generation_once(
    db: AsyncSession,
    user_id: str,
    model: str,
    system_prompt: str,
    user_prompt: str,
    temperature: float = 0.1,
    max_tokens: int = 48000,
) -> str:
    response = await create_chat_completion(
        db,
        user_id,
        {
            "model": model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            "stream": False,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "thinking": {"type": "disabled"},
        },
    )
    content = ""
    if isinstance(response, dict):
        choices = response.get("choices") if isinstance(response, dict) else None
        if isinstance(choices, list) and choices:
            first_choice = choices[0] if isinstance(choices[0], dict) else {}
            message_obj = first_choice.get("message") if isinstance(first_choice, dict) else None
            if isinstance(message_obj, dict):
                content = str(message_obj.get("content") or "")
    cleaned = _strip_thinking_content(content)
    if not cleaned:
        raise RuntimeError("模型未返回可用内容")
    return cleaned


async def _generate_step2_target_content(
    db: AsyncSession,
    user_id: str,
    target: str,
    original_content: str,
    model: str,
) -> str:
    groups = _build_step2_episode_groups(original_content)
    if not groups:
        raise RuntimeError("剧本内容为空")
    system_prompt = _STEP2_TARGET_PROMPTS[target]
    merge_prompt = _STEP2_TARGET_MERGE_PROMPTS[target]
    chunk_outputs: list[str] = []
    total = len(groups)
    for index, group_text in enumerate(groups, start=1):
        user_prompt = (
            f"以下是剧本分片 {index}/{total}。请严格依据原文执行提取，保持格式稳定。"
            f"\n\n【剧本分片】\n{group_text}"
        )
        chunk_outputs.append(
            await _call_text_generation_once(
                db,
                user_id,
                model,
                system_prompt,
                user_prompt,
                temperature=0.1,
                max_tokens=36000,
            )
        )

    merge_blocks: list[str] = []
    current_len = 0
    merge_round_inputs = chunk_outputs
    force_single_merge = target == "prop"
    while True:
        if len(merge_round_inputs) == 1 and not force_single_merge:
            return merge_round_inputs[0].strip()
        force_single_merge = False
        next_round_outputs: list[str] = []
        merge_blocks = []
        current_len = 0
        for index, item in enumerate(merge_round_inputs, start=1):
            piece = f"=== 分片结果 {index} ===\n{item.strip()}"
            estimated = len(piece) + 4
            if merge_blocks and current_len + estimated > _STEP2_MAX_MERGE_INPUT_CHARS:
                merge_user_prompt = "\n\n".join(merge_blocks).strip()
                next_round_outputs.append(
                    await _call_text_generation_once(
                        db,
                        user_id,
                        model,
                        merge_prompt,
                        merge_user_prompt,
                        temperature=0.0,
                        max_tokens=36000,
                    )
                )
                merge_blocks = []
                current_len = 0
            merge_blocks.append(piece)
            current_len += estimated
        if merge_blocks:
            merge_user_prompt = "\n\n".join(merge_blocks).strip()
            next_round_outputs.append(
                await _call_text_generation_once(
                    db,
                    user_id,
                    model,
                    merge_prompt,
                    merge_user_prompt,
                    temperature=0.0,
                    max_tokens=36000,
                )
            )
        merge_round_inputs = next_round_outputs


async def _modify_step2_target_content(
    db: AsyncSession,
    user_id: str,
    target: str,
    resources_content: str,
    instruction: str,
    model: str,
) -> str:
    label = _STEP2_TARGET_LABELS[target]
    system_prompt = (
        f"你是专业的短剧{label}整理助手。请根据用户的修改要求，直接改写当前{label}提取结果。"
        f"保持当前{label}结果的结构化格式，不要输出解释。"
    )
    user_prompt = f"【当前{label}提取结果】\n{resources_content}\n\n【修改要求】\n{instruction}"
    return await _call_text_generation_once(
        db,
        user_id,
        model,
        system_prompt,
        user_prompt,
        temperature=0.1,
        max_tokens=24000,
    )


def _get_step2_save_lock(project_id: str) -> asyncio.Lock:
    lock = _step2_save_locks.get(project_id)
    if lock is None:
        lock = asyncio.Lock()
        _step2_save_locks[project_id] = lock
    return lock


async def _save_step2_target_result(
    db: AsyncSession,
    project_id: str,
    target: str,
    target_content: str,
    original_content: str,
) -> int:
    async with _get_step2_save_lock(project_id):
        latest = await get_active_script(db, project_id)
        latest_full_content = str(latest.content or "") if latest else ""
        latest_resources = ""
        latest_original = str(original_content or "")
        if _STEP2_SEPARATOR in latest_full_content:
            latest_resources, latest_original = latest_full_content.split(_STEP2_SEPARATOR, 1)
        elif latest_full_content.strip() and not latest_original.strip():
            latest_original = latest_full_content
        sections = _split_step2_resources_sections(latest_resources)
        sections[target] = str(target_content or "").strip()
        resources_text = _compose_step2_resources_sections(sections)
        full_content = f"{resources_text}{_STEP2_SEPARATOR}{latest_original}"
        if latest and full_content == latest_full_content:
            return int(latest.version or 0)
        saved = await save_script(db, project_id, full_content, None, None, None, None)
        return int(saved.version) if saved else int(latest.version or 0) if latest else 0


async def _generate_script_once(
    db: AsyncSession,
    user_id: str,
    payload: ScriptGenerateRequest,
    project_id: str,
) -> dict[str, str]:
    response = await generate_script(project_id=project_id, payload=payload, user_id=user_id, db=db)
    if isinstance(response, dict):
        return {
            "content": str(response.get("content") or ""),
            "thinking": str(response.get("thinking") or ""),
        }
    return {"content": "", "thinking": ""}


async def _run_step2_task(task_id: str) -> None:
    async with SessionLocal() as db:
        task = await get_async_task(db, task_id=task_id)
        if not task:
            return
        try:
            await mark_async_task_running(db, task)
            payload = json.loads(task.payload_json or "{}") if task.payload_json else {}
            op = str(payload.get("op") or "").strip().lower()
            target = _normalize_step2_target(payload.get("target"))
            project_id = str(task.project_id)
            user_id = str(task.user_id)
            original_content = str(payload.get("original_content") or "")
            resources_content = str(payload.get("resources_content") or "")
            model = str(payload.get("model") or "").strip() or _OPENROUTER_TEXT_MODEL
            instruction = str(payload.get("instruction") or "").strip()

            if op == "sync":
                if original_content or resources_content:
                    full_content = f"{resources_content}{_STEP2_SEPARATOR}{original_content}"
                    await save_script(db, project_id, full_content, None, None, None, None)
                await extract_assets_from_script(db, project_id, user_id, manual_only=True)
                latest = await get_active_script(db, project_id)
                await mark_async_task_completed(
                    db,
                    task,
                    {
                        "op": "sync",
                        "version": int(latest.version) if latest else 0,
                    },
                )
                return

            if not target:
                raise RuntimeError("缺少提取目标")

            if op == "extract":
                if not original_content.strip():
                    raise RuntimeError("内容为空")
                cleaned_resources = await _generate_step2_target_content(
                    db,
                    user_id,
                    target,
                    original_content,
                    model,
                )
            elif op == "modify":
                if not resources_content.strip():
                    raise RuntimeError("内容为空")
                if not instruction:
                    raise RuntimeError("修改要求为空")
                cleaned_resources = await _modify_step2_target_content(
                    db,
                    user_id,
                    target,
                    resources_content,
                    instruction,
                    model,
                )
            else:
                raise RuntimeError("不支持的任务操作")

            if not cleaned_resources.strip():
                raise RuntimeError("模型未返回可用内容")
            version = await _save_step2_target_result(
                db,
                project_id,
                target,
                cleaned_resources,
                original_content,
            )
            await mark_async_task_completed(
                db,
                task,
                {
                    "op": op,
                    "target": target,
                    "content": cleaned_resources,
                    "version": version,
                },
            )
        except Exception as exc:
            await mark_async_task_failed(db, task, str(exc))


async def _build_storyboard_prompt_user_content(
    db: AsyncSession,
    project_id: str,
    content: str,
    instruction: Optional[str],
    episode_index: Optional[int] = None,
) -> str:
    del db, project_id, instruction, episode_index
    return str(content or "").strip()


async def _run_storyboard_task(task_id: str) -> None:
    async with _storyboard_task_lock:
        task = _storyboard_tasks.get(task_id)
        if not task:
            return
        task["status"] = "running"
        task["started_at"] = datetime.utcnow().isoformat()
    try:
        async with SessionLocal() as session:
            user_prompt = await _build_storyboard_prompt_user_content(
                session,
                task["project_id"],
                task["episode_content"],
                task.get("instruction"),
                int(task.get("episode_index") or 0),
            )
            max_storyboard_attempts = 3
            generated = ""
            thinking_text = ""
            success_attempt = 0

            for attempt in range(max_storyboard_attempts):
                retry_tip = ""
                if attempt > 0:
                    retry_tip = (
                        "\n\n【重试强约束】\n"
                        "你上一轮输出未通过格式校验。"
                        "本轮必须且只能输出 Markdown 表格本体（含表头分隔线与数据行），"
                        "禁止输出解释、思考、过程描述、标题、段落、代码块标记。"
                    )
                attempt_user_prompt = f"{user_prompt}{retry_tip}"
                request_temperature = 0.2 if attempt == 0 else 0.1
                raw_content, raw_reasoning = await _collect_storyboard_stream_output_with_retry(
                    session,
                    str(task["user_id"]),
                    str(task["model"]),
                    attempt_user_prompt,
                    temperature=request_temperature,
                    max_retries=3,
                )
                thinking_candidate = _extract_storyboard_thinking_text(raw_content, raw_reasoning)
                generated_candidate = _sanitize_storyboard_markdown(raw_content)
                if (not generated_candidate or not _contains_markdown_table(generated_candidate)) and thinking_candidate:
                    combined_candidate = _sanitize_storyboard_markdown(f"{raw_content}\n\n{thinking_candidate}")
                    if _contains_markdown_table(combined_candidate):
                        generated_candidate = combined_candidate

                if not generated_candidate:
                    logger.warning(
                        "Storyboard empty after sanitize task_id=%s episode_index=%s attempt=%s/%s raw_content_head=%s raw_reasoning_head=%s",
                        task_id,
                        task.get("episode_index"),
                        attempt + 1,
                        max_storyboard_attempts,
                        raw_content[:300].replace("\n", "\\n"),
                        thinking_candidate[:300].replace("\n", "\\n"),
                    )
                    if attempt < max_storyboard_attempts - 1:
                        continue
                    if raw_content.strip() or thinking_candidate.strip():
                        raise RuntimeError("分镜生成失败：上游仅返回思考内容，未返回可用表格，请重试")
                    raise RuntimeError("分镜生成结果为空（上游返回空内容）")

                if not _contains_markdown_table(generated_candidate):
                    logger.warning(
                        "Storyboard non-table task_id=%s episode_index=%s attempt=%s/%s content_head=%s reasoning_head=%s",
                        task_id,
                        task.get("episode_index"),
                        attempt + 1,
                        max_storyboard_attempts,
                        generated_candidate[:300].replace("\n", "\\n"),
                        thinking_candidate[:300].replace("\n", "\\n"),
                    )
                    if attempt < max_storyboard_attempts - 1:
                        continue
                    raise RuntimeError("分镜生成失败：模型返回非表格内容，请重试")

                generated = generated_candidate
                thinking_text = thinking_candidate
                success_attempt = attempt + 1
                break

            if not generated:
                raise RuntimeError("分镜生成失败：模型未返回可用表格，请重试")

            generated = _ensure_storyboard_system_columns(generated)
            logger.info("Storyboard task completed task_id=%s project_id=%s episode_index=%s content_len=%s thinking_len=%s attempt=%s", task_id, task["project_id"], task["episode_index"], len(generated), len(thinking_text), success_attempt)

            script = await get_active_script(session, task["project_id"])
            episodes: list[dict[str, Any]] = []
            if script and script.episodes:
                parsed = json.loads(script.episodes)
                if isinstance(parsed, list):
                    episodes = [dict(item) for item in parsed]
            index = int(task["episode_index"])
            if index < 0 or index >= len(episodes):
                raise RuntimeError("分集索引已变化，请刷新后重试")
            target = dict(episodes[index])
            target["storyboard"] = generated
            target["storyboardTaskId"] = task_id
            target["storyboardTaskStatus"] = "completed"
            target["storyboardTaskError"] = ""
            target["storyboardTaskThinking"] = thinking_text
            episodes[index] = target
            storyboard_text = _build_storyboard_text_from_episodes(episodes)
            await save_script(
                session,
                task["project_id"],
                None,
                None,
                storyboard_text,
                None,
                episodes,
            )
            async with _storyboard_task_lock:
                latest = _storyboard_tasks.get(task_id) or {}
                latest["status"] = "completed"
                latest["content"] = generated
                latest["thinking"] = thinking_text
                latest["error"] = ""
                latest["finished_at"] = datetime.utcnow().isoformat()
                _storyboard_tasks[task_id] = latest
    except Exception as exc:
        logger.exception("Storyboard task failed task_id=%s project_id=%s episode_index=%s", task_id, task.get("project_id"), task.get("episode_index"))
        async with _storyboard_task_lock:
            latest = _storyboard_tasks.get(task_id) or {}
            latest["status"] = "failed"
            latest["error"] = str(exc)
            latest["finished_at"] = datetime.utcnow().isoformat()
            _storyboard_tasks[task_id] = latest
        try:
            async with SessionLocal() as session:
                script = await get_active_script(session, task["project_id"])
                episodes: list[dict[str, Any]] = []
                if script and script.episodes:
                    parsed = json.loads(script.episodes)
                    if isinstance(parsed, list):
                        episodes = [dict(item) for item in parsed]
                index = int(task["episode_index"])
                if 0 <= index < len(episodes):
                    target = dict(episodes[index])
                    target["storyboardTaskId"] = task_id
                    target["storyboardTaskStatus"] = "failed"
                    target["storyboardTaskError"] = str(exc)
                    target["storyboardTaskThinking"] = str((latest.get("thinking") if isinstance(latest, dict) else "") or "")
                    episodes[index] = target
                    await save_script(session, task["project_id"], None, None, None, None, episodes)
        except Exception:
            logger.exception("更新分镜任务失败状态时异常")


@router.post("/{project_id}/script/step2-tasks/start", response_model=AsyncTaskStatusResponse)
async def start_step2_task(
    project_id: str,
    payload: Step2TaskStartRequest,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
) -> AsyncTaskStatusResponse:
    project = await get_project(db, user_id, project_id)
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    if payload.op in {"extract", "modify"} and not payload.target:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="缺少提取目标")

    task = await create_async_task(
        db,
        project_id=project_id,
        user_id=user_id,
        task_type=_STEP2_TASK_TYPE,
        payload={
            "op": payload.op,
            "target": payload.target,
            "original_content": payload.original_content,
            "resources_content": payload.resources_content,
            "model": payload.model,
            "instruction": payload.instruction,
        },
    )
    asyncio.create_task(_run_step2_task(task.id))
    return AsyncTaskStatusResponse(
        task_id=task.id,
        project_id=project_id,
        task_type=_STEP2_TASK_TYPE,
        status="RUNNING",
        result=None,
        error=None,
    )


@router.get("/{project_id}/script/step2-tasks/{task_id}", response_model=AsyncTaskStatusResponse)
async def get_step2_task_status(
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
        task_type=_STEP2_TASK_TYPE,
    )
    if not task:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="任务不存在")

    status_upper = str(task.status or "PENDING").upper()
    if status_upper in {"PENDING", "RUNNING"}:
        now = datetime.utcnow()
        updated_at = task.updated_at or task.created_at or now
        stale_seconds = (now - updated_at).total_seconds()
        if stale_seconds > 600:
            fail_message = "任务状态丢失（服务重启或任务中断），请重新执行"
            task = await mark_async_task_failed(db, task, fail_message)
            status_upper = "FAILED"

    return AsyncTaskStatusResponse(
        task_id=task.id,
        project_id=project_id,
        task_type=task.task_type,
        status=status_upper,
        result=parse_task_result(task),
        error=(str(task.error or "").strip() or None),
    )


@router.get("/{project_id}/script", response_model=ScriptResponse)
async def fetch_script(
    project_id: str,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
) -> ScriptResponse:
    project = await get_project(db, user_id, project_id)
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    script = await get_active_script(db, project_id)
    if script and not has_meaningful_script_data(script):
        fallback = await get_latest_meaningful_script(db, project_id)
        if fallback:
            script = fallback
    if not script:
        return ScriptResponse(project_id=project_id, content="")
    return ScriptResponse(
        id=script.id,
        project_id=project_id,
        content=script.content,
        thinking=script.thinking,
        storyboard=script.storyboard,
        outline=script.outline,
        episodes=json.loads(script.episodes) if script.episodes else None,
        version=script.version,
        is_active=script.is_active,
        created_at=script.created_at.isoformat() if script.created_at else None,
    )


@router.post("/{project_id}/script", response_model=ScriptResponse)
async def update_script(
    project_id: str,
    payload: ScriptRequest,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
) -> ScriptResponse:
    project = await get_project(db, user_id, project_id)
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    script = await save_script(
        db, 
        project_id, 
        payload.content, 
        payload.thinking, 
        payload.storyboard,
        payload.outline,
        payload.episodes
    )
    episodes_payload = json.loads(script.episodes) if script.episodes else None
    snapshot = "\n\n".join(
        part
        for part in (
            script.content or "",
            script.storyboard or "",
            script.outline or "",
        )
        if (part or "").strip()
    )
    state_payload = {
        "id": script.id,
        "project_id": project_id,
        "content": script.content,
        "thinking": script.thinking,
        "storyboard": script.storyboard,
        "outline": script.outline,
        "episodes": episodes_payload,
        "version": script.version,
        "is_active": script.is_active,
        "created_at": script.created_at.isoformat() if script.created_at else None,
    }
    state_url = await media_storage.upload_script_state_to_cos(project_id, script.version, state_payload)
    markdown_url = await media_storage.upload_script_snapshot_to_cos(project_id, script.version, snapshot or (script.content or ""))
    return _build_script_response(script, project_id, state_url=state_url, markdown_url=markdown_url)


@router.get("/{project_id}/script/history", response_model=ScriptHistoryResponse)
async def fetch_script_history(
    project_id: str,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
) -> ScriptHistoryResponse:
    project = await get_project(db, user_id, project_id)
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    history = await get_script_history(db, project_id)
    
    items = []
    for item in history:
        items.append(ScriptHistoryItem(
            id=item.id,
            project_id=item.project_id,
            content=item.content,
            thinking=item.thinking,
            storyboard=item.storyboard,
            outline=item.outline,
            episodes=json.loads(item.episodes) if item.episodes else None,
            version=item.version,
            is_active=item.is_active,
            created_at=item.created_at.isoformat() if item.created_at else ""
        ))
    return ScriptHistoryResponse(items=items)


@router.delete("/{project_id}/script/history/{version_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_script_version_endpoint(
    project_id: str,
    version_id: str,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
):
    project = await get_project(db, user_id, project_id)
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    
    success = await delete_script(db, project_id, version_id)
    if not success:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="脚本版本不存在")
    
    return None


@router.post("/{project_id}/script/validate", response_model=ScriptValidationResponse)
async def validate_script(
    project_id: str,
    payload: ScriptValidationRequest,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
) -> ScriptValidationResponse:
    project = await get_project(db, user_id, project_id)
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    
    result = await run_validation(db, user_id, payload.content, payload.model)
    return ScriptValidationResponse(
        valid=result.valid,
        missing=result.errors, # map errors to missing for now or fix schema
        warnings=result.warnings
    )


@router.post("/{project_id}/script/storyboard-tasks/start", response_model=StoryboardTaskStatusResponse)
async def start_storyboard_task(
    project_id: str,
    payload: StoryboardTaskStartRequest,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
) -> StoryboardTaskStatusResponse:
    project = await get_project(db, user_id, project_id)
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")

    episode_index = int(payload.episode_index)
    if episode_index < 0:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="分集索引无效")
    episode_title = str(payload.episode_title or "").strip() or f"第{episode_index + 1}集"
    episode_content = str(payload.episode_content or "").strip()
    if not episode_content:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="分集内容为空，无法生成分镜")
    model = _normalize_mode_model("generate_storyboard", payload.model)

    existing_task: Optional[dict[str, Any]] = None
    async with _storyboard_task_lock:
        for item in _storyboard_tasks.values():
            if (
                item.get("project_id") == project_id
                and item.get("user_id") == user_id
                and int(item.get("episode_index", -1)) == episode_index
                and item.get("status") in {"pending", "running"}
            ):
                existing_task = item
                break
        if not existing_task:
            task_id = str(uuid4())
            task = {
                "task_id": task_id,
                "project_id": project_id,
                "user_id": user_id,
                "episode_index": episode_index,
                "episode_title": episode_title,
                "episode_content": episode_content,
                "instruction": payload.instruction,
                "model": model,
                "status": "pending",
                "content": None,
                "thinking": None,
                "error": None,
                "created_at": datetime.utcnow().isoformat(),
                "started_at": None,
                "finished_at": None,
            }
            _storyboard_tasks[task_id] = task
            existing_task = task

    status_value = str(existing_task.get("status") or "running")
    if status_value == "pending":
        asyncio.create_task(_run_storyboard_task(str(existing_task["task_id"])))
        status_value = "running"
        async with _storyboard_task_lock:
            latest = _storyboard_tasks.get(str(existing_task["task_id"]))
            if latest:
                latest["status"] = "running"
                existing_task = latest

    script = await get_active_script(db, project_id)
    episodes: list[dict[str, Any]] = []
    if script and script.episodes:
        parsed = json.loads(script.episodes)
        if isinstance(parsed, list):
            episodes = [dict(item) for item in parsed]
    if 0 <= episode_index < len(episodes):
        target = dict(episodes[episode_index])
        target["storyboardTaskId"] = str(existing_task["task_id"])
        target["storyboardTaskStatus"] = status_value
        target["storyboardTaskError"] = ""
        target["storyboardTaskThinking"] = str(existing_task.get("thinking") or "")
        episodes[episode_index] = target
        await save_script(db, project_id, None, None, None, None, episodes)

    return StoryboardTaskStatusResponse(
        task_id=str(existing_task["task_id"]),
        project_id=project_id,
        episode_index=episode_index,
        episode_title=episode_title,
        status=status_value if status_value in {"pending", "running", "completed", "failed"} else "running",
        content=existing_task.get("content"),
        thinking=existing_task.get("thinking"),
        error=existing_task.get("error"),
    )


@router.get("/{project_id}/script/storyboard-tasks/{task_id}", response_model=StoryboardTaskStatusResponse)
async def get_storyboard_task_status(
    project_id: str,
    task_id: str,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
) -> StoryboardTaskStatusResponse:
    project = await get_project(db, user_id, project_id)
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    async with _storyboard_task_lock:
        task = _storyboard_tasks.get(task_id)
    if not task or task.get("project_id") != project_id or task.get("user_id") != user_id:
        script = await get_active_script(db, project_id)
        episodes: list[dict[str, Any]] = []
        if script and script.episodes:
            parsed = json.loads(script.episodes)
            if isinstance(parsed, list):
                episodes = [dict(item) for item in parsed]
        for index, episode in enumerate(episodes):
            if str(episode.get("storyboardTaskId") or "").strip() != task_id:
                continue
            status_value = str(episode.get("storyboardTaskStatus") or "running")
            if status_value not in {"pending", "running", "completed", "failed"}:
                status_value = "running"
            if status_value in {"pending", "running"}:
                fail_message = "任务状态丢失（服务重启或任务过期），请重新生成"
                patched = dict(episode)
                patched["storyboardTaskStatus"] = "failed"
                patched["storyboardTaskError"] = fail_message
                patched["storyboardTaskThinking"] = str(patched.get("storyboardTaskThinking") or "")
                episodes[index] = patched
                await save_script(db, project_id, None, None, None, None, episodes)
                status_value = "failed"
                episode = patched
            return StoryboardTaskStatusResponse(
                task_id=task_id,
                project_id=project_id,
                episode_index=index,
                episode_title=str(episode.get("title") or f"第{index + 1}集"),
                status=status_value,
                content=str(episode.get("storyboard") or "") if status_value == "completed" else None,
                thinking=str(episode.get("storyboardTaskThinking") or "") if status_value in {"completed", "failed"} else None,
                error=str(episode.get("storyboardTaskError") or "") if status_value == "failed" else None,
            )
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="任务不存在")
    status_value = str(task.get("status") or "running")
    if status_value not in {"pending", "running", "completed", "failed"}:
        status_value = "running"
    return StoryboardTaskStatusResponse(
        task_id=str(task.get("task_id") or task_id),
        project_id=project_id,
        episode_index=int(task.get("episode_index") or 0),
        episode_title=str(task.get("episode_title") or ""),
        status=status_value,
        content=str(task.get("content") or "") if status_value == "completed" else None,
        thinking=str(task.get("thinking") or "") if status_value in {"completed", "failed"} else None,
        error=str(task.get("error") or "") if status_value == "failed" else None,
    )


@router.post("/{project_id}/script/generate")
async def generate_script(
    project_id: str,
    payload: ScriptGenerateRequest,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
):
    project = await get_project(db, user_id, project_id)
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")

    settings = await get_or_create_settings(db, user_id)
    model = _normalize_mode_model(payload.mode, payload.model or settings.default_model_text)
    
    system_prompt = get_system_prompt(payload.mode)
    user_prompt = payload.content
    
    if payload.mode == "generate_storyboard":
        system_prompt = PROMPT_STORYBOARD
        user_prompt = await _build_storyboard_prompt_user_content(db, project_id, payload.content, payload.instruction, None)
    
    if payload.mode == "suggestion_paid":
        system_prompt = PROMPT_SUGGESTION_PAID
        if payload.instruction:
            user_prompt = f"{payload.instruction}\n\n当前内容：\n{payload.content}"
    elif payload.mode == "suggestion_traffic":
        system_prompt = PROMPT_SUGGESTION_TRAFFIC
        if payload.instruction:
            user_prompt = f"{payload.instruction}\n\n当前内容：\n{payload.content}"
    elif payload.mode == "extract_outline":
        system_prompt = PROMPT_EXTRACT_OUTLINE
        user_prompt = f"请根据以下剧本提炼大纲：\n\n{payload.content}"
    elif payload.mode == "step0_generate":
        system_prompt = "你是一个专业的短剧编剧。请根据用户提供的主题、角色和分集大纲，创作一个完整的短剧剧本。格式要求：包含【剧本基本信息】、【人物小传】、【正文剧本】等标准部分。"
        
        user_prompt = payload.content
        if payload.instruction:
            user_prompt = f"{user_prompt}\n\n【创作要求】\n{payload.instruction}"

        # Use Pro model for Step 0 but disable thinking mode
        model = _OPENROUTER_TEXT_MODEL
    elif payload.mode == "step0_continue":
        system_prompt = """你是一个专业的短剧编剧。请严格按照用户提供的上下文信息进行续写。
请仔细区分以下信息块：
1. 【写作规范】：必须遵守的文风、格式和禁忌。
2. 【角色设定】：角色性格、背景和关系，必须保持一致。
3. 【前文剧情】：前文剧情，续写内容必须紧接其后，逻辑连贯。
4. 【续写要求】（Instruction）：用户对后续剧情的具体指令。

请只输出新生成的集的内容（例如“第X集：...”），不要重复已有的内容，也不要输出任何解释性文字。"""

        # Combine content (Context) and instruction (User Prompt) explicitly
        context_block = payload.content
        instruction_block = payload.instruction or "请根据上下文续写下一集。"
        
        user_prompt = f"""{context_block}

【续写要求】
{instruction_block}"""
        
        model = _OPENROUTER_TEXT_MODEL
    elif payload.mode == "step0_modify":
        system_prompt = """你是一个专业的短剧编剧。请根据用户提供的上下文信息（包含写作规范、角色设定、完整剧本）以及修改要求，对【指定集数】的内容进行修改。
请仔细区分以下信息块：
1. 【写作规范】：必须遵守的文风、格式和禁忌。
2. 【角色设定】：角色性格、背景和关系，必须保持一致。
3. 【完整剧本】：参考上下文，确保修改后的内容与整体剧情连贯。
4. 【修改要求】（Instruction）：用户对该集内容的具体修改指令。

请只输出修改后的该集完整内容，不要输出其他集，也不要输出解释性文字。"""
        
        # Combine content (Context) and instruction (User Prompt) explicitly
        context_block = payload.content
        instruction_block = payload.instruction or "请修改本集内容。"
        
        user_prompt = f"""{context_block}

【修改要求】
{instruction_block}"""
        
        model = _OPENROUTER_TEXT_MODEL
    elif payload.mode == "split_script":
        system_prompt = PROMPT_SPLIT_SCRIPT
        user_prompt = f"请将以下剧本进行分集拆分：\n\n{payload.content}"
    elif payload.instruction:
         user_prompt = f"{payload.instruction}\n\n当前内容：\n{payload.content}"

    temperature = 0.2 if payload.mode == "generate_storyboard" else 0.7
    api_payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt}
        ],
        "stream": True,
        "temperature": temperature,
        # Set a very large max_tokens for Step 0 generation/rewriting to avoid truncation
        # Doubao 2.0 Pro supports up to 128k output tokens
        "max_tokens": 120000 
    }
    
    # Disable thinking mode for Step 0 only if explicitly requested or for legacy compatibility
    # User requested thinking mode for step0_modify, so we allow it there.
    if payload.mode in ["step0_generate", "split_script"]:
        api_payload["thinking"] = {"type": "disabled"}

    if payload.stream is False:
        non_stream_payload = dict(api_payload)
        non_stream_payload["stream"] = False
        response = await create_chat_completion(db, user_id, non_stream_payload)
        content = ""
        thinking = ""
        if isinstance(response, dict):
            choices = response.get("choices")
            if isinstance(choices, list) and choices:
                first_choice = choices[0] if isinstance(choices[0], dict) else {}
                message_obj = first_choice.get("message") if isinstance(first_choice, dict) else None
                if isinstance(message_obj, dict):
                    content = str(message_obj.get("content") or "").strip()
                    thinking = str(message_obj.get("reasoning_content") or "").strip()
        if not content:
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="模型未返回可用内容，请稍后重试")
        if payload.mode == "generate_storyboard":
            content = _ensure_storyboard_system_columns(content)
        return {"content": content, "thinking": thinking}

    async def event_generator():
        try:
            async for chunk in create_chat_completion_stream(db, user_id, api_payload):
                 # Check if chunk is a dict (parsed JSON) or raw bytes/string
                if isinstance(chunk, dict):
                    error_obj = chunk.get("error")
                    error_text = ""
                    if isinstance(error_obj, str):
                        error_text = error_obj.strip()
                    elif isinstance(error_obj, dict):
                        error_text = str(error_obj.get("message") or error_obj.get("code") or "").strip()
                    if error_text:
                        yield f"data: {json.dumps({'error': error_text})}\n\n"
                        return
                    delta = chunk.get("choices", [{}])[0].get("delta", {})
                    content = delta.get("content", "")
                    reasoning = delta.get("reasoning_content", "")
                    if content or reasoning:
                        yield f"data: {json.dumps({'choices': [{'delta': {'content': content, 'reasoning_content': reasoning}}]})}\n\n"
                elif isinstance(chunk, str):
                    if chunk.startswith("Error:"):
                         yield f"data: {json.dumps({'error': chunk})}\n\n"
                    else:
                         # If it's already a string, assume it's content
                         yield f"data: {json.dumps({'choices': [{'delta': {'content': chunk}}]})}\n\n"
            yield "data: [DONE]\n\n"
        except Exception as e:
                import traceback
                traceback.print_exc()
                logger.error(f"Stream error: {e}")
                yield f"data: {json.dumps({'error': str(e)})}\n\n"

    return StreamingResponse(event_generator(), media_type="text/event-stream")


@router.post("/parse", response_model=ScriptParseResponse)
async def parse_script_file(
    file: UploadFile = File(...),
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
):
    try:
        content = await file.read()
        file_text = read_file_content(content, file.filename)
        
        # Use Locator Strategy to avoid long generation times
        prompt = f"""
        请分析以下剧本文件，提取关键信息。
        
        提取任务：
        1. 提取“角色列表”（characters）：请使用 Locator Strategy 定位原文中每个角色的完整设定段落。
           - name: 角色真实姓名。
           - start_snippet: 该角色完整设定段落（包含姓名、外貌、性格、小传等所有信息）开始的前50-100个字符。请直接复制原文，不要自己手写。
           - end_snippet: 该角色完整设定段落结束的最后50-100个字符（通常是人物小传的结尾）。请直接复制原文，不要自己手写。
        2. 提取“分集标记”（episode_markers）：识别每一集的起始和结束位置。
           - 对于每一集，请提供：
             - title: 集名（如“第一集”）
             - start_snippet: 该集开始的前50-100个字符（务必包含集名/场景号等唯一标识，确保能在原文中定位，请直接复制原文，不要自己手写）
             - end_snippet: 该集结束的最后50-100个字符（请直接复制原文，不要自己手写）
        
        请直接返回JSON格式的数据。
        JSON格式要求如下：
        {{
            "theme": "主题",
            "characters": [
                {{"name": "角色名", "bio": "小传"}},
                ...
            ],
            "episode_markers": [
                {{
                    "title": "第一集",
                    "start_snippet": "...", 
                    "end_snippet": "..."
                }},
                ...
            ]
        }}
        
        文件内容（前45000字符）：
        {file_text[:45000]} 
        """

        payload = {
            "model": _OPENROUTER_TEXT_MODEL,
            "messages": [
                {"role": "system", "content": "你是一个严谨的剧本分析助手。请提取元数据和定位信息，不要生成剧本正文内容。"},
                {"role": "user", "content": prompt}
            ],
            "temperature": 0.0,
            "max_tokens": 64000,
            "thinking": {"type": "disabled"}
        }

        # Call LLM
        response_data = await create_chat_completion(db, user_id, payload)
        
        # Parse response
        if isinstance(response_data, dict):
             content_str = response_data.get("choices", [{}])[0].get("message", {}).get("content", "")
        else:
             content_str = str(response_data)

        # Remove Markdown code blocks if present
        content_str = content_str.strip()
        if content_str.startswith("```json"):
            content_str = content_str[7:]
        elif content_str.startswith("```"):
            content_str = content_str[3:]
        if content_str.endswith("```"):
            content_str = content_str[:-3]
        
        try:
            parsed_data = json.loads(content_str)
        except json.JSONDecodeError:
            # Fallback: try to clean up or just return empty
            logger.error(f"Failed to parse JSON: {content_str}")
            return ScriptParseResponse(theme="解析失败", characters=[], episodes=[])

        def find_best_match(text, snippet, start_pos=0):
            """
            Try to find snippet in text with various strategies.
            Returns start index or -1.
            """
            if not snippet:
                return -1
            
            # Pre-processing: Normalize snippet and text for better matching
            # Replace Chinese quotes and punctuation with standard ones or spaces?
            # No, keep it simple first.
            
            # 1. Exact match
            idx = text.find(snippet, start_pos)
            if idx != -1:
                return idx
            
            # 2. Strip whitespace
            snippet_stripped = snippet.strip()
            idx = text.find(snippet_stripped, start_pos)
            if idx != -1:
                return idx
                
            # 3. First 20 chars (if snippet is long enough)
            if len(snippet) > 20:
                short_snip = snippet[:20]
                idx = text.find(short_snip, start_pos)
                if idx != -1:
                    return idx
            
            # 4. Regex fuzzy match (ignore whitespace differences)
            try:
                # Escape special regex chars
                parts = snippet.split()
                # Join with \s* to allow flexible whitespace
                pattern = r"\s*".join([re.escape(p) for p in parts])
                if len(pattern) > 5: # Avoid too short patterns matching everywhere
                     regex = re.compile(pattern, re.DOTALL)
                     match = regex.search(text, start_pos)
                     if match:
                         return match.start()
            except Exception as e:
                logger.warning(f"Regex match failed for snippet: {snippet[:20]}... Error: {e}")
            
            return -1

        # Extract episodes using markers
        episodes = []
        markers = parsed_data.get("episode_markers", [])
        
        # Locate all start positions
        found_markers = []
        for marker in markers:
            title = marker.get("title", "未知集")
            start_snip = marker.get("start_snippet", "")
            end_snip = marker.get("end_snippet", "")
            
            start_idx = find_best_match(file_text, start_snip)
            if start_idx != -1:
                found_markers.append({
                    "title": title,
                    "start_idx": start_idx,
                    "end_snip": end_snip
                })
            else:
                logger.warning(f"Episode {title} start snippet not found: {start_snip[:20]}...")
        
        # Sort by position
        found_markers.sort(key=lambda x: x["start_idx"])
        
        # Extract content based on intervals
        for i in range(len(found_markers)):
            current_marker = found_markers[i]
            start_idx = current_marker["start_idx"]
            title = current_marker["title"]
            
            # Determine end index
            if i < len(found_markers) - 1:
                # End is the start of next episode
                end_idx = found_markers[i+1]["start_idx"]
            else:
                # Last episode: try to find end_snip
                end_snip = current_marker["end_snip"]
                end_idx = find_best_match(file_text, end_snip, start_idx)
                if end_idx != -1:
                    end_idx += len(end_snip)
                else:
                    # If end snippet not found, assume end of file
                    end_idx = len(file_text)
            
            # Extract and clean content
            content = file_text[start_idx:end_idx].strip()
            episodes.append(content)
        
        # Fallback if no episodes found
        if not episodes and len(file_text) > 0:
            logger.warning("No episode markers found. Returning full text as one episode.")
            episodes.append(file_text)

        # Extract characters using Locator Strategy
        characters = []
        for char in parsed_data.get("characters", []):
            name = char.get("name", "未知角色")
            start_snip = char.get("start_snippet", "")
            end_snip = char.get("end_snippet", "")
            
            bio = ""
            if start_snip:
                start_idx = find_best_match(file_text, start_snip)
                if start_idx != -1:
                    # Find end snippet after start snippet
                    if end_snip:
                        end_idx = find_best_match(file_text, end_snip, start_idx)
                        if end_idx != -1:
                            end_idx += len(end_snip)
                            bio = file_text[start_idx:end_idx].strip()
                        else:
                             logger.warning(f"Character {name} end snippet not found: {end_snip[:20]}...")
                             # Fallback: try to grab reasonable length (e.g. 500 chars)
                             bio = file_text[start_idx:start_idx+500].strip() + "..."
                    else:
                        # No end snippet provided, maybe just grab a chunk?
                         bio = file_text[start_idx:start_idx+500].strip() + "..."
                else:
                     logger.warning(f"Character {name} start snippet not found: {start_snip[:20]}...")
                     # If snippet fails, use whatever text was provided if any
                     bio = char.get("bio", "无法定位该角色信息")
            else:
                 # Fallback for legacy format or missing snippets
                 bio = char.get("bio", "角色信息缺失")
            
            characters.append({
                "name": name,
                "bio": bio
            })

        return ScriptParseResponse(
            theme="",
            characters=characters,
            episodes=episodes
        )

    except Exception as e:
        logger.error(f"Error parsing script file: {e}")
        raise HTTPException(status_code=500, detail=f"Script parsing failed: {str(e)}")
