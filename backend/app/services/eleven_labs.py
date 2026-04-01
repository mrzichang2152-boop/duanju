import json
import logging
import os
import re
from typing import Any, Dict, List, Optional

import httpx

from app.core.config import settings as app_settings

BASE_URL = "https://api.elevenlabs.io"
LOGGER = logging.getLogger(__name__)
OFFICIAL_CHINESE_ACCENTS = [
    "粤语（广州）",
    "粤语（香港）",
    "粤语（新加坡）",
    "普通话（北京）",
    "普通话（新加坡）",
    "普通话（台湾）",
    "标准",
]
ACCENT_ALIAS_MAP = {
    "cantonese guangzhou": "粤语（广州）",
    "cantonese hong kong": "粤语（香港）",
    "cantonese singapore": "粤语（新加坡）",
    "mandarin beijing": "普通话（北京）",
    "mandarin singapore": "普通话（新加坡）",
    "mandarin taiwan": "普通话（台湾）",
    "standard": "标准",
    "yue guangzhou": "粤语（广州）",
    "yue hong kong": "粤语（香港）",
    "yue singapore": "粤语（新加坡）",
    "putonghua beijing": "普通话（北京）",
    "putonghua singapore": "普通话（新加坡）",
    "putonghua taiwan": "普通话（台湾）",
}
AGE_ALIAS_MAP = {
    "young": "青年",
    "youth": "青年",
    "teen": "青年",
    "middle": "中年",
    "middle aged": "中年",
    "middleage": "中年",
    "adult": "中年",
    "old": "老年",
    "senior": "老年",
    "elder": "老年",
}


class ElevenLabsService:
    _CUSTOM_PAUSE_SECONDS_MIN = 0.1
    _CUSTOM_PAUSE_SECONDS_MAX = 10.0
    _SPEED_MIN = 0.7
    _SPEED_MAX = 1.2
    _STABILITY_MIN = 0.0
    _STABILITY_MAX = 1.0
    _SIMILARITY_MIN = 0.0
    _SIMILARITY_MAX = 1.0
    _STYLE_MIN = 0.0
    _STYLE_MAX = 1.0
    _SFX_MODEL_ID = "eleven_text_to_sound_v2"

    def _api_key(self) -> str:
        return app_settings.elevenlabs_api_key.strip() or os.getenv("ELEVENLABS_API_KEY", "").strip()

    def _headers(self, accept: Optional[str] = None) -> Dict[str, str]:
        api_key = self._api_key()
        if not api_key:
            raise RuntimeError("ELEVENLABS_API_KEY 未配置，请先在后端环境变量中设置")
        headers = {
            "xi-api-key": api_key,
        }
        if accept:
            headers["accept"] = accept
        return headers

    def _normalize_label_value(self, value: Any) -> str:
        text = str(value or "").strip().lower()
        if not text:
            return ""
        text = text.replace("_", " ").replace("-", " ")
        return re.sub(r"\s+", " ", text).strip()

    def _canonical_language(self, value: Any) -> str:
        normalized = self._normalize_label_value(value)
        if not normalized:
            return ""
        if normalized in {"zh", "zh cn", "chinese", "mandarin", "中文", "汉语", "普通话"}:
            return "zh"
        if normalized in {"en", "english", "英文", "英语"}:
            return "en"
        return normalized.split(" ")[0]

    def _shared_language_param(self, value: Any) -> str:
        canonical = self._canonical_language(value)
        if canonical == "zh":
            return "Chinese"
        if canonical == "en":
            return "English"
        return str(value or "").strip()

    def _canonical_accent(self, value: Any) -> str:
        normalized = self._normalize_label_value(value)
        if not normalized:
            return ""
        if normalized in ACCENT_ALIAS_MAP:
            return ACCENT_ALIAS_MAP[normalized]
        return str(value or "").strip()

    def _canonical_age(self, value: Any) -> str:
        normalized = self._normalize_label_value(value)
        if not normalized:
            return ""
        if normalized in AGE_ALIAS_MAP:
            return AGE_ALIAS_MAP[normalized]
        if normalized in {"青年", "中年", "老年"}:
            return normalized
        return str(value or "").strip()

    def _label_value_from_voice(self, voice: Dict[str, Any], key: str) -> str:
        labels = voice.get("labels") if isinstance(voice.get("labels"), dict) else {}
        label_value = str(labels.get(key, "")).strip()
        if label_value:
            return label_value
        if key == "quality":
            top_quality = str(voice.get("quality", "")).strip()
            if top_quality:
                return top_quality
            if bool(voice.get("is_high_quality")) or bool(voice.get("high_quality")):
                return "high_quality"
            return ""
        return str(voice.get(key, "")).strip()

    def _language_matches(self, item: Dict[str, Any], language_filter: str) -> bool:
        normalized_filter = self._canonical_language(language_filter)
        if not normalized_filter:
            return True
        values: List[str] = []
        labels = item.get("labels") if isinstance(item.get("labels"), dict) else {}
        language_label = str(labels.get("language", "")).strip()
        if language_label:
            values.append(language_label)
        values.extend(item.get("languages") if isinstance(item.get("languages"), list) else [])
        canonical_values = [self._canonical_language(value) for value in values if str(value or "").strip()]
        if any(normalized_filter == value for value in canonical_values):
            return True
        if normalized_filter == "zh":
            labels = item.get("labels") if isinstance(item.get("labels"), dict) else {}
            accent_value = self._normalize_label_value(labels.get("accent", ""))
            if any(
                keyword in accent_value
                for keyword in (
                    "mandarin",
                    "putonghua",
                    "cantonese",
                    "beijing",
                    "taiwan",
                    "hong kong",
                    "guangzhou",
                    "singapore",
                    "普通话",
                    "粤语",
                    "中文",
                    "汉语",
                )
            ):
                return True
            text_blob = " ".join(
                [
                    str(item.get("title", "")),
                    str(item.get("description", "")),
                    " ".join(item.get("tags") if isinstance(item.get("tags"), list) else []),
                    str(labels.get("language", "")),
                    str(labels.get("accent", "")),
                ]
            )
            normalized_blob = self._normalize_label_value(text_blob)
            if any(
                keyword in normalized_blob
                for keyword in (
                    "chinese",
                    "mandarin",
                    "putonghua",
                    "cantonese",
                    "yue",
                    "中文",
                    "汉语",
                    "普通话",
                    "粤语",
                )
            ):
                return True
        return False

    def _label_matches(self, item: Dict[str, Any], key: str, filter_value: Optional[str]) -> bool:
        normalized_filter = self._normalize_label_value(filter_value)
        if not normalized_filter:
            return True
        labels = item.get("labels") if isinstance(item.get("labels"), dict) else {}
        raw_value = str(labels.get(key, "")).strip()
        if not raw_value and key == "quality":
            raw_value = str(labels.get("quality", "")).strip()
        if key == "accent":
            normalized_value = self._canonical_accent(raw_value)
            normalized_filter_value = self._canonical_accent(filter_value)
        elif key == "age":
            normalized_value = self._canonical_age(raw_value)
            normalized_filter_value = self._canonical_age(filter_value)
        else:
            normalized_value = self._normalize_label_value(raw_value)
            normalized_filter_value = normalized_filter
        if not str(normalized_value).strip():
            return False
        return (
            str(normalized_filter_value).strip() == str(normalized_value).strip()
            or self._normalize_label_value(str(normalized_filter_value)) in self._normalize_label_value(str(normalized_value))
            or self._normalize_label_value(str(normalized_value)) in self._normalize_label_value(str(normalized_filter_value))
        )

    def _collect_voice_facets(self, voices: List[Dict[str, Any]], language_filter: Optional[str] = None) -> Dict[str, List[str]]:
        languages: Dict[str, str] = {}
        accents: Dict[str, str] = {}
        genders: Dict[str, str] = {}
        ages: Dict[str, str] = {}
        qualities: Dict[str, str] = {}
        for voice in voices:
            labels = voice.get("labels") if isinstance(voice.get("labels"), dict) else {}
            language_value = str(labels.get("language", "")).strip()
            accent_value = str(labels.get("accent", "")).strip()
            gender_value = str(labels.get("gender", "")).strip()
            age_value = self._canonical_age(labels.get("age", ""))
            quality_value = str(labels.get("quality", "")).strip()
            if not language_value:
                raw_languages = voice.get("languages") if isinstance(voice.get("languages"), list) else []
                language_value = str(raw_languages[0]).strip() if raw_languages else ""
            for value, bucket in (
                (language_value, languages),
                (accent_value, accents),
                (gender_value, genders),
                (age_value, ages),
                (quality_value, qualities),
            ):
                normalized = self._normalize_label_value(value)
                if normalized and normalized not in bucket:
                    bucket[normalized] = str(value).strip()
        if self._canonical_language(language_filter) == "zh":
            for accent_value in OFFICIAL_CHINESE_ACCENTS:
                if accent_value not in accents.values():
                    accents[self._normalize_label_value(accent_value)] = accent_value
        for age_value in ["青年", "中年", "老年"]:
            if age_value not in ages.values():
                ages[self._normalize_label_value(age_value)] = age_value
        sort_key = lambda value: self._normalize_label_value(value)
        return {
            "languages": sorted(languages.values(), key=sort_key),
            "accents": sorted(accents.values(), key=sort_key),
            "genders": sorted(genders.values(), key=sort_key),
            "ages": sorted(ages.values(), key=sort_key),
            "qualities": sorted(qualities.values(), key=sort_key),
        }

    def _extract_tags(self, voice: Dict[str, Any]) -> List[str]:
        tags: List[str] = []
        for key in ("accent", "age", "gender", "language", "description", "use_case", "quality"):
            value = self._label_value_from_voice(voice, key)
            if value:
                tags.append(value)
        category = str(voice.get("category", "")).strip()
        if category:
            tags.append(category)
        return list(dict.fromkeys(tags))

    def _extract_languages(self, voice: Dict[str, Any]) -> List[str]:
        language = self._label_value_from_voice(voice, "language")
        if not language:
            return []
        lower = language.lower()
        if "chinese" in lower:
            return ["zh"]
        if "english" in lower:
            return ["en"]
        return [lower]

    def _is_cloned_voice(self, voice: Dict[str, Any]) -> bool:
        category = self._normalize_label_value(voice.get("category", ""))
        if category in {"generated", "cloned"}:
            return True
        if category in {"professional", "premade", "library"}:
            return False
        labels = voice.get("labels") if isinstance(voice.get("labels"), dict) else {}
        source_value = self._normalize_label_value(labels.get("source", ""))
        if source_value in {"generated", "cloned"}:
            return True
        return False

    def _normalize_voice(self, voice: Dict[str, Any], is_my_voice: bool = False) -> Dict[str, Any]:
        voice_id = str(voice.get("voice_id", "")).strip()
        name = str(voice.get("name", "")).strip()
        description = str(voice.get("description", "")).strip()
        preview_audio = str(voice.get("preview_url", "")).strip()
        labels = dict(voice.get("labels")) if isinstance(voice.get("labels"), dict) else {}
        for key in ("language", "accent", "gender", "age", "use_case", "quality"):
            value = self._label_value_from_voice(voice, key)
            if value:
                if key == "accent":
                    value = self._canonical_accent(value)
                if key == "age":
                    value = self._canonical_age(value)
                labels[key] = value
        category = str(voice.get("category", "")).strip()
        if not category and bool(voice.get("public_owner_id")):
            category = "library"
        is_clone = self._is_cloned_voice(voice)
        return {
            "_id": voice_id,
            "title": name or voice_id,
            "description": description,
            "default_text": "",
            "cover_image": "",
            "preview_audio": preview_audio,
            "tags": self._extract_tags(voice),
            "languages": self._extract_languages(voice),
            "labels": labels,
            "category": category,
            "samples": [],
            "is_my_voice": bool(is_my_voice),
            "is_clone": bool(is_clone),
            "can_delete": bool(is_my_voice and is_clone),
        }

    def _normalize_model(self, model: Dict[str, Any]) -> Dict[str, Any]:
        model_id = str(model.get("model_id", "")).strip()
        name = str(model.get("name", "")).strip()
        description = str(model.get("description", "")).strip()
        return {
            "model_id": model_id,
            "name": name or model_id,
            "description": description,
            "can_do_text_to_speech": bool(model.get("can_do_text_to_speech")),
            "can_do_voice_conversion": bool(model.get("can_do_voice_conversion")),
            "languages": model.get("languages") if isinstance(model.get("languages"), list) else [],
        }

    def _normalize_pause_tag(self, text: str) -> str:
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
            return f"<break time=\"{seconds:.1f}s\"/>"

        return re.sub(
            r"\(\s*pause\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(ms|s|毫秒|秒)?\s*\)",
            replace_custom_pause,
            text,
            flags=re.IGNORECASE,
        )

    def _apply_pronunciation_overrides(
        self,
        text: str,
        pronunciation_overrides: Optional[List[Dict[str, str]]],
    ) -> str:
        if not text or not pronunciation_overrides:
            return text
        result = text
        for item in pronunciation_overrides:
            if not isinstance(item, dict):
                continue
            source = str(item.get("source", "")).strip()
            target = str(item.get("target", "")).strip()
            if not source or not target:
                continue
            result = re.sub(re.escape(source), target, result)
        return result

    async def list_voices(
        self,
        page: int = 1,
        size: int = 100,
        language: Optional[str] = None,
        query: Optional[str] = None,
        accent: Optional[str] = None,
        gender: Optional[str] = None,
        age: Optional[str] = None,
        quality: Optional[str] = None,
        include_library: bool = True,
    ) -> Dict[str, Any]:
        headers = self._headers(accept="application/json")
        safe_size = max(1, min(int(size), 200))
        safe_page = max(1, int(page))
        normalized_language = self._canonical_language(language)
        my_voices: List[Dict[str, Any]] = []
        shared_voices: List[Dict[str, Any]] = []
        shared_has_more = False
        shared_total: Optional[int] = None
        shared_params: Dict[str, Any] = {"page_size": safe_size, "page": safe_page}
        if language and normalized_language != "zh":
            shared_params["language"] = self._shared_language_param(language)
        if query:
            shared_params["search"] = query
        if accent:
            shared_params["accent"] = accent
        if gender:
            shared_params["gender"] = gender
        if age:
            shared_params["age"] = age
        if quality:
            shared_params["quality"] = quality
        async with httpx.AsyncClient(timeout=45.0) as client:
            response = await client.get(f"{BASE_URL}/v1/voices", headers=headers)
            if not response.is_error:
                payload = response.json()
                voices = payload.get("voices")
                if isinstance(voices, list):
                    my_voices = [item for item in voices if isinstance(item, dict)]
            if include_library:
                if normalized_language == "zh":
                    scan_queries: List[str] = []
                    trimmed_query = str(query or "").strip()
                    if trimmed_query:
                        scan_queries.append(trimmed_query)
                    else:
                        scan_queries.append("")
                        for keyword in ("chinese", "mandarin", "cantonese", "putonghua"):
                            if keyword not in [self._normalize_label_value(item) for item in scan_queries]:
                                scan_queries.append(keyword)
                    for search_value in scan_queries:
                        page_cursor = 1
                        scanned_pages = 0
                        while scanned_pages < 2:
                            params = {"page_size": safe_size, "page": page_cursor}
                            if search_value:
                                params["search"] = search_value
                            if accent:
                                params["accent"] = accent
                            if gender:
                                params["gender"] = gender
                            if age:
                                params["age"] = age
                            if quality:
                                params["quality"] = quality
                            shared_response = await client.get(
                                f"{BASE_URL}/v1/shared-voices",
                                headers=headers,
                                params=params,
                            )
                            if shared_response.is_error:
                                raise RuntimeError(f"ElevenLabs Library 音色获取失败：{shared_response.text}")
                            shared_payload = shared_response.json()
                            page_voices = shared_payload.get("voices")
                            if isinstance(page_voices, list):
                                shared_voices.extend([item for item in page_voices if isinstance(item, dict)])
                            current_has_more = bool(shared_payload.get("has_more"))
                            if not current_has_more:
                                break
                            page_cursor += 1
                            scanned_pages += 1
                    shared_total = None
                    shared_has_more = False
                else:
                    shared_response = await client.get(
                        f"{BASE_URL}/v1/shared-voices",
                        headers=headers,
                        params=shared_params,
                    )
                    if shared_response.is_error:
                        raise RuntimeError(f"ElevenLabs Library 音色获取失败：{shared_response.text}")
                    shared_payload = shared_response.json()
                    page_voices = shared_payload.get("voices")
                    if isinstance(page_voices, list):
                        shared_voices = [item for item in page_voices if isinstance(item, dict)]
                    shared_has_more = bool(shared_payload.get("has_more"))
                    shared_total_value = shared_payload.get("total")
                    if isinstance(shared_total_value, int):
                        shared_total = shared_total_value
        merged_sources: List[tuple[Dict[str, Any], bool]] = [
            (item, False) for item in shared_voices if isinstance(item, dict)
        ]
        if safe_page == 1:
            merged_sources.extend((item, True) for item in my_voices if isinstance(item, dict))
        voices_by_id: Dict[str, Dict[str, Any]] = {}
        for raw, is_my_voice in merged_sources:
            item = self._normalize_voice(raw, is_my_voice=is_my_voice)
            voice_id = str(item.get("_id", "")).strip()
            if not voice_id:
                continue
            if voice_id not in voices_by_id:
                voices_by_id[voice_id] = item
                continue
            existing = voices_by_id[voice_id]
            existing_tags = set(existing.get("tags") if isinstance(existing.get("tags"), list) else [])
            incoming_tags = item.get("tags") if isinstance(item.get("tags"), list) else []
            for tag in incoming_tags:
                if tag not in existing_tags:
                    (existing.setdefault("tags", [])).append(tag)
                    existing_tags.add(tag)
            existing_labels = existing.get("labels") if isinstance(existing.get("labels"), dict) else {}
            incoming_labels = item.get("labels") if isinstance(item.get("labels"), dict) else {}
            for key, value in incoming_labels.items():
                if key not in existing_labels and str(value).strip():
                    existing_labels[key] = value
            existing["labels"] = existing_labels
            existing_languages = existing.get("languages") if isinstance(existing.get("languages"), list) else []
            incoming_languages = item.get("languages") if isinstance(item.get("languages"), list) else []
            for lang in incoming_languages:
                if lang not in existing_languages:
                    existing_languages.append(lang)
            existing["languages"] = existing_languages
            if not str(existing.get("preview_audio", "")).strip() and str(item.get("preview_audio", "")).strip():
                existing["preview_audio"] = item.get("preview_audio")
            if not str(existing.get("description", "")).strip() and str(item.get("description", "")).strip():
                existing["description"] = item.get("description")
            if (
                self._normalize_label_value(str(existing.get("category", ""))) != "library"
                and self._normalize_label_value(str(item.get("category", ""))) == "library"
            ):
                existing["category"] = "library"
            if bool(item.get("is_my_voice")):
                existing["is_my_voice"] = True
            if bool(item.get("is_clone")):
                existing["is_clone"] = True
            existing["can_delete"] = bool(existing.get("is_my_voice") and existing.get("is_clone"))
        normalized_items = list(voices_by_id.values())

        query_text = (query or "").strip().lower()
        if query_text:
            normalized_items = [
                item
                for item in normalized_items
                if query_text in f"{item.get('title', '')} {item.get('_id', '')} {' '.join(item.get('tags', []))}".lower()
            ]

        if language:
            normalized_items = [item for item in normalized_items if self._language_matches(item, language)]
        if accent:
            normalized_items = [item for item in normalized_items if self._label_matches(item, "accent", accent)]
        if gender:
            normalized_items = [item for item in normalized_items if self._label_matches(item, "gender", gender)]
        if age:
            normalized_items = [item for item in normalized_items if self._label_matches(item, "age", age)]
        if quality:
            normalized_items = [item for item in normalized_items if self._label_matches(item, "quality", quality)]

        facets = self._collect_voice_facets(normalized_items, language_filter=language)
        normalized_items.sort(key=lambda item: str(item.get("title", "")).lower())
        if include_library:
            if normalized_language == "zh":
                total = len(normalized_items)
                offset = (safe_page - 1) * safe_size
                return {
                    "items": normalized_items[offset : offset + safe_size],
                    "total": total,
                    "facets": facets,
                    "has_more": offset + safe_size < total,
                }
            total = shared_total if isinstance(shared_total, int) and shared_total >= 0 else (
                safe_page * safe_size + (1 if shared_has_more else 0)
            )
            return {"items": normalized_items, "total": total, "facets": facets, "has_more": shared_has_more}
        total = len(normalized_items)
        offset = (safe_page - 1) * safe_size
        return {"items": normalized_items[offset : offset + safe_size], "total": total, "facets": facets, "has_more": False}

    async def create_voice(
        self,
        title: str,
        audio_file: bytes,
        filename: str,
        content_type: Optional[str] = None,
    ) -> Dict[str, Any]:
        headers = self._headers()
        files = {"files": (filename, audio_file, content_type or "application/octet-stream")}
        data = {"name": title}
        async with httpx.AsyncClient(timeout=120.0) as client:
            response = await client.post(f"{BASE_URL}/v1/voices/add", headers=headers, files=files, data=data)
            if response.is_error:
                raise RuntimeError(f"ElevenLabs 克隆失败：{response.text}")
            payload = response.json()
        voice_id = str(payload.get("voice_id", "")).strip()
        return {"_id": voice_id, "model_id": voice_id, "title": title, "cover_image": "", "is_clone": True, "can_delete": True}

    async def list_my_cloned_voices(self) -> List[Dict[str, Any]]:
        headers = self._headers(accept="application/json")
        async with httpx.AsyncClient(timeout=45.0) as client:
            response = await client.get(f"{BASE_URL}/v1/voices", headers=headers)
            if response.is_error:
                raise RuntimeError(f"ElevenLabs 音色列表获取失败：{response.text}")
            payload = response.json()
        voices = payload.get("voices")
        if not isinstance(voices, list):
            return []
        normalized = [
            self._normalize_voice(item, is_my_voice=True)
            for item in voices
            if isinstance(item, dict) and self._is_cloned_voice(item)
        ]
        normalized.sort(key=lambda item: str(item.get("title", "")).lower())
        return normalized

    async def delete_voice(self, voice_id: str) -> None:
        normalized_voice_id = str(voice_id or "").strip()
        if not normalized_voice_id:
            raise RuntimeError("voice_id 不能为空")
        headers = self._headers(accept="application/json")
        async with httpx.AsyncClient(timeout=45.0) as client:
            response = await client.delete(f"{BASE_URL}/v1/voices/{normalized_voice_id}", headers=headers)
            if response.is_error:
                raise RuntimeError(f"ElevenLabs 删除音色失败：{response.text}")

    async def list_models(
        self,
        can_do_voice_conversion: Optional[bool] = None,
    ) -> Dict[str, Any]:
        headers = self._headers(accept="application/json")
        async with httpx.AsyncClient(timeout=45.0) as client:
            response = await client.get(f"{BASE_URL}/v1/models", headers=headers)
            if response.is_error:
                raise RuntimeError(f"ElevenLabs 模型列表获取失败：{response.text}")
            payload = response.json()
        models = payload if isinstance(payload, list) else []
        normalized = [self._normalize_model(item) for item in models if isinstance(item, dict)]
        if can_do_voice_conversion is not None:
            normalized = [
                item
                for item in normalized
                if bool(item.get("can_do_voice_conversion")) is bool(can_do_voice_conversion)
            ]
        normalized.sort(key=lambda item: str(item.get("name", "")).lower())
        return {"items": normalized, "total": len(normalized)}

    async def tts(
        self,
        text: str,
        voice_id: str,
        model_id: str = "eleven_v3",
        output_format: str = "mp3_44100_128",
        settings: Optional[Dict[str, Any]] = None,
        language_code: Optional[str] = None,
        seed: Optional[int] = None,
        previous_text: Optional[str] = None,
        next_text: Optional[str] = None,
        pronunciation_overrides: Optional[List[Dict[str, str]]] = None,
        pronunciation_dictionary_locators: Optional[List[Dict[str, str]]] = None,
    ) -> bytes:
        normalized_text = self._apply_pronunciation_overrides(text, pronunciation_overrides)
        normalized_text = self._normalize_pause_tag(normalized_text)
        payload: Dict[str, Any] = {
            "text": normalized_text,
            "model_id": model_id or "eleven_v3",
        }
        settings_payload: Dict[str, Any] = {}
        incoming_settings = settings if isinstance(settings, dict) else {}
        stability = incoming_settings.get("stability")
        similarity_boost = incoming_settings.get("similarity_boost")
        style = incoming_settings.get("style")
        speed = incoming_settings.get("speed")
        use_speaker_boost = incoming_settings.get("use_speaker_boost")
        if isinstance(stability, (int, float)):
            settings_payload["stability"] = max(self._STABILITY_MIN, min(self._STABILITY_MAX, float(stability)))
        if isinstance(similarity_boost, (int, float)):
            settings_payload["similarity_boost"] = max(self._SIMILARITY_MIN, min(self._SIMILARITY_MAX, float(similarity_boost)))
        if isinstance(style, (int, float)):
            settings_payload["style"] = max(self._STYLE_MIN, min(self._STYLE_MAX, float(style)))
        if isinstance(speed, (int, float)):
            settings_payload["speed"] = max(self._SPEED_MIN, min(self._SPEED_MAX, float(speed)))
        if isinstance(use_speaker_boost, bool):
            settings_payload["use_speaker_boost"] = use_speaker_boost
        if settings_payload:
            payload["voice_settings"] = settings_payload
        if language_code:
            payload["language_code"] = language_code
        if isinstance(seed, int):
            payload["seed"] = seed
        if previous_text:
            payload["previous_text"] = previous_text
        if next_text:
            payload["next_text"] = next_text
        if pronunciation_dictionary_locators:
            payload["pronunciation_dictionary_locators"] = pronunciation_dictionary_locators

        headers = self._headers(accept="audio/mpeg")
        async with httpx.AsyncClient(timeout=120.0) as client:
            response = await client.post(
                f"{BASE_URL}/v1/text-to-speech/{voice_id}",
                headers=headers,
                params={"output_format": output_format},
                json=payload,
            )
            if response.is_error:
                raise RuntimeError(f"ElevenLabs 配音失败：{response.text}")
            return response.content

    async def speech_to_speech(
        self,
        audio_bytes: bytes,
        voice_id: str,
        filename: str = "segment.wav",
        model_id: str = "eleven_v3",
        settings: Optional[Dict[str, Any]] = None,
        output_format: str = "mp3_44100_128",
    ) -> bytes:
        headers = self._headers(accept="audio/mpeg")
        incoming_settings = settings if isinstance(settings, dict) else {}
        settings_payload: Dict[str, Any] = {}
        stability = incoming_settings.get("stability")
        similarity_boost = incoming_settings.get("similarity_boost")
        style = incoming_settings.get("style")
        speed = incoming_settings.get("speed")
        use_speaker_boost = incoming_settings.get("use_speaker_boost")
        if isinstance(stability, (int, float)):
            settings_payload["stability"] = max(self._STABILITY_MIN, min(self._STABILITY_MAX, float(stability)))
        if isinstance(similarity_boost, (int, float)):
            settings_payload["similarity_boost"] = max(self._SIMILARITY_MIN, min(self._SIMILARITY_MAX, float(similarity_boost)))
        if isinstance(style, (int, float)):
            settings_payload["style"] = max(self._STYLE_MIN, min(self._STYLE_MAX, float(style)))
        if isinstance(speed, (int, float)):
            settings_payload["speed"] = max(self._SPEED_MIN, min(self._SPEED_MAX, float(speed)))
        if isinstance(use_speaker_boost, bool):
            settings_payload["use_speaker_boost"] = use_speaker_boost
        data: Dict[str, Any] = {
            "model_id": model_id or "eleven_v3",
            "output_format": output_format,
        }
        if settings_payload:
            data["voice_settings"] = json.dumps(settings_payload, ensure_ascii=False)
        files = {"audio": (filename, audio_bytes, "audio/wav")}
        async with httpx.AsyncClient(timeout=120.0) as client:
            response = await client.post(
                f"{BASE_URL}/v1/speech-to-speech/{voice_id}",
                headers=headers,
                data=data,
                files=files,
            )
            if response.is_error:
                raise RuntimeError(f"ElevenLabs 语音转换失败：{response.text}")
            return response.content

    async def text_to_sound_effect(
        self,
        text: str,
        duration_seconds: float,
        model_id: str = "eleven_text_to_sound_v2",
        loop: bool = False,
        prompt_influence: float = 0.3,
    ) -> tuple[bytes, str]:
        normalized_text = str(text or "").strip()
        if not normalized_text:
            raise RuntimeError("ElevenLabs 音效生成失败：提示词不能为空")
        normalized_text_lower = normalized_text.lower()
        non_vocal_phrases = (
            "无人声",
            "无 人声",
            "不要人声",
            "无对白",
            "无 台词",
            "无台词",
            "无旁白",
            "no voice",
            "no speech",
            "no dialogue",
            "non-verbal",
            "without voice",
            "without speech",
            "without dialogue",
        )
        vocal_intent_text = normalized_text_lower
        for phrase in non_vocal_phrases:
            vocal_intent_text = vocal_intent_text.replace(phrase, "")
        speech_keywords = (
            "对白",
            "台词",
            "说话",
            "讲话",
            "口播",
            "配音",
            "朗读",
            "独白",
            "解说",
            "男声",
            "女声",
            "人声",
            "歌声",
            "吟唱",
            "哼唱",
            "大喊",
            "喊叫",
            "呼喊",
            "尖叫",
            "笑声",
            "哭声",
            "对话",
            "旁白",
            "whisper",
            "talking",
            "speaking",
            "male voice",
            "female voice",
            "voiceover",
            "narrator",
            "humming",
            "scream",
            "shout",
            "laugh",
            "crying",
            "rap",
            "唱",
            "歌词",
            "dialogue",
            "speech",
            "narration",
            "voice",
            "vocal",
            "lyric",
            "sing",
        )
        if any(keyword in vocal_intent_text for keyword in speech_keywords):
            raise RuntimeError("ElevenLabs 音效生成失败：提示词包含人声意图，请改为纯环境/特效音描述")
        request_model_id = str(model_id or self._SFX_MODEL_ID).strip() or self._SFX_MODEL_ID
        if request_model_id != self._SFX_MODEL_ID:
            raise RuntimeError(f"ElevenLabs 音效生成失败：仅支持模型 {self._SFX_MODEL_ID}")
        safe_duration = max(0.5, min(30.0, float(duration_seconds)))
        safe_prompt_influence = max(0.0, min(1.0, float(prompt_influence)))
        payload_base: Dict[str, Any] = {
            "duration_seconds": safe_duration,
            "model_id": self._SFX_MODEL_ID,
            "loop": bool(loop),
            "prompt_influence": safe_prompt_influence,
        }
        strict_non_vocal_suffix = (
            "sound effect only, non-verbal, no speech, no dialogue, no narration, no vocals, no voice"
        )
        strict_prompt = normalized_text
        if strict_non_vocal_suffix not in normalized_text.lower():
            strict_prompt = f"{normalized_text}. {strict_non_vocal_suffix}"
        concise_prompt = re.split(r"[，,。.;；!！?？]+", normalized_text)[0].strip()
        strict_concise_prompt = strict_prompt
        if concise_prompt and concise_prompt != normalized_text:
            strict_concise_prompt = f"{concise_prompt}. {strict_non_vocal_suffix}"
        headers = self._headers(accept="audio/mpeg")
        headers["content-type"] = "application/json"
        endpoints = (
            "/v1/text-to-sound-effects/convert",
            "/v1/sound-generation",
        )
        async with httpx.AsyncClient(timeout=180.0) as client:
            last_error = ""
            for endpoint in endpoints:
                prompt_candidates = [normalized_text]
                if endpoint == "/v1/sound-generation":
                    prompt_candidates = [strict_prompt]
                    if strict_concise_prompt != strict_prompt:
                        prompt_candidates.append(strict_concise_prompt)
                    if normalized_text not in prompt_candidates:
                        prompt_candidates.append(normalized_text)
                for prompt_index, candidate_prompt in enumerate(prompt_candidates):
                    payload = dict(payload_base)
                    payload["text"] = candidate_prompt
                    LOGGER.warning(
                        "ElevenLabs SFX request endpoint=%s prompt_index=%s params=%s payload=%s",
                        endpoint,
                        prompt_index,
                        {"output_format": "mp3_44100_128"},
                        payload,
                    )
                    try:
                        response = await client.post(
                            f"{BASE_URL}{endpoint}",
                            headers=headers,
                            params={"output_format": "mp3_44100_128"},
                            json=payload,
                        )
                    except Exception as exc:
                        LOGGER.exception(
                            "ElevenLabs SFX request exception endpoint=%s prompt_index=%s payload=%s",
                            endpoint,
                            prompt_index,
                            payload,
                        )
                        raise RuntimeError(f"ElevenLabs 音效生成失败：请求异常 {exc}") from exc
                    if response.is_error:
                        LOGGER.error(
                            "ElevenLabs SFX error endpoint=%s prompt_index=%s status=%s headers=%s body=%s",
                            endpoint,
                            prompt_index,
                            response.status_code,
                            dict(response.headers),
                            str(response.text or ""),
                        )
                        error_text = str(response.text or "").strip()
                        last_error = f"{endpoint} -> {response.status_code} {error_text}".strip()
                        if response.status_code == 404 and endpoint != endpoints[-1]:
                            break
                        if response.status_code in (429, 500, 502, 503, 504) and prompt_index != len(prompt_candidates) - 1:
                            continue
                        raise RuntimeError(f"ElevenLabs 音效生成失败：{last_error}".strip())
                    LOGGER.warning(
                        "ElevenLabs SFX success endpoint=%s prompt_index=%s status=%s headers=%s bytes=%s content_type=%s",
                        endpoint,
                        prompt_index,
                        response.status_code,
                        dict(response.headers),
                        len(response.content or b""),
                        str(response.headers.get("content-type") or "audio/mpeg").lower(),
                    )
                    return response.content, str(response.headers.get("content-type") or "audio/mpeg").lower()
            raise RuntimeError(f"ElevenLabs 音效生成失败：{last_error or '未知错误'}")

    async def isolate_audio(
        self,
        audio_bytes: bytes,
        filename: str = "source.wav",
        file_format: str = "other",
    ) -> bytes:
        headers = self._headers(accept="audio/mpeg")
        files = {"audio": (filename, audio_bytes, "audio/wav")}
        data = {"file_format": file_format or "other"}
        async with httpx.AsyncClient(timeout=240.0) as client:
            response = await client.post(
                f"{BASE_URL}/v1/audio-isolation",
                headers=headers,
                data=data,
                files=files,
            )
            if response.is_error:
                raise RuntimeError(f"ElevenLabs 人声分离失败：{response.text}")
            return response.content

    async def speech_to_text(
        self,
        audio_bytes: bytes,
        filename: str = "segment.wav",
        model_id: str = "scribe_v1",
    ) -> Dict[str, Any]:
        """语音转文字（Speech-to-Text），将音频文件转为文字。

        底层调用 ElevenLabs Scribe API：POST /v1/speech-to-text
        - 支持中文（zh）音频
        - 返回结构：{ "text": "...", "language": "zh", ... }
        """
        headers = self._headers(accept="application/json")
        # ElevenLabs STT 要求 multipart 字段名为 file（与 audio-isolation 的 audio 不同）
        files = {"file": (filename, audio_bytes, "application/octet-stream")}
        data: Dict[str, Any] = {
            "model_id": str(model_id).strip() or "scribe_v1",
        }
        async with httpx.AsyncClient(timeout=120.0) as client:
            response = await client.post(
                f"{BASE_URL}/v1/speech-to-text",
                headers=headers,
                data=data,
                files=files,
            )
            if response.is_error:
                raise RuntimeError(f"ElevenLabs 语音转文字失败：{response.text}")
            return response.json()


eleven_labs_service = ElevenLabsService()
