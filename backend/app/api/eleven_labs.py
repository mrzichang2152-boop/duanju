import json
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import Response

from app.api.deps import get_current_user_id
from app.services.eleven_labs import eleven_labs_service

router = APIRouter(tags=["eleven-labs"])


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


@router.post("/clone")
async def clone_voice(
    title: str = Form(...),
    file: UploadFile = File(...),
    user_id: str = Depends(get_current_user_id),
):
    try:
        content = await file.read()
        return await eleven_labs_service.create_voice(title, content, file.filename, file.content_type)
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))
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
