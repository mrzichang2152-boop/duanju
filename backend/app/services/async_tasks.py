from __future__ import annotations

import json
from typing import Any

from sqlalchemy import select
from sqlalchemy.exc import OperationalError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import engine
from app.models.async_task import AsyncTask


async def _ensure_async_tasks_table() -> None:
    async with engine.begin() as conn:
        await conn.run_sync(lambda sync_conn: AsyncTask.__table__.create(bind=sync_conn, checkfirst=True))


async def create_async_task(
    session: AsyncSession,
    *,
    project_id: str,
    user_id: str,
    task_type: str,
    payload: dict[str, Any] | None = None,
) -> AsyncTask:
    task = AsyncTask(
        project_id=project_id,
        user_id=user_id,
        task_type=task_type,
        status="PENDING",
        payload_json=json.dumps(payload or {}, ensure_ascii=False),
        result_json="{}",
        error="",
    )
    session.add(task)
    try:
        await session.commit()
    except OperationalError as exc:
        message = str(exc).lower()
        if "no such table" not in message or "async_tasks" not in message:
            raise
        await session.rollback()
        await _ensure_async_tasks_table()
        retry_task = AsyncTask(
            project_id=project_id,
            user_id=user_id,
            task_type=task_type,
            status="PENDING",
            payload_json=json.dumps(payload or {}, ensure_ascii=False),
            result_json="{}",
            error="",
        )
        session.add(retry_task)
        await session.commit()
        await session.refresh(retry_task)
        return retry_task
    await session.refresh(task)
    return task


async def get_async_task(
    session: AsyncSession,
    *,
    task_id: str,
    project_id: str | None = None,
    user_id: str | None = None,
    task_type: str | None = None,
) -> AsyncTask | None:
    stmt = select(AsyncTask).where(AsyncTask.id == task_id)
    if project_id is not None:
        stmt = stmt.where(AsyncTask.project_id == project_id)
    if user_id is not None:
        stmt = stmt.where(AsyncTask.user_id == user_id)
    if task_type:
        stmt = stmt.where(AsyncTask.task_type == task_type)
    result = await session.execute(stmt)
    return result.scalar_one_or_none()


async def mark_async_task_running(session: AsyncSession, task: AsyncTask) -> AsyncTask:
    task.status = "RUNNING"
    task.error = ""
    session.add(task)
    await session.commit()
    await session.refresh(task)
    return task


async def mark_async_task_completed(
    session: AsyncSession,
    task: AsyncTask,
    result: dict[str, Any] | None = None,
) -> AsyncTask:
    task.status = "COMPLETED"
    task.result_json = json.dumps(result or {}, ensure_ascii=False)
    task.error = ""
    session.add(task)
    await session.commit()
    await session.refresh(task)
    return task


async def mark_async_task_failed(session: AsyncSession, task: AsyncTask, error: str) -> AsyncTask:
    task.status = "FAILED"
    task.error = str(error or "任务失败")
    session.add(task)
    await session.commit()
    await session.refresh(task)
    return task


def parse_task_result(task: AsyncTask) -> dict[str, Any]:
    raw = str(task.result_json or "").strip()
    if not raw:
        return {}
    try:
        value = json.loads(raw)
    except Exception:
        return {}
    return value if isinstance(value, dict) else {}
