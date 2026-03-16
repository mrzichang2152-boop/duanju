from __future__ import annotations
from typing import Optional, List, Dict, Any
import json

from sqlalchemy import desc, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.script import Script

SEPARATOR = "\n\n=== 原文剧本 (请勿删除此行) ===\n\n"


def _extract_original_content(content: Optional[str]) -> str:
    if not content:
        return ""
    if SEPARATOR in content:
        parts = content.split(SEPARATOR)
        return SEPARATOR.join(parts[1:]).strip()
    return content.strip()


def _episodes_has_content(raw_episodes: Optional[str]) -> bool:
    if not raw_episodes:
        return False
    try:
        episodes = json.loads(raw_episodes)
    except Exception:
        return False
    if not isinstance(episodes, list):
        return False
    for ep in episodes:
        if not isinstance(ep, dict):
            continue
        content = ep.get("content")
        if isinstance(content, str) and content.strip():
            return True
        versions = ep.get("versions")
        if isinstance(versions, list):
            for v in versions:
                if isinstance(v, dict):
                    v_content = v.get("content")
                    if isinstance(v_content, str) and v_content.strip():
                        return True
    return False


def has_meaningful_script_data(script: Script) -> bool:
    if _extract_original_content(script.content):
        return True
    return _episodes_has_content(script.episodes)


async def get_active_script(session: AsyncSession, project_id: str) -> Optional[Script]:
    result = await session.execute(
        select(Script).where(Script.project_id == project_id, Script.is_active == True).order_by(desc(Script.created_at))
    )
    return result.scalars().first()


async def get_latest_meaningful_script(session: AsyncSession, project_id: str) -> Optional[Script]:
    result = await session.execute(
        select(Script).where(Script.project_id == project_id).order_by(desc(Script.created_at))
    )
    scripts = result.scalars().all()
    for script in scripts:
        if has_meaningful_script_data(script):
            return script
    return None


async def get_script_history(session: AsyncSession, project_id: str) -> list[Script]:
    result = await session.execute(
        select(Script).where(Script.project_id == project_id).order_by(desc(Script.version))
    )
    return result.scalars().all()


async def delete_script(session: AsyncSession, project_id: str, script_id: str) -> bool:
    stmt = select(Script).where(Script.id == script_id, Script.project_id == project_id)
    result = await session.execute(stmt)
    script = result.scalars().first()
    
    if not script:
        return False

    was_active = script.is_active
    await session.delete(script)
    # We don't commit immediately because we might need to update another script
    
    if was_active:
        # Find the latest remaining version to make active
        # We need to exclude the deleted script explicitly if we haven't flushed/committed
        # But since we called session.delete(script), it should be marked for deletion.
        # However, queries might still see it depending on isolation level/flush.
        await session.flush() 
        
        stmt = select(Script).where(Script.project_id == project_id).order_by(desc(Script.version))
        result = await session.execute(stmt)
        latest = result.scalars().first()
        
        if latest:
            latest.is_active = True
            session.add(latest)
            
    await session.commit()
    return True



async def save_script(
    session: AsyncSession, 
    project_id: str, 
    content: Optional[str] = None, 
    thinking: Optional[str] = None,
    storyboard: Optional[str] = None,
    outline: Optional[str] = None,
    episodes: Optional[List[Dict[str, Any]]] = None
) -> Script:
    existing = await get_active_script(session, project_id)
    latest_result = await session.execute(
        select(Script).where(Script.project_id == project_id).order_by(desc(Script.version))
    )
    latest_script = latest_result.scalars().first()
    base_script = existing or latest_script
    
    final_content = content
    final_thinking = thinking
    final_storyboard = storyboard
    final_outline = outline
    
    final_episodes_str = None
    if episodes is not None:
        final_episodes_str = json.dumps(episodes, ensure_ascii=False)
    
    if base_script:
        if content is None:
            final_content = base_script.content
        if thinking is None:
            final_thinking = base_script.thinking
        if storyboard is None:
            final_storyboard = base_script.storyboard
        if outline is None:
            final_outline = base_script.outline
        if episodes is None:
            final_episodes_str = base_script.episodes
        version = base_script.version + 1
    else:
        version = 1
        if final_content is None:
            final_content = ""

    await session.execute(
        update(Script)
        .where(Script.project_id == project_id, Script.is_active == True)
        .values(is_active=False)
    )
    await session.flush()
        
    script = Script(
        project_id=project_id, 
        content=final_content, 
        thinking=final_thinking, 
        storyboard=final_storyboard, 
        outline=final_outline,
        episodes=final_episodes_str,
        version=version, 
        is_active=True
    )
    session.add(script)
    await session.commit()
    await session.refresh(script)
    return script
