from fastapi import APIRouter, UploadFile, File, Form, HTTPException, Depends
from typing import Optional
from app.services.fish_audio import fish_audio_service
from app.api.deps import get_current_user_id

router = APIRouter(tags=["fish-audio"])

@router.get("/models")
async def list_models(
    page: int = 1,
    size: int = 100,
    language: Optional[str] = None,
    query: Optional[str] = None,
    user_id: str = Depends(get_current_user_id)
):
    try:
        return await fish_audio_service.list_models(page, size, language, query)
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))

@router.post("/clone")
async def create_custom_model(
    title: str = Form(...),
    file: UploadFile = File(...),
    user_id: str = Depends(get_current_user_id)
):
    try:
        content = await file.read()
        return await fish_audio_service.create_model(
            title,
            content,
            file.filename,
            file.content_type
        )
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))

@router.post("/tts")
async def generate_tts(
    text: str = Form(...),
    reference_id: str = Form(...),
    format: str = Form("mp3"),
    user_id: str = Depends(get_current_user_id)
):
    try:
        audio_content = await fish_audio_service.tts(text, reference_id, format)
        from fastapi.responses import Response
        return Response(content=audio_content, media_type=f"audio/{format}")
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))
