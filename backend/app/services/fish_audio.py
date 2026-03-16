import httpx
import os
import logging
import time
import re
from typing import Dict, Any, List, Optional
from app.core.config import settings as app_settings

logger = logging.getLogger(__name__)

BASE_URL = "https://api.fish.audio"

class FishAudioService:
    _PROVIDER_PAGE_SIZE = 500
    _CACHE_TTL_SECONDS = 120
    _EMOTION_BASE = {
        "happy", "sad", "angry", "excited", "calm", "nervous", "confident", "surprised",
        "satisfied", "delighted", "scared", "worried", "upset", "frustrated", "depressed",
        "empathetic", "embarrassed", "disgusted", "moved", "proud", "relaxed", "grateful",
        "curious", "sarcastic", "disdainful", "unhappy", "anxious", "hysterical",
        "indifferent", "uncertain", "doubtful", "confused", "disappointed", "regretful",
        "guilty", "ashamed", "jealous", "envious", "hopeful", "optimistic", "pessimistic",
        "nostalgic", "lonely", "bored", "contemptuous", "sympathetic", "compassionate",
        "determined", "resigned",
    }
    _TONE_EFFECT = {
        "in a hurry tone", "shouting", "screaming", "whispering", "soft tone",
        "laughing", "chuckling", "sobbing", "crying loudly", "sighing", "groaning",
        "panting", "gasping", "yawning", "snoring", "audience laughing",
        "background laughter", "crowd laughing", "break", "long-break",
        "emphasis", "slight emphasis", "strong emphasis", "very strong emphasis",
    }
    _INTENSITY = {"slightly", "very", "extremely"}
    _CUSTOM_PAUSE_SECONDS_MIN = 0.2
    _CUSTOM_PAUSE_SECONDS_MAX = 8.0
    _PROSODY_SPEED_MIN = 0.5
    _PROSODY_SPEED_MAX = 2.0
    _PROSODY_VOLUME_MIN = -12.0
    _PROSODY_VOLUME_MAX = 12.0
    _PITCH_MIN = -2.0
    _PITCH_MAX = 2.0

    def __init__(self) -> None:
        self._models_cache: Dict[str, Dict[str, Any]] = {}

    def _api_key(self) -> str:
        return app_settings.fish_audio_api_key.strip() or os.getenv("FISH_AUDIO_API_KEY", "").strip()

    def _headers(self, include_json_content_type: bool = True) -> Dict[str, str]:
        api_key = self._api_key()
        if not api_key:
            raise RuntimeError("FISH_AUDIO_API_KEY 未配置，请先在后端环境变量中设置")
        headers = {
            "Authorization": f"Bearer {api_key}",
        }
        if include_json_content_type:
            headers["Content-Type"] = "application/json"
        return headers

    def _extract_preview_audio(self, model: Dict[str, Any]) -> Optional[str]:
        if model.get("preview_audio"):
            return model["preview_audio"]
        samples = model.get("samples")
        if isinstance(samples, list):
            for sample in samples:
                if isinstance(sample, dict):
                    audio = sample.get("audio")
                    if isinstance(audio, str) and audio:
                        return audio
        return None

    def _normalize_models(self, items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        normalized: List[Dict[str, Any]] = []
        for item in items:
            if not isinstance(item, dict):
                continue
            model = dict(item)
            preview_audio = self._extract_preview_audio(model)
            if preview_audio:
                model["preview_audio"] = preview_audio
            tags = model.get("tags")
            if not isinstance(tags, list):
                model["tags"] = []
            languages = model.get("languages")
            if not isinstance(languages, list):
                model["languages"] = []
            normalized.append(model)
        return normalized

    def _is_supported_control_tag(self, raw_tag: str) -> bool:
        candidate = raw_tag.strip().lower()
        if not candidate:
            return False
        if candidate in self._EMOTION_BASE or candidate in self._TONE_EFFECT:
            return True
        parts = candidate.split()
        if len(parts) >= 2 and parts[0] in self._INTENSITY:
            emotion = " ".join(parts[1:])
            return emotion in self._EMOTION_BASE
        return False

    def _normalize_control_tags(self, text: str) -> str:
        if not text:
            return text

        def replace_custom_pause(match: re.Match[str]) -> str:
            raw_value = match.group(1)
            raw_unit = (match.group(2) or "s").lower()
            try:
                value = float(raw_value)
            except ValueError:
                return match.group(0)
            seconds = value / 1000.0 if raw_unit in {"ms", "毫秒"} else value
            seconds = max(self._CUSTOM_PAUSE_SECONDS_MIN, min(self._CUSTOM_PAUSE_SECONDS_MAX, seconds))
            long_break_count = int(seconds // 1.0)
            remainder = seconds - long_break_count
            tags: List[str] = ["[long-break]"] * long_break_count
            if remainder >= 0.2:
                tags.append("[break]")
            return " ".join(tags) if tags else "[break]"

        def replace_paren(match: re.Match[str]) -> str:
            body = match.group(1)
            normalized = " ".join(body.strip().split())
            if not self._is_supported_control_tag(normalized):
                return match.group(0)
            return f"[{normalized}]"

        normalized_text = re.sub(
            r"\(\s*pause\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(ms|s|毫秒|秒)?\s*\)",
            replace_custom_pause,
            text,
            flags=re.IGNORECASE,
        )
        normalized_text = re.sub(r"\(([a-zA-Z][a-zA-Z\s\-]{1,60})\)", replace_paren, normalized_text)
        return normalized_text

    def _apply_pitch_control_tag(self, text: str, pitch: float) -> str:
        if not text:
            return text
        clamped_pitch = max(self._PITCH_MIN, min(self._PITCH_MAX, pitch))
        if abs(clamped_pitch) < 0.05:
            return text
        tag = "[pitch up]" if clamped_pitch > 0 else "[pitch down]"
        repeat = 2 if abs(clamped_pitch) >= 1.2 else 1
        return f"{' '.join([tag] * repeat)} {text}".strip()

    async def _list_models_raw(
        self,
        client: httpx.AsyncClient,
        page: int,
        page_size: int,
        language: Optional[str] = None,
        query: Optional[str] = None,
    ) -> Dict[str, Any]:
        url = f"{BASE_URL}/model"
        params: Dict[str, Any] = {"page": page, "type": "tts", "page_size": page_size}
        if language:
            params["language"] = language
        if query:
            params["title"] = query
        headers = self._headers()
        response = await client.get(url, headers=headers, params=params)
        response.raise_for_status()
        payload = response.json()
        items = payload.get("items")
        if not isinstance(items, list):
            items = payload.get("data", {}).get("items", [])
        total = payload.get("total")
        if not isinstance(total, int):
            total = payload.get("data", {}).get("total", len(items))
        return {"items": self._normalize_models(items), "total": total}

    async def list_models(
        self,
        page: int = 1,
        size: int = 100,
        language: Optional[str] = None,
        query: Optional[str] = None,
    ) -> Dict[str, Any]:
        normalized_page = max(1, page)
        normalized_size = max(1, min(size, 500))
        language_key = (language or "").strip().lower()
        query_key = (query or "").strip()
        if query_key:
            async with httpx.AsyncClient(timeout=30.0) as client:
                payload = await self._list_models_raw(
                    client,
                    normalized_page,
                    normalized_size,
                    language_key or None,
                    query_key,
                )
            items = payload["items"]
            seen_ids: set[str] = set()
            deduped_items: List[Dict[str, Any]] = []
            for item in items:
                model_id = str(item.get("_id", "")).strip()
                if not model_id or model_id in seen_ids:
                    continue
                deduped_items.append(item)
                seen_ids.add(model_id)
            total = payload.get("total")
            if not isinstance(total, int):
                total = len(deduped_items)
            return {"items": deduped_items, "total": total}
        cache_key = f"dataset:{language_key}"
        now = time.time()
        cached = self._models_cache.get(cache_key)
        if cached and now - float(cached.get("ts", 0)) < self._CACHE_TTL_SECONDS:
            all_items = list(cached.get("items", []))
            total = int(cached.get("total", len(all_items)))
        else:
            async with httpx.AsyncClient(timeout=30.0) as client:
                payload = await self._list_models_raw(client, 1, self._PROVIDER_PAGE_SIZE, language_key or None)
            all_items = payload["items"]
            seen_ids: set[str] = set()
            deduped_items: List[Dict[str, Any]] = []
            for item in all_items:
                model_id = str(item.get("_id", "")).strip()
                if not model_id or model_id in seen_ids:
                    continue
                deduped_items.append(item)
                seen_ids.add(model_id)
            all_items = deduped_items
            total = len(all_items)
            self._models_cache[cache_key] = {
                "ts": now,
                "items": list(all_items),
                "total": total,
            }
            if len(self._models_cache) > 64:
                oldest_key = min(self._models_cache, key=lambda key: float(self._models_cache[key].get("ts", 0)))
                self._models_cache.pop(oldest_key, None)

        offset = (normalized_page - 1) * normalized_size
        page_items = all_items[offset: offset + normalized_size]
        return {"items": page_items, "total": total}

    async def create_model(
        self,
        title: str,
        audio_file: bytes,
        filename: str,
        content_type: Optional[str] = None
    ) -> Dict[str, Any]:
        url = f"{BASE_URL}/model"
        upload_content_type = content_type or "application/octet-stream"
        files = {
            "voices": (filename, audio_file, upload_content_type)
        }
        data = {
            "title": title,
            "visibility": "private",
            "train_mode": "fast",
            "type": "tts"
        }
        headers = self._headers(include_json_content_type=False)
        async with httpx.AsyncClient(timeout=120.0) as client:
            response = await client.post(url, headers=headers, data=data, files=files)
            if response.is_error:
                detail = response.text
                raise RuntimeError(f"Fish Audio 克隆失败：{detail}")
            return response.json()

    async def tts(
        self,
        text: str,
        reference_id: str,
        format: str = "mp3",
        prosody_speed: float = 1.0,
        prosody_volume: float = 0.0,
        pitch: float = 0.0,
    ) -> bytes:
        url = f"{BASE_URL}/v1/tts"
        headers = self._headers()
        normalized_text = self._normalize_control_tags(text)
        normalized_text = self._apply_pitch_control_tag(normalized_text, pitch)
        normalized_speed = max(self._PROSODY_SPEED_MIN, min(self._PROSODY_SPEED_MAX, float(prosody_speed)))
        normalized_volume = max(self._PROSODY_VOLUME_MIN, min(self._PROSODY_VOLUME_MAX, float(prosody_volume)))
        has_control_tags = bool(re.search(r"\[[a-zA-Z][a-zA-Z\s\-]{1,60}\]", normalized_text))
        payload = {
            "text": normalized_text,
            "reference_id": reference_id,
            "format": format,
            "mp3_bitrate": 128,
            "normalize": not has_control_tags,
            "prosody": {
                "speed": normalized_speed,
                "volume": normalized_volume,
            },
        }

        async with httpx.AsyncClient() as client:
            response = await client.post(url, headers=headers, json=payload, timeout=60.0)
            response.raise_for_status()
            return response.content

fish_audio_service = FishAudioService()
