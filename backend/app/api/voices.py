from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from typing import List, Optional

from app.api.deps import get_current_user_id
from app.core.db import get_db
from app.models.character_voice import CharacterVoice
from app.models.project import Project
from app.services.fish_audio import fish_audio_service
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
        # Generate TTS
        # fish_audio_service.tts returns bytes
        # voice.voice_id is the reference_id
        audio_content = await fish_audio_service.tts(
            payload.text,
            voice.voice_id,
            prosody_speed=payload.speed,
            prosody_volume=payload.volume,
            pitch=payload.pitch,
        )
        
        # Save file
        # backend/app/api/voices.py -> backend/app/api -> backend/app -> backend
        backend_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        static_dir = os.path.join(backend_dir, "static", "audio", project_id)
        os.makedirs(static_dir, exist_ok=True)
        
        filename = f"{uuid.uuid4()}.mp3"
        file_path = os.path.join(static_dir, filename)
        
        with open(file_path, "wb") as f:
            f.write(audio_content)
            
        return TTSResponse(audio_url=f"/static/audio/{project_id}/{filename}")
        
    except Exception as e:
        import logging
        logging.getLogger(__name__).error(f"TTS generation failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))
