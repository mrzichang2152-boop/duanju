from typing import Optional

from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.script import Script


async def get_active_script(session: AsyncSession, project_id: str) -> Optional[Script]:
    result = await session.execute(
        select(Script).where(Script.project_id == project_id, Script.is_active == True).order_by(desc(Script.created_at))
    )
    return result.scalars().first()


async def save_script(session: AsyncSession, project_id: str, content: str) -> Script:
    existing = await get_active_script(session, project_id)
    if existing:
        existing.is_active = False
        await session.flush()
        version = existing.version + 1
    else:
        version = 1
    script = Script(project_id=project_id, content=content, version=version, is_active=True)
    session.add(script)
    await session.commit()
    await session.refresh(script)
    return script
