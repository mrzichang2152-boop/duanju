from __future__ import annotations
from typing import Optional, Union
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.script import Script
from app.models.segment import Segment
from app.models.segment_version import SegmentVersion
from app.services.script_validation import _extract_scenes_blocks, _extract_sections, _find_section


async def list_segments(session: AsyncSession, project_id: str) -> list[Segment]:
    result = await session.execute(select(Segment).where(Segment.project_id == project_id))
    return list(result.scalars().all())


async def list_segment_versions(session: AsyncSession, segment_id: str) -> list[SegmentVersion]:
    result = await session.execute(select(SegmentVersion).where(SegmentVersion.segment_id == segment_id))
    return list(result.scalars().all())


async def get_segment(session: AsyncSession, segment_id: str) -> Optional[Segment]:
    return await session.scalar(select(Segment).where(Segment.id == segment_id))


async def create_segments_from_script(session: AsyncSession, project_id: str) -> list[Segment]:
    script = await session.scalar(
        select(Script).where(Script.project_id == project_id, Script.is_active == True)
    )
    if not script:
        return []
    
    # Check if script contains Markdown table (Step 3 format)
    # Prioritize storyboard field if available, otherwise fallback to content
    source_content = script.storyboard if script.storyboard and script.storyboard.strip() else script.content
    if not source_content:
        return []

    lines = source_content.splitlines()
    table_rows = []
    in_table = False
    header_found = False
    prompt_index = 8  # Default fallback
    
    for line in lines:
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("|") and stripped.endswith("|"):
            parts = [p.strip() for p in stripped.split("|")]
            # Filter empty parts from start/end
            # Note: split("|") on "|a|b|" gives ["", "a", "b", ""]
            if not parts[0]: parts.pop(0)
            if parts and not parts[-1]: parts.pop()
            
            # Check for header
            if ("画面生成提示词" in stripped or "画面内容" in stripped or "画面描述" in stripped) and not header_found:
                header_found = True
                # Try to find the prompt column index dynamically
                for i, col in enumerate(parts):
                    if "画面生成提示词" in col or "画面内容" in col or "画面描述" in col or "提示词" in col or "Prompt" in col:
                        prompt_index = i
                        break
                continue
            # Check for separator line
            if set(stripped.replace("|", "").replace("-", "").strip()) == set():
                continue
            
            if header_found and len(parts) > prompt_index:
                prompt = parts[prompt_index]
                table_rows.append(prompt)

    segments: list[Segment] = []
    
    if table_rows:
        # Create segments from table rows
        for index, prompt in enumerate(table_rows, start=1):
            segments.append(
                Segment(project_id=project_id, order_index=index, text_content=prompt, status="PENDING")
            )
    else:
        # Fallback to old scene block extraction (Step 1 format)
        sections = _extract_sections(script.content)
        script_body = _find_section(sections, "【正文剧本")
        if not script_body:
            return []
        scene_blocks = _extract_scenes_blocks(script_body)
        for index, (_, block) in enumerate(scene_blocks, start=1):
            text = block.strip()
            segments.append(
                Segment(project_id=project_id, order_index=index, text_content=text, status="PENDING")
            )

    if segments:
        session.add_all(segments)
        await session.commit()
        for item in segments:
            await session.refresh(item)
    return segments


async def create_segment_version(
    session: AsyncSession, segment_id: str, video_url: str, prompt: Optional[str] = None
) -> SegmentVersion:
    version = SegmentVersion(
        segment_id=segment_id, video_url=video_url, prompt=prompt, is_selected=False
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
