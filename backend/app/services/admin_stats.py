from __future__ import annotations

import json
import re
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.asset import Asset
from app.models.asset_version import AssetVersion
from app.models.project import Project
from app.models.script import Script
from app.models.segment import Segment
from app.models.segment_version import SegmentVersion
from app.models.user import User
from app.schemas.admin import (
    UsageSelfResponse,
    UsageSummaryAccountResponse,
    UsageSummaryResponse,
    UsageSummaryTotalsResponse,
)


@dataclass
class _UsageCounter:
    project_count: int = 0
    text_characters: int = 0
    image_count: int = 0
    video_count: int = 0
    video_seconds: float = 0.0
    estimated_video_count: int = 0


def _parse_admin_email_whitelist() -> set[str]:
    return {
        item.strip().lower()
        for item in str(settings.admin_emails or "").split(",")
        if item.strip()
    }


async def ensure_admin_user(session: AsyncSession, user_id: str) -> User:
    user = await session.scalar(select(User).where(User.id == user_id))
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="用户不存在")
    whitelist = _parse_admin_email_whitelist()
    if whitelist and str(user.email or "").strip().lower() not in whitelist:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="仅管理员可查看账号用量统计")
    return user


def _count_text_value(value: object) -> int:
    if value is None:
        return 0
    if isinstance(value, str):
        return len(value.strip())
    if isinstance(value, dict):
        return sum(_count_text_value(item) for item in value.values())
    if isinstance(value, list):
        return sum(_count_text_value(item) for item in value)
    return 0


def _count_script_text(script: Script) -> int:
    total = 0
    total += _count_text_value(getattr(script, "content", None))
    total += _count_text_value(getattr(script, "thinking", None))
    total += _count_text_value(getattr(script, "outline", None))
    total += _count_text_value(getattr(script, "storyboard", None))
    raw_episodes = getattr(script, "episodes", None)
    if isinstance(raw_episodes, str) and raw_episodes.strip():
        try:
            total += _count_text_value(json.loads(raw_episodes))
        except Exception:
            total += len(raw_episodes.strip())
    return total


def _split_markdown_table_line(line: str) -> list[str]:
    stripped = str(line or "").strip()
    if stripped.startswith("|"):
        stripped = stripped[1:]
    if stripped.endswith("|"):
        stripped = stripped[:-1]
    return [part.strip() for part in stripped.split("|")]


def _normalize_header(value: str) -> str:
    return re.sub(r"\s+", "", str(value or "")).strip().lower()


def _is_separator_line(line: str) -> bool:
    stripped = str(line or "").strip()
    return bool(stripped) and stripped.startswith("|") and stripped.endswith("|") and stripped.replace("|", "").replace("-", "").replace(":", "").strip() == ""


def _parse_duration_from_text(value: str) -> float:
    text = str(value or "").strip()
    if not text:
        return 5.0

    def _parse_timestamp(token: str) -> float:
        clean = str(token or "").strip()
        if ":" not in clean:
            return float("nan")
        parts = [float(item) for item in clean.split(":")]
        if any(item < 0 for item in parts):
            return float("nan")
        if len(parts) == 2:
            return parts[0] * 60 + parts[1]
        if len(parts) == 3:
            return parts[0] * 3600 + parts[1] * 60 + parts[2]
        return float("nan")

    timestamp_range = re.search(r"(\d{1,2}:\d{1,2}(?::\d{1,2})?)\s*[-~—–至到]+\s*(\d{1,2}:\d{1,2}(?::\d{1,2})?)", text)
    if timestamp_range:
        start = _parse_timestamp(timestamp_range.group(1))
        end = _parse_timestamp(timestamp_range.group(2))
        if start == start and end == end and end > start:
            return float(end - start)

    number_range = re.search(r"(\d+(?:\.\d+)?)\s*(?:s|秒)?\s*[-~—–至到]+\s*(\d+(?:\.\d+)?)\s*(?:s|秒)?", text, flags=re.IGNORECASE)
    if number_range:
        start = float(number_range.group(1))
        end = float(number_range.group(2))
        if end > start:
            return float(end - start)

    single = re.search(r"(\d+(?:\.\d+)?)\s*(?:s|秒)", text, flags=re.IGNORECASE)
    if single:
        return float(single.group(1))

    return 5.0


def _build_project_duration_map(script: Script | None) -> dict[int, float]:
    if not script:
        return {}
    source = str(getattr(script, "storyboard", None) or getattr(script, "content", None) or "").strip()
    if not source:
        return {}

    candidate_headers = ("时间轴", "分段时长", "时长")
    lines = source.splitlines()
    index = 0
    while index < len(lines):
        header_line = str(lines[index] or "").strip()
        if not (header_line.startswith("|") and header_line.endswith("|")):
            index += 1
            continue
        if index + 1 >= len(lines) or not _is_separator_line(lines[index + 1]):
            index += 1
            continue
        headers = _split_markdown_table_line(header_line)
        normalized_headers = [_normalize_header(item) for item in headers]
        duration_index = next(
            (
                idx
                for idx, item in enumerate(normalized_headers)
                if any(_normalize_header(candidate) in item for candidate in candidate_headers)
            ),
            -1,
        )
        if duration_index < 0:
            index += 1
            continue
        row_index = 0
        index += 2
        duration_map: dict[int, float] = {}
        while index < len(lines):
            row_line = str(lines[index] or "").strip()
            if not row_line or not (row_line.startswith("|") and row_line.endswith("|")):
                break
            if _is_separator_line(row_line):
                index += 1
                continue
            cells = _split_markdown_table_line(row_line)
            if len(cells) < len(headers):
                cells.extend([""] * (len(headers) - len(cells)))
            row_index += 1
            duration_map[row_index] = _parse_duration_from_text(cells[duration_index])
            index += 1
        if duration_map:
            return duration_map
    return {}


async def _collect_usage_rows(session: AsyncSession) -> tuple[list[User], list[UsageSummaryAccountResponse], UsageSummaryTotalsResponse]:
    users = list((await session.execute(select(User).order_by(User.created_at.asc()))).scalars().all())
    projects = list((await session.execute(select(Project))).scalars().all())
    scripts = list((await session.execute(select(Script))).scalars().all())
    assets = list((await session.execute(select(Asset))).scalars().all())
    asset_versions = list((await session.execute(select(AssetVersion))).scalars().all())
    segments = list((await session.execute(select(Segment))).scalars().all())
    segment_versions = list((await session.execute(select(SegmentVersion))).scalars().all())

    project_to_user = {str(project.id): str(project.user_id) for project in projects}
    asset_to_project = {str(asset.id): str(asset.project_id) for asset in assets}
    segment_to_project_order = {
        str(segment.id): (str(segment.project_id), int(getattr(segment, "order_index", 0) or 0))
        for segment in segments
    }

    project_counter: dict[str, int] = defaultdict(int)
    for project in projects:
        project_counter[str(project.user_id)] += 1

    project_scripts: dict[str, list[Script]] = defaultdict(list)
    user_counters: dict[str, _UsageCounter] = {str(user.id): _UsageCounter() for user in users}

    for user in users:
        user_counters[str(user.id)].project_count = int(project_counter.get(str(user.id), 0))

    for script in scripts:
        project_id = str(getattr(script, "project_id", "") or "")
        user_id = project_to_user.get(project_id)
        if not user_id or user_id not in user_counters:
            continue
        user_counters[user_id].text_characters += _count_script_text(script)
        project_scripts[project_id].append(script)

    project_duration_maps: dict[str, dict[int, float]] = {}
    for project_id, items in project_scripts.items():
        active_scripts = [item for item in items if bool(getattr(item, "is_active", False))]
        candidate = None
        if active_scripts:
            candidate = sorted(active_scripts, key=lambda item: getattr(item, "created_at", None) or datetime.min)[-1]
        else:
            candidate = sorted(items, key=lambda item: getattr(item, "created_at", None) or datetime.min)[-1]
        project_duration_maps[project_id] = _build_project_duration_map(candidate)

    for version in asset_versions:
        project_id = asset_to_project.get(str(getattr(version, "asset_id", "") or ""))
        user_id = project_to_user.get(project_id or "")
        if not user_id or user_id not in user_counters:
            continue
        user_counters[user_id].image_count += 1

    for version in segment_versions:
        segment_id = str(getattr(version, "segment_id", "") or "")
        segment_info = segment_to_project_order.get(segment_id)
        if not segment_info:
            continue
        project_id, order_index = segment_info
        user_id = project_to_user.get(project_id)
        if not user_id or user_id not in user_counters:
            continue
        counter = user_counters[user_id]
        counter.video_count += 1
        duration = getattr(version, "duration_seconds", None)
        if duration is None or float(duration) <= 0:
            duration = project_duration_maps.get(project_id, {}).get(order_index, 5.0)
            counter.estimated_video_count += 1
        counter.video_seconds += float(duration)

    account_rows: list[UsageSummaryAccountResponse] = []
    for user in users:
        counter = user_counters.get(str(user.id), _UsageCounter())
        account_rows.append(
            UsageSummaryAccountResponse(
                user_id=str(user.id),
                email=str(user.email or ""),
                created_at=user.created_at.isoformat() if getattr(user, "created_at", None) else None,
                project_count=counter.project_count,
                text_characters=counter.text_characters,
                image_count=counter.image_count,
                video_count=counter.video_count,
                video_seconds=round(counter.video_seconds, 2),
                estimated_video_count=counter.estimated_video_count,
            )
        )

    account_rows.sort(key=lambda item: (-item.video_seconds, -item.image_count, -item.text_characters, item.email))
    totals = UsageSummaryTotalsResponse(
        account_count=len(account_rows),
        project_count=sum(item.project_count for item in account_rows),
        text_characters=sum(item.text_characters for item in account_rows),
        image_count=sum(item.image_count for item in account_rows),
        video_count=sum(item.video_count for item in account_rows),
        video_seconds=round(sum(item.video_seconds for item in account_rows), 2),
        estimated_video_count=sum(item.estimated_video_count for item in account_rows),
    )

    return users, account_rows, totals


def _build_usage_notes(*, include_admin_notice: bool) -> list[str]:
    notes = [
        "文字统计按已持久化的剧本版本文本累计字符数汇总。",
        "图片统计按素材图片版本数量汇总。",
        "视频秒数优先使用生成时落库的真实 duration；旧视频若无时长字段，则按当前分镜时间轴或默认 5 秒兜底估算。",
    ]
    if include_admin_notice and not _parse_admin_email_whitelist():
        notes.append("当前未配置 ADMIN_EMAILS，默认允许任意已登录账号访问该统计页；如需限制管理员，请在后端环境变量中配置逗号分隔邮箱白名单。")
    return notes


async def get_current_user_usage(session: AsyncSession, user_id: str) -> UsageSelfResponse:
    users, account_rows, _ = await _collect_usage_rows(session)
    user_map = {str(item.id): item for item in users}
    current_user = user_map.get(str(user_id))
    if not current_user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="用户不存在")
    account = next((item for item in account_rows if item.user_id == str(user_id)), None)
    if account is None:
        account = UsageSummaryAccountResponse(
            user_id=str(current_user.id),
            email=str(current_user.email or ""),
            created_at=current_user.created_at.isoformat() if getattr(current_user, "created_at", None) else None,
            project_count=0,
            text_characters=0,
            image_count=0,
            video_count=0,
            video_seconds=0.0,
            estimated_video_count=0,
        )
    return UsageSelfResponse(
        generated_at=datetime.now(timezone.utc).isoformat(),
        email=str(current_user.email or ""),
        account=account,
        notes=_build_usage_notes(include_admin_notice=False),
    )


async def get_usage_summary(session: AsyncSession, admin_user_id: str) -> UsageSummaryResponse:
    admin_user = await ensure_admin_user(session, admin_user_id)
    _, account_rows, totals = await _collect_usage_rows(session)
    return UsageSummaryResponse(
        generated_at=datetime.now(timezone.utc).isoformat(),
        admin_email=str(admin_user.email or ""),
        totals=totals,
        accounts=account_rows,
        notes=_build_usage_notes(include_admin_notice=True),
    )
