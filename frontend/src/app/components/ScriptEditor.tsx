import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import Image from "next/image";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { getToken } from "@/lib/auth";
import { generateSegmentFrameImage, getModels, getSegmentFrameImageTaskStatus, generateTTS, getProjectVoices, type Asset, type CharacterVoice } from "@/lib/api";
import { extractDrawModels } from "@/lib/models";

interface ScriptEditorProps {
  content: string;
  onChange: (newContent: string) => void;
  projectId?: string;
  dialogueCellAudioMap?: Record<string, AppliedVoiceSegment[]>;
  onDialogueCellAudioMapChange?: (map: Record<string, AppliedVoiceSegment[]>) => void;
  rowStartIndex?: number;
  generatingGlobalRowIndex?: number | null;
  generatedRowIndexSet?: Set<number>;
  pendingRowIndexSet?: Set<number>;
  rowTaskStatusMap?: Record<number, string>;
  rowTaskIdMap?: Record<number, string>;
  rowVideoUrlMap?: Record<number, string>;
  rowVersionListMap?: Record<number, Array<{ id: string; video_url: string; status: string; task_status_msg?: string | null; is_selected: boolean }>>;
  rowSelectedVersionIdMap?: Record<number, string>;
  onGenerateKlingRow?: (params: {
    globalRowIndex: number;
    previousGlobalRowIndex?: number;
    headers: string[];
    row: string[];
    usePreviousSegmentEndFrame?: boolean;
    customFirstFrameUrl?: string;
    customLastFrameUrl?: string;
  }) => void;
  onModifyKlingRow?: (params: {
    globalRowIndex: number;
    headers: string[];
    row: string[];
    currentVideoUrl: string;
    instruction: string;
    referenceImageUrls: string[];
    keepOriginalSound: boolean;
  }) => void;
  modifyingGlobalRowIndex?: number | null;
  onSelectKlingVersion?: (globalRowIndex: number, versionId: string) => void;
  onDeleteKlingVersion?: (globalRowIndex: number, versionId: string) => void;
  deletingVersionKey?: string | null;
}

type Block = 
  | { type: 'text'; value: string }
  | { type: 'table'; headers: string[]; rows: string[][] };

type VoiceTagItem = { label: string; tag: string; desc: string };
type VoiceTagGroup = { key: "basic" | "advanced" | "tone" | "audio" | "special"; title: string; tags: VoiceTagItem[] };
type VoiceSegment = { id: string; text: string };
type AppliedVoiceSegment = { text: string; audioUrl: string };
type VoiceEmotionIntensity = "slightly" | "very" | "extremely";
type VoiceAccentLevel = "slight" | "normal" | "strong";
type PronunciationRule = { id: string; source: string; target: string };
type FrameReference = { assetId: string; name: string; imageUrl: string };
type FrameMaterialTab = "character" | "prop" | "scene";
type PersistedFrameState = {
  firstImageMap?: Record<string, string[]>;
  lastImageMap?: Record<string, string[]>;
  appliedMap?: Record<string, { first?: string; last?: string }>;
  previousEndFrameMap?: Record<string, boolean>;
  pendingMap?: Record<string, number>;
};

const VOICE_TAG_GROUPS: VoiceTagGroup[] = [
  {
    key: "basic",
    title: "基本情绪",
    tags: [
      { label: "开心", tag: "(happy)", desc: "轻快愉悦" },
      { label: "悲伤", tag: "(sad)", desc: "低落伤感" },
      { label: "生气", tag: "(angry)", desc: "恼火不满" },
      { label: "愤怒", tag: "(extremely angry)", desc: "极度愤怒，更具爆发感" },
      { label: "兴奋", tag: "(excited)", desc: "高能激动" },
      { label: "平静", tag: "(calm)", desc: "沉稳平和" },
      { label: "紧张", tag: "(nervous)", desc: "焦虑不安" },
      { label: "自信", tag: "(confident)", desc: "坚定有力" },
      { label: "惊讶", tag: "(surprised)", desc: "震惊诧异" },
      { label: "满足", tag: "(satisfied)", desc: "满足肯定" },
      { label: "欣喜", tag: "(delighted)", desc: "非常高兴" },
      { label: "害怕", tag: "(scared)", desc: "惧怕恐慌" },
      { label: "担忧", tag: "(worried)", desc: "忧虑顾虑" },
      { label: "烦躁", tag: "(upset)", desc: "烦闷受挫" },
      { label: "沮丧", tag: "(frustrated)", desc: "受阻恼火" },
      { label: "抑郁", tag: "(depressed)", desc: "压抑低沉" },
      { label: "共情", tag: "(empathetic)", desc: "理解安抚" },
      { label: "尴尬", tag: "(embarrassed)", desc: "局促不安" },
      { label: "厌恶", tag: "(disgusted)", desc: "反感排斥" },
      { label: "感动", tag: "(moved)", desc: "触动人心" },
      { label: "自豪", tag: "(proud)", desc: "骄傲肯定" },
      { label: "放松", tag: "(relaxed)", desc: "轻松自然" },
      { label: "感激", tag: "(grateful)", desc: "感谢表达" },
      { label: "好奇", tag: "(curious)", desc: "探索询问" },
      { label: "讽刺", tag: "(sarcastic)", desc: "反讽语气" },
    ],
  },
  {
    key: "advanced",
    title: "高级情绪",
    tags: [
      { label: "轻蔑", tag: "(disdainful)", desc: "轻视鄙夷" },
      { label: "不悦", tag: "(unhappy)", desc: "不高兴" },
      { label: "焦躁", tag: "(anxious)", desc: "急躁不安" },
      { label: "失控", tag: "(hysterical)", desc: "情绪激烈" },
      { label: "冷漠", tag: "(indifferent)", desc: "漠不关心" },
      { label: "不确定", tag: "(uncertain)", desc: "不笃定" },
      { label: "怀疑", tag: "(doubtful)", desc: "质疑口吻" },
      { label: "困惑", tag: "(confused)", desc: "不解迷茫" },
      { label: "失望", tag: "(disappointed)", desc: "期望落空" },
      { label: "懊悔", tag: "(regretful)", desc: "后悔遗憾" },
      { label: "内疚", tag: "(guilty)", desc: "自责愧疚" },
      { label: "羞愧", tag: "(ashamed)", desc: "羞惭难当" },
      { label: "嫉妒", tag: "(jealous)", desc: "妒忌心理" },
      { label: "羡慕", tag: "(envious)", desc: "向往拥有" },
      { label: "有希望", tag: "(hopeful)", desc: "期待未来" },
      { label: "乐观", tag: "(optimistic)", desc: "积极向上" },
      { label: "悲观", tag: "(pessimistic)", desc: "消极预期" },
      { label: "怀旧", tag: "(nostalgic)", desc: "追忆过去" },
      { label: "孤独", tag: "(lonely)", desc: "孤单无助" },
      { label: "无聊", tag: "(bored)", desc: "兴致缺缺" },
      { label: "蔑视", tag: "(contemptuous)", desc: "强烈鄙夷" },
      { label: "同情", tag: "(sympathetic)", desc: "表示同情" },
      { label: "怜悯", tag: "(compassionate)", desc: "深度关怀" },
      { label: "坚定", tag: "(determined)", desc: "意志坚决" },
      { label: "认命", tag: "(resigned)", desc: "接受结果" },
    ],
  },
  {
    key: "tone",
    title: "语调标记",
    tags: [
      { label: "匆忙", tag: "(in a hurry tone)", desc: "语速急促" },
      { label: "大喊", tag: "(shouting)", desc: "提高音量" },
      { label: "尖叫", tag: "(screaming)", desc: "极高音量" },
      { label: "低语", tag: "(whispering)", desc: "轻声耳语" },
      { label: "轻柔", tag: "(soft tone)", desc: "柔和细腻" },
    ],
  },
  {
    key: "audio",
    title: "音频效果",
    tags: [
      { label: "大笑", tag: "(laughing)", desc: "完整笑声" },
      { label: "轻笑", tag: "(chuckling)", desc: "轻微笑声" },
      { label: "抽泣", tag: "(sobbing)", desc: "哭泣颤抖" },
      { label: "嚎哭", tag: "(crying loudly)", desc: "大声哭泣" },
      { label: "叹气", tag: "(sighing)", desc: "长呼气" },
      { label: "呻吟", tag: "(groaning)", desc: "不适抱怨" },
      { label: "喘息", tag: "(panting)", desc: "气息急促" },
      { label: "倒吸气", tag: "(gasping)", desc: "突然吸气" },
      { label: "哈欠", tag: "(yawning)", desc: "疲惫呵欠" },
      { label: "打鼾", tag: "(snoring)", desc: "睡眠鼻息" },
    ],
  },
  {
    key: "special",
    title: "特效",
    tags: [
      { label: "观众笑", tag: "(audience laughing)", desc: "观众笑声" },
      { label: "背景笑", tag: "(background laughter)", desc: "背景氛围笑" },
      { label: "群体笑", tag: "(crowd laughing)", desc: "多人笑声" },
      { label: "短停顿", tag: "(break)", desc: "短暂停顿" },
      { label: "长停顿", tag: "(long-break)", desc: "更长停顿" },
    ],
  },
];

const KLING_COLUMN = "视频生成";
const LEGACY_KLING_COLUMN = "Kling视频生成";
const FRAME_DEFAULT_IMAGE_MODEL = "nano-banana-2";
const getFrameStateStorageKey = (projectId: string) => `script_editor_frame_state_v2:${projectId}`;
const FRAME_PENDING_MAX_AGE_MS = 30 * 60 * 1000;
const buildFramePendingKey = (rowIndex: number, frameType: "first" | "last") => `${rowIndex}:${frameType}`;
const isCompletedVideoVersion = (version: { video_url: string; status: string }) => {
  const status = String(version.status || "").toUpperCase();
  if (!version.video_url) return false;
  if (!status) return false;
  if (status.includes("FAILED") || status.includes("ERROR") || status.includes("CANCEL")) return false;
  if (status.includes("COMPLETED") || status.includes("SUCCESS")) return true;
  return false;
};
const ELEVEN_MODELS = [
  { value: "eleven_v3", label: "Eleven v3" },
  { value: "eleven_multilingual_v2", label: "Multilingual v2" },
  { value: "eleven_turbo_v2_5", label: "Turbo v2.5" },
  { value: "eleven_flash_v2_5", label: "Flash v2.5" },
  { value: "eleven_monolingual_v1", label: "Monolingual v1" },
];
const ELEVEN_OUTPUT_FORMATS = [
  { value: "mp3_44100_128", label: "MP3 44.1kHz 128kbps" },
  { value: "mp3_44100_192", label: "MP3 44.1kHz 192kbps" },
  { value: "pcm_44100", label: "PCM 44.1kHz" },
  { value: "pcm_22050", label: "PCM 22.05kHz" },
  { value: "ulaw_8000", label: "uLaw 8kHz" },
];
const ELEVEN_LANGUAGE_OPTIONS = [
  { value: "", label: "自动" },
  { value: "zh", label: "中文" },
  { value: "en", label: "英文" },
  { value: "ja", label: "日文" },
  { value: "ko", label: "韩文" },
  { value: "de", label: "德文" },
  { value: "fr", label: "法文" },
  { value: "es", label: "西班牙文" },
];

function isKlingColumnHeader(header: string) {
  const text = (header || "").replace(/\s+/g, "");
  return text === KLING_COLUMN || text === LEGACY_KLING_COLUMN;
}

function getSceneColumnIndex(headers: string[]) {
  return headers.findIndex((header) => header.replace(/\s+/g, "").includes("场景"));
}

function normalizeSceneCellValue(value: string) {
  return String(value || "")
    .replace(/\[AssetID:\s*[^\]]+\]/g, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

function isSameSceneAsPreviousRow(headers: string[], row: string[], previousRow: string[] | null) {
  if (!previousRow) return false;
  const sceneIndex = getSceneColumnIndex(headers);
  if (sceneIndex < 0) return false;
  const currentScene = normalizeSceneCellValue(row[sceneIndex] || "");
  const previousScene = normalizeSceneCellValue(previousRow[sceneIndex] || "");
  return Boolean(currentScene && previousScene && currentScene === previousScene);
}

export function ScriptEditor({
  content,
  onChange,
  projectId,
  dialogueCellAudioMap: dialogueCellAudioMapProp,
  onDialogueCellAudioMapChange,
  rowStartIndex = 0,
  generatingGlobalRowIndex = null,
  generatedRowIndexSet,
  pendingRowIndexSet,
  rowTaskStatusMap,
  rowTaskIdMap,
  rowVideoUrlMap,
  rowVersionListMap,
  rowSelectedVersionIdMap,
  onGenerateKlingRow,
  onModifyKlingRow,
  modifyingGlobalRowIndex = null,
  onSelectKlingVersion,
  onDeleteKlingVersion,
  deletingVersionKey = null,
}: ScriptEditorProps) {
  void rowTaskStatusMap;
  void rowTaskIdMap;
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [projectAssets, setProjectAssets] = useState<Asset[]>([]);
  const [projectVoices, setProjectVoices] = useState<CharacterVoice[]>([]);
  const [voiceModal, setVoiceModal] = useState<{ blockIndex: number; rowIndex: number; colIndex: number; globalRowIndex: number } | null>(null);
  const [voiceSourceText, setVoiceSourceText] = useState("");
  const [voiceSegments, setVoiceSegments] = useState<VoiceSegment[]>([]);
  const [voiceCharacter, setVoiceCharacter] = useState("");
  const [voiceSpeed, setVoiceSpeed] = useState(1);
  const [voiceStability, setVoiceStability] = useState(0.45);
  const [voiceSimilarityBoost, setVoiceSimilarityBoost] = useState(0.8);
  const [voiceStyle, setVoiceStyle] = useState(0.35);
  const [voiceUseSpeakerBoost, setVoiceUseSpeakerBoost] = useState(true);
  const [voiceModelId, setVoiceModelId] = useState("eleven_v3");
  const [voiceOutputFormat, setVoiceOutputFormat] = useState("mp3_44100_128");
  const [voiceLanguageCode, setVoiceLanguageCode] = useState("");
  const [voiceSeed, setVoiceSeed] = useState("");
  const [voicePreviousText, setVoicePreviousText] = useState("");
  const [voiceNextText, setVoiceNextText] = useState("");
  const [voicePronunciationRules, setVoicePronunciationRules] = useState<PronunciationRule[]>([
    { id: "default-0", source: "", target: "" },
  ]);
  const [voicePronunciationDictId, setVoicePronunciationDictId] = useState("");
  const [voicePronunciationDictVersion, setVoicePronunciationDictVersion] = useState("");
  const [activeVoiceSegmentId, setActiveVoiceSegmentId] = useState<string | null>(null);
  const [voiceGeneratingSegmentId, setVoiceGeneratingSegmentId] = useState<string | null>(null);
  const [voiceTagGroupKey, setVoiceTagGroupKey] = useState<VoiceTagGroup["key"]>("basic");
  const [voiceEmotionIntensity, setVoiceEmotionIntensity] = useState<VoiceEmotionIntensity>("very");
  const [voiceAccentLevel, setVoiceAccentLevel] = useState<VoiceAccentLevel>("normal");
  const [voicePauseSeconds, setVoicePauseSeconds] = useState(1.2);
  const [voiceSegmentAudioMap, setVoiceSegmentAudioMap] = useState<Record<string, string>>({});
  const [dialogueCellAudioMap, setDialogueCellAudioMap] = useState<Record<string, AppliedVoiceSegment[]>>(dialogueCellAudioMapProp || {});
  const [previewVideoUrl, setPreviewVideoUrl] = useState<string | null>(null);
  const [downloadingVideoKey, setDownloadingVideoKey] = useState<string | null>(null);
  const [videoEditModalRowIndex, setVideoEditModalRowIndex] = useState<number | null>(null);
  const [videoEditCurrentUrl, setVideoEditCurrentUrl] = useState("");
  const [videoEditTab, setVideoEditTab] = useState<FrameMaterialTab>("character");
  const [videoEditReferences, setVideoEditReferences] = useState<FrameReference[]>([]);
  const [videoEditPromptInput, setVideoEditPromptInput] = useState("");
  const [videoEditKeepOriginalSound, setVideoEditKeepOriginalSound] = useState(true);
  const [videoEditError, setVideoEditError] = useState("");
  const [frameModalRowIndex, setFrameModalRowIndex] = useState<number | null>(null);
  const [frameModalTab, setFrameModalTab] = useState<FrameMaterialTab>("character");
  const [frameGenerateTab, setFrameGenerateTab] = useState<"first" | "last">("first");
  const [framePromptInput, setFramePromptInput] = useState("");
  const [frameReferences, setFrameReferences] = useState<FrameReference[]>([]);
  const [frameGeneratingType, setFrameGeneratingType] = useState<"first" | "last" | null>(null);
  const [frameImageModels, setFrameImageModels] = useState<string[]>([FRAME_DEFAULT_IMAGE_MODEL]);
  const [frameImageModel, setFrameImageModel] = useState(FRAME_DEFAULT_IMAGE_MODEL);
  const [frameFirstImageMap, setFrameFirstImageMap] = useState<Record<number, string[]>>({});
  const [frameLastImageMap, setFrameLastImageMap] = useState<Record<number, string[]>>({});
  const [frameAppliedMap, setFrameAppliedMap] = useState<Record<number, { first?: string; last?: string }>>({});
  const [framePendingMap, setFramePendingMap] = useState<Record<string, number>>({});
  const [previewFrameUrl, setPreviewFrameUrl] = useState<string | null>(null);
  const [frameError, setFrameError] = useState("");
  const [frameEditTarget, setFrameEditTarget] = useState<{ frameType: "first" | "last"; imageUrl: string } | null>(null);
  const [frameEditInput, setFrameEditInput] = useState("");
  const [frameEditing, setFrameEditing] = useState(false);
  const [voiceError, setVoiceError] = useState("");
  const [usePreviousEndFrameMap, setUsePreviousEndFrameMap] = useState<Record<number, boolean>>({});
  const [voiceSelection, setVoiceSelection] = useState<{ start: number; end: number; text: string }>({ start: 0, end: 0, text: "" });
  const voiceAudioRefs = useRef<Record<string, HTMLAudioElement | null>>({});
  const voiceTextareaRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});
  const frameEditorRef = useRef<HTMLDivElement | null>(null);
  const videoEditEditorRef = useRef<HTMLDivElement | null>(null);
  const frameModalRowIndexRef = useRef<number | null>(null);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  // Initialize with specific value to ensure first sync happens if content is present
  const lastSerializedRef = useRef<string>('__INITIAL_EMPTY__'); 
  const isInternalUpdate = useRef(false);

  const downloadVideo = useCallback(async (videoUrl: string, filename: string, key: string) => {
    if (!videoUrl) return;
    setDownloadingVideoKey(key);
    try {
      const response = await fetch(videoUrl);
      if (!response.ok) {
        throw new Error("下载视频失败");
      }
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1500);
    } catch {
      const fallback = document.createElement("a");
      fallback.href = videoUrl;
      fallback.download = filename;
      fallback.target = "_blank";
      fallback.rel = "noopener noreferrer";
      document.body.appendChild(fallback);
      fallback.click();
      document.body.removeChild(fallback);
    } finally {
      setDownloadingVideoKey(null);
    }
  }, []);

  // Fetch project assets once
  useEffect(() => {
    if (projectId) {
      const fetchAssets = async () => {
        try {
          const token = getToken();
          const res = await fetch(`/api/projects/${projectId}/assets`, {
            headers: token ? {
              'Authorization': `Bearer ${token}`
            } : undefined
          });
          if (res.ok) {
            const data = await res.json();
            setProjectAssets(data);
          }
        } catch (e) {
          console.error("Failed to fetch project assets", e);
        }
      };
      fetchAssets();
    }
  }, [projectId]);

  useEffect(() => {
    if (!projectId) return;
    const token = getToken();
    if (!token) return;
    getProjectVoices(token, projectId)
      .then((items) => {
        setProjectVoices(items);
        if (items.length > 0) {
          setVoiceCharacter((prev) => prev || items[0].character_name);
        }
      })
      .catch(() => {
        setProjectVoices([]);
      });
  }, [projectId]);

  useEffect(() => {
    if (!projectId) return;
    const token = getToken();
    if (!token) return;
    getModels(token)
      .then((modelsRaw) => {
        const drawIds = extractDrawModels(modelsRaw);
        const merged: string[] = [];
        const seen = new Set<string>();
        for (const id of drawIds) {
          const key = id.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          merged.push(id);
        }
        if (!seen.has(FRAME_DEFAULT_IMAGE_MODEL.toLowerCase())) {
          merged.push(FRAME_DEFAULT_IMAGE_MODEL);
        }
        const nextModels = merged.length ? merged : [FRAME_DEFAULT_IMAGE_MODEL];
        setFrameImageModels(nextModels);
        setFrameImageModel((prev) => {
          if (!prev) return nextModels[0];
          const exists = nextModels.some((item) => item.toLowerCase() === prev.toLowerCase());
          return exists ? prev : nextModels[0];
        });
      })
      .catch(() => {
        setFrameImageModels([FRAME_DEFAULT_IMAGE_MODEL]);
      });
  }, [projectId]);

  useEffect(() => {
    setDialogueCellAudioMap(dialogueCellAudioMapProp || {});
  }, [dialogueCellAudioMapProp]);

  useEffect(() => {
    frameModalRowIndexRef.current = frameModalRowIndex;
  }, [frameModalRowIndex]);

  useEffect(() => {
    if (!projectId) {
      setFrameFirstImageMap({});
      setFrameLastImageMap({});
      setFrameAppliedMap({});
      setUsePreviousEndFrameMap({});
      setFramePendingMap({});
      return;
    }
    try {
      const raw = localStorage.getItem(getFrameStateStorageKey(projectId));
      if (!raw) {
        setFrameFirstImageMap({});
        setFrameLastImageMap({});
        setFrameAppliedMap({});
        setUsePreviousEndFrameMap({});
        setFramePendingMap({});
        return;
      }
      const parsed = JSON.parse(raw) as PersistedFrameState;
      const firstImageMap = parsed.firstImageMap || {};
      const lastImageMap = parsed.lastImageMap || {};
      setFrameFirstImageMap(firstImageMap);
      setFrameLastImageMap(lastImageMap);
      setFrameAppliedMap(parsed.appliedMap || {});
      setUsePreviousEndFrameMap(parsed.previousEndFrameMap || {});
      const now = Date.now();
      const rawPendingMap = parsed.pendingMap || {};
      const nextPendingMap: Record<string, number> = {};
      Object.entries(rawPendingMap).forEach(([key, ts]) => {
        const value = Number(ts || 0);
        if (!(value > 0 && now - value <= FRAME_PENDING_MAX_AGE_MS)) return;
        const [rowIndexText, frameTypeText] = String(key).split(":", 2);
        const rowIndex = Number(rowIndexText);
        const frameType = frameTypeText === "last" ? "last" : "first";
        const hasGeneratedImage = Number.isFinite(rowIndex)
          ? frameType === "first"
            ? Boolean(firstImageMap[rowIndex]?.length)
            : Boolean(lastImageMap[rowIndex]?.length)
          : false;
        if (hasGeneratedImage) return;
        nextPendingMap[key] = value;
      });
      setFramePendingMap(nextPendingMap);
    } catch {
      setFrameFirstImageMap({});
      setFrameLastImageMap({});
      setFrameAppliedMap({});
      setUsePreviousEndFrameMap({});
      setFramePendingMap({});
    }
  }, [projectId]);

  useEffect(() => {
    if (!projectId) return;
    const payload: PersistedFrameState = {
      firstImageMap: frameFirstImageMap,
      lastImageMap: frameLastImageMap,
      appliedMap: frameAppliedMap,
      previousEndFrameMap: usePreviousEndFrameMap,
      pendingMap: framePendingMap,
    };
    try {
      localStorage.setItem(getFrameStateStorageKey(projectId), JSON.stringify(payload));
    } catch {}
  }, [projectId, frameFirstImageMap, frameLastImageMap, frameAppliedMap, usePreviousEndFrameMap, framePendingMap]);

  // Parse markdown content into blocks
  const stripThinkingContent = useCallback((markdown: string) => {
    const source = String(markdown || "");
    let cleaned = source.replace(/<think>[\s\S]*?<\/think>/gi, "");
    if (/<think>/i.test(cleaned) && !/<\/think>/i.test(cleaned)) {
      const thinkStart = cleaned.search(/<think>/i);
      const tail = cleaned.slice(thinkStart);
      const firstContentOffset = tail.search(/^\s*(\|.+\||###\s+.+)$/m);
      if (thinkStart >= 0) {
        if (firstContentOffset >= 0) {
          cleaned = `${cleaned.slice(0, thinkStart)}${tail.slice(firstContentOffset)}`;
        } else {
          cleaned = cleaned.slice(0, thinkStart);
        }
      }
    }
    return cleaned.replace(/<\/?think>/gi, "").trim();
  }, []);

  const parseMarkdown = useCallback((markdown: string): Block[] => {
    const sanitizedMarkdown = stripThinkingContent(markdown);
    const lines = sanitizedMarkdown.split('\n');
    const newBlocks: Block[] = [];
    let currentTextLines: string[] = [];
    let currentTableLines: string[] = [];
    let inTable = false;

    // Helper to check if a line looks like a table separator
    const isSeparatorLine = (line: string) => {
      const trimmed = line.trim();
      // Must contain only separator characters: | - : and whitespace
      // And must have at least one dash
      // And must have a pipe
      return /^[\s\|\-:]+$/.test(trimmed) && trimmed.includes('-') && trimmed.includes('|');
    };

    // Helper to check if a line looks like a table row
    const isTableLine = (line: string) => {
      const trimmed = line.trim();
      // Must contain a pipe, or start with pipe
      return trimmed.startsWith('|') || trimmed.startsWith('｜') || trimmed.includes('|');
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      // Check for table start
      if (!inTable) {
        const nextLine = lines[i + 1];
        if (isTableLine(line) && nextLine && isSeparatorLine(nextLine)) {
           // Flush text
           if (currentTextLines.length > 0) {
             newBlocks.push({ type: 'text', value: currentTextLines.join('\n') });
             currentTextLines = [];
           }
           inTable = true;
           currentTableLines.push(line);
        } else {
           currentTextLines.push(line);
        }
      } else {
        // Inside table
        if (isTableLine(line)) {
          currentTableLines.push(line);
        } else {
          // Table ended by non-table line
          inTable = false;
          if (currentTableLines.length > 0) {
            newBlocks.push(parseTableBlock(currentTableLines));
            currentTableLines = [];
          }
          currentTextLines.push(line);
        }
      }
    }

    // Flush remaining buffers
    if (inTable && currentTableLines.length > 0) {
      newBlocks.push(parseTableBlock(currentTableLines));
    }
    if (currentTextLines.length > 0) {
      newBlocks.push({ type: 'text', value: currentTextLines.join('\n') });
    }

    return newBlocks;
  }, [stripThinkingContent]);

  const parseTableBlock = (lines: string[]): Block => {
    const headerLine = lines[0];
    const rowLines = lines.slice(2);

    const splitTableLine = (line: string) => {
      const parts: string[] = [];
      let current = "";
      let bracketDepth = 0;
      let escaped = false;

      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (escaped) {
          current += ch;
          escaped = false;
          continue;
        }
        if (ch === "\\") {
          escaped = true;
          current += ch;
          continue;
        }
        if (ch === "[") {
          bracketDepth += 1;
          current += ch;
          continue;
        }
        if (ch === "]") {
          bracketDepth = Math.max(0, bracketDepth - 1);
          current += ch;
          continue;
        }
        if (ch === "|" && bracketDepth === 0) {
          parts.push(current);
          current = "";
          continue;
        }
        current += ch;
      }
      parts.push(current);
      if (parts.length > 0 && parts[0].trim() === "") parts.shift();
      if (parts.length > 0 && parts[parts.length - 1].trim() === "") parts.pop();
      return parts;
    };

    const normalizeRowByHeaders = (rawCells: string[], headers: string[]) => {
      const expectedCount = headers.length;
      if (expectedCount <= 0) return rawCells;
      if (rawCells.length === expectedCount) return rawCells;
      const normalizedHeaders = headers.map((header) => header.replace(/\s+/g, ""));
      const timelineFirst = normalizedHeaders[0]?.includes("时间轴") || normalizedHeaders[0]?.includes("时长");
      const anchorCount = timelineFirst && expectedCount > 1 ? 2 : 1;
      const normalized = Array.from({ length: expectedCount }, () => "");

      for (let i = 0; i < anchorCount; i++) {
        normalized[i] = rawCells[i] ?? "";
      }

      const rightColumnCount = expectedCount - anchorCount;
      const rightRawStart = Math.max(anchorCount, rawCells.length - rightColumnCount);

      for (let headerIndex = expectedCount - 1, rawIndex = rawCells.length - 1; headerIndex >= anchorCount && rawIndex >= rightRawStart; headerIndex--, rawIndex--) {
        normalized[headerIndex] = rawCells[rawIndex] ?? "";
      }

      if (rightRawStart > anchorCount) {
        normalized[anchorCount] = rawCells.slice(anchorCount, rightRawStart).join(" | ");
      }
      return normalized;
    };

    const headers = splitTableLine(headerLine).map((header) => header.trim());
    const rows = rowLines.map((line) => {
      const cells = splitTableLine(line).map((cell) => cell.trim().replace(/<br\s*\/?>/gi, "\n"));
      return normalizeRowByHeaders(cells, headers);
    });
    const klingIndex = headers.findIndex((header) => isKlingColumnHeader(header));
    if (klingIndex < 0) {
      headers.push(KLING_COLUMN);
      rows.forEach((row) => row.push(""));
    } else {
      headers[klingIndex] = KLING_COLUMN;
      rows.forEach((row) => {
        if (!row[klingIndex]) {
          row[klingIndex] = "";
        }
      });
    }

    return { type: 'table', headers, rows };
  };

  const getColumnWidthClass = (header: string) => {
    const text = header.replace(/\s+/g, '');
    if (isKlingColumnHeader(text)) return 'min-w-[160px] w-[160px]';
    if (text.includes('时间轴') || text.includes('时长')) return 'w-[170px] min-w-[170px]';
    if (text.includes('镜头调度与内容融合')) return 'w-[320px] min-w-[320px]';
    if (text.includes('画面描述')) return 'w-[220px] min-w-[220px]';
    if (text.includes('角色形象') || text === '形象') return 'w-[180px] min-w-[180px]';
    if (text.includes('道具') || text.includes('场景')) return 'w-[180px] min-w-[180px]';
    if (text.includes('备注')) return 'w-[160px] min-w-[160px]';
    if (text.includes('集数') || text.includes('时长')) return 'w-[80px] min-w-[80px]';
    if (text.includes('场景') || text.includes('人物') || text.includes('角色')) return 'w-[150px] min-w-[150px]';
    if (text.includes('剧情') || text.includes('内容') || text.includes('台词') || text.includes('画面')) return 'min-w-[400px]';
    if (text.includes('爽点') || text.includes('反转') || text.includes('钩子') || text.includes('备注')) return 'w-[180px] min-w-[180px]';
    return 'min-w-[120px]';
  };

  const serializeBlocks = useCallback((currentBlocks: Block[]): string => {
    return currentBlocks.map(block => {
      if (block.type === 'text') {
        return block.value;
      } else {
        // Convert table back to markdown
        // Ensure all rows have same number of columns
        const headers = block.headers;
        const rows = block.rows;
        
        // Calculate max width for alignment (optional, but good for readability)
        // For now just simple joining
        const headerLine = `| ${headers.join(' | ')} |`;
        const separatorLine = `| ${headers.map(() => '---').join(' | ')} |`;
        const rowLines = rows.map((row) => {
          const escaped = row.map((cell) => cell.replace(/\|/g, "\\|").replace(/\n/g, "<br>"));
          return `| ${escaped.join(' | ')} |`;
        });
        
        return [headerLine, separatorLine, ...rowLines].join('\n');
      }
    }).join('\n');
  }, []);

  // Handle external content updates
  useEffect(() => {
    // If it's an internal update, we ignore it as we already have the latest blocks
    if (isInternalUpdate.current) {
        return;
    }

    // Sync if content changed externally
    if (content !== lastSerializedRef.current) {
      setBlocks(parseMarkdown(content));
      lastSerializedRef.current = content;
    }
  }, [content, parseMarkdown]);

  // Update content when blocks change (internal change)
  useEffect(() => {
    if (isInternalUpdate.current) {
      const newContent = serializeBlocks(blocks);
      if (newContent !== content) {
        lastSerializedRef.current = newContent;
        onChange(newContent);
      }
      isInternalUpdate.current = false;
    }
  }, [blocks, serializeBlocks, onChange, content]);

  const updateBlock = (index: number, value: string) => {
    isInternalUpdate.current = true;
    setBlocks(prev => prev.map((b, i) => i === index && b.type === 'text' ? { ...b, value } : b));
  };

  const updateTable = (blockIndex: number, rowIndex: number, colIndex: number, value: string) => {
    isInternalUpdate.current = true;
    setBlocks(prev => prev.map((b, i) => {
      if (i === blockIndex && b.type === 'table') {
        const newRows = [...b.rows];
        newRows[rowIndex] = [...newRows[rowIndex]];
        newRows[rowIndex][colIndex] = value;
        return { ...b, rows: newRows };
      }
      return b;
    }));
  };

  const makeDialogueCellKey = (rowIndex: number, colIndex: number) => `${rowIndex}:${colIndex}`;

  const openVoiceModal = (blockIndex: number, rowIndex: number, colIndex: number, globalRowIndex: number, initialText: string) => {
    const cellKey = makeDialogueCellKey(rowIndex, colIndex);
    const existingSegments = dialogueCellAudioMap[cellKey] || [];
    const restoredSegments = existingSegments.map((item, index) => ({
      id: `voice-segment-restored-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`,
      text: item.text,
    }));
    const initialSegmentId = restoredSegments[0]?.id || `voice-segment-${Date.now()}`;
    const initialVoiceSegments = restoredSegments.length > 0 ? restoredSegments : [{ id: initialSegmentId, text: "" }];
    const restoredAudioMap: Record<string, string> = {};
    restoredSegments.forEach((segment, index) => {
      const audioUrl = existingSegments[index]?.audioUrl;
      if (audioUrl) restoredAudioMap[segment.id] = audioUrl;
    });
    setVoiceModal({ blockIndex, rowIndex, colIndex, globalRowIndex });
    setVoiceSourceText(initialText);
    setVoiceSegments(initialVoiceSegments);
    setActiveVoiceSegmentId(initialSegmentId);
    setVoiceSpeed(1);
    setVoiceStability(0.45);
    setVoiceSimilarityBoost(0.8);
    setVoiceStyle(0.35);
    setVoiceUseSpeakerBoost(true);
    setVoiceModelId("eleven_v3");
    setVoiceOutputFormat("mp3_44100_128");
    setVoiceLanguageCode("");
    setVoiceSeed("");
    setVoicePreviousText("");
    setVoiceNextText("");
    setVoicePronunciationRules([{ id: "default-0", source: "", target: "" }]);
    setVoicePronunciationDictId("");
    setVoicePronunciationDictVersion("");
    setVoiceSegmentAudioMap(restoredAudioMap);
    setVoiceError("");
    setVoiceSelection({ start: 0, end: 0, text: "" });
    setVoiceTagGroupKey("basic");
    setVoiceEmotionIntensity("very");
    setVoiceAccentLevel("normal");
    setVoicePauseSeconds(1.2);
    if (projectVoices.length > 0) {
      setVoiceCharacter((prev) => prev || projectVoices[0].character_name);
    }
  };

  const closeVoiceModal = () => {
    setVoiceModal(null);
    setVoiceGeneratingSegmentId(null);
  };

  const playDialogueAudio = (audioUrl: string) => {
    if (!audioUrl) return;
    try {
      if (previewAudioRef.current) {
        previewAudioRef.current.pause();
        previewAudioRef.current.currentTime = 0;
      }
      const audio = new Audio(audioUrl);
      previewAudioRef.current = audio;
      void audio.play();
    } catch {}
  };

  const syncVoiceSelection = useCallback((segmentId: string) => {
    const textarea = voiceTextareaRefs.current[segmentId];
    if (!textarea) return;
    const start = textarea.selectionStart ?? 0;
    const end = textarea.selectionEnd ?? start;
    const segment = voiceSegments.find((item) => item.id === segmentId);
    const text = (segment?.text || "").slice(start, end);
    setActiveVoiceSegmentId(segmentId);
    setVoiceSelection({ start, end, text });
  }, [voiceSegments]);

  const addVoiceSegment = (text = "") => {
    const newId = `voice-segment-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setVoiceSegments((prev) => [...prev, { id: newId, text }]);
    setActiveVoiceSegmentId(newId);
    setVoiceSelection({ start: 0, end: 0, text: "" });
    requestAnimationFrame(() => {
      const nextEl = voiceTextareaRefs.current[newId];
      if (!nextEl) return;
      nextEl.focus();
    });
  };

  const updateVoiceSegment = (segmentId: string, text: string) => {
    setVoiceSegments((prev) => prev.map((item) => (item.id === segmentId ? { ...item, text } : item)));
  };

  const removeVoiceSegment = (segmentId: string) => {
    setVoiceSegments((prev) => {
      if (prev.length <= 1) return prev;
      const filtered = prev.filter((item) => item.id !== segmentId);
      const fallbackId = filtered[0]?.id || null;
      if (activeVoiceSegmentId === segmentId) {
        setActiveVoiceSegmentId(fallbackId);
        setVoiceSelection({ start: 0, end: 0, text: "" });
      }
      return filtered;
    });
    setVoiceSegmentAudioMap((prev) => {
      const next = { ...prev };
      delete next[segmentId];
      return next;
    });
    delete voiceAudioRefs.current[segmentId];
    delete voiceTextareaRefs.current[segmentId];
  };

  const combinedVoiceText = voiceSegments
    .map((item) => item.text.trim())
    .filter(Boolean)
    .join("\n");

  const activeTagGroup = VOICE_TAG_GROUPS.find((group) => group.key === voiceTagGroupKey) || VOICE_TAG_GROUPS[0];
  const isEmotionGroup = activeTagGroup.key === "basic" || activeTagGroup.key === "advanced";
  const formatVoiceTag = (tag: string) => {
    if (!isEmotionGroup) return tag;
    const normalized = tag.trim();
    if (!normalized.startsWith("(") || !normalized.endsWith(")")) return tag;
    const inner = normalized.slice(1, -1).trim();
    if (!inner) return tag;
    if (
      inner.startsWith("slightly ") ||
      inner.startsWith("very ") ||
      inner.startsWith("extremely ")
    ) {
      return normalized;
    }
    return `(${voiceEmotionIntensity} ${inner})`;
  };

  const insertVoiceTag = (tag: string) => {
    const finalTag = formatVoiceTag(tag);
    if (!activeVoiceSegmentId) {
      if (voiceSegments.length === 0) {
        addVoiceSegment(`${finalTag} `);
      }
      return;
    }
    const textarea = voiceTextareaRefs.current[activeVoiceSegmentId];
    const targetSegment = voiceSegments.find((item) => item.id === activeVoiceSegmentId);
    if (!textarea || !targetSegment) return;
    const start = textarea.selectionStart ?? 0;
    const end = textarea.selectionEnd ?? start;
    const hasSelection = end > start;
    const currentText = targetSegment.text;
    const selectedText = currentText.slice(start, end);
    const insertion = hasSelection ? `${finalTag}${selectedText}` : `${finalTag} `;
    const nextText = `${currentText.slice(0, start)}${insertion}${currentText.slice(end)}`;
    const nextCaret = start + insertion.length;
    updateVoiceSegment(activeVoiceSegmentId, nextText);
    requestAnimationFrame(() => {
      const nextEl = voiceTextareaRefs.current[activeVoiceSegmentId];
      if (!nextEl) return;
      nextEl.focus();
      nextEl.selectionStart = nextCaret;
      nextEl.selectionEnd = nextCaret;
      setVoiceSelection({ start: nextCaret, end: nextCaret, text: "" });
    });
  };

  const insertCustomPause = () => {
    const safeSeconds = Math.max(0.2, Math.min(8, Number.isFinite(voicePauseSeconds) ? voicePauseSeconds : 1.2));
    const pauseTag = `(pause:${safeSeconds.toFixed(1)}s)`;
    if (!activeVoiceSegmentId) {
      if (voiceSegments.length === 0) {
        addVoiceSegment(`${pauseTag} `);
      }
      return;
    }
    const textarea = voiceTextareaRefs.current[activeVoiceSegmentId];
    const targetSegment = voiceSegments.find((item) => item.id === activeVoiceSegmentId);
    if (!textarea || !targetSegment) return;
    const start = textarea.selectionStart ?? 0;
    const end = textarea.selectionEnd ?? start;
    const hasSelection = end > start;
    const currentText = targetSegment.text;
    const selectedText = currentText.slice(start, end);
    const insertion = hasSelection ? `${pauseTag}${selectedText}` : `${pauseTag} `;
    const nextText = `${currentText.slice(0, start)}${insertion}${currentText.slice(end)}`;
    const nextCaret = start + insertion.length;
    updateVoiceSegment(activeVoiceSegmentId, nextText);
    requestAnimationFrame(() => {
      const nextEl = voiceTextareaRefs.current[activeVoiceSegmentId];
      if (!nextEl) return;
      nextEl.focus();
      nextEl.selectionStart = nextCaret;
      nextEl.selectionEnd = nextCaret;
      setVoiceSelection({ start: nextCaret, end: nextCaret, text: "" });
    });
  };

  const insertAccentTag = () => {
    const accentTag =
      voiceAccentLevel === "slight"
        ? "[slight emphasis]"
        : voiceAccentLevel === "strong"
        ? "[strong emphasis]"
        : "[emphasis]";
    if (!activeVoiceSegmentId) {
      if (voiceSegments.length === 0) {
        addVoiceSegment(`${accentTag} `);
      }
      return;
    }
    const textarea = voiceTextareaRefs.current[activeVoiceSegmentId];
    const targetSegment = voiceSegments.find((item) => item.id === activeVoiceSegmentId);
    if (!textarea || !targetSegment) return;
    const start = textarea.selectionStart ?? 0;
    const end = textarea.selectionEnd ?? start;
    const hasSelection = end > start;
    const currentText = targetSegment.text;
    const selectedText = currentText.slice(start, end);
    const insertion = hasSelection ? `${accentTag}${selectedText}` : `${accentTag} `;
    const nextText = `${currentText.slice(0, start)}${insertion}${currentText.slice(end)}`;
    const nextCaret = start + insertion.length;
    updateVoiceSegment(activeVoiceSegmentId, nextText);
    requestAnimationFrame(() => {
      const nextEl = voiceTextareaRefs.current[activeVoiceSegmentId];
      if (!nextEl) return;
      nextEl.focus();
      nextEl.selectionStart = nextCaret;
      nextEl.selectionEnd = nextCaret;
      setVoiceSelection({ start: nextCaret, end: nextCaret, text: "" });
    });
  };

  const addPronunciationRule = () => {
    setVoicePronunciationRules((prev) => [
      ...prev,
      { id: `pron-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, source: "", target: "" },
    ]);
  };

  const updatePronunciationRule = (id: string, key: "source" | "target", value: string) => {
    setVoicePronunciationRules((prev) => prev.map((item) => (item.id === id ? { ...item, [key]: value } : item)));
  };

  const removePronunciationRule = (id: string) => {
    setVoicePronunciationRules((prev) => (prev.length <= 1 ? prev : prev.filter((item) => item.id !== id)));
  };

  const applyVoiceTextToCell = () => {
    if (!voiceModal) return;
    const appliedSegments = voiceSegments
      .map((item) => ({
        text: item.text.trim(),
        audioUrl: voiceSegmentAudioMap[item.id] || "",
      }))
      .filter((item) => item.text);
    if (appliedSegments.length === 0) return;
    const cellKey = makeDialogueCellKey(voiceModal.rowIndex, voiceModal.colIndex);
    const nextDialogueCellAudioMap = {
      ...dialogueCellAudioMap,
      [cellKey]: appliedSegments,
    };
    setDialogueCellAudioMap(nextDialogueCellAudioMap);
    onDialogueCellAudioMapChange?.(nextDialogueCellAudioMap);
    closeVoiceModal();
  };

  const generateVoiceForSegment = async (segmentId: string) => {
    if (!projectId) return;
    if (!voiceCharacter) return;
    const segment = voiceSegments.find((item) => item.id === segmentId);
    const ttsText = segment?.text.trim() || "";
    if (!ttsText) return;
    const token = getToken();
    if (!token) return;

    setVoiceGeneratingSegmentId(segmentId);
    setVoiceError("");
    try {
      const pronunciationOverrides = voicePronunciationRules
        .map((item) => ({ source: item.source.trim(), target: item.target.trim() }))
        .filter((item) => item.source && item.target);
      const pronunciationDictionaryLocators =
        voicePronunciationDictId.trim() && voicePronunciationDictVersion.trim()
          ? [
              {
                pronunciation_dictionary_id: voicePronunciationDictId.trim(),
                version_id: voicePronunciationDictVersion.trim(),
              },
            ]
          : [];
      const parsedSeed = Number(voiceSeed);
      const result = await generateTTS(token, projectId, {
        character_name: voiceCharacter,
        text: ttsText,
        speed: voiceSpeed,
        tts_config: {
          model_id: voiceModelId,
          output_format: voiceOutputFormat,
          language_code: voiceLanguageCode || undefined,
          seed: Number.isInteger(parsedSeed) ? parsedSeed : undefined,
          previous_text: voicePreviousText.trim() || undefined,
          next_text: voiceNextText.trim() || undefined,
          settings: {
            stability: voiceStability,
            similarity_boost: voiceSimilarityBoost,
            style: voiceStyle,
            speed: voiceSpeed,
            use_speaker_boost: voiceUseSpeakerBoost,
          },
          pronunciation_overrides: pronunciationOverrides,
          pronunciation_dictionary_locators: pronunciationDictionaryLocators,
        },
      });
      const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3000/api";
      const backendBase = apiBase.endsWith("/api") ? apiBase.slice(0, -4) : apiBase;
      const fullUrl = result.audio_url.startsWith("http") ? result.audio_url : `${backendBase}${result.audio_url}`;
      setVoiceSegmentAudioMap((prev) => ({
        ...prev,
        [segmentId]: fullUrl,
      }));
    } catch (error) {
      setVoiceError(error instanceof Error ? error.message : "生成配音失败");
    } finally {
      setVoiceGeneratingSegmentId(null);
    }
  };

  const resolveAssetImageUrl = useCallback((asset: Asset) => {
    const versions = asset.versions || [];
    const isRemotePublicUrl = (raw: string) => {
      const url = String(raw || "").trim();
      if (!(url.startsWith("http://") || url.startsWith("https://"))) return false;
      if (
        url.includes("/static/") &&
        (url.includes("localhost") || url.includes("127.0.0.1") || url.includes(":8003"))
      ) {
        return false;
      }
      return true;
    };
    const selectedRemote = versions.find(
      (version) => version.is_selected && isRemotePublicUrl(version.image_url || "")
    );
    if (selectedRemote?.image_url) return String(selectedRemote.image_url).trim();
    const latestRemote = [...versions]
      .reverse()
      .find((version) => isRemotePublicUrl(version.image_url || ""));
    if (latestRemote?.image_url) return String(latestRemote.image_url).trim();
    const selectedAny = versions.find((version) => version.is_selected && version.image_url);
    if (selectedAny?.image_url) return String(selectedAny.image_url).trim();
    const fallbackAny = versions.find((version) => Boolean(version.image_url));
    return String(fallbackAny?.image_url || "").trim();
  }, []);

  const resolveAssetType = useCallback((asset: Asset): FrameMaterialTab | null => {
    const typeText = String(asset.type || "").toLowerCase();
    if (typeText.includes("character") || typeText.includes("角色")) return "character";
    if (typeText.includes("prop") || typeText.includes("道具")) return "prop";
    if (typeText.includes("scene") || typeText.includes("场景")) return "scene";
    return null;
  }, []);

  const materialAssetsByTab = useMemo(() => {
    const initial: Record<FrameMaterialTab, Array<{ asset: Asset; imageUrl: string }>> = {
      character: [],
      prop: [],
      scene: [],
    };
    projectAssets.forEach((asset) => {
      const tab = resolveAssetType(asset);
      if (!tab) return;
      const imageUrl = resolveAssetImageUrl(asset);
      if (!imageUrl) return;
      initial[tab].push({ asset, imageUrl });
    });
    return initial;
  }, [projectAssets, resolveAssetImageUrl, resolveAssetType]);

  const frameReferenceOptionMap = useMemo(() => {
    const map: Record<string, FrameReference> = {};
    (Object.values(materialAssetsByTab).flat() || []).forEach(({ asset, imageUrl }) => {
      map[asset.id] = { assetId: asset.id, name: asset.name, imageUrl };
    });
    return map;
  }, [materialAssetsByTab]);

  const syncFrameEditorState = useCallback(() => {
    const editor = frameEditorRef.current;
    if (!editor) return;
    const tokenNodes = Array.from(editor.querySelectorAll("span[data-frame-ref='1']")) as HTMLSpanElement[];
    const refs: FrameReference[] = [];
    tokenNodes.forEach((node) => {
      const refId = String(node.dataset.refId || "").trim();
      if (!refId) return;
      const mapped = frameReferenceOptionMap[refId];
      if (mapped) {
        refs.push(mapped);
      } else {
        const refName = String(node.dataset.refName || "").trim();
        const refUrl = String(node.dataset.refUrl || "").trim();
        if (refName && refUrl) refs.push({ assetId: refId, name: refName, imageUrl: refUrl });
      }
    });
    const prompt = String(editor.textContent || "").replace(/\u00a0/g, " ").trim();
    setFrameReferences(refs);
    setFramePromptInput(prompt);
  }, [frameReferenceOptionMap]);

  const openFrameModal = (globalRowIndex: number) => {
    setFrameModalRowIndex(globalRowIndex);
    setFrameModalTab("character");
    setFrameGenerateTab("first");
    setFramePromptInput("");
    setFrameReferences([]);
    setFrameError("");
    window.setTimeout(() => {
      if (frameEditorRef.current) {
        frameEditorRef.current.innerHTML = "";
      }
    }, 0);
  };

  const insertFrameReferenceToken = useCallback((ref: FrameReference) => {
    const editor = frameEditorRef.current;
    if (!editor) return;
    editor.focus();
    const token = document.createElement("span");
    token.dataset.frameRef = "1";
    token.dataset.refId = ref.assetId;
    token.dataset.refName = ref.name;
    token.dataset.refUrl = ref.imageUrl;
    token.contentEditable = "false";
    token.className = "mx-1 inline-flex rounded bg-blue-100 px-2 py-0.5 text-xs text-blue-700 align-middle";
    token.textContent = ref.name;
    const space = document.createTextNode(" ");
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0 && editor.contains(selection.anchorNode)) {
      const range = selection.getRangeAt(0);
      range.deleteContents();
      range.insertNode(space);
      range.insertNode(token);
      range.setStartAfter(space);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
    } else {
      editor.appendChild(token);
      editor.appendChild(space);
    }
    syncFrameEditorState();
  }, [syncFrameEditorState]);

  const toggleFrameReference = (assetId: string, name: string, imageUrl: string) => {
    insertFrameReferenceToken({ assetId, name, imageUrl });
  };

  const syncVideoEditEditorState = useCallback(() => {
    const editor = videoEditEditorRef.current;
    if (!editor) return;
    const tokenNodes = Array.from(editor.querySelectorAll("span[data-video-edit-ref='1']")) as HTMLSpanElement[];
    const refs: FrameReference[] = [];
    tokenNodes.forEach((node) => {
      const refId = String(node.dataset.refId || "").trim();
      if (!refId) return;
      const mapped = frameReferenceOptionMap[refId];
      if (mapped) {
        refs.push(mapped);
      } else {
        const refName = String(node.dataset.refName || "").trim();
        const refUrl = String(node.dataset.refUrl || "").trim();
        if (refName && refUrl) refs.push({ assetId: refId, name: refName, imageUrl: refUrl });
      }
    });
    const prompt = String(editor.textContent || "").replace(/\u00a0/g, " ").trim();
    setVideoEditReferences(refs);
    setVideoEditPromptInput(prompt);
  }, [frameReferenceOptionMap]);

  const insertVideoEditReferenceToken = useCallback((ref: FrameReference) => {
    const editor = videoEditEditorRef.current;
    if (!editor) return;
    editor.focus();
    const token = document.createElement("span");
    token.dataset.videoEditRef = "1";
    token.dataset.refId = ref.assetId;
    token.dataset.refName = ref.name;
    token.dataset.refUrl = ref.imageUrl;
    token.contentEditable = "false";
    token.className = "mx-1 inline-flex rounded bg-indigo-100 px-2 py-0.5 text-xs text-indigo-700 align-middle";
    token.textContent = ref.name;
    const space = document.createTextNode(" ");
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0 && editor.contains(selection.anchorNode)) {
      const range = selection.getRangeAt(0);
      range.deleteContents();
      range.insertNode(space);
      range.insertNode(token);
      range.setStartAfter(space);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
    } else {
      editor.appendChild(token);
      editor.appendChild(space);
    }
    syncVideoEditEditorState();
  }, [syncVideoEditEditorState]);

  const readVideoDurationSeconds = useCallback((videoUrl: string) => new Promise<number>((resolve, reject) => {
    if (!videoUrl) {
      reject(new Error("empty video url"));
      return;
    }
    const video = document.createElement("video");
    let finished = false;
    const cleanup = () => {
      video.onloadedmetadata = null;
      video.onerror = null;
      video.removeAttribute("src");
      video.load();
    };
    const done = (resolver: () => void) => {
      if (finished) return;
      finished = true;
      window.clearTimeout(timeout);
      cleanup();
      resolver();
    };
    const timeout = window.setTimeout(() => {
      done(() => reject(new Error("timeout")));
    }, 12000);
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      const duration = Number(video.duration || 0);
      if (!Number.isFinite(duration) || duration <= 0) {
        done(() => reject(new Error("invalid duration")));
        return;
      }
      done(() => resolve(duration));
    };
    video.onerror = () => {
      done(() => reject(new Error("load metadata failed")));
    };
    video.src = videoUrl;
  }), []);

  const openVideoEditModal = async (globalRowIndex: number, currentVideoUrl: string) => {
    try {
      const duration = await readVideoDurationSeconds(currentVideoUrl);
      if (duration < 3 || duration > 10) {
        window.alert(`当前视频时长为 ${duration.toFixed(1)}s，仅支持修改 3-10s 的视频。`);
        return;
      }
    } catch {
      window.alert("无法读取当前视频时长，仅支持修改 3-10s 的视频。");
      return;
    }
    setVideoEditModalRowIndex(globalRowIndex);
    setVideoEditCurrentUrl(currentVideoUrl);
    setVideoEditTab("character");
    setVideoEditReferences([]);
    setVideoEditPromptInput("");
    setVideoEditKeepOriginalSound(true);
    setVideoEditError("");
    window.setTimeout(() => {
      if (videoEditEditorRef.current) {
        videoEditEditorRef.current.innerHTML = "";
      }
    }, 0);
  };

  const closeVideoEditModal = () => {
    setVideoEditModalRowIndex(null);
    setVideoEditCurrentUrl("");
    setVideoEditReferences([]);
    setVideoEditPromptInput("");
    setVideoEditError("");
    if (videoEditEditorRef.current) {
      videoEditEditorRef.current.innerHTML = "";
    }
  };

  const submitVideoEdit = () => {
    if (videoEditModalRowIndex === null) return;
    const instruction = videoEditPromptInput.trim();
    if (!instruction) {
      setVideoEditError("请输入修改指令");
      return;
    }
    if (!videoEditCurrentUrl) {
      setVideoEditError("当前视频地址无效，请先生成视频");
      return;
    }
    setVideoEditError("");
    const references = Array.from(new Set(videoEditReferences.map((item) => item.imageUrl))).filter(Boolean);
    let headers: string[] = [];
    let row: string[] = [];
    let cursor = rowStartIndex;
    for (const block of blocks) {
      if (block.type !== "table") continue;
      const nextCursor = cursor + block.rows.length;
      if (videoEditModalRowIndex >= cursor && videoEditModalRowIndex < nextCursor) {
        const rowOffset = videoEditModalRowIndex - cursor;
        headers = block.headers;
        row = block.headers.map((_, i) => block.rows[rowOffset]?.[i] || "");
        break;
      }
      cursor = nextCursor;
    }
    onModifyKlingRow?.({
      globalRowIndex: videoEditModalRowIndex,
      headers,
      row,
      currentVideoUrl: videoEditCurrentUrl,
      instruction,
      referenceImageUrls: references,
      keepOriginalSound: videoEditKeepOriginalSound,
    });
    closeVideoEditModal();
  };

  const markFramePending = useCallback((rowIndex: number, frameType: "first" | "last", pending: boolean) => {
    const key = buildFramePendingKey(rowIndex, frameType);
    setFramePendingMap((prev) => {
      if (pending) {
        return { ...prev, [key]: Date.now() };
      }
      if (!Object.prototype.hasOwnProperty.call(prev, key)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  const appendGeneratedFrameImage = useCallback((rowIndex: number, frameType: "first" | "last", imageUrl: string) => {
    if (!projectId || !imageUrl) return;
    setFrameFirstImageMap((prev) => {
      if (frameType !== "first") return prev;
      const list = prev[rowIndex] || [];
      return { ...prev, [rowIndex]: [imageUrl, ...list] };
    });
    setFrameLastImageMap((prev) => {
      if (frameType !== "last") return prev;
      const list = prev[rowIndex] || [];
      return { ...prev, [rowIndex]: [imageUrl, ...list] };
    });
    try {
      const raw = localStorage.getItem(getFrameStateStorageKey(projectId));
      const parsed = raw ? (JSON.parse(raw) as PersistedFrameState) : {};
      const firstImageMap = parsed.firstImageMap || {};
      const lastImageMap = parsed.lastImageMap || {};
      if (frameType === "first") {
        const list = firstImageMap[rowIndex] || [];
        firstImageMap[rowIndex] = [imageUrl, ...list];
      } else {
        const list = lastImageMap[rowIndex] || [];
        lastImageMap[rowIndex] = [imageUrl, ...list];
      }
      localStorage.setItem(
        getFrameStateStorageKey(projectId),
        JSON.stringify({
          ...parsed,
          firstImageMap,
          lastImageMap,
        })
      );
    } catch {}
  }, [projectId]);

  const waitForFrameTask = useCallback(async (taskId: string) => {
    if (!projectId) throw new Error("项目不存在");
    const token = getToken();
    if (!token) throw new Error("登录已失效");
    const start = Date.now();
    while (Date.now() - start < 15 * 60 * 1000) {
      const status = await getSegmentFrameImageTaskStatus(token, projectId, taskId);
      if (status.status === "COMPLETED") {
        const imageUrl = String((status.result?.image_url as string) || "").trim();
        if (!imageUrl) throw new Error("未返回图片地址");
        return imageUrl;
      }
      if (status.status === "FAILED") {
        throw new Error(status.error || "生成失败");
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new Error("生成超时，请稍后刷新查看");
  }, [projectId]);

  const generateFrameImage = async (frameType: "first" | "last") => {
    if (!projectId || frameModalRowIndex === null) return;
    const rowIndex = frameModalRowIndex;
    const token = getToken();
    if (!token) return;
    const prompt = framePromptInput.trim();
    if (!prompt) {
      setFrameError("请输入提示词");
      return;
    }
    setFrameGeneratingType(frameType);
    markFramePending(rowIndex, frameType, true);
    setFrameError("");
    try {
      const references = Array.from(new Set(frameReferences.map((item) => item.imageUrl))).filter(Boolean);
      const task = await generateSegmentFrameImage(token, projectId, {
        prompt,
        references,
        frame_type: frameType,
        aspect_ratio: "16:9",
        model: frameImageModel,
      });
      const generated = await waitForFrameTask(task.task_id);
      appendGeneratedFrameImage(rowIndex, frameType, generated);
    } catch (error) {
      if (frameModalRowIndexRef.current === rowIndex) {
        setFrameError(error instanceof Error ? error.message : "生成失败");
      }
    } finally {
      markFramePending(rowIndex, frameType, false);
      setFrameGeneratingType(null);
    }
  };

  const applyFrameForRow = (rowIndex: number, frameType: "first" | "last", imageUrl: string) => {
    setFrameAppliedMap((prev) => {
      const current = prev[rowIndex] || {};
      const currentValue = frameType === "first" ? current.first : current.last;
      const nextValue = currentValue === imageUrl ? undefined : imageUrl;
      return {
        ...prev,
        [rowIndex]:
          frameType === "first"
            ? { ...current, first: nextValue }
            : { ...current, last: nextValue },
      };
    });
  };

  const closeFrameModalAndApply = () => {
    setFrameModalRowIndex(null);
    setFramePromptInput("");
    setFrameReferences([]);
    setFrameError("");
    setFrameEditTarget(null);
    setFrameEditInput("");
    setFrameEditing(false);
    if (frameEditorRef.current) {
      frameEditorRef.current.innerHTML = "";
    }
  };

  const startFrameEdit = (frameType: "first" | "last", imageUrl: string) => {
    setFrameEditTarget({ frameType, imageUrl });
    setFrameEditInput("");
    setFrameError("");
  };

  const submitFrameEdit = async () => {
    if (!projectId || frameModalRowIndex === null || !frameEditTarget) return;
    const rowIndex = frameModalRowIndex;
    const editTarget = frameEditTarget;
    const basePrompt = framePromptInput.trim();
    const extraRefs = frameReferences.map((item) => item.imageUrl);
    const token = getToken();
    if (!token) return;
    const editPrompt = frameEditInput.trim();
    if (!editPrompt) {
      setFrameError("请输入修改意见");
      return;
    }
    setFrameEditing(true);
    markFramePending(rowIndex, editTarget.frameType, true);
    setFrameError("");
    try {
      const references = Array.from(new Set([editTarget.imageUrl, ...extraRefs])).filter(Boolean);
      const mergedPrompt = `${basePrompt}\n修改意见：${editPrompt}`.trim();
      const task = await generateSegmentFrameImage(token, projectId, {
        prompt: mergedPrompt,
        references,
        frame_type: editTarget.frameType,
        aspect_ratio: "16:9",
        model: frameImageModel,
      });
      const generated = await waitForFrameTask(task.task_id);
      appendGeneratedFrameImage(rowIndex, editTarget.frameType, generated);
      if (frameModalRowIndexRef.current === rowIndex) {
        setFrameEditTarget(null);
        setFrameEditInput("");
      }
    } catch (error) {
      if (frameModalRowIndexRef.current === rowIndex) {
        setFrameError(error instanceof Error ? error.message : "修改失败");
      }
    } finally {
      markFramePending(rowIndex, editTarget.frameType, false);
      setFrameEditing(false);
    }
  };

  return (
    <>
    <div className="w-full bg-white rounded-xl border border-slate-200 overflow-hidden shadow-sm">
      {(() => {
        let globalRowCursor = rowStartIndex;
        return blocks.map((block, index) => {
        if (block.type === 'text') {
          return (
            <TextBlock 
              key={index} 
              value={block.value} 
              onChange={(v) => updateBlock(index, v)} 
            />
          );
        } else {
          const blockRowBase = globalRowCursor;
          globalRowCursor += block.rows.length;
          return (
            <div key={index} className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead className="text-xs text-slate-500 uppercase bg-slate-50 border-b border-slate-100">
                  <tr>
                    {block.headers.map((header, i) => (
                      <th 
                        key={i} 
                        className={`px-4 py-3 font-medium whitespace-nowrap ${getColumnWidthClass(header)}`}
                      >
                        {header}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {block.rows.map((row, rowIndex) => (
                    <tr key={rowIndex} className="hover:bg-slate-50 group">
                      {block.headers.map((header, colIndex) => {
                        const normalizedHeader = header.replace(/\s+/g, '');
                        const isKlingColumn = isKlingColumnHeader(normalizedHeader);
                        const cell = row[colIndex] || '';
                        const globalRowIndex = blockRowBase + rowIndex;
                        const isPending = Boolean(pendingRowIndexSet?.has(globalRowIndex));
                        const rowVideoUrl = rowVideoUrlMap?.[globalRowIndex] || "";
                        const rowVersions = rowVersionListMap?.[globalRowIndex] || [];
                        const completedVersions = rowVersions.filter((version) => isCompletedVideoVersion(version));
                        const completedVersionsForDisplay = [...completedVersions].reverse();
                        const latestVersion = rowVersions[0];
                        const latestStatus = String(latestVersion?.status || "").toUpperCase();
                        const latestFailedMsg = String(latestVersion?.task_status_msg || "").trim();
                        const previousRow = rowIndex > 0 ? block.rows[rowIndex - 1] : null;
                        const canUsePreviousEndFrame = Boolean(previousRow);
                        const defaultUsePreviousEndFrame = isSameSceneAsPreviousRow(block.headers, row, previousRow);
                        const usePreviousEndFrame = Object.prototype.hasOwnProperty.call(usePreviousEndFrameMap, globalRowIndex)
                          ? Boolean(usePreviousEndFrameMap[globalRowIndex])
                          : defaultUsePreviousEndFrame;
                        const selectedVersionId = rowSelectedVersionIdMap?.[globalRowIndex] || "";
                        const hasSelectedCompletedVersion = completedVersionsForDisplay.some((version) => version.id === selectedVersionId);
                        const effectiveSelectedVersionId = hasSelectedCompletedVersion
                          ? selectedVersionId
                          : (completedVersions[0]?.id || "");
                        const currentVersionDeleteKey = `${globalRowIndex}:${effectiveSelectedVersionId}`;
                        const currentVersionDownloadKey = `${globalRowIndex}:${effectiveSelectedVersionId || "default"}`;
                        const isDeletingVersion = deletingVersionKey === currentVersionDeleteKey;
                        const isDownloadingVersion = downloadingVideoKey === currentVersionDownloadKey;
                        const selectedVersion = completedVersions.find((version) => version.id === effectiveSelectedVersionId);
                        const previewUrl = selectedVersion?.video_url || rowVideoUrl;
                        const versionIndex = completedVersionsForDisplay.findIndex((version) => version.id === effectiveSelectedVersionId);
                        const downloadFilename = `分镜${globalRowIndex + 1}-${versionIndex >= 0 ? `版本${versionIndex + 1}` : "当前版本"}.mp4`;
                        const normalized = header.replace(/\s+/g, '');
                        const appliedFrames = frameAppliedMap[globalRowIndex] || {};
                        return (
                          <td 
                            key={colIndex} 
                            className={`px-4 py-3 relative align-top ${getColumnWidthClass(header)}`}
                          >
                            {isKlingColumn ? (
                              <div className="flex flex-col items-center gap-2">
                                <button
                                  onClick={() =>
                                    onGenerateKlingRow?.({
                                      globalRowIndex,
                                      previousGlobalRowIndex: previousRow ? globalRowIndex - 1 : undefined,
                                      headers: block.headers,
                                      row: block.headers.map((_, i) => row[i] || ""),
                                      usePreviousSegmentEndFrame: canUsePreviousEndFrame ? usePreviousEndFrame : false,
                                      customFirstFrameUrl: appliedFrames.first,
                                      customLastFrameUrl: appliedFrames.last,
                                    })
                                  }
                                  disabled={generatingGlobalRowIndex === globalRowIndex || isPending}
                                  className={`rounded px-3 py-1 text-xs text-white ${
                                    generatingGlobalRowIndex === globalRowIndex || isPending
                                      ? "bg-slate-400"
                                      : "bg-blue-600 hover:bg-blue-700"
                                  }`}
                                >
                                  {generatingGlobalRowIndex === globalRowIndex || isPending ? "生成中" : "生成视频"}
                                </button>
                                <label className={`flex items-center gap-1 text-[11px] ${canUsePreviousEndFrame ? "text-slate-600" : "text-slate-300"}`}>
                                  <input
                                    type="checkbox"
                                    checked={canUsePreviousEndFrame ? usePreviousEndFrame : false}
                                    disabled={!canUsePreviousEndFrame}
                                    onChange={(event) => {
                                      const checked = event.target.checked;
                                      setUsePreviousEndFrameMap((prev) => ({ ...prev, [globalRowIndex]: checked }));
                                    }}
                                  />
                                  使用前一条分镜频尾帧
                                </label>
                                <button
                                  type="button"
                                  onClick={() => openFrameModal(globalRowIndex)}
                                  className="rounded border border-blue-200 px-3 py-1 text-xs text-blue-700 hover:bg-blue-50"
                                >
                                  自定义首尾帧
                                </button>
                                {(appliedFrames.first || appliedFrames.last) ? (
                                  <div className="flex items-center gap-2">
                                    {appliedFrames.first ? (
                                      <button
                                        type="button"
                                        onClick={() => setPreviewFrameUrl(appliedFrames.first || null)}
                                        className="rounded border border-cyan-200 px-2 py-1 text-[11px] text-cyan-700 hover:bg-cyan-50"
                                      >
                                        首帧预览
                                      </button>
                                    ) : null}
                                    {appliedFrames.last ? (
                                      <button
                                        type="button"
                                        onClick={() => setPreviewFrameUrl(appliedFrames.last || null)}
                                        className="rounded border border-fuchsia-200 px-2 py-1 text-[11px] text-fuchsia-700 hover:bg-fuchsia-50"
                                      >
                                        尾帧预览
                                      </button>
                                    ) : null}
                                  </div>
                                ) : null}
                                {!isPending && generatedRowIndexSet?.has(globalRowIndex) ? (
                                  <span className="text-xs text-green-600">已生成</span>
                                ) : null}
                                {!isPending && latestStatus.includes("FAILED") ? (
                                  <span className="text-[11px] text-rose-600">
                                    生成失败{latestFailedMsg ? `：${latestFailedMsg}` : "，请重试"}
                                  </span>
                                ) : null}
                                {completedVersions.length > 0 ? (
                                  <div className="flex w-full items-center gap-1">
                                    {completedVersionsForDisplay.length > 1 ? (
                                      <select
                                        value={effectiveSelectedVersionId}
                                        onChange={(event) => onSelectKlingVersion?.(globalRowIndex, event.target.value)}
                                        disabled={isDeletingVersion}
                                        className="min-w-0 flex-1 rounded border border-slate-200 px-2 py-1 text-[11px] text-slate-700 disabled:opacity-50"
                                      >
                                        {completedVersionsForDisplay.map((version, versionIndex) => (
                                          <option key={version.id} value={version.id}>
                                            {`版本${versionIndex + 1}${version.id === effectiveSelectedVersionId ? "（当前）" : ""}`}
                                          </option>
                                        ))}
                                      </select>
                                    ) : (
                                      <div className="min-w-0 flex-1 rounded border border-slate-200 px-2 py-1 text-[11px] text-slate-500">
                                        版本1（当前）
                                      </div>
                                    )}
                                    <button
                                      type="button"
                                      onClick={() => onDeleteKlingVersion?.(globalRowIndex, effectiveSelectedVersionId)}
                                      disabled={!effectiveSelectedVersionId || isDeletingVersion}
                                      className="rounded border border-rose-200 px-2 py-1 text-[11px] text-rose-600 hover:bg-rose-50 disabled:opacity-50"
                                    >
                                      {isDeletingVersion ? "删除中..." : "删除"}
                                    </button>
                                  </div>
                                ) : null}
                                {previewUrl ? (
                                  <div className="flex flex-wrap items-center gap-2">
                                    <button
                                      onClick={() => setPreviewVideoUrl(previewUrl)}
                                      className="rounded border border-green-300 px-3 py-1 text-xs text-green-700 hover:bg-green-50"
                                    >
                                      播放视频
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => { void openVideoEditModal(globalRowIndex, previewUrl); }}
                                      disabled={modifyingGlobalRowIndex === globalRowIndex}
                                      className="rounded border border-amber-300 px-3 py-1 text-xs text-amber-700 hover:bg-amber-50 disabled:opacity-50"
                                    >
                                      {modifyingGlobalRowIndex === globalRowIndex ? "修改中..." : "修改当前视频"}
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => downloadVideo(previewUrl, downloadFilename, currentVersionDownloadKey)}
                                      disabled={isDownloadingVersion}
                                      className="rounded border border-indigo-300 px-3 py-1 text-xs text-indigo-700 hover:bg-indigo-50 disabled:opacity-50"
                                    >
                                      {isDownloadingVersion ? "下载中..." : "下载视频"}
                                    </button>
                                  </div>
                                ) : null}
                              </div>
                            ) : (
                              <div className="space-y-2">
                                <TableCell
                                  value={cell}
                                  onChange={(v) => updateTable(index, rowIndex, colIndex, v)}
                                  projectId={projectId}
                                  projectAssets={projectAssets}
                                  columnHeader={header}
                                />
                              </div>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
      });
      })()}
    </div>
    {previewVideoUrl ? (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6">
        <div className="w-full max-w-4xl rounded-xl bg-white p-4 shadow-2xl">
          <div className="mb-3 flex items-center justify-between">
            <div className="text-sm font-medium text-slate-700">视频预览</div>
            <button
              onClick={() => setPreviewVideoUrl(null)}
              className="rounded-md border border-slate-200 px-3 py-1 text-xs text-slate-600 hover:bg-slate-50"
            >
              关闭
            </button>
          </div>
          <video
            src={previewVideoUrl}
            controls
            autoPlay
            className="h-auto max-h-[75vh] w-full rounded-lg bg-black"
          />
        </div>
      </div>
    ) : null}
    {previewFrameUrl ? (
      <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-6">
        <div className="w-full max-w-2xl rounded-xl bg-white p-4 shadow-2xl">
          <div className="mb-3 flex items-center justify-between">
            <div className="text-sm font-medium text-slate-700">帧图预览</div>
            <button
              onClick={() => setPreviewFrameUrl(null)}
              className="rounded-md border border-slate-200 px-3 py-1 text-xs text-slate-600 hover:bg-slate-50"
            >
              关闭
            </button>
          </div>
          <img src={previewFrameUrl} alt="帧图预览" className="h-auto max-h-[75vh] w-full rounded-lg object-contain bg-slate-100" />
        </div>
      </div>
    ) : null}
    {videoEditModalRowIndex !== null ? (
      <div className="fixed inset-0 z-[85] overflow-y-auto bg-black/50 px-4 py-6">
        <div className="mx-auto w-full max-w-6xl rounded-2xl border border-slate-200 bg-white shadow-xl">
          <div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-100 bg-white px-5 py-4">
            <div className="text-sm font-semibold text-slate-900">修改当前视频</div>
            <button
              onClick={closeVideoEditModal}
              className="rounded-md px-2 py-1 text-xs text-slate-500 hover:bg-slate-100"
            >
              关闭
            </button>
          </div>
          <div className="space-y-4 p-5">
            <div className="overflow-hidden rounded-xl border border-slate-200 bg-black">
              <video src={videoEditCurrentUrl} controls className="h-auto max-h-[45vh] w-full" />
            </div>
            <div className="flex items-center gap-2 border-b border-slate-100 pb-2">
              <button
                type="button"
                onClick={() => setVideoEditTab("character")}
                className={`rounded px-3 py-1 text-xs ${videoEditTab === "character" ? "bg-blue-600 text-white" : "border border-slate-200 text-slate-600"}`}
              >
                角色形象
              </button>
              <button
                type="button"
                onClick={() => setVideoEditTab("prop")}
                className={`rounded px-3 py-1 text-xs ${videoEditTab === "prop" ? "bg-blue-600 text-white" : "border border-slate-200 text-slate-600"}`}
              >
                道具
              </button>
              <button
                type="button"
                onClick={() => setVideoEditTab("scene")}
                className={`rounded px-3 py-1 text-xs ${videoEditTab === "scene" ? "bg-blue-600 text-white" : "border border-slate-200 text-slate-600"}`}
              >
                场景
              </button>
            </div>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              {(materialAssetsByTab[videoEditTab] || []).map(({ asset, imageUrl }) => {
                const selected = videoEditReferences.some((item) => item.assetId === asset.id);
                return (
                  <button
                    key={`video-edit-${asset.id}`}
                    type="button"
                    onClick={() => insertVideoEditReferenceToken({ assetId: asset.id, name: asset.name, imageUrl })}
                    className={`overflow-hidden rounded-lg border text-left ${selected ? "border-indigo-500 ring-2 ring-indigo-200" : "border-slate-200"}`}
                  >
                    <img src={imageUrl} alt={asset.name} className="h-24 w-full object-cover bg-slate-100" />
                    <div className="truncate px-2 py-1 text-xs">{asset.name}</div>
                  </button>
                );
              })}
            </div>
            <div className="space-y-2">
              <div className="relative min-h-[96px] w-full rounded-lg border border-slate-200 px-3 py-2">
                <div
                  ref={videoEditEditorRef}
                  contentEditable
                  suppressContentEditableWarning
                  onInput={syncVideoEditEditorState}
                  className="min-h-[80px] w-full whitespace-pre-wrap break-words text-sm outline-none"
                />
                {!videoEditPromptInput && videoEditReferences.length === 0 ? (
                  <span className="pointer-events-none absolute left-3 top-2 text-sm text-slate-400">
                    输入修改指令，可引用上方素材
                  </span>
                ) : null}
              </div>
              <div className="flex items-center justify-between gap-3">
                <div className="space-y-1">
                  <div className="text-xs text-slate-500">提示：将基于当前视频进行编辑，已选素材会作为参考图。</div>
                  <label className="inline-flex items-center gap-2 text-xs text-slate-600">
                    <input
                      type="checkbox"
                      checked={videoEditKeepOriginalSound}
                      onChange={(e) => setVideoEditKeepOriginalSound(e.target.checked)}
                      className="h-3.5 w-3.5 rounded border-slate-300"
                    />
                    保留原声
                  </label>
                </div>
                <button
                  type="button"
                  onClick={submitVideoEdit}
                  disabled={modifyingGlobalRowIndex !== null}
                  className="rounded bg-amber-600 px-3 py-1.5 text-xs text-white hover:bg-amber-700 disabled:opacity-50"
                >
                  提交视频修改
                </button>
              </div>
              {videoEditError ? <div className="text-xs text-rose-600">{videoEditError}</div> : null}
            </div>
          </div>
        </div>
      </div>
    ) : null}
    {frameModalRowIndex !== null ? (
      <div className="fixed inset-0 z-50 overflow-y-auto bg-black/50 px-4 py-6">
        <div className="mx-auto w-full max-w-6xl rounded-2xl border border-slate-200 bg-white shadow-xl">
          <div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-100 bg-white px-5 py-4">
            <div className="text-sm font-semibold text-slate-900">自定义首尾帧</div>
            <button
              onClick={closeFrameModalAndApply}
              className="rounded-md px-2 py-1 text-xs text-slate-500 hover:bg-slate-100"
            >
              关闭
            </button>
          </div>
          <div className="space-y-4 p-5">
            <div className="flex items-center gap-2 border-b border-slate-100 pb-2">
              <button
                type="button"
                onClick={() => setFrameModalTab("character")}
                className={`rounded px-3 py-1 text-xs ${frameModalTab === "character" ? "bg-blue-600 text-white" : "border border-slate-200 text-slate-600"}`}
              >
                角色形象
              </button>
              <button
                type="button"
                onClick={() => setFrameModalTab("prop")}
                className={`rounded px-3 py-1 text-xs ${frameModalTab === "prop" ? "bg-blue-600 text-white" : "border border-slate-200 text-slate-600"}`}
              >
                道具
              </button>
              <button
                type="button"
                onClick={() => setFrameModalTab("scene")}
                className={`rounded px-3 py-1 text-xs ${frameModalTab === "scene" ? "bg-blue-600 text-white" : "border border-slate-200 text-slate-600"}`}
              >
                场景
              </button>
            </div>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              {(materialAssetsByTab[frameModalTab] || []).map(({ asset, imageUrl }) => {
                const selected = frameReferences.some((item) => item.assetId === asset.id);
                return (
                  <button
                    key={asset.id}
                    type="button"
                    onClick={() => toggleFrameReference(asset.id, asset.name, imageUrl)}
                    className={`overflow-hidden rounded-lg border text-left ${selected ? "border-blue-500 ring-2 ring-blue-200" : "border-slate-200"}`}
                  >
                    <img src={imageUrl} alt={asset.name} className="h-24 w-full object-cover bg-slate-100" />
                    <div className="truncate px-2 py-1 text-xs">{asset.name}</div>
                  </button>
                );
              })}
            </div>
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setFrameGenerateTab("first")}
                  className={`rounded px-3 py-1 text-xs ${frameGenerateTab === "first" ? "bg-emerald-600 text-white" : "border border-slate-200 text-slate-600"}`}
                >
                  首帧
                </button>
                <button
                  type="button"
                  onClick={() => setFrameGenerateTab("last")}
                  className={`rounded px-3 py-1 text-xs ${frameGenerateTab === "last" ? "bg-fuchsia-600 text-white" : "border border-slate-200 text-slate-600"}`}
                >
                  尾帧
                </button>
                <label className="ml-1 flex items-center gap-1 text-xs text-slate-600">
                  <span>模型</span>
                  <select
                    value={frameImageModel}
                    onChange={(event) => setFrameImageModel(event.target.value)}
                    className="rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700"
                  >
                    {frameImageModels.map((modelId) => (
                      <option key={modelId} value={modelId}>
                        {modelId}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="relative min-h-[96px] w-full rounded-lg border border-slate-200 px-3 py-2">
                <div
                  ref={frameEditorRef}
                  contentEditable
                  suppressContentEditableWarning
                  onInput={syncFrameEditorState}
                  className="min-h-[80px] w-full whitespace-pre-wrap break-words text-sm outline-none"
                />
                {!framePromptInput && frameReferences.length === 0 ? (
                  <span className="pointer-events-none absolute left-3 top-2 text-sm text-slate-400">
                    输入首尾帧提示词
                  </span>
                ) : null}
              </div>
              <div className="flex items-center gap-2">
                {frameGenerateTab === "first" ? (
                  <button
                    type="button"
                    onClick={() => generateFrameImage("first")}
                    disabled={frameGeneratingType !== null || (frameModalRowIndex !== null && Boolean(framePendingMap[buildFramePendingKey(frameModalRowIndex, "first")]))}
                    className="rounded bg-emerald-600 px-3 py-1.5 text-xs text-white hover:bg-emerald-700 disabled:opacity-50"
                  >
                    {frameGeneratingType === "first" || (frameModalRowIndex !== null && Boolean(framePendingMap[buildFramePendingKey(frameModalRowIndex, "first")])) ? "生成中..." : "生成首帧"}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => generateFrameImage("last")}
                    disabled={frameGeneratingType !== null || (frameModalRowIndex !== null && Boolean(framePendingMap[buildFramePendingKey(frameModalRowIndex, "last")]))}
                    className="rounded bg-fuchsia-600 px-3 py-1.5 text-xs text-white hover:bg-fuchsia-700 disabled:opacity-50"
                  >
                    {frameGeneratingType === "last" || (frameModalRowIndex !== null && Boolean(framePendingMap[buildFramePendingKey(frameModalRowIndex, "last")])) ? "生成中..." : "生成尾帧"}
                  </button>
                )}
                {frameError ? <span className="text-xs text-rose-600">{frameError}</span> : null}
              </div>
            </div>
            <div className="space-y-2">
              <div className="text-xs font-semibold text-slate-600">首帧展示区</div>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                {(frameFirstImageMap[frameModalRowIndex] || []).map((imageUrl) => {
                  const applied = frameAppliedMap[frameModalRowIndex]?.first === imageUrl;
                  const editing = frameEditTarget?.frameType === "first" && frameEditTarget?.imageUrl === imageUrl;
                  return (
                    <div key={`first-${imageUrl}`} className="overflow-hidden rounded-lg border border-slate-200">
                      <img
                        src={imageUrl}
                        alt="首帧"
                        onClick={() => setPreviewFrameUrl(imageUrl)}
                        className="h-28 w-full cursor-zoom-in object-cover bg-slate-100"
                      />
                      <div className="flex items-center justify-end gap-2 p-2">
                        <button
                          type="button"
                          onClick={() => applyFrameForRow(frameModalRowIndex, "first", imageUrl)}
                          className={`rounded px-2 py-1 text-xs ${applied ? "bg-emerald-600 text-white" : "border border-emerald-300 text-emerald-700"}`}
                        >
                          {applied ? "已应用" : "应用"}
                        </button>
                        <button
                          type="button"
                          onClick={() => startFrameEdit("first", imageUrl)}
                          className={`rounded px-2 py-1 text-xs ${editing ? "bg-indigo-600 text-white" : "border border-indigo-300 text-indigo-700"}`}
                        >
                          输入修改意见
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
              {frameEditTarget?.frameType === "first" ? (
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <textarea
                    value={frameEditInput}
                    onChange={(event) => setFrameEditInput(event.target.value)}
                    placeholder="输入对当前首帧图片的修改意见"
                    className="h-20 w-full rounded border border-slate-200 bg-white px-3 py-2 text-sm outline-none"
                  />
                  <div className="mt-2 flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setFrameEditTarget(null);
                        setFrameEditInput("");
                      }}
                      disabled={frameEditing}
                      className="rounded border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      onClick={submitFrameEdit}
                      disabled={frameEditing}
                      className="rounded bg-indigo-600 px-3 py-1.5 text-xs text-white hover:bg-indigo-700 disabled:opacity-50"
                    >
                      {frameEditing ? "修改中..." : "修改图片"}
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
            <div className="space-y-2">
              <div className="text-xs font-semibold text-slate-600">尾帧展示区</div>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                {(frameLastImageMap[frameModalRowIndex] || []).map((imageUrl) => {
                  const applied = frameAppliedMap[frameModalRowIndex]?.last === imageUrl;
                  const editing = frameEditTarget?.frameType === "last" && frameEditTarget?.imageUrl === imageUrl;
                  return (
                    <div key={`last-${imageUrl}`} className="overflow-hidden rounded-lg border border-slate-200">
                      <img
                        src={imageUrl}
                        alt="尾帧"
                        onClick={() => setPreviewFrameUrl(imageUrl)}
                        className="h-28 w-full cursor-zoom-in object-cover bg-slate-100"
                      />
                      <div className="flex items-center justify-end gap-2 p-2">
                        <button
                          type="button"
                          onClick={() => applyFrameForRow(frameModalRowIndex, "last", imageUrl)}
                          className={`rounded px-2 py-1 text-xs ${applied ? "bg-fuchsia-600 text-white" : "border border-fuchsia-300 text-fuchsia-700"}`}
                        >
                          {applied ? "已应用" : "应用"}
                        </button>
                        <button
                          type="button"
                          onClick={() => startFrameEdit("last", imageUrl)}
                          className={`rounded px-2 py-1 text-xs ${editing ? "bg-indigo-600 text-white" : "border border-indigo-300 text-indigo-700"}`}
                        >
                          输入修改意见
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
              {frameEditTarget?.frameType === "last" ? (
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <textarea
                    value={frameEditInput}
                    onChange={(event) => setFrameEditInput(event.target.value)}
                    placeholder="输入对当前尾帧图片的修改意见"
                    className="h-20 w-full rounded border border-slate-200 bg-white px-3 py-2 text-sm outline-none"
                  />
                  <div className="mt-2 flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setFrameEditTarget(null);
                        setFrameEditInput("");
                      }}
                      disabled={frameEditing}
                      className="rounded border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      onClick={submitFrameEdit}
                      disabled={frameEditing}
                      className="rounded bg-indigo-600 px-3 py-1.5 text-xs text-white hover:bg-indigo-700 disabled:opacity-50"
                    >
                      {frameEditing ? "修改中..." : "修改图片"}
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    ) : null}
    {voiceModal ? (
      <div className="fixed inset-0 z-50 overflow-y-auto bg-black/40 px-4 py-6">
        <div className="mx-auto w-full max-w-4xl rounded-2xl border border-slate-200 bg-white shadow-xl">
          <div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-100 bg-white px-5 py-4">
            <div className="text-sm font-semibold text-slate-900">文本转语音</div>
            <button onClick={closeVoiceModal} className="rounded-md px-2 py-1 text-xs text-slate-500 hover:bg-slate-100">关闭</button>
          </div>
          <div className="grid grid-cols-1 gap-4 p-5 lg:grid-cols-[1fr_360px]">
            <div className="space-y-4">
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                <div className="mb-2 text-xs font-semibold text-slate-500">表格内容/台词原文</div>
                <div className="max-h-28 overflow-y-auto whitespace-pre-wrap text-sm text-slate-700">{voiceSourceText || "空"}</div>
              </div>
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold text-slate-800">台词片段</div>
                <button
                  onClick={() => addVoiceSegment("")}
                  className="rounded-lg border border-indigo-200 px-3 py-1.5 text-xs text-indigo-700 hover:bg-indigo-50"
                >
                  + 创建台词
                </button>
              </div>
              <div className="space-y-3 max-h-[420px] overflow-y-auto pr-1">
                {voiceSegments.map((segment, index) => (
                  <div
                    key={segment.id}
                    className={`rounded-xl border p-3 ${
                      activeVoiceSegmentId === segment.id ? "border-indigo-300 bg-indigo-50/30" : "border-slate-200 bg-white"
                    }`}
                  >
                    <div className="mb-2 flex items-center justify-between">
                      <div className="text-xs font-semibold text-slate-600">第 {index + 1} 段</div>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => addVoiceSegment(voiceSourceText)}
                          className="rounded border border-slate-200 px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-50"
                        >
                          复制原文新建
                        </button>
                        <button
                          onClick={() => removeVoiceSegment(segment.id)}
                          disabled={voiceSegments.length <= 1}
                          className="rounded border border-rose-200 px-2 py-1 text-[11px] text-rose-600 hover:bg-rose-50 disabled:opacity-50"
                        >
                          删除
                        </button>
                      </div>
                    </div>
                    <textarea
                      ref={(el) => {
                        voiceTextareaRefs.current[segment.id] = el;
                      }}
                      value={segment.text}
                      onFocus={() => setActiveVoiceSegmentId(segment.id)}
                      onChange={(event) => {
                        updateVoiceSegment(segment.id, event.target.value);
                        requestAnimationFrame(() => syncVoiceSelection(segment.id));
                      }}
                      onSelect={() => syncVoiceSelection(segment.id)}
                      onKeyUp={() => syncVoiceSelection(segment.id)}
                      onMouseUp={() => syncVoiceSelection(segment.id)}
                      className="h-28 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:border-indigo-500"
                      placeholder="在此输入或粘贴本段台词，可在右侧插入标签"
                    />
                    <div className="mt-2 flex items-center justify-between">
                      <div className="text-[11px] text-slate-500">
                        {segment.text.length} 字符 · 已选 {activeVoiceSegmentId === segment.id ? voiceSelection.text.length : 0} 字符
                      </div>
                      <button
                        onClick={() => generateVoiceForSegment(segment.id)}
                        disabled={voiceGeneratingSegmentId === segment.id || !segment.text.trim() || !voiceCharacter}
                        className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs text-white hover:bg-indigo-700 disabled:opacity-50"
                      >
                        {voiceGeneratingSegmentId === segment.id ? "生成中..." : "生成该段语音"}
                      </button>
                    </div>
                    {voiceSegmentAudioMap[segment.id] ? (
                      <audio
                        ref={(el) => {
                          voiceAudioRefs.current[segment.id] = el;
                        }}
                        controls
                        src={voiceSegmentAudioMap[segment.id]}
                        className="mt-2 h-10 w-full"
                      />
                    ) : null}
                  </div>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={applyVoiceTextToCell}
                  disabled={!combinedVoiceText}
                  className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                  应用全部片段到单元格
                </button>
              </div>
              {voiceError ? <div className="text-xs text-rose-600">{voiceError}</div> : null}
            </div>
            <div className="space-y-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
              <div>
                <div className="mb-2 text-xs font-semibold text-slate-700">说话人</div>
                <select
                  value={voiceCharacter}
                  onChange={(event) => setVoiceCharacter(event.target.value)}
                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm"
                >
                  {projectVoices.map((voice) => (
                    <option key={voice.id} value={voice.character_name}>
                      {voice.character_name}
                    </option>
                  ))}
                </select>
                {projectVoices.length === 0 ? (
                  <div className="mt-2 text-[11px] text-amber-600">未检测到角色音色，请先在 Step3 配置。</div>
                ) : null}
              </div>
              <div className="space-y-3 border-t border-slate-200 pt-4">
                <div className="text-xs font-semibold text-slate-700">ElevenLabs 表演标签库</div>
                <div className="grid grid-cols-5 gap-1">
                  {VOICE_TAG_GROUPS.map((group) => (
                    <button
                      key={group.key}
                      onClick={() => setVoiceTagGroupKey(group.key)}
                      className={`rounded px-1.5 py-1 text-[10px] ${
                        voiceTagGroupKey === group.key
                          ? "bg-indigo-600 text-white"
                          : "bg-white text-slate-600 border border-slate-200 hover:bg-slate-100"
                      }`}
                    >
                      {group.title}
                    </button>
                  ))}
                </div>
                <div className="space-y-3 rounded-lg border border-slate-200 bg-white p-2">
                  <div className="rounded-md border border-slate-100 bg-slate-50 p-2">
                    <div className="mb-2 text-[11px] font-medium text-slate-700">强度调节（作用于情绪标签）</div>
                    <div className="grid grid-cols-3 gap-1">
                      {[
                        { key: "slightly" as const, label: "轻微" },
                        { key: "very" as const, label: "明显" },
                        { key: "extremely" as const, label: "极强" },
                      ].map((item) => (
                        <button
                          key={item.key}
                          onClick={() => setVoiceEmotionIntensity(item.key)}
                          className={`rounded px-2 py-1 text-[11px] ${
                            voiceEmotionIntensity === item.key
                              ? "bg-indigo-600 text-white"
                              : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-100"
                          }`}
                        >
                          {item.label}
                        </button>
                      ))}
                    </div>
                    <div className="mt-2 text-[10px] text-slate-500">
                      当前情绪标签示例：({voiceEmotionIntensity} happy)
                    </div>
                  </div>
                  <div className="max-h-[300px] overflow-y-auto space-y-2">
                    {activeTagGroup.tags.map((item) => (
                      <button
                        key={item.tag}
                        onClick={() => insertVoiceTag(item.tag)}
                        className="w-full rounded border border-violet-200 bg-violet-50 px-2 py-1.5 text-left hover:bg-violet-100"
                      >
                        <div className="text-[11px] font-medium text-violet-800">{item.label} {item.tag}</div>
                        <div className="text-[10px] text-violet-600">{item.desc}</div>
                      </button>
                    ))}
                  </div>
                </div>
                <div className="space-y-2 rounded-lg border border-slate-200 bg-white p-2">
                  <div className="text-[11px] font-medium text-slate-700">重音</div>
                  <div className="grid grid-cols-3 gap-1">
                    {[
                      { key: "slight" as const, label: "轻重音", tag: "[slight emphasis]" },
                      { key: "normal" as const, label: "标准", tag: "[emphasis]" },
                      { key: "strong" as const, label: "强重音", tag: "[strong emphasis]" },
                    ].map((item) => (
                      <button
                        key={item.key}
                        onClick={() => setVoiceAccentLevel(item.key)}
                        className={`rounded px-2 py-1 text-[11px] ${
                          voiceAccentLevel === item.key
                            ? "bg-indigo-600 text-white"
                            : "border border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100"
                        }`}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                  <div className="flex items-center justify-between">
                    <div className="text-[10px] text-slate-500">
                      当前重音标签：{voiceAccentLevel === "slight" ? "[slight emphasis]" : voiceAccentLevel === "strong" ? "[strong emphasis]" : "[emphasis]"}
                    </div>
                    <button
                      onClick={insertAccentTag}
                      className="rounded border border-indigo-200 px-2 py-1 text-[11px] text-indigo-700 hover:bg-indigo-50"
                    >
                      插入重音
                    </button>
                  </div>
                </div>
                <div className="space-y-2 rounded-lg border border-slate-200 bg-white p-2">
                  <div className="text-[11px] font-medium text-slate-700">自定义停顿</div>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={0.2}
                      max={8}
                      step={0.1}
                      value={voicePauseSeconds}
                      onChange={(event) => setVoicePauseSeconds(Number(event.target.value))}
                      className="w-20 rounded border border-slate-200 px-2 py-1 text-[11px] text-slate-700"
                    />
                    <span className="text-[11px] text-slate-500">秒</span>
                    <button
                      onClick={insertCustomPause}
                      className="rounded border border-indigo-200 px-2 py-1 text-[11px] text-indigo-700 hover:bg-indigo-50"
                    >
                      插入停顿
                    </button>
                  </div>
                  <div className="text-[10px] text-slate-500">
                    将插入 (pause:{Math.max(0.2, Math.min(8, voicePauseSeconds || 1.2)).toFixed(1)}s)，后端会转换为停顿控制标签。
                  </div>
                </div>
                <div className="text-[11px] text-slate-500">
                  先点击某个“台词片段”输入框，再点标签即可插入到该片段光标或选中位置。
                </div>
              </div>
              <div className="space-y-3 border-t border-slate-200 pt-4">
                <div className="text-xs font-semibold text-slate-700">ElevenLabs 全量调节项</div>
                <div className="grid grid-cols-1 gap-2">
                  <select value={voiceModelId} onChange={(event) => setVoiceModelId(event.target.value)} className="w-full rounded border border-slate-200 px-2 py-1.5 text-xs">
                    {ELEVEN_MODELS.map((item) => (
                      <option key={item.value} value={item.value}>{item.label}</option>
                    ))}
                  </select>
                  <select value={voiceOutputFormat} onChange={(event) => setVoiceOutputFormat(event.target.value)} className="w-full rounded border border-slate-200 px-2 py-1.5 text-xs">
                    {ELEVEN_OUTPUT_FORMATS.map((item) => (
                      <option key={item.value} value={item.value}>{item.label}</option>
                    ))}
                  </select>
                  <select value={voiceLanguageCode} onChange={(event) => setVoiceLanguageCode(event.target.value)} className="w-full rounded border border-slate-200 px-2 py-1.5 text-xs">
                    {ELEVEN_LANGUAGE_OPTIONS.map((item) => (
                      <option key={item.value || "auto"} value={item.value}>{item.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <div className="mb-1 flex items-center justify-between text-[11px] text-slate-700">
                    <span>语速</span>
                    <span>{voiceSpeed.toFixed(2)}</span>
                  </div>
                  <input type="range" min={0.7} max={1.2} step={0.01} value={voiceSpeed} onChange={(event) => setVoiceSpeed(Number(event.target.value))} className="w-full accent-indigo-600" />
                </div>
                <div>
                  <div className="mb-1 flex items-center justify-between text-[11px] text-slate-700">
                    <span>稳定性</span>
                    <span>{voiceStability.toFixed(2)}</span>
                  </div>
                  <input type="range" min={0} max={1} step={0.01} value={voiceStability} onChange={(event) => setVoiceStability(Number(event.target.value))} className="w-full accent-indigo-600" />
                </div>
                <div>
                  <div className="mb-1 flex items-center justify-between text-[11px] text-slate-700">
                    <span>相似度增强</span>
                    <span>{voiceSimilarityBoost.toFixed(2)}</span>
                  </div>
                  <input type="range" min={0} max={1} step={0.01} value={voiceSimilarityBoost} onChange={(event) => setVoiceSimilarityBoost(Number(event.target.value))} className="w-full accent-indigo-600" />
                </div>
                <div>
                  <div className="mb-1 flex items-center justify-between text-[11px] text-slate-700">
                    <span>风格夸张度</span>
                    <span>{voiceStyle.toFixed(2)}</span>
                  </div>
                  <input type="range" min={0} max={1} step={0.01} value={voiceStyle} onChange={(event) => setVoiceStyle(Number(event.target.value))} className="w-full accent-indigo-600" />
                </div>
                <label className="flex items-center gap-2 text-[11px] text-slate-700">
                  <input type="checkbox" checked={voiceUseSpeakerBoost} onChange={(event) => setVoiceUseSpeakerBoost(event.target.checked)} />
                  启用 Speaker Boost
                </label>
                <input value={voiceSeed} onChange={(event) => setVoiceSeed(event.target.value)} className="w-full rounded border border-slate-200 px-2 py-1.5 text-xs" placeholder="随机种子 seed（可选整数）" />
                <textarea value={voicePreviousText} onChange={(event) => setVoicePreviousText(event.target.value)} className="h-14 w-full rounded border border-slate-200 px-2 py-1.5 text-xs" placeholder="上一段上下文 previous_text（可选）" />
                <textarea value={voiceNextText} onChange={(event) => setVoiceNextText(event.target.value)} className="h-14 w-full rounded border border-slate-200 px-2 py-1.5 text-xs" placeholder="下一段上下文 next_text（可选）" />
                <div className="space-y-2 rounded border border-slate-200 bg-white p-2">
                  <div className="text-[11px] font-medium text-slate-700">发音控制（逐词替换）</div>
                  {voicePronunciationRules.map((item) => (
                    <div key={item.id} className="grid grid-cols-12 gap-1">
                      <input value={item.source} onChange={(event) => updatePronunciationRule(item.id, "source", event.target.value)} className="col-span-5 rounded border border-slate-200 px-2 py-1 text-[11px]" placeholder="原词" />
                      <input value={item.target} onChange={(event) => updatePronunciationRule(item.id, "target", event.target.value)} className="col-span-5 rounded border border-slate-200 px-2 py-1 text-[11px]" placeholder="替换发音文本/IPA" />
                      <button onClick={() => removePronunciationRule(item.id)} className="col-span-2 rounded border border-rose-200 px-2 py-1 text-[11px] text-rose-600">删</button>
                    </div>
                  ))}
                  <button onClick={addPronunciationRule} className="w-full rounded border border-slate-200 px-2 py-1 text-[11px] text-slate-700">新增发音规则</button>
                </div>
                <input value={voicePronunciationDictId} onChange={(event) => setVoicePronunciationDictId(event.target.value)} className="w-full rounded border border-slate-200 px-2 py-1.5 text-xs" placeholder="Pronunciation Dictionary ID（可选）" />
                <input value={voicePronunciationDictVersion} onChange={(event) => setVoicePronunciationDictVersion(event.target.value)} className="w-full rounded border border-slate-200 px-2 py-1.5 text-xs" placeholder="Dictionary Version ID（可选）" />
              </div>
            </div>
          </div>
        </div>
      </div>
    ) : null}
    </>
  );
}

function TableCell({
  value,
  onChange,
  projectId,
  projectAssets,
  columnHeader,
}: {
  value: string;
  onChange: (v: string) => void;
  projectId?: string;
  projectAssets?: Asset[];
  columnHeader?: string;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewTitle, setPreviewTitle] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selectedPickerIds, setSelectedPickerIds] = useState<string[]>([]);
  const normalizeAssetKey = React.useCallback((input: string) => {
    return (input || "")
      .trim()
      .replace(/[（(][^）)]*[）)]/g, "")
      .replace(/[\s【】\[\]{}《》<>:：,，。.!！?？、·|｜/\\_-]/g, "")
      .toLowerCase();
  }, []);
  const preferredAssetTypes = React.useMemo(() => {
    const text = (columnHeader || "").replace(/\s+/g, "");
    if (text.includes("角色形象") || text === "形象") return ["CHARACTER_LOOK"];
    if (text.includes("道具")) return ["PROP"];
    if (text.includes("场景")) return ["SCENE"];
    if (text.includes("角色")) return ["CHARACTER", "CHARACTER_LOOK"];
    return null;
  }, [columnHeader]);
  const pickerAssetType = React.useMemo(() => {
    const text = (columnHeader || "").replace(/\s+/g, "");
    if (text.includes("角色形象") || text === "形象") return "CHARACTER_LOOK";
    if (text.includes("道具")) return "PROP";
    if (text.includes("场景")) return "SCENE";
    return null;
  }, [columnHeader]);
  const enableAssetBindingAssist = React.useMemo(() => {
    const text = (columnHeader || "").replace(/\s+/g, "");
    if (!text) return false;
    return text.includes("角色形象") || text === "形象" || text.includes("道具") || text.includes("场景") || text.includes("角色");
  }, [columnHeader]);
  const resolveAssetImageUrl = React.useCallback((asset: Asset) => {
    const versions = asset.versions || [];
    const selectedVersion = versions.find((v) => v.is_selected && Boolean((v.image_url || "").trim()));
    if (selectedVersion?.image_url) return String(selectedVersion.image_url).trim();
    const latestVersion = [...versions].reverse().find((v) => Boolean((v.image_url || "").trim()));
    if (latestVersion?.image_url) return String(latestVersion.image_url).trim();
    return "";
  }, []);

  const { displayText, assetRefs } = React.useMemo(() => {
    const normalizeMarkdownText = (input: string) =>
      String(input || "")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/\\n/g, "\n")
        .replace(/\\\\/g, "\n");

    const assetTagRegex = /\[AssetID:\s*([^\]]+)\]/g;
    const refs: Array<{ raw: string; id?: string; name: string }> = [];
    const seenRefKey = new Set<string>();
    const trimmedValue = normalizeMarkdownText(value || "");
    if (!enableAssetBindingAssist) {
      return { displayText: trimmedValue, assetRefs: refs };
    }
    const allAssets = projectAssets || [];
    const typeFiltered =
      preferredAssetTypes && preferredAssetTypes.length > 0
        ? allAssets.filter((asset) => preferredAssetTypes.includes(asset.type))
        : allAssets;
    const searchPool = typeFiltered.length > 0 ? typeFiltered : allAssets;
    const findAssetByRaw = (raw: string) => {
      const rawKey = normalizeAssetKey(raw);
      const exactById = searchPool.find((asset) => asset.id === raw) || allAssets.find((asset) => asset.id === raw);
      if (exactById) return exactById;
      const scored = searchPool
        .map((asset) => {
          const versions = asset.versions || [];
          const selectedVersion = versions.find((v) => v.is_selected && Boolean((v.image_url || "").trim()));
          const latestVersion = [...versions].reverse().find((v) => Boolean((v.image_url || "").trim()));
          const hasImage = Boolean(latestVersion);
          const assetKey = normalizeAssetKey(asset.name);
          let nameMatchScore = 0;
          if (asset.name.trim() === raw) nameMatchScore = Math.max(nameMatchScore, 120);
          if (assetKey && rawKey && assetKey === rawKey) nameMatchScore = Math.max(nameMatchScore, 100);
          if (nameMatchScore <= 0) {
            return { asset, score: 0 };
          }
          let score = nameMatchScore;
          if (preferredAssetTypes?.includes(asset.type)) score += 40;
          if (hasImage) score += 30;
          if (selectedVersion?.image_url) score += 10;
          return { asset, score };
        })
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score);
      return scored[0]?.asset;
    };
    const pushRef = (raw: string) => {
      const text = String(raw || "").trim();
      if (!text) return;
      const byName = findAssetByRaw(text);
      const refKey = `${byName?.id || ""}:${text}`;
      if (seenRefKey.has(refKey)) return;
      seenRefKey.add(refKey);
      refs.push({
        raw: text,
        id: byName?.id,
        name: byName?.name || text,
      });
    };

    let match: RegExpExecArray | null;
    while ((match = assetTagRegex.exec(trimmedValue)) !== null) {
      pushRef((match[1] || "").trim());
    }

    const text = trimmedValue.replace(assetTagRegex, "").trim();
    return { displayText: text, assetRefs: refs };
  }, [enableAssetBindingAssist, normalizeAssetKey, preferredAssetTypes, projectAssets, value]);
  const pickerAssetData = React.useMemo<{
    items: Array<{ id: string; name: string; hasImage: boolean; imageUrl: string }>;
    canonicalIdBySourceId: Map<string, string>;
  }>(() => {
    const canonicalIdBySourceId = new Map<string, string>();
    if (!enableAssetBindingAssist || !pickerAssetType || !projectAssets || projectAssets.length === 0) {
      return { items: [], canonicalIdBySourceId };
    }
    const grouped = new Map<
      string,
      {
        id: string;
        name: string;
        hasImage: boolean;
        imageUrl: string;
        score: number;
        sourceIds: string[];
      }
    >();
    projectAssets
      .filter((asset) => {
        if (asset.type !== pickerAssetType) return false;
        return Boolean(resolveAssetImageUrl(asset));
      })
      .forEach((asset) => {
        const versions = asset.versions || [];
        const resolvedImageUrl = resolveAssetImageUrl(asset);
        const hasImage = Boolean(resolvedImageUrl);
        const score = (hasImage ? 100 : 0) + Math.min(versions.length, 10);
        const groupKey = `${asset.type}:${normalizeAssetKey(asset.name) || asset.id}`;
        const existing = grouped.get(groupKey);
        if (!existing || score > existing.score) {
          grouped.set(groupKey, {
            id: asset.id,
            name: asset.name,
            hasImage,
            imageUrl: resolvedImageUrl || (projectId ? `/api/projects/${projectId}/assets/${asset.id}/image` : ""),
            score,
            sourceIds: existing ? [...existing.sourceIds, asset.id] : [asset.id],
          });
        } else {
          existing.sourceIds.push(asset.id);
        }
      });
    const items = Array.from(grouped.values())
      .map((item) => ({
        id: item.id,
        name: item.name,
        hasImage: item.hasImage,
        imageUrl: item.imageUrl,
      }))
      .sort((a, b) => {
        if (a.hasImage !== b.hasImage) return a.hasImage ? -1 : 1;
        return a.name.localeCompare(b.name, "zh-CN");
      });
    grouped.forEach((item) => {
      item.sourceIds.forEach((sourceId) => {
        canonicalIdBySourceId.set(sourceId, item.id);
      });
    });
    return { items, canonicalIdBySourceId };
  }, [enableAssetBindingAssist, normalizeAssetKey, pickerAssetType, projectAssets, projectId, resolveAssetImageUrl]);
  const pickerAssets = pickerAssetData.items;

  const assetImages = React.useMemo(() => {
    if (assetRefs.length === 0 || !projectAssets || projectAssets.length === 0) {
      return [];
    }
    const selectedImages: { id: string; url: string; name: string }[] = [];
    const idSet = new Set(assetRefs.map((item) => item.id).filter((id): id is string => Boolean(id)));
    for (const asset of projectAssets) {
      if (!idSet.has(asset.id)) continue;
      const imageUrl = resolveAssetImageUrl(asset);
      if (!imageUrl) continue;
      selectedImages.push({
        id: asset.id,
        name: asset.name,
        url: imageUrl,
      });
    }
    return selectedImages;
  }, [assetRefs, projectAssets, resolveAssetImageUrl]);
  const openPicker = React.useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (!pickerAssetType) return;
    const currentIds = Array.from(
      new Set(
        assetRefs
          .map((item) => item.id)
          .filter((id): id is string => Boolean(id))
          .map((id) => pickerAssetData.canonicalIdBySourceId.get(id) || id)
      )
    );
    setSelectedPickerIds(currentIds);
    setPickerOpen(true);
  }, [assetRefs, pickerAssetData.canonicalIdBySourceId, pickerAssetType]);
  const togglePickerAsset = React.useCallback((assetId: string) => {
    setSelectedPickerIds((prev) => {
      if (prev.includes(assetId)) {
        return prev.filter((id) => id !== assetId);
      }
      return [...prev, assetId];
    });
  }, []);
  const applyPickerSelection = React.useCallback(() => {
    const selectedTaggedLines = selectedPickerIds
      .map((id) => {
        const item = pickerAssets.find((asset) => asset.id === id);
        if (!item) return "";
        return `${item.name} [AssetID: ${item.id}]`;
      })
      .filter(Boolean);
    const pickerNameKeySet = new Set(pickerAssets.map((item) => normalizeAssetKey(item.name)));
    const baseLines = String(value || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => {
        if (!line) return false;
        if (/\[AssetID:\s*[^\]]+\]/i.test(line)) return false;
        return !pickerNameKeySet.has(normalizeAssetKey(line));
      });
    const nextLines = [...baseLines, ...selectedTaggedLines];
    onChange(nextLines.join("\n"));
    setPickerOpen(false);
  }, [normalizeAssetKey, onChange, pickerAssets, selectedPickerIds, value]);

  if (isEditing) {
    return (
      <AutoResizeTextarea
        autoFocus
        value={value}
        onChange={(v) => onChange(v)}
        onBlur={() => setIsEditing(false)}
        className="w-full bg-transparent border border-blue-200 rounded p-1 text-slate-700 resize-none overflow-hidden min-h-[24px] leading-relaxed focus:outline-none focus:ring-1 focus:ring-blue-500"
      />
    );
  }

  return (
    <>
      <div 
        onClick={() => setIsEditing(true)}
        className="min-h-[24px] cursor-text"
      >
        {enableAssetBindingAssist && pickerAssetType ? (
          <div className="mb-1">
            <button
              type="button"
              onClick={openPicker}
              className="rounded border border-blue-200 px-2 py-0.5 text-xs text-blue-600 hover:bg-blue-50"
            >
              选择素材
            </button>
          </div>
        ) : null}
        <div className="text-slate-700 leading-relaxed">
          {displayText ? (
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                p: ({ children }) => <p className="whitespace-pre-wrap mb-1 last:mb-0">{children}</p>,
                strong: ({ children }) => <strong className="font-semibold text-slate-800">{children}</strong>,
                ul: ({ children }) => <ul className="list-disc pl-5 space-y-1">{children}</ul>,
                ol: ({ children }) => <ol className="list-decimal pl-5 space-y-1">{children}</ol>,
                li: ({ children }) => <li className="whitespace-pre-wrap">{children}</li>,
              }}
            >
              {displayText}
            </ReactMarkdown>
          ) : <span className="text-slate-300 italic">空</span>}
        </div>

        {enableAssetBindingAssist && assetRefs.length > 0 ? (
          <div className="mt-1 flex flex-wrap gap-2">
            {assetRefs.map((assetRef, index) => {
              const image = assetRef.id ? assetImages.find((item) => item.id === assetRef.id) : undefined;
              const clickable = Boolean(image?.url);
              return (
                <button
                  key={`${assetRef.raw}-${index}`}
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    if (!clickable || !image) return;
                    setPreviewTitle(assetRef.name);
                    setPreviewUrl(image.url);
                  }}
                  className={`text-xs ${clickable ? "text-blue-600 hover:text-blue-700 underline underline-offset-2" : "text-slate-400"}`}
                >
                  {assetRef.name}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>

      {previewUrl ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setPreviewUrl(null)}>
          <div className="max-w-3xl rounded-xl bg-white p-3" onClick={(event) => event.stopPropagation()}>
            <div className="mb-2 text-sm font-medium text-slate-700">{previewTitle}</div>
            <Image src={previewUrl} alt={previewTitle} width={960} height={960} className="h-auto w-full rounded-lg border border-slate-200" unoptimized />
          </div>
        </div>
      ) : null}

      {pickerOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setPickerOpen(false)}>
          <div className="w-full max-w-4xl rounded-xl bg-white p-4" onClick={(event) => event.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <div className="text-sm font-medium text-slate-800">
                {pickerAssetType === "CHARACTER_LOOK" ? "选择角色形象素材" : pickerAssetType === "PROP" ? "选择道具素材" : "选择场景素材"}
              </div>
              <button type="button" onClick={() => setPickerOpen(false)} className="text-xs text-slate-500 hover:text-slate-700">
                关闭
              </button>
            </div>
            <div className="max-h-[60vh] overflow-y-auto rounded-lg border border-slate-200">
              {pickerAssets.length === 0 ? (
                <div className="p-6 text-center text-sm text-slate-500">暂无可选素材</div>
              ) : (
                <div className="grid grid-cols-1 gap-3 p-3 md:grid-cols-2">
                  {pickerAssets.map((asset) => {
                    const checked = selectedPickerIds.includes(asset.id);
                    return (
                      <button
                        key={asset.id}
                        type="button"
                        onClick={() => togglePickerAsset(asset.id)}
                        className={`flex items-center gap-3 rounded-lg border p-2 text-left ${checked ? "border-blue-400 bg-blue-50" : "border-slate-200 hover:border-slate-300"}`}
                      >
                        <div className="h-16 w-16 shrink-0 overflow-hidden rounded bg-slate-100">
                          {asset.hasImage && asset.imageUrl ? (
                            <Image src={asset.imageUrl} alt={asset.name} width={96} height={96} className="h-full w-full object-cover" unoptimized />
                          ) : (
                            <div className="flex h-full w-full items-center justify-center text-[10px] text-slate-400">无图</div>
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-slate-700">{asset.name}</div>
                          <div className="mt-1 truncate text-[11px] text-slate-400">{asset.id}</div>
                        </div>
                        <input type="checkbox" readOnly checked={checked} className="h-4 w-4 accent-blue-600" />
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="mt-3 flex justify-end gap-2">
              <button type="button" onClick={() => setPickerOpen(false)} className="rounded border border-slate-200 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50">
                取消
              </button>
              <button type="button" onClick={applyPickerSelection} className="rounded bg-blue-600 px-3 py-1.5 text-xs text-white hover:bg-blue-700">
                添加所选素材
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

function AutoResizeTextarea({ value, onChange, className, ...props }: { value: string, onChange: (v: string) => void, className?: string } & Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'onChange'>) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const adjustHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${textarea.scrollHeight}px`;
    }
  }, []);

  useEffect(() => {
    adjustHeight();
  }, [value, adjustHeight]);

  // Adjust on mount and window resize
  useEffect(() => {
    adjustHeight();
    window.addEventListener('resize', adjustHeight);
    return () => window.removeEventListener('resize', adjustHeight);
  }, [adjustHeight]);

  return (
    <textarea
      ref={textareaRef}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={className}
      rows={1}
      {...props}
    />
  );
}

function TextBlock({ value, onChange }: { value: string, onChange: (v: string) => void }) {
  const [isEditing, setIsEditing] = useState(false);

  if (isEditing) {
    return (
      <div className="p-4 border-b border-slate-100 last:border-0 relative group">
        <AutoResizeTextarea
          autoFocus
          value={value}
          onChange={onChange}
          onBlur={() => setIsEditing(false)}
          className="w-full min-h-[100px] resize-none outline-none text-slate-700 leading-relaxed font-mono text-sm bg-slate-50 p-2 rounded overflow-hidden"
          placeholder="输入剧本内容..."
        />
      </div>
    );
  }

  return (
    <div 
      onClick={() => setIsEditing(true)}
      className="p-4 border-b border-slate-100 last:border-0 cursor-text min-h-[50px] hover:bg-slate-50 transition-colors"
    >
      {value.split('\n').map((line, i) => {
         const trimmed = line.trim();
         // Headers
         if (trimmed.startsWith('# ')) return <h1 key={i} className="text-2xl font-bold mb-4 text-slate-900">{trimmed.substring(2)}</h1>;
         if (trimmed.startsWith('## ')) return <h2 key={i} className="text-xl font-bold mb-3 text-slate-800">{trimmed.substring(3)}</h2>;
         if (trimmed.startsWith('### ')) return <h3 key={i} className="text-lg font-bold mb-2 text-slate-800">{trimmed.substring(4)}</h3>;
         
         // List items
         if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
           return (
             <div key={i} className="flex items-start mb-1 ml-4">
               <span className="mr-2">•</span>
               <span>{renderInlineMarkdown(trimmed.substring(2))}</span>
             </div>
           );
         }

         // Empty lines
         if (!trimmed) return <div key={i} className="h-4"></div>;

         // Regular paragraph
         return (
           <div key={i} className="mb-2 text-slate-700 leading-relaxed">
             {renderInlineMarkdown(line)}
           </div>
         );
      })}
    </div>
  );
}

function renderInlineMarkdown(text: string) {
  // Simple bold parsing: **text**
  const parts = text.split(/(\*\*.*?\*\*)/g);
  return parts.map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={index} className="font-bold text-slate-900">{part.slice(2, -2)}</strong>;
    }
    return part;
  });
}
