from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from typing import List, Optional

from app.api.deps import get_current_user_id
from app.core.db import get_db
from app.models.character_voice import CharacterVoice
from app.models.project import Project
from app.services.eleven_labs import eleven_labs_service
from pydantic import BaseModel
import os
import uuid

router = APIRouter()

class VoiceConfigUpdate(BaseModel):
    voice_id: str
    voice_type: str  # PRESET, CUSTOM, CLONE
    preview_url: Optional[str] = None
    config: Optional[dict] = {}

class CharacterVoiceResponse(BaseModel):
    id: str
    character_name: str
    voice_id: str
    voice_type: str
    preview_url: Optional[str]
    config: dict

class TTSRequest(BaseModel):
    text: str
    character_name: str
    speed: float = 1.0
    volume: float = 0.0
    pitch: float = 0.0
    tts_config: Optional[dict] = None

class TTSResponse(BaseModel):
    audio_url: str

@router.get("/{project_id}/voices", response_model=List[CharacterVoiceResponse])
async def get_project_voices(
    project_id: str,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
):
    # Verify project access
    result = await db.execute(select(Project).where(Project.id == project_id, Project.user_id == user_id))
    project = result.scalars().first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    result = await db.execute(select(CharacterVoice).where(CharacterVoice.project_id == project_id))
    voices = result.scalars().all()
    return voices

@router.post("/{project_id}/voices/{character_name}", response_model=CharacterVoiceResponse)
async def update_character_voice(
    project_id: str,
    character_name: str,
    payload: VoiceConfigUpdate,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
):
    # Verify project access
    result = await db.execute(select(Project).where(Project.id == project_id, Project.user_id == user_id))
    project = result.scalars().first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    # Check if voice exists for this character
    result = await db.execute(
        select(CharacterVoice).where(
            CharacterVoice.project_id == project_id,
            CharacterVoice.character_name == character_name
        )
    )
    voice = result.scalars().first()

    if voice:
        voice.voice_id = payload.voice_id
        voice.voice_type = payload.voice_type
        if payload.preview_url:
            voice.preview_url = payload.preview_url
        if payload.config:
            voice.config = payload.config
    else:
        voice = CharacterVoice(
            project_id=project_id,
            character_name=character_name,
            voice_id=payload.voice_id,
            voice_type=payload.voice_type,
            preview_url=payload.preview_url,
            config=payload.config or {}
        )
        db.add(voice)
    
    await db.commit()
    await db.refresh(voice)
    return voice

@router.post("/{project_id}/tts", response_model=TTSResponse)
async def generate_tts(
    project_id: str,
    payload: TTSRequest,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
):
    # Verify project access
    result = await db.execute(select(Project).where(Project.id == project_id, Project.user_id == user_id))
    project = result.scalars().first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    # Check if voice exists for this character
    result = await db.execute(
        select(CharacterVoice).where(
            CharacterVoice.project_id == project_id,
            CharacterVoice.character_name == payload.character_name
        )
    )
    voice = result.scalars().first()
    
    if not voice:
        raise HTTPException(status_code=400, detail=f"Voice not configured for character: {payload.character_name}")
    
    try:
        tts_config = payload.tts_config if isinstance(payload.tts_config, dict) else {}
        settings = tts_config.get("settings") if isinstance(tts_config.get("settings"), dict) else {}
        if "speed" not in settings and isinstance(payload.speed, (int, float)):
            settings["speed"] = payload.speed
        if isinstance(payload.volume, (int, float)):
            settings["style"] = max(0.0, min(1.0, (float(payload.volume) + 12.0) / 24.0))
        model_id = str(tts_config.get("model_id", "")).strip() or "eleven_v3"
        output_format = str(tts_config.get("output_format", "")).strip() or "mp3_44100_128"
        language_code = str(tts_config.get("language_code", "")).strip() or None
        previous_text = str(tts_config.get("previous_text", "")).strip() or None
        next_text = str(tts_config.get("next_text", "")).strip() or None
        seed = tts_config.get("seed") if isinstance(tts_config.get("seed"), int) else None
        pronunciation_overrides = (
            tts_config.get("pronunciation_overrides")
            if isinstance(tts_config.get("pronunciation_overrides"), list)
            else None
        )
        pronunciation_dictionary_locators = (
            tts_config.get("pronunciation_dictionary_locators")
            if isinstance(tts_config.get("pronunciation_dictionary_locators"), list)
            else None
        )
        audio_content = await eleven_labs_service.tts(
            text=payload.text,
            voice_id=voice.voice_id,
            model_id=model_id,
            output_format=output_format,
            settings=settings,
            language_code=language_code,
            seed=seed,
            previous_text=previous_text,
            next_text=next_text,
            pronunciation_overrides=pronunciation_overrides,
            pronunciation_dictionary_locators=pronunciation_dictionary_locators,
        )
        
        # Save file
        # backend/app/api/voices.py -> backend/app/api -> backend/app -> backend
        backend_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        static_dir = os.path.join(backend_dir, "static", "audio", project_id)
        os.makedirs(static_dir, exist_ok=True)
        
        filename_ext = "mp3" if output_format.startswith("mp3") else "wav"
        filename = f"{uuid.uuid4()}.{filename_ext}"
        file_path = os.path.join(static_dir, filename)
        
        with open(file_path, "wb") as f:
            f.write(audio_content)

        from app.services import media_storage

        out_url = f"/static/audio/{project_id}/{filename}"
        if media_storage.cos_enabled():
            out_url = await media_storage.publish_local_file_under_static(project_id, file_path)
        return TTSResponse(audio_url=out_url)
        
    except Exception as e:
        import logging
        logging.getLogger(__name__).error(f"TTS generation failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))
