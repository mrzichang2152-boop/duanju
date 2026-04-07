from __future__ import annotations
import os
import re
from typing import Optional, Union
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.script import Script
from app.models.segment import Segment
from app.models.segment_version import SegmentVersion
from app.services.script_validation import _extract_scenes_blocks, _extract_sections, _find_section


async def list_segments(session: AsyncSession, project_id: str) -> list[Segment]:
    result = await session.execute(
        select(Segment)
        .where(Segment.project_id == project_id)
        .order_by(Segment.order_index.asc(), Segment.created_at.asc())
    )
    return list(result.scalars().all())


async def list_segment_versions(session: AsyncSession, segment_id: str) -> list[SegmentVersion]:
    result = await session.execute(
        select(SegmentVersion)
        .where(SegmentVersion.segment_id == segment_id)
        .order_by(SegmentVersion.created_at.desc())
    )
    return list(result.scalars().all())


async def get_segment(session: AsyncSession, segment_id: str) -> Optional[Segment]:
    return await session.scalar(select(Segment).where(Segment.id == segment_id))


def _split_markdown_table_line(line: str) -> list[str]:
    stripped = str(line or "").strip()
    if stripped.startswith("|"):
        stripped = stripped[1:]
    if stripped.endswith("|"):
        stripped = stripped[:-1]
    return [part.strip() for part in stripped.split("|")]


async def _extract_segment_texts_from_script(session: AsyncSession, project_id: str) -> list[str]:
    script = await session.scalar(
        select(Script).where(Script.project_id == project_id, Script.is_active == True)
    )
    if not script:
        return []

    source_content = script.storyboard if script.storyboard and script.storyboard.strip() else script.content
    if not source_content:
        return []

    candidate_headers = (
        "镜头调度与内容融合",
        "镜头调度与内容",
        "画面生成提示词",
        "画面内容",
        "画面描述",
        "内容/台词",
        "定格画面",
        "分镜",
        "提示词",
        "prompt",
    )
    priority_headers = (
        "镜头调度与内容融合",
        "镜头调度与内容",
        "画面生成提示词",
        "画面内容",
        "画面描述",
        "内容/台词",
        "定格画面",
        "分镜",
        "提示词",
        "prompt",
    )

    def normalize_header(value: str) -> str:
        return re.sub(r"\s+", "", str(value or "")).strip().lower()

    def is_separator_line(line: str) -> bool:
        stripped = str(line or "").strip()
        return bool(stripped) and stripped.startswith("|") and stripped.endswith("|") and stripped.replace("|", "").replace("-", "").replace(":", "").strip() == ""

    def normalize_row_cells(cells: list[str], expected_count: int) -> list[str]:
        values = list(cells)
        if expected_count <= 0:
            return values
        if len(values) < expected_count:
            values.extend([""] * (expected_count - len(values)))
            return values
        if len(values) > expected_count:
            head = values[: max(expected_count - 1, 0)]
            tail = " | ".join(values[max(expected_count - 1, 0) :]).strip()
            return [*head, tail] if expected_count > 0 else values
        return values

    def pick_segment_text(headers: list[str], cells: list[str]) -> str:
        normalized_map = {
            normalize_header(header): str(cells[index] or "").strip()
            for index, header in enumerate(headers)
            if index < len(cells)
        }
        for header in priority_headers:
            value = normalized_map.get(normalize_header(header), "")
            if value:
                return value
        composed = [
            normalized_map.get(normalize_header("镜头调度与内容融合"), ""),
            normalized_map.get(normalize_header("镜头调度与内容"), ""),
            normalized_map.get(normalize_header("画面描述"), ""),
            normalized_map.get(normalize_header("内容/台词"), ""),
            normalized_map.get(normalize_header("定格画面"), ""),
            normalized_map.get(normalize_header("分镜"), ""),
        ]
        return "\n".join(part for part in composed if part).strip()

    lines = source_content.splitlines()
    table_rows: list[str] = []
    index = 0
    while index < len(lines):
        stripped = str(lines[index] or "").strip()
        if not (stripped.startswith("|") and stripped.endswith("|")):
            index += 1
            continue
        header_cells = _split_markdown_table_line(stripped)
        normalized_headers = [normalize_header(cell) for cell in header_cells]
        if len(header_cells) < 3 or not any(
            any(normalize_header(candidate) in header for candidate in candidate_headers)
            for header in normalized_headers
        ):
            index += 1
            continue
        if index + 1 >= len(lines) or not is_separator_line(lines[index + 1]):
            index += 1
            continue

        index += 2
        while index < len(lines):
            row_line = str(lines[index] or "").strip()
            if not row_line:
                break
            if not (row_line.startswith("|") and row_line.endswith("|")):
                break
            if is_separator_line(row_line):
                index += 1
                continue
            row_cells = normalize_row_cells(_split_markdown_table_line(row_line), len(header_cells))
            if [normalize_header(cell) for cell in row_cells[: len(header_cells)]] == normalized_headers:
                index += 1
                continue
            segment_text = pick_segment_text(header_cells, row_cells)
            if segment_text:
                table_rows.append(segment_text)
            index += 1

    if table_rows:
        return table_rows

    sections = _extract_sections(script.content)
    script_body = _find_section(sections, "【正文剧本")
    if not script_body:
        return []
    scene_blocks = _extract_scenes_blocks(script_body)
    return [block.strip() for _, block in scene_blocks if block.strip()]


async def create_segments_from_script(session: AsyncSession, project_id: str) -> list[Segment]:
    segment_texts = await _extract_segment_texts_from_script(session, project_id)
    segments = [
        Segment(project_id=project_id, order_index=index, text_content=text, status="PENDING")
        for index, text in enumerate(segment_texts, start=1)
    ]
    if segments:
        session.add_all(segments)
        await session.commit()
        for item in segments:
            await session.refresh(item)
    return segments


async def sync_segments_with_script(session: AsyncSession, project_id: str) -> list[Segment]:
    segment_texts = await _extract_segment_texts_from_script(session, project_id)
    existing = await list_segments(session, project_id)
    if not segment_texts:
        return existing

    changed = False
    for index, text in enumerate(segment_texts, start=1):
        if index <= len(existing):
            segment = existing[index - 1]
            if segment.order_index != index:
                segment.order_index = index
                changed = True
            if (segment.text_content or "") != text:
                segment.text_content = text
                changed = True
            session.add(segment)
            continue
        session.add(Segment(project_id=project_id, order_index=index, text_content=text, status="PENDING"))
        changed = True

    if len(existing) > len(segment_texts):
        for segment in existing[len(segment_texts):]:
            versions = await list_segment_versions(session, segment.id)
            for version in versions:
                _remove_local_static_video(str(version.video_url or ""))
            await session.execute(delete(SegmentVersion).where(SegmentVersion.segment_id == segment.id))
            await session.delete(segment)
        changed = True

    if changed:
        await session.commit()
    return await list_segments(session, project_id)


async def create_segment_version(
    session: AsyncSession, segment_id: str, video_url: str, prompt: Optional[str] = None, task_id: Optional[str] = None, status: str = "COMPLETED"
) -> SegmentVersion:
    result = await session.execute(select(SegmentVersion).where(SegmentVersion.segment_id == segment_id))
    existing_versions = list(result.scalars().all())
    for existing in existing_versions:
        existing.is_selected = False
    version = SegmentVersion(
        segment_id=segment_id, video_url=video_url, prompt=prompt, task_id=task_id, status=status, is_selected=True
    )
    session.add(version)
    await session.commit()
    await session.refresh(version)
    return version


async def select_segment_version(session: AsyncSession, segment_id: str, version_id: str) -> None:
    result = await session.execute(select(SegmentVersion).where(SegmentVersion.segment_id == segment_id))
    versions = list(result.scalars().all())
    for version in versions:
        version.is_selected = version.id == version_id
    await session.commit()


def _remove_local_static_video(video_url: str) -> None:
    normalized = str(video_url or "").strip()
    if not normalized.startswith("/static/"):
        return
    base_dir = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
    static_root = os.path.abspath(os.path.join(base_dir, "static"))
    abs_path = os.path.abspath(os.path.join(static_root, normalized.replace("/static/", "", 1)))
    try:
        if os.path.commonpath([abs_path, static_root]) != static_root:
            return
    except ValueError:
        return
    if os.path.isfile(abs_path):
        os.remove(abs_path)


async def delete_segment_version(session: AsyncSession, segment_id: str, version_id: str) -> None:
    result = await session.execute(
        select(SegmentVersion)
        .where(SegmentVersion.segment_id == segment_id)
        .order_by(SegmentVersion.created_at.desc())
    )
    versions = list(result.scalars().all())
    target = next((item for item in versions if item.id == version_id), None)
    if not target:
        raise ValueError("视频版本不存在")
    target_video_url = str(target.video_url or "").strip()
    was_selected = bool(target.is_selected)
    await session.delete(target)
    await session.flush()
    remaining = [item for item in versions if item.id != version_id]
    if remaining:
        if was_selected or not any(bool(item.is_selected) for item in remaining):
            latest = remaining[0]
            for item in remaining:
                item.is_selected = item.id == latest.id
    await session.commit()
    _remove_local_static_video(target_video_url)
