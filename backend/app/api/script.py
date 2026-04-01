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
from app.services.assets import list_assets, extract_assets_from_script
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
)

router = APIRouter()
logger = logging.getLogger(__name__)
_storyboard_task_lock = asyncio.Lock()
_storyboard_tasks: dict[str, dict[str, Any]] = {}
_OPENROUTER_TEXT_MODEL = "gemini-3.1-pro"


def _build_storyboard_text_from_episodes(episodes: list[dict[str, Any]]) -> str:
    return "\n\n".join([f"### {str(item.get('title') or '').strip()}\n\n{str(item.get('storyboard') or '').strip()}" for item in episodes])


def _normalize_mode_model(mode: str, model: Optional[str]) -> str:
    return _OPENROUTER_TEXT_MODEL


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
            project_id = str(task.project_id)
            user_id = str(task.user_id)
            original_content = str(payload.get("original_content") or "")
            resources_content = str(payload.get("resources_content") or "")
            model = str(payload.get("model") or "").strip() or _OPENROUTER_TEXT_MODEL
            instruction = str(payload.get("instruction") or "")

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

            mode = "extract_resources" if op == "extract" else "step2_modify"
            base_content = original_content if op == "extract" else resources_content
            if not base_content.strip():
                raise RuntimeError("内容为空")

            generated = await _generate_script_once(
                db,
                user_id,
                ScriptGenerateRequest(
                    mode=mode,
                    content=base_content,
                    model=model,
                    instruction=instruction or None,
                    stream=False,
                ),
                project_id,
            )
            cleaned_resources = _strip_thinking_content(generated.get("content") or "")
            if not cleaned_resources:
                raise RuntimeError("模型未返回可用内容")
            full_content = f"{cleaned_resources}{_STEP2_SEPARATOR}{original_content}"
            saved = await save_script(db, project_id, full_content, None, None, None, None)
            await mark_async_task_completed(
                db,
                task,
                {
                    "op": op,
                    "content": cleaned_resources,
                    "version": int(saved.version) if saved else 0,
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
    assets = await list_assets(db, project_id)
    asset_context = ""
    if assets:
        valid_asset_types = ["CHARACTER_LOOK", "PROP", "SCENE"]
        all_candidate_assets = [a for a in assets if a.type in valid_asset_types]
        filtered_assets = list(all_candidate_assets)
        if episode_index is not None and episode_index >= 0:
            target_episode_no = episode_index + 1
            episode_assets = []
            for item in all_candidate_assets:
                desc_text = str(item.description or "")
                if _episode_text_mentions_all(desc_text):
                    episode_assets.append(item)
                    continue
                episodes = _extract_episode_numbers(desc_text)
                if target_episode_no in episodes:
                    episode_assets.append(item)
            filtered_assets = episode_assets
            if not filtered_assets and all_candidate_assets:
                logger.warning(
                    "No episode-scoped assets matched by 出场集数, fallback to all whitelisted assets. project_id=%s episode=%s total_assets=%s",
                    project_id,
                    target_episode_no,
                    len(all_candidate_assets),
                )
                filtered_assets = list(all_candidate_assets)

        if filtered_assets:
            asset_context = "【可用素材库】\n请在生成分镜时，严格只使用以下素材。若名称不在下方白名单中，视为非法虚构，禁止输出。\n"
            type_mapping = {
                "CHARACTER_LOOK": "角色形象",
                "PROP": "道具",
                "SCENE": "场景"
            }
            for asset in filtered_assets:
                desc = asset.description or "无描述"
                type_display = type_mapping.get(asset.type, asset.type)
                asset_context += f"- [{type_display}] {asset.name} (ID: {asset.id}): {desc}\n"

            look_assets = [a for a in filtered_assets if a.type == "CHARACTER_LOOK"]
            prop_assets = [a for a in filtered_assets if a.type == "PROP"]
            scene_assets = [a for a in filtered_assets if a.type == "SCENE"]

            asset_context += "\n【素材白名单（强制）】\n"
            if look_assets:
                asset_context += "可用角色形象（仅可从以下选择，禁止新增/改写/简称）：\n"
                for look_asset in look_assets:
                    look_full_name = str(look_asset.name or "").strip()
                    asset_context += f"- {look_full_name}[AssetID:{look_asset.id}]\n"
            else:
                asset_context += "可用角色形象：无\n"

            if prop_assets:
                asset_context += "可用道具（仅可从以下选择，禁止新增/改写/别名）：\n"
                for prop_asset in prop_assets:
                    prop_name = str(prop_asset.name or "").strip()
                    asset_context += f"- {prop_name}[AssetID:{prop_asset.id}]\n"
            else:
                asset_context += "可用道具：无\n"

            if scene_assets:
                asset_context += "可用场景（仅可从以下选择，禁止新增/改写/别名）：\n"
                for scene_asset in scene_assets:
                    scene_name = str(scene_asset.name or "").strip()
                    asset_context += f"- {scene_name}[AssetID:{scene_asset.id}]\n"
            else:
                asset_context += "可用场景：无\n"

            asset_context += (
                "\n【强制约束】\n"
                "1) 角色形象列、镜头调度与内容融合列、台词角色标识中，凡涉及角色主体，必须直接使用“角色形象全名”，禁止使用“汪老板/冯硕”等简称。\n"
                "2) 角色形象列只允许填写白名单中的角色形象全名及其AssetID；若该镜头无角色，填“无”。\n"
                "3) 道具列只允许填写白名单道具及其AssetID；若无道具填“无”；若剧情需要但白名单缺失，填“缺失道具:xxx（待补素材）”，且不得附AssetID。\n"
                "4) 场景列只允许填写白名单场景及其AssetID；若剧情需要但白名单缺失，填“缺失场景:xxx（待补素材）”，且不得附AssetID。\n"
                "5) 禁止输出任何白名单之外的角色形象/道具/场景名称；一旦出现即判定为错误输出。\n"
            )
            asset_context += "\n"
            logger.info(f"Attached {len(filtered_assets)} assets to storyboard prompt (filtered from {len(assets)})")
        elif episode_index is not None and episode_index >= 0:
            logger.info("No assets available for storyboard prompt. project_id=%s episode=%s", project_id, episode_index + 1)

    style_instruction = (instruction or "").strip()
    style_block = f"【全局风格要求】\n{style_instruction}\n\n" if style_instruction else ""

    base_prompt = (
        f"{style_block}"
        f"{asset_context}"
        f"请将以下剧本转换为分镜脚本：\n\n{content}\n\n"
    )
    if not asset_context:
        return base_prompt

    return (
        f"{base_prompt}"
        "【再次提醒】\n"
        "时间轴单行时长必须在3~15秒，禁止把7~8秒作为默认折中值；"
        "同画面与同场景的连续动作优先在15秒范围内合并成长镜头，接近15秒再切分。\n"
        "只要有台词，必须逐句标注角色名与起止秒（开始秒-结束秒），并在该句中写清说话时的表情变化、眼神指向和语气/音量/语速。\n"
        "请务必使用素材库中的AssetID标记角色、道具和场景。严禁省略。"
        "如果某个角色/道具/场景在素材库中存在，必须附带 `[AssetID:xxx]`，否则视为错误。"
        "如果同一镜头出现多个角色，角色形象列必须逐个列出所有角色形象，且每个角色都要附带各自的 `[AssetID:xxx]`。"
        "角色形象列只允许输出“角色形象全名[AssetID:xxx]”列表，不允许追加任何外观长描述、出场集数或解释性文本。"
        "镜头调度与内容融合中的台词角色标识也必须直接使用“角色形象全名”。"
    )


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
            content_chunks: list[str] = []
            async for chunk in create_chat_completion_stream(
                session,
                task["user_id"],
                {
                    "model": task["model"],
                    "messages": [
                        {"role": "system", "content": PROMPT_STORYBOARD},
                        {"role": "user", "content": user_prompt},
                    ],
                    "temperature": 0.2,
                    "max_tokens": 120000,
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
                if isinstance(delta, dict):
                    piece = delta.get("content") or delta.get("reasoning_content")
                if not piece and isinstance(first_choice.get("message"), dict):
                    msg_obj = first_choice.get("message")
                    piece = msg_obj.get("content") or msg_obj.get("reasoning_content")
                if piece:
                    content_chunks.append(str(piece))
            generated = "".join(content_chunks).strip()
            if not generated:
                raise RuntimeError("分镜生成结果为空（上游返回空内容）")
            logger.info("Storyboard task completed task_id=%s project_id=%s episode_index=%s content_len=%s", task_id, task["project_id"], task["episode_index"], len(generated))

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

    task = await create_async_task(
        db,
        project_id=project_id,
        user_id=user_id,
        task_type=_STEP2_TASK_TYPE,
        payload={
            "op": payload.op,
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
    return AsyncTaskStatusResponse(
        task_id=task.id,
        project_id=project_id,
        task_type=task.task_type,
        status=str(task.status or "PENDING").upper(),
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
    from app.services.media_storage import upload_script_snapshot_to_cos

    snapshot = "\n\n".join(
        part
        for part in (
            script.content or "",
            script.storyboard or "",
            script.outline or "",
        )
        if (part or "").strip()
    )
    await upload_script_snapshot_to_cos(project_id, script.version, snapshot or (script.content or ""))
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

    existing_task: dict[str, Any] | None = None
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
        episodes[episode_index] = target
        await save_script(db, project_id, None, None, None, None, episodes)

    return StoryboardTaskStatusResponse(
        task_id=str(existing_task["task_id"]),
        project_id=project_id,
        episode_index=episode_index,
        episode_title=episode_title,
        status=status_value if status_value in {"pending", "running", "completed", "failed"} else "running",
        content=existing_task.get("content"),
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
            return StoryboardTaskStatusResponse(
                task_id=task_id,
                project_id=project_id,
                episode_index=index,
                episode_title=str(episode.get("title") or f"第{index + 1}集"),
                status=status_value,
                content=str(episode.get("storyboard") or "") if status_value == "completed" else None,
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
