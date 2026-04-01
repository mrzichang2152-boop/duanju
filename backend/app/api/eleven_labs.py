import json
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user_id
from app.core.db import get_db
from app.models.character_voice import CharacterVoice
from app.models.eleven_labs_cloned_voice import ElevenLabsClonedVoice
from app.models.project import Project
from app.services.eleven_labs import eleven_labs_service

router = APIRouter(tags=["eleven-labs"])
MAX_CLONED_VOICES_PER_ACCOUNT = 3


async def _get_owned_clone_voice_ids(db: AsyncSession, user_id: str) -> set[str]:
    owned_rows = await db.execute(
        select(ElevenLabsClonedVoice.voice_id).where(ElevenLabsClonedVoice.user_id == user_id)
    )
    owned_ids = {
        str(voice_id).strip()
        for voice_id in owned_rows.scalars().all()
        if str(voice_id).strip()
    }

    project_rows = await db.execute(select(Project.id).where(Project.user_id == user_id))
    project_ids = [str(item).strip() for item in project_rows.scalars().all() if str(item).strip()]
    if project_ids:
        clone_rows = await db.execute(
            select(CharacterVoice.voice_id).where(
                CharacterVoice.project_id.in_(project_ids),
                CharacterVoice.voice_type == "CLONE",
            )
        )
        referenced_ids = {
            str(voice_id).strip()
            for voice_id in clone_rows.scalars().all()
            if str(voice_id).strip()
        }
        missing_ids = referenced_ids - owned_ids
        if missing_ids:
            db.add_all(
                [
                    ElevenLabsClonedVoice(user_id=user_id, voice_id=voice_id, title="")
                    for voice_id in missing_ids
                ]
            )
            await db.commit()
            owned_ids.update(missing_ids)

    return owned_ids


@router.get("/voices")
async def list_voices(
    page: int = 1,
    size: int = 100,
    language: Optional[str] = None,
    query: Optional[str] = None,
    accent: Optional[str] = None,
    gender: Optional[str] = None,
    age: Optional[str] = None,
    quality: Optional[str] = None,
    include_library: bool = True,
    user_id: str = Depends(get_current_user_id),
):
    try:
        return await eleven_labs_service.list_voices(
            page=page,
            size=size,
            language=language,
            query=query,
            accent=accent,
            gender=gender,
            age=age,
            quality=quality,
            include_library=include_library,
        )
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@router.get("/models")
async def list_models(
    can_do_voice_conversion: Optional[bool] = None,
    user_id: str = Depends(get_current_user_id),
):
    try:
        return await eleven_labs_service.list_models(can_do_voice_conversion=can_do_voice_conversion)
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@router.get("/cloned-voices")
async def list_cloned_voices(
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
):
    try:
        owned_ids = await _get_owned_clone_voice_ids(db, user_id)
        items = await eleven_labs_service.list_my_cloned_voices()
        filtered = [item for item in items if str(item.get("_id") or "").strip() in owned_ids]
        return {
            "items": filtered,
            "total": len(filtered),
            "limit": MAX_CLONED_VOICES_PER_ACCOUNT,
            "remaining": max(0, MAX_CLONED_VOICES_PER_ACCOUNT - len(filtered)),
        }
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@router.delete("/voices/{voice_id}")
async def delete_voice(
    voice_id: str,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
):
    try:
        normalized_voice_id = str(voice_id or "").strip()
        if not normalized_voice_id:
            raise HTTPException(status_code=400, detail="voice_id 不能为空")
        owned_ids = await _get_owned_clone_voice_ids(db, user_id)
        if normalized_voice_id not in owned_ids:
            raise HTTPException(status_code=403, detail="仅允许删除当前账号创建的克隆音色")
        await eleven_labs_service.delete_voice(normalized_voice_id)
        await db.execute(
            delete(ElevenLabsClonedVoice).where(
                ElevenLabsClonedVoice.user_id == user_id,
                ElevenLabsClonedVoice.voice_id == normalized_voice_id,
            )
        )
        await db.commit()
        return {"status": "deleted", "voice_id": normalized_voice_id}
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@router.post("/clone")
async def clone_voice(
    title: str = Form(...),
    file: UploadFile = File(...),
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
):
    try:
        owned_ids = await _get_owned_clone_voice_ids(db, user_id)
        existing = await eleven_labs_service.list_my_cloned_voices()
        existing_owned = [item for item in existing if str(item.get("_id") or "").strip() in owned_ids]
        if len(existing_owned) >= MAX_CLONED_VOICES_PER_ACCOUNT:
            raise HTTPException(
                status_code=400,
                detail=f"当前账号最多可克隆 {MAX_CLONED_VOICES_PER_ACCOUNT} 个音色，请先删除旧音色后再克隆",
            )
        content = await file.read()
        result = await eleven_labs_service.create_voice(title, content, file.filename, file.content_type)
        new_voice_id = str(result.get("_id") or result.get("model_id") or "").strip()
        if new_voice_id:
            exists_row = await db.execute(
                select(ElevenLabsClonedVoice.id).where(
                    ElevenLabsClonedVoice.user_id == user_id,
                    ElevenLabsClonedVoice.voice_id == new_voice_id,
                )
            )
            if not exists_row.scalar_one_or_none():
                db.add(
                    ElevenLabsClonedVoice(
                        user_id=user_id,
                        voice_id=new_voice_id,
                        title=str(result.get("title") or title or "").strip(),
                    )
                )
                await db.commit()
        return result
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@router.post("/tts")
async def generate_tts(
    text: str = Form(...),
    voice_id: str = Form(...),
    output_format: str = Form("mp3_44100_128"),
    model_id: str = Form("eleven_v3"),
    settings_json: Optional[str] = Form(None),
    language_code: Optional[str] = Form(None),
    seed: Optional[int] = Form(None),
    previous_text: Optional[str] = Form(None),
    next_text: Optional[str] = Form(None),
    pronunciation_overrides_json: Optional[str] = Form(None),
    pronunciation_dictionary_locators_json: Optional[str] = Form(None),
    user_id: str = Depends(get_current_user_id),
):
    try:
        settings = json.loads(settings_json) if settings_json else {}
        pronunciation_overrides = (
            json.loads(pronunciation_overrides_json) if pronunciation_overrides_json else None
        )
        pronunciation_dictionary_locators = (
            json.loads(pronunciation_dictionary_locators_json)
            if pronunciation_dictionary_locators_json
            else None
        )
        audio_content = await eleven_labs_service.tts(
            text=text,
            voice_id=voice_id,
            model_id=model_id,
            output_format=output_format,
            settings=settings if isinstance(settings, dict) else {},
            language_code=language_code,
            seed=seed,
            previous_text=previous_text,
            next_text=next_text,
            pronunciation_overrides=pronunciation_overrides if isinstance(pronunciation_overrides, list) else None,
            pronunciation_dictionary_locators=(
                pronunciation_dictionary_locators
                if isinstance(pronunciation_dictionary_locators, list)
                else None
            ),
        )
        media_type = "audio/mpeg" if output_format.startswith("mp3") else "audio/wav"
        return Response(content=audio_content, media_type=media_type)
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except json.JSONDecodeError:
        raise HTTPException(status_code=422, detail="调节参数 JSON 格式无效")
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))
