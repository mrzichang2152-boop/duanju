import re
from fastapi import APIRouter, Depends, HTTPException, status, UploadFile, File
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession
import json
import logging
from typing import Optional

from app.api.deps import get_current_user_id
from app.core.db import get_db
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
)
from app.services.projects import get_project
from app.services.script_validation import validate_script_with_model as run_validation
from app.services.scripts import get_active_script, save_script, get_script_history
from app.services.settings import get_or_create_settings
from app.services.linkapi import create_chat_completion, create_chat_completion_stream
from app.services.file_parsing import read_file_content

from app.core.script_prompts import (
    get_system_prompt,
    PROMPT_SUGGESTION_PAID,
    PROMPT_SUGGESTION_TRAFFIC,
    PROMPT_CONTINUATION_DEFAULT,
    PROMPT_CONTINUATION_TRAFFIC,
    PROMPT_CONTINUATION_PAID,
)

router = APIRouter()
logger = logging.getLogger(__name__)

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
    if not script:
        return ScriptResponse(project_id=project_id, content="")
    return ScriptResponse(
        id=script.id,
        project_id=project_id,
        content=script.content,
        thinking=script.thinking,
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
    script = await save_script(db, project_id, payload.content, payload.thinking)
    return ScriptResponse(
        id=script.id,
        project_id=project_id,
        content=script.content,
        thinking=script.thinking,
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
            version=item.version,
            is_active=item.is_active,
            created_at=item.created_at.isoformat() if item.created_at else ""
        ))
    return ScriptHistoryResponse(items=items)


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


@router.post("/{project_id}/script/generate", response_model=ScriptGenerateResponse)
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
    model = payload.model or settings.default_model_text
    
    system_prompt = get_system_prompt(payload.mode)
    user_prompt = payload.content
    
    if payload.mode == "step0_generate":
        system_prompt = "你是一个专业的短剧编剧。请根据用户提供的主题、角色和分集大纲，创作一个完整的短剧剧本。格式要求：包含【剧本基本信息】、【人物小传】、【正文剧本】等标准部分。"
        
        user_prompt = payload.content
        if payload.instruction:
            user_prompt = f"{user_prompt}\n\n【创作要求】\n{payload.instruction}"

        # Use Pro model for Step 0 but disable thinking mode
        model = "doubao-seed-2-0-pro-260215"
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
        
        model = "doubao-seed-2-0-pro-260215"
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
        
        model = "doubao-seed-2-0-pro-260215"
    elif payload.instruction:
         user_prompt = f"{payload.instruction}\n\n当前内容：\n{payload.content}"

    api_payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt}
        ],
        "stream": True,
        "temperature": 0.7
    }
    
    # Disable thinking mode for Step 0 only if explicitly requested or for legacy compatibility
    # User requested thinking mode for step0_modify, so we allow it there.
    if payload.mode in ["step0_generate"]:
        api_payload["thinking"] = {"type": "disabled"}

    async def event_generator():
        try:
            async for chunk in create_chat_completion_stream(db, user_id, api_payload):
                 # Check if chunk is a dict (parsed JSON) or raw bytes/string
                if isinstance(chunk, dict):
                    delta = chunk.get("choices", [{}])[0].get("delta", {})
                    content = delta.get("content", "")
                    reasoning = delta.get("reasoning_content", "")
                    
                    if content or reasoning:
                        # Yield SSE format
                        yield f"data: {json.dumps({'choices': [{'delta': {'content': content, 'reasoning_content': reasoning}}]})}\n\n"
                elif isinstance(chunk, str):
                     # If it's already a string, assume it's content
                     yield f"data: {json.dumps({'choices': [{'delta': {'content': chunk}}]})}\n\n"
            yield "data: [DONE]\n\n"
        except Exception as e:
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
            "model": "doubao-seed-2-0-pro-260215",
            "messages": [
                {"role": "system", "content": "你是一个严谨的剧本分析助手。请提取元数据和定位信息，不要生成剧本正文内容。"},
                {"role": "user", "content": prompt}
            ],
            "temperature": 0.0,
            "max_tokens": 4000,
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
