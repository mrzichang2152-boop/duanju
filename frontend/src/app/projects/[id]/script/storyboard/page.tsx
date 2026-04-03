"use client";

import { useEffect, useMemo, useState, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import { deleteSegmentVersion, generateSegment, getAssets, getScript, getSegments, getStoryboardTaskStatus, mergeEpisodeOnServer, saveScript, selectSegmentVersion, startStoryboardTask, type Asset, type Episode, type Segment, type SegmentVersion } from "@/lib/api";
import { getToken } from "@/lib/auth";
import { ScriptEditor } from "@/app/components/ScriptEditor";

const SEPARATOR = "\n\n=== 原文剧本 (请勿删除此行) ===\n\n";

const STYLE_OPTIONS = [
  "真人电影写实", "3D 写实渲染", "3D 超写实渲染", "3D 虚幻引擎风", "3D 游戏 CG",
  "3D 半写实", "3D 皮克斯风", "3D 迪士尼风", "3D 萌系 Q 版", "3D 粘土风",
  "3D 三渲二", "3D Low Poly", "2D 动画", "2D 日式动漫", "2D 国漫风",
  "2D 美式卡通", "2D Q 版卡通", "2D 水彩油画", "2D 水墨国风", "2D 赛博风格",
];

const STYLE_PROMPT_MAP: Record<string, string> = Object.fromEntries(
  STYLE_OPTIONS.map((style) => [style, `全局视觉风格：${style}。请保持整集分镜在美术气质、光影语气、镜头审美上的统一。`])
);
const KLING_COLUMN = "视频生成";
const LEGACY_KLING_COLUMN = "Kling视频生成";
const STEP4_VIDEO_MODEL_OPTIONS = [
  { value: "klingv3omni", label: "Kling v3 Omni" },
  { value: "seedance2.0", label: "Seedance 2.0" },
] as const;
type Step4VideoModel = (typeof STEP4_VIDEO_MODEL_OPTIONS)[number]["value"];

function resolveStep4VideoModel(model: Step4VideoModel): string {
  if (model === "klingv3omni") return "kling-v3-omni";
  return "doubao-seedance-2-0-260128";
}
const TABLE_HEADER_KEYWORDS = ["时间轴", "镜头", "景别", "机位", "运镜", "内容", "台词", "画面", "提示词", "prompt", "角色", "场景", "道具", "备注"];
const COLUMN_MEANING_MAP: Record<string, string> = {
  时间轴: "镜头在整段视频中的时间位置与节奏",
  镜头调度与内容融合: "起始、过程、定格画面一体化的镜头与内容指令",
  镜头景别与机位: "镜头远近、视角和机位关系",
  运镜手法: "镜头运动方式与运动路径",
  "内容/台词": "该镜头中人物动作、对白与叙事信息",
  画面描述: "画面主体、环境、构图、光影与氛围",
  定格画面: "镜头结束瞬间的画面终态与下镜头衔接锚点",
  角色形象: "角色外观与服装造型的视觉约束",
  形象: "角色或主体参考形象信息",
  道具: "需要出现并保持一致的道具元素",
  场景: "拍摄场景、空间结构与环境状态",
  备注: "补充的导演要求与约束条件",
};
const VIDEO_FIELD_ORDER = ["时间轴", "镜头调度与内容融合", "画面描述", "角色形象", "道具", "场景", "备注", "镜头景别与机位", "运镜手法", "内容/台词", "定格画面"] as const;

type KlingAssetRole = "character" | "scene" | "prop" | "first_frame";
type EpisodeWithVersions = Episode & {
  versions?: Array<{ id?: string; content?: string }>;
  currentVersionId?: string;
};
type Step5PersistState = {
  mergedVideoUrlMap?: Record<number, string>;
};
type ManualPendingRowState = {
  segmentId: string;
  baseVersionIds: string[];
  submittedAt: number;
};

const getManualPendingStorageKey = (projectId: string) => `storyboard-manual-pending-v1:${projectId}`;
const STORYBOARD_TASK_PENDING_MAX_AGE_MS = 60 * 60 * 1000;
const getStoryboardTaskPendingStorageKey = (projectId: string) => `storyboard-task-pending-v1:${projectId}`;

type StoryboardPendingTaskState = {
  episodeIndex: number;
  episodeTitle: string;
  taskId: string;
  startedAt: number;
};

function readStoryboardPendingTasks(projectId: string): Record<number, StoryboardPendingTaskState> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(getStoryboardTaskPendingStorageKey(projectId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, StoryboardPendingTaskState>;
    const now = Date.now();
    const next: Record<number, StoryboardPendingTaskState> = {};
    Object.entries(parsed || {}).forEach(([key, value]) => {
      const episodeIndex = Number(key);
      const taskId = String(value?.taskId || "").trim();
      if (Number.isNaN(episodeIndex) || !taskId) return;
      const startedAt = Number(value?.startedAt || 0);
      if (!startedAt || now - startedAt > STORYBOARD_TASK_PENDING_MAX_AGE_MS) return;
      next[episodeIndex] = {
        episodeIndex,
        episodeTitle: String(value?.episodeTitle || `第${episodeIndex + 1}集`),
        taskId,
        startedAt,
      };
    });
    return next;
  } catch {
    return {};
  }
}

function writeStoryboardPendingTasks(projectId: string, value: Record<number, StoryboardPendingTaskState>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(getStoryboardTaskPendingStorageKey(projectId), JSON.stringify(value));
  } catch {}
}

function extractAssetTokensFromCell(cell: string) {
  const regex = /\[AssetID:\s*([^\]]+)\]/g;
  const tokens: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(cell)) !== null) {
    if (match[1]) tokens.push(match[1].trim());
  }
  return tokens;
}

function extractImageUrlsFromCell(cell: string) {
  const markdownRegex = /!\[.*?\]\((.*?)\)/g;
  const urls: string[] = [];
  let markdownMatch: RegExpExecArray | null;
  while ((markdownMatch = markdownRegex.exec(cell)) !== null) {
    if (markdownMatch[1]) urls.push(markdownMatch[1].trim());
  }
  const plainUrlRegex = /(https?:\/\/[^\s)]+)/g;
  let plainMatch: RegExpExecArray | null;
  while ((plainMatch = plainUrlRegex.exec(cell)) !== null) {
    if (plainMatch[1]) urls.push(plainMatch[1].trim());
  }
  return Array.from(new Set(urls.filter(Boolean)));
}

function resolveAssetIdsFromCell(cell: string, assets: Asset[], _role?: KlingAssetRole) {
  const tokens = extractAssetTokensFromCell(cell);
  const resolved: string[] = [];
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  tokens.forEach((token) => {
    const text = String(token || "").trim();
    if (!text) return;
    const exact = assets.find((asset) => asset.id === text);
    if (exact?.id) {
      resolved.push(exact.id);
      return;
    }
    if (uuidRegex.test(text)) {
      resolved.push(text);
    }
  });
  return Array.from(new Set(resolved));
}

function mapHeaderToAssetRole(header: string): KlingAssetRole | null {
  const normalized = header.replace(/\s/g, "");
  if (normalized.includes("首帧") || normalized.includes("首位帧") || normalized.includes("起始帧")) return "first_frame";
  if (normalized.includes("角色") || normalized === "形象") return "character";
  if (normalized.includes("场景")) return "scene";
  if (normalized.includes("道具")) return "prop";
  return null;
}

function getSelectedOrLatestSegmentVideoUrl(segment?: Segment) {
  const versions = segment?.versions || [];
  if (versions.length === 0) return "";
  const selected = versions.find((version) => version.is_selected && version.video_url);
  if (selected?.video_url) return selected.video_url;
  const completedWithVideo = versions.filter((version) => isKlingCompletedStatus(version.status) && version.video_url);
  if (completedWithVideo.length > 0) return completedWithVideo[0].video_url;
  const latestWithVideo = versions.find((version) => Boolean(version.video_url));
  return latestWithVideo?.video_url || "";
}

function resolveBackendMediaUrl(url: string) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  
  // Use current origin if available (client side), or fallback
  if (typeof window !== "undefined") {
    return `${window.location.origin}${raw.startsWith('/') ? '' : '/'}${raw}`;
  }
  
  // Server-side fallback
  const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3000/api";
  const backendBase = apiBase.endsWith("/api") ? apiBase.slice(0, -4) : apiBase;
  return `${backendBase}${raw.startsWith('/') ? '' : '/'}${raw}`;
}

function normalizeHeaderForMatch(header: string) {
  return (header || "").replace(/\s+/g, "").toLowerCase();
}

function isVideoGenerateHeader(header: string) {
  const normalized = (header || "").replace(/\s+/g, "");
  return normalized === KLING_COLUMN || normalized === LEGACY_KLING_COLUMN || normalized === "生成视频";
}

function findFieldIndex(headers: string[], field: string) {
  const normalizedHeaders = headers.map((h) => normalizeHeaderForMatch(h));
  if (field === "时间轴") {
    return normalizedHeaders.findIndex((h) => h.includes("时间轴") || h.includes("时长"));
  }
  if (field === "镜头景别与机位") {
    return normalizedHeaders.findIndex((h) => (h.includes("镜头") || h.includes("景别")) && h.includes("机位"));
  }
  if (field === "运镜手法") {
    return normalizedHeaders.findIndex((h) => h.includes("运镜"));
  }
  if (field === "内容/台词") {
    return normalizedHeaders.findIndex((h) => h.includes("内容") || h.includes("台词") || h.includes("对白"));
  }
  if (field === "画面描述") {
    return normalizedHeaders.findIndex((h) => h.includes("画面") || h.includes("提示词") || h.includes("prompt"));
  }
  if (field === "角色形象") {
    return normalizedHeaders.findIndex((h) => h.includes("角色形象") || h === "形象" || h.includes("角色"));
  }
  if (field === "道具") {
    return normalizedHeaders.findIndex((h) => h.includes("道具"));
  }
  if (field === "场景") {
    return normalizedHeaders.findIndex((h) => h.includes("场景"));
  }
  if (field === "备注") {
    return normalizedHeaders.findIndex((h) => h.includes("备注"));
  }
  return -1;
}

function parseDurationFromTimeline(text: string) {
  const value = (text || "").trim();
  if (!value) return 5;
  const parseTimestampToken = (token: string) => {
    const clean = (token || "").trim();
    if (!clean.includes(":")) return Number.NaN;
    const parts = clean.split(":").map((item) => Number(item));
    if (parts.some((item) => !Number.isFinite(item) || item < 0)) return Number.NaN;
    if (parts.length === 2) {
      return parts[0] * 60 + parts[1];
    }
    if (parts.length === 3) {
      return parts[0] * 3600 + parts[1] * 60 + parts[2];
    }
    return Number.NaN;
  };
  const timestampRangeMatch = value.match(/(\d{1,2}:\d{1,2}(?::\d{1,2})?)\s*[-~—–至到]+\s*(\d{1,2}:\d{1,2}(?::\d{1,2})?)/);
  if (timestampRangeMatch) {
    const start = parseTimestampToken(timestampRangeMatch[1]);
    const end = parseTimestampToken(timestampRangeMatch[2]);
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      return end - start;
    }
  }
  const rangeMatch = value.match(/(\d+(?:\.\d+)?)\s*(?:s|秒)?\s*[-~—–至到]+\s*(\d+(?:\.\d+)?)\s*(?:s|秒)?/i);
  if (rangeMatch) {
    const start = Number(rangeMatch[1]);
    const end = Number(rangeMatch[2]);
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      return end - start;
    }
  }
  const singleMatch = value.match(/(\d+(?:\.\d+)?)\s*(?:s|秒)/i);
  if (singleMatch) {
    const single = Number(singleMatch[1]);
    if (Number.isFinite(single) && single > 0) return single;
  }
  return 5;
}

function normalizeKlingDuration(rawDuration: number) {
  const safe = Number.isFinite(rawDuration) ? rawDuration : 5;
  const rounded = Math.round(safe);
  return Math.max(3, Math.min(15, rounded));
}

function countStoryboardRows(markdown: string) {
  const lines = markdown.split("\n");
  let headerFound = false;
  let rowCount = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (headerFound) break;
      continue;
    }
    if (!trimmed.startsWith("|") || !trimmed.includes("|")) {
      if (headerFound) break;
      continue;
    }
    const parts = trimmed.split("|").map((p) => p.trim()).filter(Boolean);
    if (!headerFound) {
      const joined = parts.join(" ").toLowerCase();
      const isHeader = parts.length >= 3 && TABLE_HEADER_KEYWORDS.some((keyword) => joined.includes(keyword.toLowerCase()));
      if (isHeader) headerFound = true;
      continue;
    }
    if (trimmed.replace(/\||-|:|\s/g, "") === "") continue;
    rowCount += 1;
  }
  return rowCount;
}

function isKlingPendingStatus(value: string) {
  const normalized = String(value || "").toUpperCase();
  if (!normalized) return false;
  if (normalized.includes("FAILED") || normalized.includes("ERROR") || normalized.includes("CANCEL")) return false;
  if (normalized.includes("COMPLETED") || normalized.includes("SUCCESS")) return false;
  if (normalized === "KLING_SUBMITTED" || normalized === "KLING_PROCESSING") return true;
  return (
    normalized.includes("SUBMIT")
    || normalized.includes("PROCESS")
    || normalized.includes("PENDING")
    || normalized.includes("QUEUE")
    || normalized.includes("RUNNING")
  );
}

function isKlingCompletedStatus(value: string) {
  const normalized = String(value || "").toUpperCase();
  if (!normalized) return false;
  if (normalized.includes("FAILED") || normalized.includes("ERROR") || normalized.includes("CANCEL")) return false;
  return normalized.includes("COMPLETED") || normalized.includes("SUCCESS");
}

function buildCombinedStoryboardFromEpisodes(episodes: Episode[]) {
  return episodes
    .map((ep) => `### ${ep.title}\n\n${ep.storyboard || ""}`)
    .join("\n\n");
}

function extractEpisodeStoryboardMap(storyboardText: string) {
  const text = String(storyboardText || "");
  const headingRegex = /^###\s+(.+)$/gm;
  const headings: Array<{ title: string; headingStart: number; contentStart: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = headingRegex.exec(text)) !== null) {
    headings.push({
      title: String(match[1] || "").trim(),
      headingStart: match.index,
      contentStart: match.index + match[0].length,
    });
  }
  const map: Record<string, string> = {};
  headings.forEach((item, index) => {
    const nextHeadingStart = index < headings.length - 1 ? headings[index + 1].headingStart : text.length;
    const section = text.slice(item.contentStart, nextHeadingStart).trim();
    if (item.title) {
      map[item.title] = section;
    }
  });
  return map;
}

function stripThinkingContent(text: string) {
  const source = String(text || "");
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
}

export default function ScriptStoryboardPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const projectId = params.id;
  const [content, setContent] = useState("");
  const [storyboard, setStoryboard] = useState("");
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState("gemini-3.1-pro");
  const [globalStyle, setGlobalStyle] = useState("真人电影写实");
  const [isScriptCollapsed, setIsScriptCollapsed] = useState(false);
  const [videoResolution, setVideoResolution] = useState<"720p" | "1080p">("720p");
  const [videoAspectRatio, setVideoAspectRatio] = useState<"9:16" | "16:9" | "1:1">("9:16");
  const [videoAudioMode, setVideoAudioMode] = useState<"silent" | "with_audio">("with_audio");
  const [selectedVideoModel, setSelectedVideoModel] = useState<Step4VideoModel>("klingv3omni");
  const [segments, setSegments] = useState<Segment[]>([]);
  const [projectAssets, setProjectAssets] = useState<Asset[]>([]);
  const [generatingGlobalRowIndex, setGeneratingGlobalRowIndex] = useState<number | null>(null);
  const [modifyingGlobalRowIndex, setModifyingGlobalRowIndex] = useState<number | null>(null);
  const [manualPendingRowMap, setManualPendingRowMap] = useState<Record<number, ManualPendingRowState>>({});
  const [deletingVersionKey, setDeletingVersionKey] = useState<string | null>(null);
  const autoSelectingVersionKeySetRef = useRef<Set<string>>(new Set());

  // Episode state
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [selectedEpisodeIndex, setSelectedEpisodeIndex] = useState(0);
  const [generatingEpisodes, setGeneratingEpisodes] = useState<Set<number>>(new Set());
  const [expandedEpisodes, setExpandedEpisodes] = useState<Set<number>>(new Set([0])); // Default expand first
  const [mergingEpisodes, setMergingEpisodes] = useState<Set<number>>(new Set());
  const [mergedVideoUrlMap, setMergedVideoUrlMap] = useState<Record<number, string>>({});
  const [pendingStoryboardTasks, setPendingStoryboardTasks] = useState<Record<number, StoryboardPendingTaskState>>({});
  const [customPromptModalEpisodeIndex, setCustomPromptModalEpisodeIndex] = useState<number | null>(null);
  const [customStoryboardPrompt, setCustomStoryboardPrompt] = useState("");
  const [customPromptSubmittingEpisodeIndex, setCustomPromptSubmittingEpisodeIndex] = useState<number | null>(null);

  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastSavedContentRef = useRef("");
  const lastSavedStoryboardRef = useRef("");
  const lastSavedEpisodesRef = useRef<Episode[]>([]);
  const hydratingRef = useRef(false);
  const storyboardPollTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Load/Save selected model from/to localStorage
  useEffect(() => {
    if (!projectId) return;
    const key = `storyboard-model-${projectId}`;
    const saved = localStorage.getItem(key);
    if (saved) {
      setSelectedModel(saved === "gemini-3-pro" ? "gemini-3.1-pro" : saved);
    }
  }, [projectId]);

  useEffect(() => {
    if (!projectId) return;
    const token = getToken();
    if (!token) return;
    getAssets(token, projectId)
      .then((items) => setProjectAssets(items))
      .catch(() => setProjectAssets([]));
  }, [projectId]);

  useEffect(() => {
    if (!projectId || !selectedModel) return;
    const key = `storyboard-model-${projectId}`;
    localStorage.setItem(key, selectedModel);
  }, [projectId, selectedModel]);

  useEffect(() => {
    if (!projectId) return;
    const key = `storyboard-style-${projectId}`;
    const saved = localStorage.getItem(key);
    if (saved && STYLE_OPTIONS.includes(saved)) {
      setGlobalStyle(saved);
    }
  }, [projectId]);

  useEffect(() => {
    if (!projectId || !globalStyle) return;
    const key = `storyboard-style-${projectId}`;
    localStorage.setItem(key, globalStyle);
  }, [projectId, globalStyle]);

  useEffect(() => {
    if (episodes.length === 0) {
      setSelectedEpisodeIndex(0);
      return;
    }
    setSelectedEpisodeIndex((prev) => Math.min(Math.max(prev, 0), episodes.length - 1));
  }, [episodes.length]);

  useEffect(() => {
    if (!projectId) return;
    const key = `storyboard-video-audio-${projectId}`;
    const saved = localStorage.getItem(key);
    if (saved === "silent" || saved === "with_audio") {
      setVideoAudioMode(saved);
    }
  }, [projectId]);

  useEffect(() => {
    if (!projectId) return;
    const key = `storyboard-video-model-${projectId}`;
    const saved = localStorage.getItem(key);
    if (saved === "klingv3omni" || saved === "seedance2.0") {
      setSelectedVideoModel(saved);
    }
  }, [projectId]);

  useEffect(() => {
    if (!projectId) return;
    setPendingStoryboardTasks(readStoryboardPendingTasks(projectId));
  }, [projectId]);

  useEffect(() => {
    if (!projectId) return;
    writeStoryboardPendingTasks(projectId, pendingStoryboardTasks);
  }, [projectId, pendingStoryboardTasks]);

  useEffect(() => {
    if (!projectId) return;
    const key = `storyboard-video-audio-${projectId}`;
    localStorage.setItem(key, videoAudioMode);
  }, [projectId, videoAudioMode]);

  useEffect(() => {
    if (!projectId) return;
    const key = `storyboard-video-model-${projectId}`;
    localStorage.setItem(key, selectedVideoModel);
  }, [projectId, selectedVideoModel]);

  useEffect(() => {
    if (!projectId) return;
    try {
      const raw =
        window.localStorage.getItem(`video-step5-state:${projectId}`) ||
        window.localStorage.getItem(`video-step-state-${projectId}`);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Step5PersistState;
      const restoredMap =
        parsed.mergedVideoUrlMap && typeof parsed.mergedVideoUrlMap === "object"
          ? (parsed.mergedVideoUrlMap as Record<number, string>)
          : {};
      if (Object.keys(restoredMap).length > 0) {
        setMergedVideoUrlMap(restoredMap);
      }
    } catch {}
  }, [projectId]);

  useEffect(() => {
    if (!projectId) return;
    try {
      const raw = window.localStorage.getItem(getManualPendingStorageKey(projectId));
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<string, ManualPendingRowState>;
      if (!parsed || typeof parsed !== "object") return;
      const now = Date.now();
      const restored: Record<number, ManualPendingRowState> = {};
      Object.entries(parsed).forEach(([rowIndexKey, item]) => {
        const rowIndex = Number(rowIndexKey);
        if (Number.isNaN(rowIndex)) return;
        if (!item?.segmentId) return;
        if (!item.submittedAt || now - Number(item.submittedAt) > 30 * 60 * 1000) return;
        restored[rowIndex] = {
          segmentId: String(item.segmentId),
          baseVersionIds: Array.isArray(item.baseVersionIds) ? item.baseVersionIds.map((id) => String(id)) : [],
          submittedAt: Number(item.submittedAt) || now,
        };
      });
      setManualPendingRowMap(restored);
    } catch {}
  }, [projectId]);

  useEffect(() => {
    if (!projectId) return;
    try {
      window.localStorage.setItem(
        getManualPendingStorageKey(projectId),
        JSON.stringify(manualPendingRowMap)
      );
    } catch {}
  }, [projectId, manualPendingRowMap]);

  // Load script
  useEffect(() => {
    if (!projectId) return;
    const token = getToken();
    if (!token) {
      router.push("/login");
      return;
    }

    getScript(token, projectId)
      .then(async (data) => {
        hydratingRef.current = true;
        const rawContent = data.content ?? "";
        const originalContent = rawContent.includes(SEPARATOR)
          ? String(rawContent.split(SEPARATOR)[1] || "")
          : rawContent;
        setContent(stripThinkingContent(originalContent));
        const initialStoryboard = stripThinkingContent(data.storyboard || "");
        setStoryboard(initialStoryboard);
        
        lastSavedContentRef.current = data.content ?? "";
        lastSavedStoryboardRef.current = initialStoryboard;

        if (data.episodes && data.episodes.length > 0) {
            const storyboardByTitle = extractEpisodeStoryboardMap(initialStoryboard);
            const loadedEpisodes: Episode[] = (data.episodes as EpisodeWithVersions[]).map((ep) => {
                const fallbackStoryboard = storyboardByTitle[String(ep.title || "").trim()] || "";
                const normalizedRawStoryboard = String(ep.storyboard || "").trim() ? String(ep.storyboard || "") : fallbackStoryboard;
                const normalizedStoryboard = stripThinkingContent(normalizedRawStoryboard);
                if (!ep.content && ep.versions && Array.isArray(ep.versions) && ep.versions.length > 0) {
                     const current = ep.versions.find((v) => v.id === ep.currentVersionId) || ep.versions[0];
                     return {
                      ...ep,
                      content: current?.content || "",
                      storyboard: normalizedStoryboard,
                      thinking: ep.thinking || "",
                      userInput: ep.userInput || "",
                     };
                }
                return {
                  ...ep,
                  content: ep.content || "",
                  storyboard: normalizedStoryboard,
                  thinking: ep.thinking || "",
                  userInput: ep.userInput || "",
                };
            });
            setEpisodes(loadedEpisodes);
            setGeneratingEpisodes(() => {
              const next = new Set<number>();
              loadedEpisodes.forEach((ep, index) => {
                if ((ep.storyboardTaskStatus === "running" || ep.storyboardTaskStatus === "pending") && ep.storyboardTaskId) {
                  next.add(index);
                }
              });
              return next;
            });
            setPendingStoryboardTasks((prev) => {
              const next = { ...prev };
              loadedEpisodes.forEach((ep, index) => {
                const taskId = String(ep.storyboardTaskId || "").trim();
                if ((ep.storyboardTaskStatus === "running" || ep.storyboardTaskStatus === "pending") && taskId) {
                  next[index] = {
                    episodeIndex: index,
                    episodeTitle: ep.title || `第${index + 1}集`,
                    taskId,
                    startedAt: Date.now(),
                  };
                }
              });
              return next;
            });
            lastSavedEpisodesRef.current = loadedEpisodes;
        } else {
            setEpisodes([]);
            setGeneratingEpisodes(new Set());
            lastSavedEpisodesRef.current = [];
        }
        const segmentData = await getSegments(token, projectId);
        setSegments(segmentData);
      })
      .catch(() => setMessage("加载失败"))
      .finally(() => {
        hydratingRef.current = false;
        setLoading(false);
      });
  }, [projectId, router]);

  const generatedRowIndexSet = useMemo(() => {
    const set = new Set<number>();
    segments.forEach((segment, index) => {
      if (segment.versions?.some((version) => version.video_url)) {
        set.add(index);
      }
    });
    return set;
  }, [segments]);

  const pendingRowIndexSet = useMemo(() => {
    const set = new Set<number>();
    const now = Date.now();
    Object.entries(manualPendingRowMap).forEach(([rowIndexKey, rowState]) => {
      const rowIndex = Number(rowIndexKey);
      if (Number.isNaN(rowIndex)) return;
      const segment = segments.find((item) => item.id === rowState?.segmentId);
      if (!segment) {
        const submittedAt = Number(rowState?.submittedAt || 0);
        if (!submittedAt || now - submittedAt < 2 * 60 * 1000) {
          set.add(rowIndex);
        }
        return;
      }
      const segmentStatus = String(segment.task_status || "").toUpperCase();
      const versionPending = (segment.versions || []).some((version) => isKlingPendingStatus(version.status));
      if (isKlingPendingStatus(segmentStatus) || versionPending) {
        set.add(rowIndex);
      }
    });
    segments.forEach((segment, index) => {
      const segmentStatus = String(segment.task_status || "").toUpperCase();
      const versionPending = (segment.versions || []).some((version) => isKlingPendingStatus(version.status));
      if (isKlingPendingStatus(segmentStatus) || versionPending) {
        set.add(index);
      }
    });
    return set;
  }, [segments, manualPendingRowMap]);

  const applySelectedVersionForRow = (globalRowIndex: number, versionId: string) => {
    setSegments((prev) =>
      prev.map((item, index) => {
        if (index !== globalRowIndex) return item;
        return {
          ...item,
          versions: (item.versions || []).map((version) => ({
            ...version,
            is_selected: version.id === versionId,
          })),
        };
      })
    );
  };

  useEffect(() => {
    if (Object.keys(manualPendingRowMap).length === 0) return;
    const next: Record<number, ManualPendingRowState> = {};
    const autoSelectTargets: Array<{ rowIndex: number; segmentId: string; versionId: string }> = [];
    let changed = false;
    const now = Date.now();
    Object.entries(manualPendingRowMap).forEach(([rowIndexKey, rowState]) => {
      const rowIndex = Number(rowIndexKey);
      const segmentId = rowState?.segmentId || "";
      if (Number.isNaN(rowIndex) || !segmentId) {
        changed = true;
        return;
      }
      const segment = segments.find((item) => item.id === segmentId);
      if (!segment) {
        next[rowIndex] = rowState;
        return;
      }
      const segmentPending = isKlingPendingStatus(String(segment.task_status || ""));
      const versionPending = (segment.versions || []).some((version) => isKlingPendingStatus(version.status));
      if (segmentPending || versionPending) {
        next[rowIndex] = rowState;
        return;
      }
      const baseVersionIdSet = new Set(rowState.baseVersionIds || []);
      const newVersions = (segment.versions || []).filter((version) => !baseVersionIdSet.has(version.id));
      if (newVersions.length === 0) {
        if (now - Number(rowState.submittedAt || 0) < 10 * 60 * 1000) {
          next[rowIndex] = rowState;
          return;
        }
        changed = true;
        return;
      }
      changed = true;
      const completedVersions = newVersions.filter(
        (version) => isKlingCompletedStatus(version.status) && Boolean(version.video_url)
      );
      const latestCompletedVersion = completedVersions[0];
      const selectedVersion = (segment.versions || []).find((version) => version.is_selected && version.video_url);
      if (latestCompletedVersion?.id && latestCompletedVersion.id !== selectedVersion?.id) {
        autoSelectTargets.push({
          rowIndex,
          segmentId: segment.id,
          versionId: latestCompletedVersion.id,
        });
      }
    });
    if (changed) {
      setManualPendingRowMap(next);
    }
    if (autoSelectTargets.length === 0 || !projectId) return;
    const token = getToken();
    if (!token) return;
    autoSelectTargets.forEach((target) => {
      const autoSelectKey = `${target.segmentId}:${target.versionId}`;
      if (autoSelectingVersionKeySetRef.current.has(autoSelectKey)) return;
      autoSelectingVersionKeySetRef.current.add(autoSelectKey);
      applySelectedVersionForRow(target.rowIndex, target.versionId);
      void selectSegmentVersion(token, projectId, target.segmentId, target.versionId)
        .then(() =>
          getSegments(token, projectId).then((refreshedSegments) => {
            setSegments(refreshedSegments);
          })
        )
        .catch(() => {})
        .finally(() => {
          autoSelectingVersionKeySetRef.current.delete(autoSelectKey);
        });
    });
  }, [segments, manualPendingRowMap, projectId]);

  const rowTaskStatusMap = useMemo(() => {
    const map: Record<number, string> = {};
    segments.forEach((segment, index) => {
      const latestVersion = (segment.versions || [])[0];
      const status = String(latestVersion?.status || segment.task_status || segment.status || "").toUpperCase();
      if (status) {
        map[index] = status;
      }
    });
    return map;
  }, [segments]);

  const rowTaskIdMap = useMemo(() => {
    const map: Record<number, string> = {};
    segments.forEach((segment, index) => {
      const latestVersion = (segment.versions || [])[0];
      const taskId = String(latestVersion?.task_id || segment.task_id || "").trim();
      if (taskId) {
        map[index] = taskId;
      }
    });
    return map;
  }, [segments]);

  const rowVersionListMap = useMemo(() => {
    const map: Record<number, SegmentVersion[]> = {};
    segments.forEach((segment, index) => {
      map[index] = segment.versions || [];
    });
    return map;
  }, [segments]);

  const rowSelectedVersionIdMap = useMemo(() => {
    const map: Record<number, string> = {};
    segments.forEach((segment, index) => {
      const selected = segment.versions?.find((version) => version.is_selected && version.video_url);
      if (selected?.id) {
        map[index] = selected.id;
        return;
      }
      const completed = segment.versions?.filter((version) => isKlingCompletedStatus(version.status) && version.video_url) || [];
      if (completed.length > 0) {
        map[index] = completed[0].id;
      }
    });
    return map;
  }, [segments]);

  useEffect(() => {
    if (!projectId || pendingRowIndexSet.size === 0) return;
    const timer = window.setInterval(async () => {
      const token = getToken();
      if (!token) return;
      try {
        const refreshed = await getSegments(token, projectId);
        setSegments(refreshed);
      } catch {}
    }, 4000);
    return () => window.clearInterval(timer);
  }, [projectId, pendingRowIndexSet]);

  const rowVideoUrlMap = useMemo(() => {
    const map: Record<number, string> = {};
    segments.forEach((segment, index) => {
      const selectedVersionId = rowSelectedVersionIdMap[index];
      const selected = segment.versions?.find((version) => version.id === selectedVersionId && version.video_url);
      if (selected?.video_url) {
        map[index] = selected.video_url;
        return;
      }
      const completed = segment.versions?.filter((version) => isKlingCompletedStatus(version.status) && version.video_url) || [];
      if (completed.length > 0) {
        map[index] = completed[0].video_url;
      }
    });
    return map;
  }, [segments, rowSelectedVersionIdMap]);

  // Sync storyboard string from episodes
  useEffect(() => {
    if (episodes.length === 0 || hydratingRef.current) return;
    const hasAnyEpisodeStoryboard = episodes.some((ep) => String(ep.storyboard || "").trim().length > 0);
    if (!hasAnyEpisodeStoryboard) return;
    const combinedStoryboard = buildCombinedStoryboardFromEpisodes(episodes);
    setStoryboard((prev) => (prev === combinedStoryboard ? prev : combinedStoryboard));
  }, [episodes]);

  // Auto-save effect
  useEffect(() => {
    if (loading || !projectId) return;
    
    const episodesChanged = JSON.stringify(episodes) !== JSON.stringify(lastSavedEpisodesRef.current);
    const storyboardChanged = storyboard !== lastSavedStoryboardRef.current;

    if (!episodesChanged && !storyboardChanged) return;

    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);

    saveTimeoutRef.current = setTimeout(async () => {
      const token = getToken();
      if (!token) return;
      try {
        await saveScript(token, projectId, undefined, undefined, storyboard, undefined, episodes);
        lastSavedStoryboardRef.current = storyboard;
        lastSavedEpisodesRef.current = episodes;
      } catch (e) {
        console.error("Auto-save failed", e);
      }
    }, 2000);

    return () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    };
  }, [episodes, storyboard, projectId, loading]);

  useEffect(() => {
    if (!projectId) return;
    const runningTaskMap = new Map<number, { index: number; title: string; taskId: string }>();
    episodes.forEach((episode, index) => {
      const taskId = String(episode.storyboardTaskId || "").trim();
      if ((episode.storyboardTaskStatus === "running" || episode.storyboardTaskStatus === "pending") && taskId) {
        runningTaskMap.set(index, {
          index,
          title: episode.title || `第${index + 1}集`,
          taskId,
        });
      }
    });
    const now = Date.now();
    Object.values(pendingStoryboardTasks).forEach((item) => {
      if (!item?.taskId) return;
      if (now - Number(item.startedAt || 0) > STORYBOARD_TASK_PENDING_MAX_AGE_MS) return;
      if (!runningTaskMap.has(item.episodeIndex)) {
        runningTaskMap.set(item.episodeIndex, {
          index: item.episodeIndex,
          title: item.episodeTitle || `第${item.episodeIndex + 1}集`,
          taskId: item.taskId,
        });
      }
    });
    const runningTasks = Array.from(runningTaskMap.values());
    if (storyboardPollTimerRef.current) {
      clearInterval(storyboardPollTimerRef.current);
      storyboardPollTimerRef.current = null;
    }
    if (runningTasks.length === 0) return;
    setGeneratingEpisodes((prev) => {
      const next = new Set(prev);
      runningTasks.forEach((item) => next.add(item.index));
      return next;
    });
    const poll = async () => {
      const token = getToken();
      if (!token) return;
      await Promise.all(
        runningTasks.map(async (item) => {
          try {
            const result = await getStoryboardTaskStatus(token, projectId, item.taskId);
            if (result.status === "running" || result.status === "pending") return;
            if (result.status === "completed") {
              setEpisodes((prev) => {
                if (!prev[item.index]) return prev;
                const next = [...prev];
                next[item.index] = {
                  ...next[item.index],
                  storyboard: stripThinkingContent(result.content || next[item.index].storyboard || ""),
                  storyboardTaskId: result.task_id,
                  storyboardTaskStatus: "completed",
                  storyboardTaskError: "",
                };
                return next;
              });
              setExpandedEpisodes((prev) => new Set(prev).add(item.index));
              setMessage(`${item.title} 分镜生成完成`);
              setPendingStoryboardTasks((prev) => {
                const next = { ...prev };
                delete next[item.index];
                return next;
              });
            } else if (result.status === "failed") {
              setEpisodes((prev) => {
                if (!prev[item.index]) return prev;
                const next = [...prev];
                next[item.index] = {
                  ...next[item.index],
                  storyboardTaskId: result.task_id,
                  storyboardTaskStatus: "failed",
                  storyboardTaskError: result.error || "生成失败",
                };
                return next;
              });
              setMessage(`${item.title} 生成失败：${result.error || "未知错误"}`);
              setPendingStoryboardTasks((prev) => {
                const next = { ...prev };
                delete next[item.index];
                return next;
              });
            }
            setGeneratingEpisodes((prev) => {
              const next = new Set(prev);
              next.delete(item.index);
              return next;
            });
          } catch {
            return;
          }
        })
      );
    };
    void poll();
    storyboardPollTimerRef.current = setInterval(() => {
      void poll();
    }, 3000);
    return () => {
      if (storyboardPollTimerRef.current) {
        clearInterval(storyboardPollTimerRef.current);
        storyboardPollTimerRef.current = null;
      }
    };
  }, [episodes, projectId, pendingStoryboardTasks]);

  const handleGenerateEpisode = async (index: number, extraInstruction?: string) => {
    if (!projectId) return;
    const token = getToken();
    if (!token) return;

    const episode = episodes[index];
    if (!episode) return;

    if (episode.storyboardTaskStatus === "running" && episode.storyboardTaskId) {
      setGeneratingEpisodes((prev) => new Set(prev).add(index));
      setMessage(`${episode.title} 正在生成中...`);
      return;
    }

    setGeneratingEpisodes(prev => new Set(prev).add(index));
    setMessage(`正在生成 ${episode.title} 的分镜...`);

    try {
      const styleInstruction = STYLE_PROMPT_MAP[globalStyle] || `全局视觉风格：${globalStyle}`;
      const customInstruction = String(extraInstruction || "").trim();
      const mergedInstruction = [
        styleInstruction,
        customInstruction ? `【本次额外要求】\n${customInstruction}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      const result = await startStoryboardTask(token, projectId, {
        episode_index: index,
        episode_title: episode.title || `第${index + 1}集`,
        episode_content: episode.content,
        model: selectedModel,
        instruction: mergedInstruction,
      });
      setEpisodes((prev) => {
        if (!prev[index]) return prev;
        const next = [...prev];
        next[index] = {
          ...next[index],
          storyboardTaskId: result.task_id,
          storyboardTaskStatus: result.status,
          storyboardTaskError: result.error || "",
          storyboard: result.status === "completed" ? (result.content || next[index].storyboard || "") : next[index].storyboard,
        };
        return next;
      });
      if (result.status === "running" || result.status === "pending") {
        setPendingStoryboardTasks((prev) => ({
          ...prev,
          [index]: {
            episodeIndex: index,
            episodeTitle: episode.title || `第${index + 1}集`,
            taskId: result.task_id,
            startedAt: Date.now(),
          },
        }));
      }
      if (result.status === "completed") {
        setMessage(`${episode.title} 分镜生成完成`);
        setExpandedEpisodes((prev) => new Set(prev).add(index));
        setPendingStoryboardTasks((prev) => {
          const next = { ...prev };
          delete next[index];
          return next;
        });
        setGeneratingEpisodes((prev) => {
          const next = new Set(prev);
          next.delete(index);
          return next;
        });
      } else if (result.status === "failed") {
        setMessage(`${episode.title} 生成失败：${result.error || "未知错误"}`);
        setPendingStoryboardTasks((prev) => {
          const next = { ...prev };
          delete next[index];
          return next;
        });
        setGeneratingEpisodes((prev) => {
          const next = new Set(prev);
          next.delete(index);
          return next;
        });
      } else {
        setMessage(`正在生成 ${episode.title} 的分镜...`);
      }
    } catch (e) {
      console.error(e);
      setMessage(`${episode.title} 生成失败`);
      setPendingStoryboardTasks((prev) => {
        const next = { ...prev };
        delete next[index];
        return next;
      });
      setEpisodes((prev) => {
        if (!prev[index]) return prev;
        const next = [...prev];
        next[index] = {
          ...next[index],
          storyboardTaskStatus: "failed",
          storyboardTaskError: e instanceof Error ? e.message : "生成失败",
        };
        return next;
      });
      setGeneratingEpisodes((prev) => {
        const next = new Set(prev);
        next.delete(index);
        return next;
      });
    }
  };

  const handleGenerateEpisodeWithCustomPrompt = async () => {
    if (customPromptModalEpisodeIndex === null) return;
    const prompt = customStoryboardPrompt.trim();
    if (!prompt) {
      setMessage("请输入按要求生成分镜的提示内容");
      return;
    }
    const targetEpisodeIndex = customPromptModalEpisodeIndex;
    setCustomPromptSubmittingEpisodeIndex(targetEpisodeIndex);
    try {
      await handleGenerateEpisode(targetEpisodeIndex, prompt);
      setCustomPromptModalEpisodeIndex(null);
      setCustomStoryboardPrompt("");
    } finally {
      setCustomPromptSubmittingEpisodeIndex(null);
    }
  };

  const toggleEpisodeExpand = (index: number) => {
      setExpandedEpisodes(prev => {
          const newSet = new Set(prev);
          if (newSet.has(index)) {
              newSet.delete(index);
          } else {
              newSet.add(index);
          }
          return newSet;
      });
  };

  const handleEpisodeStoryboardChange = (index: number, newStoryboard: string) => {
      setEpisodes(prev => {
          const newEpisodes = [...prev];
          newEpisodes[index] = { ...newEpisodes[index], storyboard: newStoryboard };
          return newEpisodes;
      });
  };

  const syncMergedVideosToStep5 = (nextMap: Record<number, string>) => {
    if (!projectId || Object.keys(nextMap).length === 0) return;
    const storageKey = `video-step5-state:${projectId}`;
    try {
      const raw = window.localStorage.getItem(storageKey);
      const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const existingMergedMap =
        parsed.mergedVideoUrlMap && typeof parsed.mergedVideoUrlMap === "object"
          ? (parsed.mergedVideoUrlMap as Record<number, string>)
          : {};
      window.localStorage.setItem(
        storageKey,
        JSON.stringify({
          ...parsed,
          mergedVideoUrlMap: { ...existingMergedMap, ...nextMap },
        })
      );
    } catch {
      window.localStorage.setItem(storageKey, JSON.stringify({ mergedVideoUrlMap: nextMap }));
    }
  };

  const handleMergeEpisodeVideo = async ({
    episodeIndex,
    title,
    rowStartIndex,
    rowCount,
  }: {
    episodeIndex: number;
    title: string;
    rowStartIndex: number;
    rowCount: number;
  }) => {
    if (!projectId) return;
    const clipUrls = segments
      .slice(rowStartIndex, rowStartIndex + rowCount)
      .map((segment) => getSelectedOrLatestSegmentVideoUrl(segment))
      .filter(Boolean);
    if (clipUrls.length === 0) {
      setMessage(`${title} 暂无可合并视频，请先生成分镜视频`);
      return;
    }
    const token = getToken();
    if (!token) {
      router.push("/login");
      return;
    }
    setMergingEpisodes((prev) => new Set(prev).add(episodeIndex));
    setMessage(`正在合并 ${title} 视频...`);
    try {
      const result = await mergeEpisodeOnServer(token, projectId, {
        episodeTitle: title,
        clipUrls,
      });
      const mergedVideoUrl = resolveBackendMediaUrl(result.merged_video_url);
      setMergedVideoUrlMap((prev) => ({ ...prev, [episodeIndex]: mergedVideoUrl }));
      syncMergedVideosToStep5({ [episodeIndex]: mergedVideoUrl });
      setMessage(result.already_exists ? `${title} 已复用合并视频` : `${title} 合并完成`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : `${title} 合并失败`);
    } finally {
      setMergingEpisodes((prev) => {
        const next = new Set(prev);
        next.delete(episodeIndex);
        return next;
      });
    }
  };

  const handleGenerateKlingRow = async ({
    globalRowIndex,
    previousGlobalRowIndex,
    headers,
    row,
    usePreviousSegmentEndFrame,
    customFirstFrameUrl,
    customLastFrameUrl,
  }: {
    globalRowIndex: number;
    previousGlobalRowIndex?: number;
    headers: string[];
    row: string[];
    usePreviousSegmentEndFrame?: boolean;
    customFirstFrameUrl?: string;
    customLastFrameUrl?: string;
  }) => {
    setGeneratingGlobalRowIndex(globalRowIndex);
    setMessage("正在提交视频生成请求...");
    let submitted = false;
    try {
      if (!projectId) {
        throw new Error("项目 ID 无效，请刷新页面后重试");
      }
      const token = getToken();
      if (!token) {
        router.push("/login");
        throw new Error("登录状态已失效，请重新登录后重试");
      }
      let segment = segments[globalRowIndex];
      if (!segment) {
        const refreshedSegments = await getSegments(token, projectId);
        setSegments(refreshedSegments);
        segment = refreshedSegments[globalRowIndex];
      }
      if (!segment) {
        throw new Error("当前行还未同步到分段，请等待自动保存后重试");
      }
      setManualPendingRowMap((prev) => ({
        ...prev,
        [globalRowIndex]: {
          segmentId: segment.id,
          baseVersionIds: (segment.versions || []).map((version) => version.id),
          submittedAt: Date.now(),
        },
      }));
      const mode = videoResolution === "1080p" ? "pro" : "std";
      const timelineIndex = findFieldIndex(headers, "时间轴");
      const timelineText = timelineIndex >= 0 ? (row[timelineIndex] || "") : "";
      const duration = normalizeKlingDuration(parseDurationFromTimeline(timelineText));
      const rowFieldValueLines: string[] = [];
      const rowFieldMeaningLines: string[] = [];
      const assetBindings: Array<{
        asset_id: string;
        role: KlingAssetRole;
        name?: string;
        description?: string;
      }> = [];
      const bindingKeySet = new Set<string>();
      let firstFrameAssetId = "";
      const pushBinding = (assetId: string, role: KlingAssetRole) => {
        const key = `${role}:${assetId}`;
        if (bindingKeySet.has(key)) return;
        bindingKeySet.add(key);
        const asset = projectAssets.find((item) => item.id === assetId);
        assetBindings.push({
          asset_id: assetId,
          role,
          name: asset?.name || undefined,
          description: asset?.description || undefined,
        });
      };

      headers.forEach((header, index) => {
        const cell = row[index] || "";
        if (!cell) return;
        const role = mapHeaderToAssetRole(header);
        if (!role) return;
        if (usePreviousSegmentEndFrame && role === "first_frame") return;
        const ids = resolveAssetIdsFromCell(cell, projectAssets, role);
        if (ids.length > 0) {
          ids.forEach((id) => {
            pushBinding(id, role);
            if (role === "first_frame" && !firstFrameAssetId) firstFrameAssetId = id;
          });
        }
      });
      let previousSegmentVideoUrl = "";
      if (usePreviousSegmentEndFrame && typeof previousGlobalRowIndex === "number" && previousGlobalRowIndex >= 0) {
        const previousSegment = segments[previousGlobalRowIndex];
        previousSegmentVideoUrl = rowVideoUrlMap[previousGlobalRowIndex] || getSelectedOrLatestSegmentVideoUrl(previousSegment);
      }

      const sanitizeCellForPrompt = (text: string) =>
        String(text || "")
          .replace(/\[AssetID:\s*[^\]]+\]/gi, "")
          .replace(/\n{3,}/g, "\n\n")
          .trim();
      const consumedHeaderIndexSet = new Set<number>();
      VIDEO_FIELD_ORDER.forEach((field) => {
        const fieldIndex = findFieldIndex(headers, field);
        if (fieldIndex < 0) return;
        consumedHeaderIndexSet.add(fieldIndex);
        const fieldHeader = headers[fieldIndex];
        const fieldCell = sanitizeCellForPrompt(row[fieldIndex] || "") || "（空）";
        rowFieldMeaningLines.push(`- ${field}：${COLUMN_MEANING_MAP[field] || "该字段用于描述当前镜头的重要信息"}`);
        rowFieldValueLines.push(`${field}: ${fieldCell}`);
        if (fieldHeader !== field) {
          rowFieldValueLines.push(`字段别名: ${fieldHeader}`);
        }
      });

      headers.forEach((header, index) => {
        if (consumedHeaderIndexSet.has(index)) return;
        if (isVideoGenerateHeader(header)) return;
        rowFieldMeaningLines.push(`- ${header}：${COLUMN_MEANING_MAP[header] || "该字段用于描述当前镜头的重要信息"}`);
        rowFieldValueLines.push(`${header}: ${sanitizeCellForPrompt(row[index] || "") || "（空）"}`);
      });

      const systemPrompt = [
        "你是短剧分镜视频生成模型的执行器。",
        `全局视觉风格：${globalStyle}。`,
        "严格遵循用户提供的每个字段，不得丢失字段信息，不得擅自改写剧情事实。",
        "优先保证人物动作、表情、台词、道具、场景与时间轴一致。",
        `目标分辨率：${videoResolution}，画幅：${videoAspectRatio}，模式：${mode}。`,
      ].join("\n");

      const usePreviousTailFrame = Boolean(previousSegmentVideoUrl) && !customFirstFrameUrl;
      const modelToUse = resolveStep4VideoModel(selectedVideoModel);
      const withAudio = videoAudioMode === "with_audio";

      const prompt = [
        "请基于当前分镜行生成单镜头视频，严格融合所有字段语义。",
        "【字段定义】",
        ...rowFieldMeaningLines,
        "【字段取值】",
        ...rowFieldValueLines,
        "【生成要求】",
        `模型：${modelToUse}`,
        `模式：${mode}`,
        `分辨率：${videoResolution}`,
        `画幅比例：${videoAspectRatio}`,
        `时长：${duration}s`,
        `首帧来源：${usePreviousTailFrame ? "上一条分镜已选视频尾帧" : "默认首帧"}`,
        `音频：${withAudio ? "有声" : "无声"}`,
      ].join("\n");
      const options: Record<string, unknown> = {
        model: modelToUse,
        mode,
        duration,
        aspect_ratio: videoAspectRatio,
        with_audio: withAudio,
        sound: withAudio ? "on" : "off",
        system_prompt: systemPrompt,
      };
      if (usePreviousTailFrame) {
        options.previous_segment_video_url = previousSegmentVideoUrl;
      }
      if (customFirstFrameUrl) {
        options.custom_first_frame_url = customFirstFrameUrl;
      }
      if (customLastFrameUrl) {
        options.custom_last_frame_url = customLastFrameUrl;
      }
      if (assetBindings.length > 0) {
        options.asset_bindings = assetBindings;
      }
      if (firstFrameAssetId) {
        options.first_frame_asset_id = firstFrameAssetId;
      }

      await generateSegment(token, projectId, {
        segment_id: segment.id,
        prompt,
        model: modelToUse,
        options: {
          ...options,
          model: modelToUse,
          with_audio: withAudio,
          sound: withAudio ? "on" : "off",
        },
        user_selected_row_index: globalRowIndex,
      });
      submitted = true;
      try {
        const refreshedSegments = await getSegments(token, projectId);
        setSegments(refreshedSegments);
      } catch {}
      const referenceCount = assetBindings.length > 0
        ? new Set(assetBindings.map((item) => item.asset_id)).size
        : 0;
      setMessage(`视频任务已提交，正在生成中（本次参考图：${referenceCount}）`);
    } catch (error) {
      if (!submitted) {
        setManualPendingRowMap((prev) => {
          const next = { ...prev };
          delete next[globalRowIndex];
          return next;
        });
      }
      setMessage(error instanceof Error ? error.message : "视频生成失败");
    } finally {
      setGeneratingGlobalRowIndex(null);
    }
  };

  const handleModifyKlingRow = async ({
    globalRowIndex,
    headers,
    row,
    currentVideoUrl,
    instruction,
    referenceImageUrls,
    keepOriginalSound,
  }: {
    globalRowIndex: number;
    headers: string[];
    row: string[];
    currentVideoUrl: string;
    instruction: string;
    referenceImageUrls: string[];
    keepOriginalSound: boolean;
  }) => {
    setModifyingGlobalRowIndex(globalRowIndex);
    setMessage("正在提交视频修改请求...");
    let submitted = false;
    try {
      if (!projectId) throw new Error("项目 ID 无效，请刷新页面后重试");
      const token = getToken();
      if (!token) {
        router.push("/login");
        throw new Error("登录状态已失效，请重新登录后重试");
      }
      if (!currentVideoUrl) throw new Error("当前行没有可修改的视频，请先生成视频");
      let segment = segments[globalRowIndex];
      if (!segment) {
        const refreshedSegments = await getSegments(token, projectId);
        setSegments(refreshedSegments);
        segment = refreshedSegments[globalRowIndex];
      }
      if (!segment) throw new Error("当前行还未同步到分段，请等待自动保存后重试");

      setManualPendingRowMap((prev) => ({
        ...prev,
        [globalRowIndex]: {
          segmentId: segment.id,
          baseVersionIds: (segment.versions || []).map((version) => version.id),
          submittedAt: Date.now(),
        },
      }));

      const rowFieldValueLines: string[] = [];
      const rowFieldMeaningLines: string[] = [];
      const assetBindings: Array<{ asset_id: string; role: KlingAssetRole; name?: string; description?: string }> = [];
      const bindingKeySet = new Set<string>();
      const pushBinding = (assetId: string, role: KlingAssetRole) => {
        const key = `${role}:${assetId}`;
        if (bindingKeySet.has(key)) return;
        bindingKeySet.add(key);
        const asset = projectAssets.find((item) => item.id === assetId);
        assetBindings.push({
          asset_id: assetId,
          role,
          name: asset?.name || undefined,
          description: asset?.description || undefined,
        });
      };

      headers.forEach((header, index) => {
        const cell = row[index] || "";
        if (!cell) return;
        const role = mapHeaderToAssetRole(header);
        if (!role || role === "first_frame") return;
        const ids = resolveAssetIdsFromCell(cell, projectAssets, role);
        ids.forEach((id) => pushBinding(id, role));
      });

      const sanitizeCellForPrompt = (text: string) =>
        String(text || "")
          .replace(/\[AssetID:\s*[^\]]+\]/gi, "")
          .replace(/\n{3,}/g, "\n\n")
          .trim();

      const consumedHeaderIndexSet = new Set<number>();
      VIDEO_FIELD_ORDER.forEach((field) => {
        const fieldIndex = findFieldIndex(headers, field);
        if (fieldIndex < 0) return;
        consumedHeaderIndexSet.add(fieldIndex);
        const fieldHeader = headers[fieldIndex];
        const fieldCell = sanitizeCellForPrompt(row[fieldIndex] || "") || "（空）";
        rowFieldMeaningLines.push(`- ${field}：${COLUMN_MEANING_MAP[field] || "该字段用于描述当前镜头的重要信息"}`);
        rowFieldValueLines.push(`${field}: ${fieldCell}`);
        if (fieldHeader !== field) {
          rowFieldValueLines.push(`字段别名: ${fieldHeader}`);
        }
      });
      headers.forEach((header, index) => {
        if (consumedHeaderIndexSet.has(index)) return;
        if (isVideoGenerateHeader(header)) return;
        rowFieldMeaningLines.push(`- ${header}：${COLUMN_MEANING_MAP[header] || "该字段用于描述当前镜头的重要信息"}`);
        rowFieldValueLines.push(`${header}: ${sanitizeCellForPrompt(row[index] || "") || "（空）"}`);
      });

      const systemPrompt = [
        "你是短剧分镜视频编辑模型的执行器。",
        `全局视觉风格：${globalStyle}。`,
        "你将基于当前视频进行编辑，严格保留镜头结构与叙事连续性。",
        "优先保证人物动作、表情、台词、道具、场景与时间轴一致。",
      ].join("\n");

      const references = Array.from(new Set(referenceImageUrls.map((item) => String(item || "").trim()).filter(Boolean))).slice(0, 4);
      const prompt = [
        "请基于<<<video_1>>>对当前分镜视频做定向修改。",
        "【字段定义】",
        ...rowFieldMeaningLines,
        "【字段取值】",
        ...rowFieldValueLines,
        "【用户修改要求】",
        instruction,
      ].join("\n");

      const modelToUse = resolveStep4VideoModel(selectedVideoModel);
      const withAudio = videoAudioMode === "with_audio";
      await generateSegment(token, projectId, {
        segment_id: segment.id,
        prompt,
        model: modelToUse,
        options: {
          model: modelToUse,
          mode: videoResolution === "1080p" ? "pro" : "std",
          aspect_ratio: videoAspectRatio,
          with_audio: withAudio,
          sound: withAudio ? "on" : "off",
          system_prompt: systemPrompt,
          reference_video_url: currentVideoUrl,
          refer_type: "base",
          keep_original_sound: keepOriginalSound ? "yes" : "no",
          reference_images: references,
          asset_bindings: assetBindings,
        },
      });
      submitted = true;
      try {
        const refreshedSegments = await getSegments(token, projectId);
        setSegments(refreshedSegments);
      } catch {}
      setMessage(`视频修改任务已提交，正在生成中（本次参考图：${references.length}）`);
    } catch (error) {
      if (!submitted) {
        setManualPendingRowMap((prev) => {
          const next = { ...prev };
          delete next[globalRowIndex];
          return next;
        });
      }
      setMessage(error instanceof Error ? error.message : "视频修改失败");
    } finally {
      setModifyingGlobalRowIndex(null);
    }
  };

  const handleSelectKlingVersion = async (globalRowIndex: number, versionId: string) => {
    if (!projectId) return;
    const token = getToken();
    if (!token) return;
    const segment = segments[globalRowIndex];
    if (!segment?.id || !versionId) return;
    applySelectedVersionForRow(globalRowIndex, versionId);
    try {
      await selectSegmentVersion(token, projectId, segment.id, versionId);
      void getSegments(token, projectId)
        .then((refreshedSegments) => setSegments(refreshedSegments))
        .catch(() => {});
    } catch (error) {
      void getSegments(token, projectId)
        .then((refreshedSegments) => setSegments(refreshedSegments))
        .catch(() => {});
      setMessage(error instanceof Error ? error.message : "切换版本失败");
    }
  };

  const handleDeleteKlingVersion = async (globalRowIndex: number, versionId: string) => {
    if (!projectId) return;
    const token = getToken();
    if (!token) return;
    const segment = segments[globalRowIndex];
    if (!segment?.id || !versionId) return;
    const confirmed = window.confirm("确认删除该视频版本吗？删除后不可恢复。");
    if (!confirmed) return;
    const key = `${globalRowIndex}:${versionId}`;
    setDeletingVersionKey(key);
    try {
      await deleteSegmentVersion(token, projectId, segment.id, versionId);
      const refreshedSegments = await getSegments(token, projectId);
      setSegments(refreshedSegments);
      setMessage("已删除该视频版本");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "删除版本失败");
    } finally {
      setDeletingVersionKey(null);
    }
  };

  if (loading) return <div>加载中...</div>;

  return (
    <div className="h-full flex flex-col space-y-4">
      <div className="flex justify-between items-center">
        <h2 className="text-xl font-bold">Step 4: 生成分镜脚本</h2>
        <div className="flex items-center gap-2">
          <button
            onClick={() => router.push(`/projects/${projectId}/script/assets`)}
            className="rounded-lg border border-slate-200 px-4 py-2 text-sm hover:bg-slate-50 text-slate-600"
          >
            上一步
          </button>
          <button
            onClick={() => {
              syncMergedVideosToStep5(mergedVideoUrlMap);
              router.push(`/projects/${projectId}/script/video`);
            }}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm text-white hover:bg-slate-800"
          >
            下一步：生成配音
          </button>
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm">
        <div className="flex justify-between items-center mb-2">
          <div className="font-semibold">原文剧本 (参考)</div>
          <button
            onClick={() => setIsScriptCollapsed(!isScriptCollapsed)}
            className="text-xs text-slate-500 hover:text-slate-700"
          >
            {isScriptCollapsed ? "展开" : "收起"}
          </button>
        </div>
        {!isScriptCollapsed && (
          <textarea
            value={content}
            readOnly
            className="w-full h-32 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700 resize-none"
            placeholder="暂无剧本内容"
          />
        )}
      </div>

      <div className="flex items-center gap-4">
        <select
          value={selectedModel}
          onChange={(e) => setSelectedModel(e.target.value)}
          className="border p-2 rounded text-sm"
        >
          <option value="gemini-3.1-pro">Gemini 3.1 Pro</option>
          <option value="deepseek-r1-250120">DeepSeek R1 (deepseek-r1)</option>
          <option value="deepseek-v3-241226">DeepSeek V3 (deepseek-v3)</option>
          <option value="gpt-4o-2024-08-06">GPT-4o (gpt-4o)</option>
          <option value="claude-3-5-sonnet-20240620">Claude 3.5 Sonnet</option>
        </select>
        {message && <span className="text-gray-500 text-sm">{message}</span>}
      </div>

      {episodes.length > 0 ? (
        <div className="flex-1 overflow-y-auto space-y-4 pb-10">
            <div className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="flex flex-wrap items-center gap-3">
                    <span className="text-xs text-slate-500">视频设置：</span>
                    <select
                        value={videoResolution}
                        onChange={(e) => setVideoResolution((e.target.value as "720p" | "1080p"))}
                        className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs"
                    >
                        <option value="720p">720p</option>
                        <option value="1080p">1080p</option>
                    </select>
                    <select
                        value={videoAspectRatio}
                        onChange={(e) => setVideoAspectRatio((e.target.value as "9:16" | "16:9" | "1:1"))}
                        className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs"
                    >
                        <option value="9:16">竖屏</option>
                        <option value="16:9">横屏</option>
                        <option value="1:1">方幕</option>
                    </select>
                    <span className="text-xs text-slate-500">视频模型：</span>
                    <select
                        value={selectedVideoModel}
                        onChange={(e) => setSelectedVideoModel(e.target.value as Step4VideoModel)}
                        className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs"
                    >
                        {STEP4_VIDEO_MODEL_OPTIONS.map((item) => (
                          <option key={item.value} value={item.value}>{item.label}</option>
                        ))}
                    </select>
                    <span className="text-xs text-slate-500">音频：</span>
                    <select
                        value={videoAudioMode}
                        onChange={(e) => setVideoAudioMode((e.target.value as "silent" | "with_audio"))}
                        className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs"
                    >
                        <option value="silent">无声</option>
                        <option value="with_audio">有声</option>
                    </select>
                    <span className="text-xs text-slate-500">全局风格：</span>
                    <select
                        value={globalStyle}
                        onChange={(e) => setGlobalStyle(e.target.value)}
                        className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs"
                    >
                        {STYLE_OPTIONS.map((style) => (
                            <option key={style} value={style}>
                                {style}
                            </option>
                        ))}
                    </select>
                </div>
            </div>
            {(() => {
              let rowCursor = 0;
              const episodeRows = episodes.map((episode, index) => {
                const rowStartIndex = rowCursor;
                const rowCount = countStoryboardRows(episode.storyboard || "");
                rowCursor += rowCount;
                const title = episode.title || `第 ${index + 1} 集`;
                const readyClipCount = segments
                  .slice(rowStartIndex, rowStartIndex + rowCount)
                  .map((segment) => getSelectedOrLatestSegmentVideoUrl(segment))
                  .filter(Boolean).length;
                const mergedVideoUrl = mergedVideoUrlMap[index];
                return {
                  episode,
                  index,
                  rowStartIndex,
                  rowCount,
                  title,
                  readyClipCount,
                  mergedVideoUrl,
                };
              });
              const selectedRow = episodeRows[selectedEpisodeIndex] || episodeRows[0];
              if (!selectedRow) return null;
              const { episode, index, rowStartIndex, rowCount, title, readyClipCount, mergedVideoUrl } = selectedRow;
              return (
                <>
                <div className="border border-slate-200 rounded-xl bg-white p-4">
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="text-xs text-slate-500">编辑集数：</span>
                    <select
                      value={index}
                      onChange={(e) => {
                        const nextIndex = Number(e.target.value);
                        setSelectedEpisodeIndex(nextIndex);
                        setExpandedEpisodes((prev) => new Set(prev).add(nextIndex));
                      }}
                      className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs"
                    >
                      {episodeRows.map((item) => (
                        <option key={item.index} value={item.index}>
                          {item.title || `第 ${item.index + 1} 集`}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <div key={index} className="border border-slate-200 rounded-xl overflow-hidden bg-white">
                    <div 
                        className="bg-slate-50 px-4 py-3 flex justify-between items-center cursor-pointer hover:bg-slate-100 transition-colors"
                        onClick={() => toggleEpisodeExpand(index)}
                    >
                        <div className="font-semibold text-slate-800">{title}</div>
                        <div className="flex items-center gap-3">
                            <button
                                onClick={(e) => {
                                    e.stopPropagation();
                                    handleGenerateEpisode(index);
                                }}
                                disabled={generatingEpisodes.has(index) || episode.storyboardTaskStatus === "running" || episode.storyboardTaskStatus === "pending"}
                                className="px-3 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
                            >
                                {generatingEpisodes.has(index) || episode.storyboardTaskStatus === "running" || episode.storyboardTaskStatus === "pending" ? "生成中..." : "生成分镜"}
                            </button>
                            <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setCustomPromptModalEpisodeIndex(index);
                                  setCustomStoryboardPrompt("");
                                }}
                                disabled={generatingEpisodes.has(index) || episode.storyboardTaskStatus === "running" || episode.storyboardTaskStatus === "pending"}
                                className="px-3 py-1 text-xs bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:opacity-50"
                            >
                                按要求生成分镜
                            </button>
                            <button
                                onClick={(e) => {
                                    e.stopPropagation();
                                    void handleMergeEpisodeVideo({
                                      episodeIndex: index,
                                      title,
                                      rowStartIndex,
                                      rowCount,
                                    });
                                }}
                                disabled={mergingEpisodes.has(index) || readyClipCount === 0}
                                className="px-3 py-1 text-xs bg-emerald-600 text-white rounded hover:bg-emerald-700 disabled:opacity-50"
                            >
                                {mergingEpisodes.has(index) ? "合并中..." : "合并视频"}
                            </button>
                            <span className="text-slate-400 text-xs">
                                {expandedEpisodes.has(index) ? "收起" : "展开"}
                            </span>
                        </div>
                    </div>
                    {episode.storyboardTaskStatus === "failed" && episode.storyboardTaskError ? (
                      <div className="px-4 py-2 border-t border-red-100 bg-red-50 text-xs text-red-600">
                        分镜生成失败：{episode.storyboardTaskError}
                      </div>
                    ) : null}
                    
                    {expandedEpisodes.has(index) && (
                        <div className="p-4 border-t border-slate-200">
                             {mergedVideoUrl ? (
                                <div className="mb-4">
                                    <div className="text-xs font-semibold text-slate-500 mb-2">合并视频:</div>
                                    <video src={mergedVideoUrl} controls className="w-full rounded border border-slate-200 bg-black" />
                                </div>
                             ) : null}
                             <div className="mb-4">
                                <div className="text-xs font-semibold text-slate-500 mb-2">本集剧本:</div>
                                <div className="p-3 bg-slate-50 rounded text-xs text-slate-600 max-h-32 overflow-y-auto whitespace-pre-wrap border border-slate-100">
                                    {episode.content}
                                </div>
                             </div>
                             
                             <div>
                                <div className="text-xs font-semibold text-slate-500 mb-2">分镜脚本:</div>
                                <ScriptEditor
                                    content={episode.storyboard || ""}
                                    onChange={(newContent) => handleEpisodeStoryboardChange(index, newContent)}
                                    projectId={projectId}
                                    rowStartIndex={rowStartIndex}
                                    generatingGlobalRowIndex={generatingGlobalRowIndex}
                                    generatedRowIndexSet={generatedRowIndexSet}
                                    pendingRowIndexSet={pendingRowIndexSet}
                                    rowTaskStatusMap={rowTaskStatusMap}
                                    rowTaskIdMap={rowTaskIdMap}
                                    rowVideoUrlMap={rowVideoUrlMap}
                                    rowVersionListMap={rowVersionListMap}
                                    rowSelectedVersionIdMap={rowSelectedVersionIdMap}
                                    onGenerateKlingRow={handleGenerateKlingRow}
                                    onModifyKlingRow={handleModifyKlingRow}
                                    modifyingGlobalRowIndex={modifyingGlobalRowIndex}
                                    onSelectKlingVersion={handleSelectKlingVersion}
                                    onDeleteKlingVersion={handleDeleteKlingVersion}
                                    deletingVersionKey={deletingVersionKey}
                                />
                             </div>
                        </div>
                    )}
                </div>
                </>
              );
            })()}
        </div>
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center text-slate-500 border-2 border-dashed border-slate-200 rounded-xl">
             <p className="mb-2">暂无分集数据</p>
             <p className="text-sm">请先在 Step 1 生成并拆分剧本</p>
             <button 
                onClick={() => router.push(`/projects/${projectId}/script/input`)}
                className="mt-4 px-4 py-2 bg-slate-100 hover:bg-slate-200 rounded-lg text-sm text-slate-700"
             >
                前往 Step 1
             </button>
        </div>
      )}

      {customPromptModalEpisodeIndex !== null ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => {
            if (customPromptSubmittingEpisodeIndex !== null) return;
            setCustomPromptModalEpisodeIndex(null);
          }}
        >
          <div className="w-full max-w-2xl rounded-xl bg-white p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 text-sm font-semibold text-slate-800">按要求生成分镜</div>
            <textarea
              value={customStoryboardPrompt}
              onChange={(e) => setCustomStoryboardPrompt(e.target.value)}
              placeholder="请输入本次额外要求（自然语言）"
              className="h-40 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-indigo-500"
            />
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setCustomPromptModalEpisodeIndex(null)}
                disabled={customPromptSubmittingEpisodeIndex !== null}
                className="rounded-lg border border-slate-200 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => {
                  void handleGenerateEpisodeWithCustomPrompt();
                }}
                disabled={customPromptSubmittingEpisodeIndex !== null || !customStoryboardPrompt.trim()}
                className="rounded-lg bg-indigo-600 px-4 py-2 text-sm text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                {customPromptSubmittingEpisodeIndex !== null ? "生成中..." : "生成分镜"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
