"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CharacterVoice,
  ElevenLabsVoiceModel,
  cloneElevenLabsVoice,
  generateElevenLabsPreview,
  getElevenLabsVoices,
  updateCharacterVoice,
} from "@/lib/api";
import { getToken } from "@/lib/auth";

interface VoiceSelectorProps {
  projectId: string;
  characterName: string;
  initialVoice?: CharacterVoice | null;
  onVoiceUpdate: (voice: CharacterVoice) => void;
}

const TAG_LABEL_MAP: Record<string, string> = {
  male: "男声",
  female: "女声",
  man: "男声",
  woman: "女声",
  中文: "中文",
  汉语: "中文",
  chinese: "中文",
  mandarin: "中文",
  english: "英文",
  英文: "英文",
  warm: "温暖",
  soft: "柔和",
  deep: "低沉",
  bright: "明亮",
  anime: "动漫",
  cartoon: "动漫",
  documentary: "纪录",
  emotional: "情感",
  commercial: "商业",
  professional: "专业",
  young: "青年",
  youth: "青年",
  middle: "中年",
  "middle aged": "中年",
  old: "老年",
  senior: "老年",
  neutral: "中性",
  high_quality: "高质量",
  "high quality": "高质量",
};
const LANGUAGE_ZH_MAP: Record<string, string> = {
  ar: "阿拉伯语",
  bg: "保加利亚语",
  cs: "捷克语",
  da: "丹麦语",
  de: "德语",
  el: "希腊语",
  en: "英语",
  es: "西班牙语",
  fi: "芬兰语",
  fil: "菲律宾语",
  fr: "法语",
  hi: "印地语",
  hr: "克罗地亚语",
  hu: "匈牙利语",
  id: "印尼语",
  it: "意大利语",
  ja: "日语",
  ko: "韩语",
  ms: "马来语",
  nl: "荷兰语",
  no: "挪威语",
  pl: "波兰语",
  pt: "葡萄牙语",
  ro: "罗马尼亚语",
  ru: "俄语",
  sk: "斯洛伐克语",
  sv: "瑞典语",
  ta: "泰米尔语",
  tr: "土耳其语",
  uk: "乌克兰语",
  vi: "越南语",
  zh: "中文",
  chinese: "中文",
  mandarin: "中文",
  english: "英语",
};
const CHINESE_ACCENT_OPTIONS = [
  "粤语（广州）",
  "粤语（香港）",
  "粤语（新加坡）",
  "普通话（北京）",
  "普通话（新加坡）",
  "普通话（台湾）",
  "标准",
];
const AGE_OPTIONS = ["青年", "中年", "老年"];

const normalizeFacetKey = (value: string) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const displayTag = (tag: string) => TAG_LABEL_MAP[normalizeFacetKey(tag)] || TAG_LABEL_MAP[tag] || tag;
const displayLanguage = (value: string) => {
  const normalized = normalizeFacetKey(value);
  if (LANGUAGE_ZH_MAP[normalized]) return LANGUAGE_ZH_MAP[normalized];
  const locale = normalized.split(" ")[0].split("-")[0];
  if (LANGUAGE_ZH_MAP[locale]) return LANGUAGE_ZH_MAP[locale];
  return String(value || "").trim() ? `其他语言` : "未知语言";
};
const languageParamFromFilter = (language: string) => {
  const normalized = normalizeFacetKey(language);
  if (!normalized || normalized === normalizeFacetKey(UNIQUE_ALL)) return undefined;
  if (["zh", "chinese", "mandarin", "中文", "汉语", "普通话"].includes(normalized)) return "zh";
  if (["en", "english", "英语", "英文"].includes(normalized)) return "en";
  const locale = normalized.split(" ")[0].split("-")[0];
  return locale || undefined;
};
const modelLabel = (model: ElevenLabsVoiceModel, key: string) => String(model.labels?.[key] || "").trim();
const languageFromModel = (model: ElevenLabsVoiceModel) => {
  const label = modelLabel(model, "language");
  if (label) return displayLanguage(label);
  const languages = Array.isArray(model.languages)
    ? model.languages.map((lang) => String(lang).toLowerCase().replace(/_/g, "-"))
    : [];
  if (languages.some((lang) => /^(zh|cn|cmn|yue)(-|$)/.test(lang) || ["zh-hans", "zh-hant"].includes(lang))) return "中文";
  if (languages.some((lang) => /^(en)(-|$)/.test(lang))) return "英语";
  return "未知语言";
};
const genderFromModel = (model: ElevenLabsVoiceModel) => {
  const label = modelLabel(model, "gender");
  if (label) return displayTag(label);
  return "中性";
};
const accentFromModel = (model: ElevenLabsVoiceModel) => displayTag(modelLabel(model, "accent") || "未知口音");
const ageFromModel = (model: ElevenLabsVoiceModel) => displayTag(modelLabel(model, "age") || "未知年龄");
const qualityFromModel = (model: ElevenLabsVoiceModel) => displayTag(modelLabel(model, "quality") || "");
const previewFromModel = (model: ElevenLabsVoiceModel) =>
  model.preview_audio || model.samples?.find((sample) => sample.audio)?.audio || "";
const MODELS_PAGE_SIZE = 100;
const ensureCurrentOption = (selected: string, options: string[]) =>
  selected && selected !== "全部" && !options.some((item) => normalizeFacetKey(item) === normalizeFacetKey(selected))
    ? [selected, ...options]
    : options;
const UNIQUE_ALL = "全部";
const mergeModels = (base: ElevenLabsVoiceModel[], incoming: ElevenLabsVoiceModel[]) => {
  const next = [...base];
  const idSet = new Set(next.map((item) => String(item._id || "").trim()).filter(Boolean));
  incoming.forEach((item) => {
    const modelId = String(item._id || "").trim();
    if (!modelId || idSet.has(modelId)) return;
    next.push(item);
    idSet.add(modelId);
  });
  return next;
};

const chipClass = (active: boolean) =>
  `rounded-full border px-2.5 py-1 text-[11px] transition ${
    active ? "border-indigo-200 bg-indigo-50 text-indigo-700" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
  }`;

export function VoiceSelector({
  projectId,
  characterName,
  initialVoice,
  onVoiceUpdate,
}: VoiceSelectorProps) {
  const [currentVoice, setCurrentVoice] = useState<CharacterVoice | null>(initialVoice ?? null);
  const [models, setModels] = useState<ElevenLabsVoiceModel[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [previewingId, setPreviewingId] = useState("");
  const [saving, setSaving] = useState(false);
  const [cloning, setCloning] = useState(false);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<"select" | "custom" | "clone">("select");
  const [modalOpen, setModalOpen] = useState(false);
  const [selectedPresetId, setSelectedPresetId] = useState("");
  const [customId, setCustomId] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [submittedSearchQuery, setSubmittedSearchQuery] = useState("");
  const [sortMode, setSortMode] = useState<"推荐" | "名称">("推荐");
  const [selectedLanguage, setSelectedLanguage] = useState(UNIQUE_ALL);
  const [selectedAccent, setSelectedAccent] = useState(UNIQUE_ALL);
  const [selectedGender, setSelectedGender] = useState(UNIQUE_ALL);
  const [selectedAge, setSelectedAge] = useState(UNIQUE_ALL);
  const [selectedQuality, setSelectedQuality] = useState(UNIQUE_ALL);
  const [facetOptions, setFacetOptions] = useState({
    languages: [] as string[],
    accents: [] as string[],
    genders: [] as string[],
    ages: [] as string[],
    qualities: [] as string[],
  });
  const [currentPage, setCurrentPage] = useState(1);
  const [changingPage, setChangingPage] = useState(false);
  const [hasMorePage, setHasMorePage] = useState(false);
  const [totalCount, setTotalCount] = useState(0);
  const [cloneTitle, setCloneTitle] = useState(`${characterName}-clone`);
  const [cloneFile, setCloneFile] = useState<File | null>(null);
  const [cloneDurationSec, setCloneDurationSec] = useState<number | null>(null);
  const [detectingCloneDuration, setDetectingCloneDuration] = useState(false);
  const [clonedModelId, setClonedModelId] = useState("");
  const [clonedModelTitle, setClonedModelTitle] = useState("");
  const [clonedCoverImage, setClonedCoverImage] = useState("");
  const [clonePreviewText, setClonePreviewText] = useState("你好，这是一段克隆音色试听");
  const [clonePreviewing, setClonePreviewing] = useState(false);
  const [clonePreviewAudioUrl, setClonePreviewAudioUrl] = useState("");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const previewObjectUrlRef = useRef("");
  const clonePreviewObjectUrlRef = useRef("");

  const requestModelsPage = useCallback(async (token: string, page: number) => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await getElevenLabsVoices(token, {
          page,
          size: MODELS_PAGE_SIZE,
          language: languageParamFromFilter(selectedLanguage),
          query: submittedSearchQuery || undefined,
          accent: selectedAccent !== UNIQUE_ALL ? selectedAccent : undefined,
          gender: selectedGender !== UNIQUE_ALL ? selectedGender : undefined,
          age: selectedAge !== UNIQUE_ALL ? selectedAge : undefined,
          quality: selectedQuality !== UNIQUE_ALL ? selectedQuality : undefined,
          includeLibrary: true,
        });
      } catch (err) {
        lastError = err;
        if (attempt === 0) {
          await new Promise((resolve) => setTimeout(resolve, 350));
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error("加载 ElevenLabs 音色失败");
  }, [selectedLanguage, selectedAccent, selectedGender, selectedAge, selectedQuality, submittedSearchQuery]);

  useEffect(() => {
    let cancelled = false;
    const fetchPage = async () => {
      try {
        const token = getToken();
        if (!token?.trim()) {
          setError("登录状态失效，请重新登录后再设置音色");
          return;
        }
        setLoadingModels(true);
        setError("");
        const first = await requestModelsPage(token, 1);
        if (cancelled) return;
        const firstItems = Array.isArray(first.items) ? first.items : [];
        const normalizedFirstItems = mergeModels([], firstItems);
        setTotalCount(typeof first.total === "number" ? first.total : 0);
        setHasMorePage(Boolean(first.has_more));
        setModels(normalizedFirstItems);
        setFacetOptions({
          languages: Array.isArray(first.facets?.languages) ? first.facets.languages : [],
          accents: Array.isArray(first.facets?.accents) ? first.facets.accents : [],
          genders: Array.isArray(first.facets?.genders) ? first.facets.genders : [],
          ages: Array.isArray(first.facets?.ages) ? first.facets.ages : [],
          qualities: Array.isArray(first.facets?.qualities) ? first.facets.qualities : [],
        });
        setCurrentPage(1);
      } catch (err) {
        console.error("Failed to fetch voice models", err);
        setError(err instanceof Error ? err.message : "加载 ElevenLabs 音色失败");
      } finally {
        if (!cancelled) {
          setLoadingModels(false);
          setChangingPage(false);
        }
      }
    };
    void fetchPage();
    return () => {
      cancelled = true;
    };
  }, [characterName, requestModelsPage]);

  const loadPage = async (targetPage: number) => {
    if (loadingModels || changingPage) return;
    const token = getToken();
    if (!token?.trim()) {
      setError("登录状态失效，请重新登录后再设置音色");
      return;
    }
    try {
      setChangingPage(true);
      const res = await requestModelsPage(token, targetPage);
      const incoming = Array.isArray(res.items) ? res.items : [];
      setModels(mergeModels([], incoming));
      setTotalCount(typeof res.total === "number" ? res.total : incoming.length);
      setHasMorePage(Boolean(res.has_more));
      setFacetOptions({
        languages: Array.isArray(res.facets?.languages) ? res.facets.languages : [],
        accents: Array.isArray(res.facets?.accents) ? res.facets.accents : [],
        genders: Array.isArray(res.facets?.genders) ? res.facets.genders : [],
        ages: Array.isArray(res.facets?.ages) ? res.facets.ages : [],
        qualities: Array.isArray(res.facets?.qualities) ? res.facets.qualities : [],
      });
      setCurrentPage(targetPage);
    } catch (err) {
      setError(err instanceof Error ? err.message : "切换分页失败");
    } finally {
      setChangingPage(false);
    }
  };

  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
      }
      if (previewObjectUrlRef.current) {
        URL.revokeObjectURL(previewObjectUrlRef.current);
      }
      if (clonePreviewObjectUrlRef.current) {
        URL.revokeObjectURL(clonePreviewObjectUrlRef.current);
      }
    };
  }, []);

  useEffect(() => {
    setCloneTitle(`${characterName}-clone`);
    setClonedModelId("");
    setClonedModelTitle("");
    setClonedCoverImage("");
    setClonePreviewText("你好，这是一段克隆音色试听");
    setClonePreviewAudioUrl("");
    setCloneFile(null);
    setCloneDurationSec(null);
    setDetectingCloneDuration(false);
  }, [characterName]);

  const s2ProModel = useMemo(
    () =>
      models.find((model) => {
        const title = (model.title || "").toLowerCase();
        const tags = (model.tags || []).join(" ").toLowerCase();
        return (title.includes("s2") && title.includes("pro")) || (tags.includes("s2") && tags.includes("pro"));
      }) || null,
    [models]
  );

  useEffect(() => {
    if (initialVoice?.voice_type === "PRESET" && initialVoice.voice_id) {
      setSelectedPresetId(initialVoice.voice_id);
      return;
    }
    if (s2ProModel?._id) {
      setSelectedPresetId(s2ProModel._id);
      return;
    }
    if (models.length > 0) {
      setSelectedPresetId(models[0]._id);
    }
  }, [initialVoice, models, s2ProModel]);

  useEffect(() => {
    if (!initialVoice) return;
    if (initialVoice.voice_type === "CUSTOM") {
      setMode("custom");
      setCustomId(initialVoice.voice_id);
      return;
    }
    if (initialVoice.voice_type === "CLONE") {
      setMode("clone");
      return;
    }
    setMode("select");
  }, [initialVoice]);

  const languageOptions = useMemo(
    () => ensureCurrentOption(selectedLanguage, facetOptions.languages),
    [selectedLanguage, facetOptions.languages]
  );
  const accentOptions = useMemo(
    () => {
      if (selectedLanguage === UNIQUE_ALL) return [];
      const languageParam = languageParamFromFilter(selectedLanguage);
      if (languageParam === "zh") {
        return ensureCurrentOption(selectedAccent, CHINESE_ACCENT_OPTIONS);
      }
      return ensureCurrentOption(selectedAccent, facetOptions.accents);
    },
    [selectedLanguage, selectedAccent, facetOptions.accents]
  );
  const genderOptions = useMemo(
    () => ensureCurrentOption(selectedGender, facetOptions.genders),
    [selectedGender, facetOptions.genders]
  );
  const ageOptions = useMemo(
    () => ensureCurrentOption(selectedAge, AGE_OPTIONS),
    [selectedAge]
  );
  const qualityOptions = useMemo(
    () => ensureCurrentOption(selectedQuality, facetOptions.qualities),
    [selectedQuality, facetOptions.qualities]
  );
  const totalPages = useMemo(
    () => Math.max(1, Math.ceil(Math.max(0, totalCount) / MODELS_PAGE_SIZE)),
    [totalCount]
  );

  const selectedPreset = useMemo(
    () => models.find((m) => m._id === selectedPresetId) || null,
    [models, selectedPresetId]
  );
  const currentVoiceModel = useMemo(
    () => models.find((m) => m._id === currentVoice?.voice_id) || null,
    [models, currentVoice?.voice_id]
  );
  const currentVoicePreview = useMemo(() => {
    if (currentVoice?.preview_url) return currentVoice.preview_url;
    if (currentVoiceModel) return previewFromModel(currentVoiceModel);
    return "";
  }, [currentVoice?.preview_url, currentVoiceModel]);

  useEffect(() => {
    setCurrentVoice(initialVoice ?? null);
  }, [initialVoice]);

  const playAudio = async (url?: string) => {
    if (!url) return false;
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = "";
      audioRef.current = null;
    }
    const player = new Audio(url);
    audioRef.current = player;
    try {
      const started = await Promise.race<boolean>([
        player.play().then(() => true).catch(() => false),
        new Promise<boolean>((resolve) => {
          setTimeout(() => resolve(false), 5000);
        }),
      ]);
      if (!started) {
        player.pause();
        player.src = "";
        if (audioRef.current === player) {
          audioRef.current = null;
        }
        return false;
      }
      return true;
    } catch {
      player.pause();
      player.src = "";
      if (audioRef.current === player) {
        audioRef.current = null;
      }
      return false;
    }
  };

  const detectAudioDuration = async (file: File): Promise<number | null> =>
    new Promise((resolve) => {
      const objectUrl = URL.createObjectURL(file);
      const audio = new Audio();
      let settled = false;
      const finalize = (duration: number | null) => {
        if (settled) return;
        settled = true;
        audio.pause();
        audio.src = "";
        URL.revokeObjectURL(objectUrl);
        resolve(duration);
      };
      const timeoutId = setTimeout(() => finalize(null), 5000);
      audio.preload = "metadata";
      audio.onloadedmetadata = () => {
        clearTimeout(timeoutId);
        const duration = Number(audio.duration);
        if (Number.isFinite(duration) && duration > 0) {
          finalize(duration);
          return;
        }
        finalize(null);
      };
      audio.onerror = () => {
        clearTimeout(timeoutId);
        finalize(null);
      };
      audio.src = objectUrl;
    });

  const handlePreview = async (model: ElevenLabsVoiceModel) => {
    setError("");
    setPreviewingId(model._id);
    try {
      const directPreview = previewFromModel(model);
      if (directPreview) {
        const ok = await playAudio(directPreview);
        if (ok) return;
      }
      const token = getToken();
      if (!token?.trim()) {
        throw new Error("登录状态失效，请重新登录");
      }
      const text = (model.default_text || model.title || "你好，这是一段音色试听").slice(0, 80);
      const blob = await generateElevenLabsPreview(token, {
        text,
        voice_id: model._id,
        output_format: "mp3_44100_128",
      });
      if (previewObjectUrlRef.current) {
        URL.revokeObjectURL(previewObjectUrlRef.current);
      }
      const objectUrl = URL.createObjectURL(blob);
      previewObjectUrlRef.current = objectUrl;
      const played = await playAudio(objectUrl);
      if (!played) {
        throw new Error("浏览器无法播放该试听音频");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "试听失败，请稍后重试");
    } finally {
      setPreviewingId("");
    }
  };

  const filteredModels = useMemo(() => {
    if (sortMode === "名称") {
      return [...models].sort((a, b) => (a.title || "").localeCompare(b.title || "", "zh-CN"));
    }
    return [...models].sort((a, b) => {
      const aScore = ((a.title || "").toLowerCase().includes("s2") ? 2 : 0) + ((a.title || "").toLowerCase().includes("pro") ? 1 : 0);
      const bScore = ((b.title || "").toLowerCase().includes("s2") ? 2 : 0) + ((b.title || "").toLowerCase().includes("pro") ? 1 : 0);
      return bScore - aScore;
    });
  }, [models, sortMode]);

  const clearFilters = () => {
    setSearchQuery("");
    setSubmittedSearchQuery("");
    setSelectedLanguage(UNIQUE_ALL);
    setSelectedAccent(UNIQUE_ALL);
    setSelectedGender(UNIQUE_ALL);
    setSelectedAge(UNIQUE_ALL);
    setSelectedQuality(UNIQUE_ALL);
    setSortMode("推荐");
  };

  const handleSearch = () => {
    setSubmittedSearchQuery(searchQuery.trim());
  };

  const handleApplyPreset = async () => {
    if (!selectedPreset) {
      setError("请选择一个预设音色");
      return;
    }
    try {
      const token = getToken();
      if (!token?.trim()) {
        setError("登录状态失效，请重新登录");
        return;
      }
      setError("");
      setSaving(true);
      const updated = await updateCharacterVoice(token, projectId, characterName, {
        voice_id: selectedPreset._id,
        voice_type: "PRESET",
        preview_url: previewFromModel(selectedPreset)
      });
      setCurrentVoice(updated);
      onVoiceUpdate(updated);
      setModalOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "设置预设音色失败");
    } finally {
      setSaving(false);
    }
  };

  const handleCustomSubmit = async () => {
    if (!customId.trim()) return;
    try {
      const token = getToken();
      if (!token?.trim()) {
        setError("登录状态失效，请重新登录");
        return;
      }
      setError("");
      setSaving(true);
      const updated = await updateCharacterVoice(token, projectId, characterName, {
        voice_id: customId.trim(),
        voice_type: "CUSTOM"
      });
      setCurrentVoice(updated);
      onVoiceUpdate(updated);
      setModalOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "设置自定义音色失败");
    } finally {
      setSaving(false);
    }
  };

  const handleCloneSubmit = async () => {
    if (!cloneFile) {
      setError("请先选择用于克隆的音频文件");
      return;
    }
    try {
      const token = getToken();
      if (!token?.trim()) {
        setError("登录状态失效，请重新登录");
        return;
      }
      setError("");
      setCloning(true);
      const result = await cloneElevenLabsVoice(token, cloneFile, cloneTitle.trim() || `${characterName}-clone`);
      const modelId = result._id || result.model_id || "";
      if (!modelId) {
        throw new Error("克隆成功但未返回模型 ID");
      }
      setClonedModelId(modelId);
      setClonedModelTitle(result.title || cloneTitle.trim() || `${characterName}-clone`);
      setClonedCoverImage(result.cover_image || "");
    } catch (err) {
      setError(err instanceof Error ? err.message : "克隆音色失败");
    } finally {
      setCloning(false);
    }
  };

  const handleClonePreview = async () => {
    if (!clonedModelId) {
      setError("请先完成克隆后再试听");
      return;
    }
    const text = clonePreviewText.trim();
    if (!text) {
      setError("请输入要试听的文本");
      return;
    }
    try {
      const token = getToken();
      if (!token?.trim()) {
        setError("登录状态失效，请重新登录");
        return;
      }
      setError("");
      setClonePreviewing(true);
      const blob = await generateElevenLabsPreview(token, {
        text: text.slice(0, 200),
        voice_id: clonedModelId,
        output_format: "mp3_44100_128",
      });
      if (clonePreviewObjectUrlRef.current) {
        URL.revokeObjectURL(clonePreviewObjectUrlRef.current);
      }
      const objectUrl = URL.createObjectURL(blob);
      clonePreviewObjectUrlRef.current = objectUrl;
      setClonePreviewAudioUrl(objectUrl);
      const played = await playAudio(objectUrl);
      if (!played) {
        throw new Error("浏览器无法播放该试听音频");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "克隆音色试听失败");
    } finally {
      setClonePreviewing(false);
    }
  };

  const handleApplyClonedVoice = async () => {
    if (!clonedModelId) {
      setError("请先完成克隆");
      return;
    }
    try {
      const token = getToken();
      if (!token?.trim()) {
        setError("登录状态失效，请重新登录");
        return;
      }
      setError("");
      setSaving(true);
      const updated = await updateCharacterVoice(token, projectId, characterName, {
        voice_id: clonedModelId,
        voice_type: "CLONE",
        preview_url: clonedCoverImage,
        config: { title: clonedModelTitle || cloneTitle }
      });
      setCurrentVoice(updated);
      onVoiceUpdate(updated);
      setModalOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "应用克隆音色失败");
    } finally {
      setSaving(false);
    }
  };

  const resetCloneResult = () => {
    if (clonePreviewObjectUrlRef.current) {
      URL.revokeObjectURL(clonePreviewObjectUrlRef.current);
      clonePreviewObjectUrlRef.current = "";
    }
    setClonedModelId("");
    setClonedModelTitle("");
    setClonedCoverImage("");
    setClonePreviewText("你好，这是一段克隆音色试听");
    setClonePreviewAudioUrl("");
  };

  const handleReplayClonePreview = async () => {
    if (!clonePreviewAudioUrl) {
      setError("请先生成一次克隆试听");
      return;
    }
    setError("");
    const played = await playAudio(clonePreviewAudioUrl);
    if (!played) {
      setError("浏览器无法播放该试听音频");
    }
  };

  return (
    <>
      <div className="rounded-lg border border-slate-200 bg-white p-3">
        <div className="flex items-center gap-3">
          <audio controls src={currentVoicePreview || undefined} className="h-8 min-w-0 flex-1" />
          <button
            className="shrink-0 rounded bg-indigo-600 px-3 py-1.5 text-xs text-white hover:bg-indigo-700"
            onClick={() => setModalOpen(true)}
          >
            音色设置
          </button>
        </div>
      </div>

      {modalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
          <div className="max-h-[94vh] w-full max-w-6xl overflow-hidden rounded-xl bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
              <div>
                <div className="text-sm font-semibold text-slate-900">音色设置</div>
                <div className="text-[11px] text-slate-500">已加载 {models.length} 条音色{totalCount ? ` / 约 ${totalCount.toLocaleString()} 总量` : ""}</div>
              </div>
              <button
                className="rounded border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50"
                onClick={() => setModalOpen(false)}
              >
                关闭
              </button>
            </div>

            <div className="max-h-[calc(94vh-56px)] overflow-y-auto p-4">
              <div className="flex border-b border-slate-100">
                <button
                  className={`mr-4 pb-2 text-xs font-medium ${mode === "select" ? "border-b-2 border-indigo-600 text-indigo-600" : "text-slate-500"}`}
                  onClick={() => setMode("select")}
                >
                  预设音色
                </button>
                <button
                  className={`mr-4 pb-2 text-xs font-medium ${mode === "custom" ? "border-b-2 border-indigo-600 text-indigo-600" : "text-slate-500"}`}
                  onClick={() => setMode("custom")}
                >
                  自定义 ID
                </button>
                <button
                  className={`pb-2 text-xs font-medium ${mode === "clone" ? "border-b-2 border-indigo-600 text-indigo-600" : "text-slate-500"}`}
                  onClick={() => setMode("clone")}
                >
                  克隆音色
                </button>
              </div>

              {error ? <div className="mt-2 rounded bg-red-50 px-2 py-1 text-[11px] text-red-600">{error}</div> : null}

              {mode === "select" ? (
                <div className="mt-3 space-y-3">
                  <div className="grid grid-cols-1 gap-2 md:grid-cols-4">
                    <div className="flex gap-2 md:col-span-2">
                      <input
                        type="text"
                        placeholder="搜索音色名称 / 标签 / 音色ID"
                        className="min-w-0 flex-1 rounded border border-slate-200 px-2 py-1.5 text-xs"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                      />
                      <button
                        className="shrink-0 rounded border border-slate-200 px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50"
                        onClick={handleSearch}
                      >
                        搜索
                      </button>
                    </div>
                    <div className="flex items-center gap-1 rounded border border-slate-200 bg-slate-50 px-2 py-1.5 text-xs text-slate-600">
                      <span>排序</span>
                      <button className={chipClass(sortMode === "推荐")} onClick={() => setSortMode("推荐")}>推荐</button>
                      <button className={chipClass(sortMode === "名称")} onClick={() => setSortMode("名称")}>名称</button>
                    </div>
                    <button
                      className="rounded border border-slate-200 px-2 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
                      onClick={clearFilters}
                    >
                      重置筛选
                    </button>
                  </div>

                  <div className="rounded border border-slate-100 bg-slate-50 p-2">
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <span className="text-[11px] text-slate-500">语言</span>
                      {[UNIQUE_ALL, ...languageOptions].map((lang) => (
                        <button
                          key={lang}
                          className={chipClass(selectedLanguage === lang)}
                          onClick={() => {
                            setSelectedLanguage(lang);
                            setSelectedAccent(UNIQUE_ALL);
                          }}
                        >
                          {lang === UNIQUE_ALL ? UNIQUE_ALL : displayLanguage(lang)}
                        </button>
                      ))}
                    </div>
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <span className="text-[11px] text-slate-500">口音</span>
                      {selectedLanguage === UNIQUE_ALL ? (
                        <span className="text-[11px] text-slate-400">请先选择语言，再选择对应口音</span>
                      ) : (
                        [UNIQUE_ALL, ...accentOptions].map((accent) => (
                          <button key={accent} className={chipClass(selectedAccent === accent)} onClick={() => setSelectedAccent(accent)}>
                            {displayTag(accent)}
                          </button>
                        ))
                      )}
                    </div>
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <span className="text-[11px] text-slate-500">性别</span>
                      {[UNIQUE_ALL, ...genderOptions].map((gender) => (
                        <button key={gender} className={chipClass(selectedGender === gender)} onClick={() => setSelectedGender(gender)}>
                          {displayTag(gender)}
                        </button>
                      ))}
                    </div>
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <span className="text-[11px] text-slate-500">年龄</span>
                      {[UNIQUE_ALL, ...ageOptions].map((age) => (
                        <button key={age} className={chipClass(selectedAge === age)} onClick={() => setSelectedAge(age)}>
                          {displayTag(age)}
                        </button>
                      ))}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[11px] text-slate-500">质量</span>
                      {[UNIQUE_ALL, ...qualityOptions].map((quality) => (
                        <button
                          key={quality}
                          className={chipClass(selectedQuality === quality)}
                          onClick={() => setSelectedQuality(quality)}
                        >
                          {displayTag(quality)}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="text-[11px] text-slate-500">
                    当前筛选结果：{filteredModels.length} 条（第 {currentPage} / {totalPages} 页）
                  </div>

                  <div className="max-h-[56vh] overflow-y-auto rounded border border-slate-100">
                    {loadingModels ? (
                      <div className="p-3 text-xs text-slate-500">正在拉取 ElevenLabs 官方预设音色...</div>
                    ) : filteredModels.length === 0 ? (
                      <div className="p-3 text-xs text-slate-400">当前筛选条件下无可选音色</div>
                    ) : (
                      <div className="grid grid-cols-1 gap-2 p-2 md:grid-cols-2">
                        {filteredModels.map((model) => {
                          const displayTags = Array.from(
                            new Set((model.tags || []).map((tag) => displayTag(tag)).filter(Boolean))
                          ).slice(0, 5);
                          const previewUrl = previewFromModel(model);
                          return (
                            <div
                              key={model._id}
                              className={`rounded-lg border p-2 ${
                                selectedPresetId === model._id ? "border-indigo-200 bg-indigo-50" : "border-slate-200 bg-white"
                              }`}
                            >
                              <div className="flex items-start justify-between gap-2">
                                <div className="min-w-0">
                                  <div className="truncate text-xs font-semibold text-slate-800">{model.title || model._id}</div>
                                  <div className="truncate text-[10px] text-slate-400">{model._id}</div>
                                </div>
                                <div className="flex items-center gap-1">
                                  {previewUrl ? (
                                    <button
                                      className="rounded border border-slate-200 px-2 py-1 text-[10px] text-indigo-600 hover:bg-indigo-50"
                                      onClick={() => void handlePreview(model)}
                                    >
                                      {previewingId === model._id ? "试听中..." : "试听"}
                                    </button>
                                  ) : (
                                    <button
                                      className="rounded border border-slate-200 px-2 py-1 text-[10px] text-slate-600 hover:bg-slate-50"
                                      onClick={() => void handlePreview(model)}
                                    >
                                      {previewingId === model._id ? "生成中..." : "生成试听"}
                                    </button>
                                  )}
                                  <button
                                    className={`rounded px-2 py-1 text-[10px] ${
                                      selectedPresetId === model._id
                                        ? "bg-indigo-600 text-white"
                                        : "border border-slate-200 text-slate-600 hover:bg-slate-50"
                                    }`}
                                    onClick={() => setSelectedPresetId(model._id)}
                                  >
                                    {selectedPresetId === model._id ? "已选中" : "选择"}
                                  </button>
                                </div>
                              </div>
                              <div className="mt-2 flex flex-wrap gap-1">
                                {normalizeFacetKey(model.category || "") === "library" ? (
                                  <span className="rounded bg-indigo-100 px-2 py-0.5 text-[10px] text-indigo-700">Library</span>
                                ) : null}
                                <span className="rounded bg-slate-100 px-2 py-0.5 text-[10px] text-slate-600">{languageFromModel(model)}</span>
                                <span className="rounded bg-slate-100 px-2 py-0.5 text-[10px] text-slate-600">{genderFromModel(model)}</span>
                                <span className="rounded bg-slate-100 px-2 py-0.5 text-[10px] text-slate-600">{accentFromModel(model)}</span>
                                <span className="rounded bg-slate-100 px-2 py-0.5 text-[10px] text-slate-600">{ageFromModel(model)}</span>
                                {qualityFromModel(model) ? (
                                  <span className="rounded bg-slate-100 px-2 py-0.5 text-[10px] text-slate-600">{qualityFromModel(model)}</span>
                                ) : null}
                                {displayTags.map((tag) => (
                                  <span key={`${model._id}-${tag}`} className="rounded bg-slate-100 px-2 py-0.5 text-[10px] text-slate-600">
                                    {tag}
                                  </span>
                                ))}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      className="flex-1 rounded bg-indigo-600 py-2 text-xs text-white hover:bg-indigo-700 disabled:opacity-50"
                      onClick={handleApplyPreset}
                      disabled={saving || !selectedPresetId}
                    >
                      {saving ? "保存中..." : "应用选中预设音色"}
                    </button>
                    <button
                      className="rounded border border-slate-200 px-3 py-2 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                      onClick={() => void loadPage(currentPage - 1)}
                      disabled={changingPage || currentPage <= 1}
                    >
                      上一页
                    </button>
                    <button
                      className="rounded border border-slate-200 px-3 py-2 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                      onClick={() => void loadPage(currentPage + 1)}
                      disabled={changingPage || (!hasMorePage && currentPage >= totalPages)}
                    >
                      {changingPage ? "切换中..." : "下一页"}
                    </button>
                  </div>
                </div>
              ) : null}

              {mode === "custom" ? (
                <div className="mt-3 space-y-2">
                  <div className="text-xs text-slate-500">可直接输入 ElevenLabs 音色 ID。</div>
                  <input
                    type="text"
                    placeholder="请输入音色 ID"
                    className="w-full rounded border border-slate-200 px-2 py-1.5 text-xs"
                    value={customId}
                    onChange={(e) => setCustomId(e.target.value)}
                  />
                  <button
                    className="w-full rounded bg-slate-900 py-2 text-xs text-white hover:bg-slate-800 disabled:opacity-50"
                    onClick={handleCustomSubmit}
                    disabled={saving || !customId.trim()}
                  >
                    {saving ? "保存中..." : "保存音色 ID"}
                  </button>
                </div>
              ) : null}

              {mode === "clone" ? (
                <div className="mt-3 space-y-3">
                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                    <div className="mb-2 flex items-center justify-between">
                      <div className="text-xs font-medium text-slate-800">步骤 1：上传参考音频并创建克隆</div>
                      <div className="rounded-full bg-white px-2 py-0.5 text-[10px] text-slate-500">支持 mp3 / wav</div>
                    </div>
                    <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
                      <input
                        type="text"
                        placeholder="克隆音色名称"
                        className="rounded border border-slate-200 px-2 py-1.5 text-xs md:col-span-2"
                        value={cloneTitle}
                        onChange={(e) => setCloneTitle(e.target.value)}
                      />
                      <label className="flex cursor-pointer items-center justify-center rounded border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-600 hover:bg-slate-50">
                        选择音频文件
                        <input
                          type="file"
                          accept="audio/*"
                          className="hidden"
                          onChange={(e) => {
                            const file = e.target.files?.[0] || null;
                            setCloneFile(file);
                            setCloneDurationSec(null);
                            resetCloneResult();
                            if (!file) return;
                            setDetectingCloneDuration(true);
                            void detectAudioDuration(file)
                              .then((duration) => {
                                setCloneDurationSec(duration);
                              })
                              .finally(() => {
                                setDetectingCloneDuration(false);
                              });
                          }}
                          disabled={cloning}
                        />
                      </label>
                    </div>
                    <div className="mt-2 rounded border border-dashed border-slate-200 bg-white px-2 py-1.5 text-[11px] text-slate-500">
                      {cloneFile ? `已选择文件：${cloneFile.name}` : "尚未选择音频文件"}
                    </div>
                    {cloneFile ? (
                      <div className="mt-1 text-[11px] text-slate-500">
                        {detectingCloneDuration
                          ? "正在分析音频时长..."
                          : cloneDurationSec
                            ? `音频时长约 ${cloneDurationSec.toFixed(1)} 秒`
                            : "未能识别音频时长，仍可继续克隆"}
                      </div>
                    ) : null}
                    {cloneFile && !detectingCloneDuration && cloneDurationSec !== null && cloneDurationSec < 30 ? (
                      <div className="mt-1 rounded border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] text-amber-700">
                        当前音频不足 30 秒，允许继续克隆，但可能出现音色相似度不足、稳定性较差或发音漂移。
                      </div>
                    ) : null}
                    <button
                      className="mt-2 w-full rounded bg-indigo-600 py-2 text-xs text-white hover:bg-indigo-700 disabled:opacity-50"
                      onClick={handleCloneSubmit}
                      disabled={cloning || !cloneFile}
                    >
                      {cloning ? "正在克隆音色..." : "开始克隆"}
                    </button>
                  </div>

                  <div className={`rounded-lg border p-3 ${clonedModelId ? "border-emerald-200 bg-emerald-50" : "border-slate-200 bg-white"}`}>
                    <div className="mb-2 flex items-center justify-between">
                      <div className="text-xs font-medium text-slate-800">步骤 2：试听并确认使用</div>
                      <div className={`rounded-full px-2 py-0.5 text-[10px] ${clonedModelId ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>
                        {clonedModelId ? "已完成克隆" : "等待克隆完成"}
                      </div>
                    </div>
                    {clonedModelId ? (
                      <>
                        <div className="rounded border border-emerald-200 bg-white px-2 py-1.5 text-xs text-emerald-700">
                          克隆模型：{clonedModelTitle || "新克隆音色"}（ID：{clonedModelId}）
                        </div>
                        <textarea
                          rows={3}
                          className="mt-2 w-full rounded border border-emerald-200 bg-white px-2 py-1.5 text-xs"
                          placeholder="输入一段文本试听克隆效果"
                          value={clonePreviewText}
                          onChange={(e) => setClonePreviewText(e.target.value)}
                          disabled={clonePreviewing}
                        />
                        <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-3">
                          <button
                            className="rounded bg-emerald-600 py-2 text-xs text-white hover:bg-emerald-700 disabled:opacity-50 md:col-span-2"
                            onClick={handleClonePreview}
                            disabled={clonePreviewing || !clonePreviewText.trim()}
                          >
                            {clonePreviewing ? "生成试听中..." : "生成并播放试听"}
                          </button>
                          <button
                            className="rounded border border-emerald-300 py-2 text-xs text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
                            onClick={() => void handleReplayClonePreview()}
                            disabled={clonePreviewing || !clonePreviewAudioUrl}
                          >
                            重新播放
                          </button>
                        </div>
                        <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2">
                          <button
                            className="rounded bg-slate-900 py-2 text-xs text-white hover:bg-slate-800 disabled:opacity-50"
                            onClick={handleApplyClonedVoice}
                            disabled={saving || clonePreviewing}
                          >
                            {saving ? "保存中..." : "确认使用此克隆音色"}
                          </button>
                          <button
                            className="rounded border border-slate-200 py-2 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                            onClick={resetCloneResult}
                            disabled={clonePreviewing || cloning || saving}
                          >
                            清空并重新克隆
                          </button>
                        </div>
                      </>
                    ) : (
                      <div className="rounded border border-dashed border-slate-200 bg-white px-2 py-3 text-xs text-slate-500">
                        完成步骤 1 后，这里会显示克隆结果与试听区。
                      </div>
                    )}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
