"use client";

import { useEffect, useMemo, useState, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import { deleteSegmentFrameImage, deleteSegmentVersion, generateSegment, generateSegmentFrameImage, getAssets, getScript, getSegmentFrameImageTaskStatus, getSegments, getStoryboardTaskStatus, mergeEpisodeOnServer, saveScript, selectSegmentVersion, startStoryboardTask, type Asset, type Episode, type Segment, type SegmentVersion } from "@/lib/api";
import { getToken } from "@/lib/auth";
import { ScriptEditor } from "@/app/components/ScriptEditor";

const SEPARATOR = "\n\n=== 原文剧本 (请勿删除此行) ===\n\n";

type StyleTabKey = "custom" | "realistic" | "three_d" | "two_d" | "director";

type StylePresetItem = {
  name: string;
  description: string;
  image: string;
};

type CustomStyleItem = {
  id: string;
  name: string;
  prompt: string;
  image: string;
  description: string;
};

const MAX_CUSTOM_STYLE_COUNT = 12;
const MAX_CUSTOM_STYLE_IMAGE_DATA_URL_LENGTH = 1_000_000;

const isOversizedCustomStyleImage = (image: string): boolean => {
  const value = String(image || "").trim();
  return value.startsWith("data:image") && value.length > MAX_CUSTOM_STYLE_IMAGE_DATA_URL_LENGTH;
};

const loadImageElement = (dataUrl: string): Promise<HTMLImageElement> => new Promise((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = () => reject(new Error("图片读取失败"));
  img.src = dataUrl;
});

const compressCustomStyleImage = async (dataUrl: string): Promise<string> => {
  const source = String(dataUrl || "").trim();
  if (!source.startsWith("data:image")) return source;
  try {
    const image = await loadImageElement(source);
    const maxEdge = 1280;
    const sourceWidth = Math.max(1, Number(image.naturalWidth) || 1);
    const sourceHeight = Math.max(1, Number(image.naturalHeight) || 1);
    const scale = Math.min(1, maxEdge / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return source;
    context.drawImage(image, 0, 0, width, height);
    const qualityList = [0.9, 0.82, 0.74, 0.66, 0.56];
    let result = source;
    for (const quality of qualityList) {
      const candidate = canvas.toDataURL("image/jpeg", quality);
      result = candidate;
      if (!isOversizedCustomStyleImage(candidate)) {
        return candidate;
      }
    }
    return result;
  } catch {
    return source;
  }
};

const REALISTIC_STYLE_PRESETS: StylePresetItem[] = [
  { name: "徐克武侠", description: "占位描述：强调写意武打、强动势镜头与冷暖对比光影。", image: "https://picsum.photos/seed/xu-ke-wuxia/480/280" },
  { name: "赛博朋克", description: "占位描述：霓虹高对比、雨夜反光、科技与街头混合视觉。", image: "https://picsum.photos/seed/cyberpunk-neon/480/280" },
  { name: "胶片质感", description: "占位描述：颗粒、偏色、柔和高光与复古曝光风格。", image: "https://picsum.photos/seed/film-grain-look/480/280" },
];

const THREE_D_STYLE_PRESETS: StylePresetItem[] = [
  { name: "3D 写实渲染", description: "占位描述：物理材质真实，体积光与反射细节完整。", image: "https://picsum.photos/seed/3d-realistic/480/280" },
  { name: "3D 超写实渲染", description: "占位描述：超高细节皮肤与材质，电影级真实度。", image: "https://picsum.photos/seed/3d-hyperreal/480/280" },
  { name: "3D 虚幻引擎风", description: "占位描述：虚幻风格光照与高动态场景表现。", image: "https://picsum.photos/seed/3d-unreal/480/280" },
  { name: "3D 游戏 CG", description: "占位描述：游戏宣传片质感，角色与场景冲击力强。", image: "https://picsum.photos/seed/3d-game-cg/480/280" },
  { name: "3D 半写实", description: "占位描述：兼顾真实体积与风格化造型。", image: "https://picsum.photos/seed/3d-semi-real/480/280" },
  { name: "3D 皮克斯风", description: "占位描述：圆润体块与温暖色调，角色表情夸张。", image: "https://picsum.photos/seed/3d-pixar/480/280" },
  { name: "3D 迪士尼风", description: "占位描述：叙事感强、童话光效与精致角色设计。", image: "https://picsum.photos/seed/3d-disney/480/280" },
  { name: "3D 萌系 Q 版", description: "占位描述：Q 版比例与可爱表情，色彩明快。", image: "https://picsum.photos/seed/3d-chibi/480/280" },
  { name: "3D 粘土风", description: "占位描述：手工黏土材质触感，柔和布光。", image: "https://picsum.photos/seed/3d-clay/480/280" },
  { name: "3D 三渲二", description: "占位描述：3D 结构结合 2D 渲染线条与平涂。", image: "https://picsum.photos/seed/3d-toon/480/280" },
  { name: "3D Low Poly", description: "占位描述：低多边形几何造型，简洁块面语言。", image: "https://picsum.photos/seed/3d-lowpoly/480/280" },
];

const TWO_D_STYLE_PRESETS: StylePresetItem[] = [
  { name: "2D 动画", description: "占位描述：传统动画分层、运动夸张、节奏鲜明。", image: "https://picsum.photos/seed/2d-animation/480/280" },
  { name: "2D 日式动漫", description: "占位描述：日漫线稿与赛璐璐上色，分镜节奏强。", image: "https://picsum.photos/seed/2d-anime/480/280" },
  { name: "2D 国漫风", description: "占位描述：东方美术语汇与现代动画融合。", image: "https://picsum.photos/seed/2d-guoman/480/280" },
  { name: "2D 美式卡通", description: "占位描述：美卡夸张造型与高饱和色彩表现。", image: "https://picsum.photos/seed/2d-american-cartoon/480/280" },
  { name: "2D Q 版卡通", description: "占位描述：Q 版比例、轻松气氛、表情强化。", image: "https://picsum.photos/seed/2d-chibi-cartoon/480/280" },
  { name: "2D 水彩油画", description: "占位描述：笔触层次与湿画法扩散质感。", image: "https://picsum.photos/seed/2d-watercolor-oil/480/280" },
  { name: "2D 水墨国风", description: "占位描述：留白、水墨晕染与东方意境构图。", image: "https://picsum.photos/seed/2d-ink-style/480/280" },
  { name: "2D 赛博风格", description: "占位描述：二维线条结合未来科技与霓虹氛围。", image: "https://picsum.photos/seed/2d-cyber-style/480/280" },
];

const DIRECTOR_STYLE_PRESETS: StylePresetItem[] = [
  { name: "阿尔弗雷德・希区柯克", description: "占位描述：悬疑构图、心理压迫与视觉暗示。", image: "https://picsum.photos/seed/director-hitchcock/480/280" },
  { name: "斯坦利・库布里克", description: "占位描述：对称构图、冷静运动、空间秩序感。", image: "https://picsum.photos/seed/director-kubrick/480/280" },
  { name: "黑泽明", description: "占位描述：动态调度、群像场面与自然力量表达。", image: "https://picsum.photos/seed/director-kurosawa/480/280" },
  { name: "费德里科・费里尼", description: "占位描述：梦境叙事、夸张人物与戏剧化场面。", image: "https://picsum.photos/seed/director-fellini/480/280" },
  { name: "英格玛・伯格曼", description: "占位描述：人物内心与静默空间的哲思表达。", image: "https://picsum.photos/seed/director-bergman/480/280" },
  { name: "李安", description: "占位描述：细腻情感推进与节制的镜头表达。", image: "https://picsum.photos/seed/director-ang-lee/480/280" },
  { name: "王家卫", description: "占位描述：都市情绪、色彩霓虹与碎片化时间感。", image: "https://picsum.photos/seed/director-wkw/480/280" },
  { name: "张艺谋", description: "占位描述：强烈色彩符号与仪式化视觉场面。", image: "https://picsum.photos/seed/director-zhangyimou/480/280" },
  { name: "陈凯歌", description: "占位描述：史诗气质与人物命运的戏剧张力。", image: "https://picsum.photos/seed/director-chenkai-ge/480/280" },
  { name: "侯孝贤", description: "占位描述：长镜头、日常观察与留白叙事。", image: "https://picsum.photos/seed/director-houhsiaohsien/480/280" },
];

const STYLE_PRESET_TABS: Array<{ key: Exclude<StyleTabKey, "custom">; label: string; styles: StylePresetItem[] }> = [
  { key: "realistic", label: "真人写实", styles: REALISTIC_STYLE_PRESETS },
  { key: "three_d", label: "3D风格", styles: THREE_D_STYLE_PRESETS },
  { key: "two_d", label: "2D风格", styles: TWO_D_STYLE_PRESETS },
  { key: "director", label: "导演风格", styles: DIRECTOR_STYLE_PRESETS },
];

const PRESET_STYLE_NAMES = STYLE_PRESET_TABS.flatMap((tab) => tab.styles.map((item) => item.name));
const PRESET_STYLE_PROMPT_MAP: Record<string, string> = Object.fromEntries(
  PRESET_STYLE_NAMES.map((style) => [style, `全局视觉风格：${style}。请保持整集分镜在美术气质、光影语气、镜头审美上的统一。`])
);
const KLING_COLUMN = "生成视频";
const LEGACY_KLING_COLUMN = "Kling视频生成";
const STEP4_VIDEO_MODEL_OPTIONS = [
  { value: "klingv3omni", label: "Kling v3 Omni" },
  { value: "seedance2.0", label: "Seedance 2.0" },
] as const;
const MAX_VIDEO_REFERENCE_IMAGES = 8;
type Step4VideoModel = (typeof STEP4_VIDEO_MODEL_OPTIONS)[number]["value"];

function resolveStep4VideoModel(model: Step4VideoModel): string {
  if (model === "klingv3omni") return "kling-v3-omni";
  return "doubao-seedance-2-0-260128";
}
const TABLE_HEADER_KEYWORDS = ["时间轴", "分镜", "分段时长", "镜头", "景别", "机位", "运镜", "内容", "台词", "画面", "提示词", "prompt", "角色", "场景", "道具", "备注"];
const COLUMN_MEANING_MAP: Record<string, string> = {
  分镜: "当前连续镜头的起始画面与场景基底说明",
  分段时长: "当前分段的时长与节奏控制信息",
  时间轴: "镜头在整段视频中的时间位置与节奏",
  镜头调度与内容: "按秒段拆分的运镜、动作、台词、表情与定格画面指令",
  镜头调度与内容融合: "起始、过程、定格画面一体化的镜头与内容指令",
  镜头景别与机位: "镜头远近、视角和机位关系",
  运镜手法: "镜头运动方式与运动路径",
  "内容/台词": "该镜头中人物动作、对白与叙事信息",
  画面描述: "画面主体、环境、构图、光影与氛围",
  定格画面: "镜头结束瞬间的画面终态与下镜头衔接锚点",
  角色: "角色外观与服装造型的视觉约束（兼容旧表头）",
  角色形象: "角色外观与服装造型的视觉约束",
  形象: "角色或主体参考形象信息",
  道具: "需要出现并保持一致的道具元素",
  场景: "拍摄场景、空间结构与环境状态",
  远景位置关系图: "远景构图、空间层次与主体位置关系参考图信息",
  首帧图片: "当前镜头首帧参考图或首帧图片链接",
  生成视频: "当前行的视频生成与素材管理操作列",
  备注: "补充的导演要求与约束条件",
};
const VIDEO_FIELD_ORDER = ["分镜", "分段时长", "镜头调度与内容", "角色形象", "场景", "道具", "远景位置关系图", "首帧图片", "备注", "时间轴", "镜头调度与内容融合", "画面描述", "镜头景别与机位", "运镜手法", "内容/台词", "定格画面"] as const;

type KlingAssetRole = "character" | "scene" | "prop" | "first_frame";
type VideoGenerateRowPayload = {
  globalRowIndex: number;
  previousGlobalRowIndex?: number;
  headers: string[];
  row: string[];
  usePreviousSegmentEndFrame?: boolean;
  customFirstFrameUrl?: string;
  customLastFrameUrl?: string;
};
const VIDEO_ASSET_ROLE_PRIORITY: Record<KlingAssetRole, number> = {
  first_frame: 4,
  character: 3,
  scene: 2,
  prop: 1,
};
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
const getBatchFirstFrameStorageKey = (projectId: string) => `storyboard-batch-first-frame-v2:${projectId}`;
const getScriptEditorFrameStateStorageKey = (projectId: string) => `script_editor_frame_state_v2:${projectId}`;
const FRAME_MATERIAL_REF_START = "<!-- MATERIAL_REF_START -->";
const FRAME_MATERIAL_REF_END = "<!-- MATERIAL_REF_END -->";

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

function readBatchFirstFramePersist(projectId: string): Record<string, BatchFirstFramePersistItem> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(getBatchFirstFrameStorageKey(projectId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, BatchFirstFramePersistItem>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeBatchFirstFramePersist(projectId: string, value: Record<string, BatchFirstFramePersistItem>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(getBatchFirstFrameStorageKey(projectId), JSON.stringify(value));
  } catch {}
}

function addFirstFrameImageToMaterialManagerState(
  projectId: string,
  rowIndex: number,
  imageUrl: string,
  meta?: { name?: string; description?: string }
) {
  if (typeof window === "undefined") return;
  const normalizedUrl = String(imageUrl || "").trim();
  if (!normalizedUrl) return;
  try {
    const raw = window.localStorage.getItem(getScriptEditorFrameStateStorageKey(projectId));
    const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const firstImageMap = (parsed.firstImageMap as Record<string, string[]>) || {};
    const generatedMetaMap = (parsed.generatedMetaMap as Record<string, Record<string, unknown>>) || {};
    const rowKey = String(rowIndex);
    const currentList = Array.isArray(firstImageMap[rowKey]) ? firstImageMap[rowKey] : [];
    firstImageMap[rowKey] = [normalizedUrl, ...currentList.filter((item) => String(item || "").trim() !== normalizedUrl)];
    generatedMetaMap[normalizedUrl] = {
      ...(generatedMetaMap[normalizedUrl] || {}),
      name: String(meta?.name || "").trim(),
      description: String(meta?.description || "").trim(),
      frameType: "first",
    };
    window.localStorage.setItem(
      getScriptEditorFrameStateStorageKey(projectId),
      JSON.stringify({ ...parsed, firstImageMap, generatedMetaMap })
    );
  } catch {}
}

function removeFirstFrameImageFromMaterialManagerState(projectId: string, rowIndex: number, imageUrl: string) {
  if (typeof window === "undefined") return;
  const normalizedUrl = String(imageUrl || "").trim();
  if (!normalizedUrl) return;
  try {
    const raw = window.localStorage.getItem(getScriptEditorFrameStateStorageKey(projectId));
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const firstImageMap = (parsed.firstImageMap as Record<string, string[]>) || {};
    const rowKey = String(rowIndex);
    const currentList = Array.isArray(firstImageMap[rowKey]) ? firstImageMap[rowKey] : [];
    firstImageMap[rowKey] = currentList.filter((item) => String(item || "").trim() !== normalizedUrl);
    window.localStorage.setItem(
      getScriptEditorFrameStateStorageKey(projectId),
      JSON.stringify({ ...parsed, firstImageMap })
    );
    window.dispatchEvent(new CustomEvent("script-editor-frame-state-updated", { detail: { projectId } }));
  } catch {}
}

function extractAssetTokensFromCell(cell: string) {
  const regex = /\[AssetID:\s*([^\]]+)\]/g;
  const tokens: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(cell)) !== null) {
    if (match[1]) tokens.push(match[1].trim());
  }
  return Array.from(new Set(tokens.filter(Boolean)));
}

function removeAssetTokensFromText(text: string) {
  return String(text || "")
    .replace(/\[AssetID:\s*[^\]]+\]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildPromptWithAssetTokens(plainText: string, assetIds: string[]) {
  const cleanText = String(plainText || "").trim();
  const tokenLines = Array.from(new Set((assetIds || []).map((id) => String(id || "").trim()).filter(Boolean))).map((id) => `[AssetID:${id}]`);
  return [cleanText, ...tokenLines].filter(Boolean).join("\n");
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
  if (normalized.includes("远景位置关系图")) return "scene";
  if (normalized.includes("角色") || normalized === "形象") return "character";
  if (normalized.includes("场景")) return "scene";
  if (normalized.includes("道具")) return "prop";
  return null;
}

function extractInlineMaterialBindingsFromCell(cell: string, role: KlingAssetRole) {
  const blockRegex = /<!--\s*MATERIAL_REF_START\s*-->[\s\S]*?<!--\s*MATERIAL_REF_END\s*-->/g;
  const blocks = String(cell || "").match(blockRegex) || [];
  const bindings: Array<{ role: KlingAssetRole; image_url: string; name?: string; description?: string; base_character_name?: string }> = [];
  const seen = new Set<string>();
  blocks.forEach((block) => {
    if (extractAssetTokensFromCell(block).length > 0) return;
    const imageUrl = String(block.match(/!\[[^\]]*\]\(([^)]+)\)/)?.[1] || "").trim();
    if (!imageUrl) return;
    const name = String(block.match(/素材名\s*[：:]\s*([^\n]+)/)?.[1] || "").trim();
    const description = String(block.match(/素材描述\s*[：:]\s*([^\n]+)/)?.[1] || "").trim();
    const baseCharacterName = String(block.match(/基础角色\s*[：:]\s*([^\n]+)/)?.[1] || "").trim();
    const key = `${role}|${imageUrl}`;
    if (seen.has(key)) return;
    seen.add(key);
    bindings.push({
      role,
      image_url: imageUrl,
      name: name || undefined,
      description: description || undefined,
      base_character_name: role === "character" && baseCharacterName ? baseCharacterName : undefined,
    });
  });
  return bindings;
}

function findSegmentForRow(segments: Segment[], globalRowIndex: number) {
  return segments.find((item) => Number(item.order_index) === globalRowIndex + 1) || segments[globalRowIndex];
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
  if (field === "分镜") {
    return normalizedHeaders.findIndex((h) => h.includes("分镜"));
  }
  if (field === "分段时长" || field === "时间轴") {
    return normalizedHeaders.findIndex((h) => h.includes("分段时长") || h.includes("时间轴") || h.includes("时长"));
  }
  if (field === "镜头调度与内容") {
    return normalizedHeaders.findIndex((h) => h.includes("镜头调度与内容") || (h.includes("镜头") && h.includes("内容")));
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
  if (field === "角色" || field === "角色形象") {
    return normalizedHeaders.findIndex((h) => h.includes("角色形象") || h === "形象" || h.includes("角色"));
  }
  if (field === "道具") {
    return normalizedHeaders.findIndex((h) => h.includes("道具"));
  }
  if (field === "场景") {
    return normalizedHeaders.findIndex((h) => h.includes("场景"));
  }
  if (field === "远景位置关系图") {
    return normalizedHeaders.findIndex((h) => h.includes("远景位置关系图"));
  }
  if (field === "首帧图片") {
    return normalizedHeaders.findIndex((h) => h.includes("首帧") || h.includes("首位帧") || h.includes("起始帧"));
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

function sanitizeVideoPromptCell(text: string) {
  return String(text || "")
    .replace(/\[AssetID:\s*[^\]]+\]/gi, "")
    .replace(/<!--\s*MATERIAL_REF_START\s*-->/gi, "")
    .replace(/<!--\s*MATERIAL_REF_END\s*-->/gi, "")
    .replace(/!\[[^\]]*\]\(([^)]+)\)/g, "")
    .replace(/^\s*素材类型\s*[：:].*$/gim, "")
    .replace(/^\s*素材名\s*[：:].*$/gim, "")
    .replace(/^\s*素材描述\s*[：:].*$/gim, "")
    .replace(/^\s*基础角色\s*[：:].*$/gim, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitFreezeFrameInstruction(text: string) {
  const sanitized = sanitizeVideoPromptCell(text);
  if (!sanitized) {
    return { motionText: "", freezeFrameText: "" };
  }
  const motionLines: string[] = [];
  const freezeFrameLines: string[] = [];
  sanitized.split("\n").forEach((line) => {
    const trimmed = line.trim();
    if (/^定格画面\s*[：:]/i.test(trimmed)) {
      const value = trimmed.replace(/^定格画面\s*[：:]\s*/i, "").trim();
      if (value) freezeFrameLines.push(value);
      return;
    }
    motionLines.push(line);
  });
  return {
    motionText: motionLines.join("\n").trim(),
    freezeFrameText: freezeFrameLines.join("\n").trim(),
  };
}

function resolveRowMotionText(headers: string[], row: string[]) {
  const motionIndex = findFieldIndex(headers, "镜头调度与内容");
  if (motionIndex >= 0) {
    return splitFreezeFrameInstruction(row[motionIndex] || "");
  }
  const fusionIndex = findFieldIndex(headers, "镜头调度与内容融合");
  if (fusionIndex >= 0) {
    return splitFreezeFrameInstruction(row[fusionIndex] || "");
  }
  return { motionText: "", freezeFrameText: "" };
}

function resolveRowFreezeFrameText(headers: string[], row: string[]) {
  const explicitFreezeIndex = findFieldIndex(headers, "定格画面");
  const explicitFreezeText = explicitFreezeIndex >= 0 ? sanitizeVideoPromptCell(row[explicitFreezeIndex] || "") : "";
  if (explicitFreezeText) return explicitFreezeText;
  return resolveRowMotionText(headers, row).freezeFrameText;
}

function formatDurationLabel(seconds: number) {
  const safe = Number.isFinite(seconds) ? seconds : 0;
  if (Math.abs(safe - Math.round(safe)) < 0.001) {
    return `${Math.round(safe)}s`;
  }
  return `${safe.toFixed(1).replace(/\.0$/, "")}s`;
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

type EpisodeTableContext = {
  prefix: string;
  suffix: string;
  headers: string[];
  rows: string[][];
};

type BatchFirstFrameMaterialTab = "character" | "baseCharacter" | "prop" | "scene" | "first" | "last" | "wide";

type BatchFirstFrameItem = {
  rowIndex: number;
  tabLabel: string;
  prompt: string;
  status: "idle" | "generating" | "success" | "failed";
  generatedImages: string[];
  appliedImageUrl?: string;
  scriptAppliedImageUrl?: string;
  error?: string;
  references: string[];
};

type BatchFirstFramePersistItem = {
  prompt: string;
  generatedImages: string[];
  appliedImageUrl?: string;
  scriptAppliedImageUrl?: string;
  references: string[];
};

const BATCH_FIRST_FRAME_MATERIAL_TABS: Array<{ key: BatchFirstFrameMaterialTab; label: string }> = [
  { key: "character", label: "角色形象" },
  { key: "baseCharacter", label: "基础角色" },
  { key: "prop", label: "道具" },
  { key: "scene", label: "场景" },
  { key: "first", label: "首帧" },
  { key: "last", label: "尾帧" },
  { key: "wide", label: "远景位置关系图" },
];

const BATCH_FIRST_FRAME_ASPECT_RATIO_OPTIONS: Array<{ label: string; value: "9:16" | "3:4" | "1:1" | "4:3" | "16:9" }> = [
  { label: "竖屏（9:16）", value: "9:16" },
  { label: "竖构图（3:4）", value: "3:4" },
  { label: "方图（1:1）", value: "1:1" },
  { label: "横构图（4:3）", value: "4:3" },
  { label: "横屏（16:9）", value: "16:9" },
];

function resolveBatchFirstFrameMaterialTabByAssetType(typeValue?: string | null): BatchFirstFrameMaterialTab {
  const rawType = String(typeValue || "").trim().toUpperCase();
  const normalized = rawType.toLowerCase().replace(/\s+/g, "");
  if (!normalized) return "first";
  if (rawType === "CHARACTER_LOOK" || normalized.includes("look") || normalized.includes("角色形象")) return "character";
  if (rawType === "CHARACTER" || normalized === "character" || normalized.includes("base") || normalized.includes("基础角色")) return "baseCharacter";
  if (normalized.includes("prop") || normalized.includes("道具")) return "prop";
  if (normalized.includes("scene") || normalized.includes("场景")) return "scene";
  if (normalized.includes("wide") || normalized.includes("远景")) return "wide";
  if (normalized.includes("last") || normalized.includes("尾帧")) return "last";
  if (normalized.includes("角色") || normalized.includes("形象")) return "character";
  return "first";
}

function getAssetPreviewUrl(asset: Asset) {
  const versions = asset.versions || [];
  const normalizeUrl = (value?: string | null) => resolveBackendMediaUrl(String(value || "").trim());
  const selected = versions.find((version) => version.is_selected && normalizeUrl(version.image_url));
  if (selected?.image_url) return normalizeUrl(selected.image_url);
  const latest = [...versions].reverse().find((version) => normalizeUrl(version.image_url));
  if (latest?.image_url) return normalizeUrl(latest.image_url);
  return "";
}

function getBatchPreviewColumnClass(total: number) {
  if (total <= 4) return "grid-cols-1 sm:grid-cols-2";
  if (total <= 9) return "grid-cols-1 sm:grid-cols-2 md:grid-cols-3";
  if (total <= 16) return "grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4";
  return "grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5";
}

function isTableSeparatorLine(line: string) {
  const trimmed = String(line || "").trim();
  if (!trimmed.startsWith("|")) return false;
  return trimmed.replace(/\||-|:|\s/g, "") === "";
}

function splitTableLine(line: string) {
  const trimmed = String(line || "").trim();
  const raw = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let current = "";
  let escaped = false;
  for (const ch of raw) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "|") {
      cells.push(current.trim().replace(/<br\s*\/?>/gi, "\n"));
      current = "";
      continue;
    }
    current += ch;
  }
  cells.push(current.trim().replace(/<br\s*\/?>/gi, "\n"));
  return cells;
}

function serializeTable(headers: string[], rows: string[][]) {
  const safeHeaders = [...headers];
  const normalizedRows = rows.map((row) => {
    const cells = [...row];
    while (cells.length < safeHeaders.length) cells.push("");
    return cells.slice(0, safeHeaders.length);
  });
  const escapeCell = (cell: string) => String(cell || "").replace(/\|/g, "\\|").replace(/\n/g, "<br>");
  const headerLine = `| ${safeHeaders.map(escapeCell).join(" | ")} |`;
  const sepLine = `| ${safeHeaders.map(() => "---").join(" | ")} |`;
  const rowLines = normalizedRows.map((row) => `| ${row.map(escapeCell).join(" | ")} |`);
  return [headerLine, sepLine, ...rowLines].join("\n");
}

function parseEpisodeTableContext(storyboardText: string): EpisodeTableContext | null {
  const text = String(storyboardText || "");
  const lines = text.split("\n");
  const separatorRegex = /^\s*\|?[\s:-]+\|[\s|:-]*$/;
  let fallbackContext: EpisodeTableContext | null = null;
  for (let i = 0; i < lines.length - 1; i += 1) {
    const current = String(lines[i] || "").trim();
    const next = String(lines[i + 1] || "").trim();
    if (!current.startsWith("|") || !separatorRegex.test(next)) continue;
    let end = i + 2;
    while (end < lines.length && String(lines[end] || "").trim().startsWith("|")) {
      end += 1;
    }
    const headers = splitTableLine(lines[i]);
    const rows = lines
      .slice(i + 2, end)
      .filter((line) => !isTableSeparatorLine(line))
      .map((line) => splitTableLine(line));
    const context: EpisodeTableContext = {
      prefix: lines.slice(0, i).join("\n").trim(),
      suffix: lines.slice(end).join("\n").trim(),
      headers,
      rows,
    };
    const normalizedHeaders = headers.map((header) => String(header || "").replace(/\s+/g, ""));
    const hasStoryboardColumn = normalizedHeaders.some((header) => header.includes("分镜"));
    if (hasStoryboardColumn) return context;
    if (!fallbackContext) fallbackContext = context;
  }
  return fallbackContext;
}

function rebuildEpisodeStoryboardFromTable(context: EpisodeTableContext) {
  const table = serializeTable(context.headers, context.rows);
  return [context.prefix, table, context.suffix].filter((part) => String(part || "").trim()).join("\n\n");
}

function findColumnIndexByIncludes(headers: string[], matcherList: string[]) {
  const normalized = headers.map((header) => String(header || "").replace(/\s+/g, ""));
  return normalized.findIndex((header) => matcherList.some((matcher) => header.includes(matcher)));
}

function stripCellToPlainText(cell: string) {
  return String(cell || "")
    .replace(/!\[[^\]]*\]\(([^)]+)\)/g, "")
    .replace(/\[AssetID:\s*[^\]]+\]/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .trim();
}

function toChineseNumber(indexFromOne: number) {
  const digits = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
  if (indexFromOne <= 10) {
    if (indexFromOne === 10) return "十";
    return digits[indexFromOne] || String(indexFromOne);
  }
  if (indexFromOne < 20) {
    return `十${digits[indexFromOne % 10] || ""}`;
  }
  const tens = Math.floor(indexFromOne / 10);
  const ones = indexFromOne % 10;
  return `${digits[tens] || tens}十${ones ? digits[ones] : ""}`;
}

function stripThinkingContent(text: string) {
  const source = String(text || "");
  let cleaned = source.replace(/<think>[\s\S]*?<\/think>/gi, "");
  if (/<think>/i.test(cleaned) && !/<\/think>/i.test(cleaned)) {
    const thinkStart = cleaned.search(/<think>/i);
    const tail = cleaned.slice(thinkStart);
    const firstContentOffset = tail.search(/^\s*(\|.+\||#{1,6}\s+.+)$/m);
    const fallbackOffset = tail.search(/\S/m);
    if (thinkStart >= 0) {
      if (firstContentOffset >= 0) {
        cleaned = `${cleaned.slice(0, thinkStart)}${tail.slice(firstContentOffset)}`;
      } else if (fallbackOffset >= 0) {
        cleaned = `${cleaned.slice(0, thinkStart)}${tail.slice(fallbackOffset)}`;
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
  const [actionToast, setActionToast] = useState<{ type: "error" | "success" | "info"; text: string } | null>(null);
  const [selectedModel, setSelectedModel] = useState("gemini-3.1-pro-preview");
  const [customStyles, setCustomStyles] = useState<CustomStyleItem[]>([]);
  const [globalStyle, setGlobalStyle] = useState("徐克武侠");
  const [isStyleModalOpen, setIsStyleModalOpen] = useState(false);
  const [activeStyleTab, setActiveStyleTab] = useState<StyleTabKey>("realistic");
  const [showCreateCustomStyle, setShowCreateCustomStyle] = useState(false);
  const [newCustomStyleName, setNewCustomStyleName] = useState("");
  const [newCustomStylePrompt, setNewCustomStylePrompt] = useState("");
  const [newCustomStyleImage, setNewCustomStyleImage] = useState("");
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
  const [batchFirstFrameModalEpisodeIndex, setBatchFirstFrameModalEpisodeIndex] = useState<number | null>(null);
  const [batchFirstFrameActiveTabIndex, setBatchFirstFrameActiveTabIndex] = useState(0);
  const [batchFirstFrameItems, setBatchFirstFrameItems] = useState<BatchFirstFrameItem[]>([]);
  const [batchFirstFrameModel, setBatchFirstFrameModel] = useState("nano-banana-2");
  const [batchFirstFrameAspectRatio, setBatchFirstFrameAspectRatio] = useState<"9:16" | "3:4" | "1:1" | "4:3" | "16:9">("16:9");
  const [batchFirstFrameQuickChannel, setBatchFirstFrameQuickChannel] = useState(false);
  const [batchFirstFrameMaterialTab, setBatchFirstFrameMaterialTab] = useState<BatchFirstFrameMaterialTab>("first");
  const [batchFirstFrameShowAllPreview, setBatchFirstFrameShowAllPreview] = useState(false);
  const [batchImagePreviewUrl, setBatchImagePreviewUrl] = useState<string | null>(null);
  const [batchImagePreviewTitle, setBatchImagePreviewTitle] = useState("图片预览");

  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastSavedContentRef = useRef("");
  const lastSavedStoryboardRef = useRef("");
  const lastSavedEpisodesRef = useRef<Episode[]>([]);
  const hydratingRef = useRef(false);
  const storyboardPollTimerRef = useRef<NodeJS.Timeout | null>(null);
  const storyboardStartInFlightRef = useRef<Set<number>>(new Set());
  const batchPromptEditorRef = useRef<HTMLDivElement | null>(null);
  const batchPromptSelectionRef = useRef<Range | null>(null);

  // Load/Save selected model from/to localStorage
  useEffect(() => {
    if (!projectId) return;
    const key = `storyboard-model-${projectId}`;
    const saved = localStorage.getItem(key);
    if (saved) {
      setSelectedModel(saved === "gemini-3-pro" || saved === "gemini-3.1-pro" ? "gemini-3.1-pro-preview" : saved);
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
    const key = `storyboard-custom-styles-${projectId}`;
    try {
      const raw = localStorage.getItem(key);
      if (!raw) {
        setCustomStyles([]);
        return;
      }
      const parsed = JSON.parse(raw) as CustomStyleItem[];
      if (!Array.isArray(parsed)) {
        setCustomStyles([]);
        return;
      }
      const normalized = parsed
        .map((item) => ({
          id: String(item.id || "").trim(),
          name: String(item.name || "").trim(),
          prompt: String(item.prompt || "").trim(),
          image: String(item.image || "").trim(),
          description: String(item.description || "").trim(),
        }))
        .filter((item) => item.id && item.name && item.image && !isOversizedCustomStyleImage(item.image))
        .slice(0, MAX_CUSTOM_STYLE_COUNT);
      setCustomStyles(normalized);
    } catch {
      setCustomStyles([]);
    }
  }, [projectId]);

  useEffect(() => {
    if (!projectId) return;
    const key = `storyboard-custom-styles-${projectId}`;
    const persistList = customStyles
      .filter((item) => item.id && item.name && item.image && !isOversizedCustomStyleImage(item.image))
      .slice(0, MAX_CUSTOM_STYLE_COUNT);
    let candidate = persistList;
    while (candidate.length > 0) {
      try {
        localStorage.setItem(key, JSON.stringify(candidate));
        return;
      } catch {
        candidate = candidate.slice(0, candidate.length - 1);
      }
    }
    try {
      localStorage.removeItem(key);
    } catch {}
  }, [projectId, customStyles]);

  useEffect(() => {
    if (!projectId) return;
    const key = `storyboard-style-${projectId}`;
    const saved = String(localStorage.getItem(key) || "").trim();
    if (!saved) return;
    const existsInPreset = PRESET_STYLE_NAMES.includes(saved);
    const existsInCustom = customStyles.some((item) => item.name === saved);
    if (existsInPreset || existsInCustom) {
      setGlobalStyle(saved);
      return;
    }
    setGlobalStyle("徐克武侠");
  }, [projectId, customStyles]);

  useEffect(() => {
    if (!projectId || !globalStyle) return;
    const key = `storyboard-style-${projectId}`;
    localStorage.setItem(key, globalStyle);
  }, [projectId, globalStyle]);

  const globalStylePromptText = useMemo(() => {
    const customStyle = customStyles.find((item) => item.name === globalStyle);
    if (customStyle) {
      return `全局视觉风格：${customStyle.name}。风格提示：${customStyle.prompt || customStyle.description || "请保持统一的视觉审美"}。请保持整集分镜在美术气质、光影语气、镜头审美上的统一。`;
    }
    return PRESET_STYLE_PROMPT_MAP[globalStyle] || `全局视觉风格：${globalStyle}`;
  }, [customStyles, globalStyle]);

  useEffect(() => {
    if (episodes.length === 0) {
      setSelectedEpisodeIndex(0);
      return;
    }
    setSelectedEpisodeIndex((prev) => Math.min(Math.max(prev, 0), episodes.length - 1));
  }, [episodes.length]);

  useEffect(() => {
    if (!actionToast) return;
    const timer = window.setTimeout(() => setActionToast(null), 2600);
    return () => window.clearTimeout(timer);
  }, [actionToast]);

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
                  storyboardTaskThinking: String(result.thinking || ""),
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
                  storyboardTaskThinking: String(result.thinking || ""),
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
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : "任务状态查询失败";
            const normalizedError = String(errorMessage || "").toLowerCase();
            const isMissingTask =
              errorMessage.includes("任务不存在") ||
              normalizedError.includes("404") ||
              normalizedError.includes("not found");
            if (!isMissingTask) {
              return;
            }
            setEpisodes((prev) => {
              if (!prev[item.index]) return prev;
              const next = [...prev];
              next[item.index] = {
                ...next[item.index],
                storyboardTaskStatus: "failed",
                storyboardTaskError: "任务状态丢失（服务重启或任务过期），请重新生成",
              };
              return next;
            });
            setPendingStoryboardTasks((prev) => {
              const next = { ...prev };
              delete next[item.index];
              return next;
            });
            setGeneratingEpisodes((prev) => {
              const next = new Set(prev);
              next.delete(item.index);
              return next;
            });
            setMessage(`${item.title} 任务状态丢失，请重新生成`);
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
    if (storyboardStartInFlightRef.current.has(index)) return;
    storyboardStartInFlightRef.current.add(index);
    const token = getToken();
    if (!token) {
      storyboardStartInFlightRef.current.delete(index);
      return;
    }

    const episode = episodes[index];
    if (!episode) {
      storyboardStartInFlightRef.current.delete(index);
      return;
    }

    if (episode.storyboardTaskStatus === "running" && episode.storyboardTaskId) {
      setGeneratingEpisodes((prev) => new Set(prev).add(index));
      setMessage(`${episode.title} 正在生成中...`);
      return;
    }

    setGeneratingEpisodes(prev => new Set(prev).add(index));
    setMessage(`正在生成 ${episode.title} 的分镜...`);

    try {
      const customInstruction = String(extraInstruction || "").trim();
      const mergedInstruction = [
        globalStylePromptText,
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
          storyboardTaskThinking: String(result.thinking || ""),
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
    } finally {
      storyboardStartInFlightRef.current.delete(index);
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

  const waitForBatchFirstFrameTask = async (taskId: string) => {
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
  };

  const buildBatchFirstFrameMaterialBlock = (imageUrl: string, materialName: string, materialDescription?: string) => {
    const lines: string[] = [];
    lines.push(FRAME_MATERIAL_REF_START);
    lines.push(`![首帧图片](${imageUrl})`);
    lines.push("素材类型：首帧");
    if (materialName.trim()) {
      lines.push(`素材名：${materialName.trim()}`);
    }
    if (String(materialDescription || "").trim()) {
      lines.push(`素材描述：${String(materialDescription || "").trim()}`);
    }
    lines.push(FRAME_MATERIAL_REF_END);
    return lines.join("\n");
  };

  const writeBatchFirstFrameCellImages = (
    episodeIndex: number,
    rowIndex: number,
    imageUrls: string[],
    options?: { materialName?: string; materialDescription?: string }
  ) => {
    const episode = episodes[episodeIndex];
    const context = parseEpisodeTableContext(String(episode?.storyboard || ""));
    if (!context) throw new Error("分镜表格不存在");
    const firstFrameColIndex = findColumnIndexByIncludes(context.headers, ["首帧图片", "首帧"]);
    if (firstFrameColIndex < 0) throw new Error("当前表格缺少“首帧图片”列");
    if (!context.rows[rowIndex]) throw new Error("目标分镜不存在");
    while (context.rows[rowIndex].length < context.headers.length) context.rows[rowIndex].push("");
    const uniqueUrls = Array.from(new Set(imageUrls.map((item) => String(item || "").trim()).filter(Boolean)));
    const firstUrl = uniqueUrls[0] || "";
    if (!firstUrl) {
      context.rows[rowIndex][firstFrameColIndex] = "";
    } else {
      const materialName = String(options?.materialName || "").trim() || `分镜${rowIndex + 1}首帧`;
      const materialDescription = String(options?.materialDescription || "").trim();
      context.rows[rowIndex][firstFrameColIndex] = buildBatchFirstFrameMaterialBlock(firstUrl, materialName, materialDescription);
    }
    handleEpisodeStoryboardChange(episodeIndex, rebuildEpisodeStoryboardFromTable(context));
  };

  const getBatchPersistItemKey = (episodeIndex: number, rowIndex: number) => `${episodeIndex}:${rowIndex}`;

  const openBatchFirstFrameModal = (episodeIndex: number) => {
    const episode = episodes[episodeIndex];
    if (!episode) return;
    const context = parseEpisodeTableContext(String(episode.storyboard || ""));
    if (!context || context.rows.length === 0) {
      setMessage("未找到可生成首帧的分镜表格");
      return;
    }
    const persistedMap = projectId ? readBatchFirstFramePersist(projectId) : {};
    const storyboardColIndex = findColumnIndexByIncludes(context.headers, ["分镜"]);
    const firstFrameColIndex = findColumnIndexByIncludes(context.headers, ["首帧图片", "首帧"]);
    const rowsWithIndex = context.rows
      .map((row, rowIndex) => ({ row, rowIndex }))
      .filter(({ row }) => {
        const storyboardText = stripCellToPlainText(storyboardColIndex >= 0 ? row[storyboardColIndex] || "" : "");
        return Boolean(storyboardText);
      });
    if (rowsWithIndex.length === 0) {
      setMessage("未找到可生成首帧的分镜内容");
      return;
    }
    const initialItems: BatchFirstFrameItem[] = rowsWithIndex.map(({ row, rowIndex }, index) => {
      const existingImageUrls = firstFrameColIndex >= 0 ? extractImageUrlsFromCell(row[firstFrameColIndex] || "") : [];
      const persistKey = getBatchPersistItemKey(episodeIndex, rowIndex);
      const persisted = persistedMap[persistKey];
      const persistedPrompt = String(persisted?.prompt || "").trim();
      const prompt = persistedPrompt || stripCellToPlainText(storyboardColIndex >= 0 ? row[storyboardColIndex] || "" : "");
      const mergedImages = Array.from(new Set([...(persisted?.generatedImages || []), ...existingImageUrls].map((item) => String(item || "").trim()).filter(Boolean)));
      const persistedApplied = String(persisted?.appliedImageUrl || "").trim();
      const persistedScriptApplied = String(persisted?.scriptAppliedImageUrl || "").trim();
      const appliedImageUrl = (persistedApplied && mergedImages.includes(persistedApplied))
        ? persistedApplied
        : (mergedImages[0] || "");
      const scriptAppliedImageUrl = existingImageUrls[0] || persistedScriptApplied || "";
      return {
        rowIndex,
        tabLabel: `分镜${toChineseNumber(index + 1)}`,
        prompt,
        status: "idle",
        generatedImages: mergedImages,
        appliedImageUrl: appliedImageUrl || undefined,
        scriptAppliedImageUrl: scriptAppliedImageUrl || undefined,
        references: Array.from(new Set((persisted?.references || []).map((item) => String(item || "").trim()).filter(Boolean))),
      };
    });
    setBatchFirstFrameItems(initialItems);
    setBatchFirstFrameModalEpisodeIndex(episodeIndex);
    setBatchFirstFrameActiveTabIndex(0);
    setBatchFirstFrameMaterialTab("first");
  };

  const closeBatchFirstFrameModal = () => {
    setBatchFirstFrameModalEpisodeIndex(null);
    setBatchFirstFrameItems([]);
    setBatchFirstFrameActiveTabIndex(0);
    setBatchFirstFrameShowAllPreview(false);
    setBatchImagePreviewUrl(null);
  };

  const handleBatchFirstFramePromptChange = (tabIndex: number, value: string) => {
    setBatchFirstFrameItems((prev) => prev.map((item, index) => (
      index === tabIndex ? { ...item, prompt: value } : item
    )));
  };

  const createBatchPromptTokenNode = (assetId: string, label: string) => {
    const token = document.createElement("span");
    token.dataset.batchRef = "1";
    token.dataset.assetId = assetId;
    token.className = "mx-1 inline-flex rounded bg-blue-100 px-2 py-0.5 text-xs text-blue-700 align-middle";
    token.contentEditable = "false";
    token.textContent = label;
    return token;
  };

  const saveBatchPromptSelection = () => {
    const editor = batchPromptEditorRef.current;
    if (!editor || typeof window === "undefined") return;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    if (!editor.contains(range.commonAncestorContainer)) return;
    batchPromptSelectionRef.current = range.cloneRange();
  };

  const handleApplyAssetToBatchPrompt = (asset: Asset) => {
    const editor = batchPromptEditorRef.current;
    if (!editor || typeof window === "undefined") return;
    const existingNodes = Array.from(editor.querySelectorAll(`span[data-batch-ref='1'][data-asset-id='${asset.id}']`)) as HTMLSpanElement[];
    if (existingNodes.length > 0) {
      existingNodes.forEach((node) => node.remove());
      syncBatchPromptEditorState();
      return;
    }
    const token = createBatchPromptTokenNode(asset.id, asset.name);
    const selection = window.getSelection();
    let range: Range | null = null;
    if (selection && selection.rangeCount > 0) {
      const currentRange = selection.getRangeAt(0);
      if (editor.contains(currentRange.commonAncestorContainer)) {
        range = currentRange.cloneRange();
      }
    }
    if (!range && batchPromptSelectionRef.current && editor.contains(batchPromptSelectionRef.current.commonAncestorContainer)) {
      range = batchPromptSelectionRef.current.cloneRange();
    }
    if (!range) {
      range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
    }
    range.deleteContents();
    range.insertNode(token);
    const trailingSpace = document.createTextNode(" ");
    token.after(trailingSpace);
    const nextRange = document.createRange();
    nextRange.setStartAfter(trailingSpace);
    nextRange.collapse(true);
    if (selection) {
      selection.removeAllRanges();
      selection.addRange(nextRange);
    }
    batchPromptSelectionRef.current = nextRange.cloneRange();
    syncBatchPromptEditorState();
  };

  const handleApplyAssetToBatchImage = (asset: Asset) => {
    if (batchFirstFrameModalEpisodeIndex === null) return;
    const targetIndex = batchFirstFrameActiveTabIndex;
    const currentItem = batchFirstFrameItems[targetIndex];
    if (!currentItem) return;
    const imageUrl = getAssetPreviewUrl(asset);
    if (!imageUrl) {
      setMessage("该素材暂无可用图片");
      return;
    }
    const alreadyApplied = String(currentItem.scriptAppliedImageUrl || "").trim() === imageUrl;
    try {
      writeBatchFirstFrameCellImages(
        batchFirstFrameModalEpisodeIndex,
        currentItem.rowIndex,
        alreadyApplied ? [] : [imageUrl],
        {
          materialName: String(asset.name || "").trim() || `${currentItem.tabLabel}首帧`,
          materialDescription: String(asset.description || "").trim() || removeAssetTokensFromText(currentItem.prompt || ""),
        }
      );
      setBatchFirstFrameItems((prev) => prev.map((item, index) => (
        index === targetIndex
          ? {
              ...item,
              scriptAppliedImageUrl: alreadyApplied ? undefined : imageUrl,
              status: "success",
              error: "",
            }
          : item
      )));
      setMessage(alreadyApplied ? "已取消应用到剧本" : "已应用到剧本");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "应用到剧本失败");
    }
  };

  const handleRemoveBatchReference = (tabIndex: number, imageUrl: string) => {
    setBatchFirstFrameItems((prev) => prev.map((item, index) => {
      if (index !== tabIndex) return item;
      return { ...item, references: item.references.filter((url) => url !== imageUrl) };
    }));
  };

  const handleApplyBatchGeneratedImage = (tabIndex: number, imageUrl: string) => {
    const currentItem = batchFirstFrameItems[tabIndex];
    if (!currentItem) return;
    const alreadyInLibrary = String(currentItem.appliedImageUrl || "").trim() === imageUrl;
    if (alreadyInLibrary) {
      setBatchFirstFrameItems((prev) => prev.map((item, index) => {
        if (index !== tabIndex) return item;
        return {
          ...item,
          appliedImageUrl: undefined,
          scriptAppliedImageUrl: item.scriptAppliedImageUrl === imageUrl ? undefined : item.scriptAppliedImageUrl,
          status: "success",
          error: "",
        };
      }));
      if (projectId) {
        removeFirstFrameImageFromMaterialManagerState(projectId, currentItem.rowIndex, imageUrl);
      }
      if (batchFirstFrameModalEpisodeIndex !== null && currentItem.scriptAppliedImageUrl === imageUrl) {
        try {
          writeBatchFirstFrameCellImages(
            batchFirstFrameModalEpisodeIndex,
            currentItem.rowIndex,
            [],
            {
              materialName: `${currentItem.tabLabel || "当前分镜"}首帧`,
              materialDescription: removeAssetTokensFromText(currentItem.prompt || ""),
            }
          );
        } catch {}
      }
      setMessage(`已从素材库移除：${currentItem.tabLabel || "当前分镜"}首帧图`);
      return;
    }
    setBatchFirstFrameItems((prev) => prev.map((item, index) => (
      index === tabIndex ? { ...item, appliedImageUrl: imageUrl, status: "success", error: "" } : item
    )));
    if (projectId) {
      addFirstFrameImageToMaterialManagerState(projectId, currentItem.rowIndex, imageUrl, {
        name: `${currentItem.tabLabel || "当前分镜"}首帧`,
        description: removeAssetTokensFromText(currentItem.prompt || ""),
      });
    }
    setMessage(`已加入素材库：${currentItem.tabLabel || "当前分镜"}首帧图（默认未应用到剧本）`);
  };

  const handleDeleteBatchGeneratedImage = async (tabIndex: number, imageUrl: string) => {
    if (!projectId || batchFirstFrameModalEpisodeIndex === null) return;
    const token = getToken();
    if (!token) return;
    try {
      await deleteSegmentFrameImage(token, projectId, imageUrl);
    } catch {}
    setBatchFirstFrameItems((prev) => prev.map((item, index) => {
      if (index !== tabIndex) return item;
      const nextImages = item.generatedImages.filter((url) => url !== imageUrl);
      const nextLibraryApplied = item.appliedImageUrl === imageUrl ? undefined : item.appliedImageUrl;
      const nextScriptApplied = item.scriptAppliedImageUrl === imageUrl ? undefined : item.scriptAppliedImageUrl;
      return { ...item, generatedImages: nextImages, appliedImageUrl: nextLibraryApplied, scriptAppliedImageUrl: nextScriptApplied };
    }));
    try {
      const currentItem = batchFirstFrameItems[tabIndex];
      const targetRowIndex = currentItem?.rowIndex ?? tabIndex;
      const nextScriptApplied = currentItem?.scriptAppliedImageUrl === imageUrl ? "" : String(currentItem?.scriptAppliedImageUrl || "");
      writeBatchFirstFrameCellImages(
        batchFirstFrameModalEpisodeIndex,
        targetRowIndex,
        nextScriptApplied ? [nextScriptApplied] : [],
        {
          materialName: `${currentItem?.tabLabel || "当前分镜"}首帧`,
          materialDescription: removeAssetTokensFromText(currentItem?.prompt || ""),
        }
      );
    } catch {}
  };

  const handleBatchGenerateFirstFrame = async (tabIndex: number) => {
    if (!projectId || batchFirstFrameModalEpisodeIndex === null) return;
    const token = getToken();
    if (!token) return;
    const targetItem = batchFirstFrameItems[tabIndex];
    if (!targetItem) return;
    const prompt = String(targetItem.prompt || "").trim();
    if (!prompt) {
      setBatchFirstFrameItems((prev) => prev.map((item, index) => (
        index === tabIndex ? { ...item, status: "failed", error: "请输入提示词" } : item
      )));
      return;
    }

    setBatchFirstFrameItems((prev) => prev.map((item, index) => (
      index === tabIndex ? { ...item, status: "generating", error: "" } : item
    )));

    try {
      const references = Array.from(new Set((targetItem.references || []).map((item) => String(item || "").trim()).filter(Boolean)));
      const promptWithStyle = [
        `【全局风格】\n${globalStylePromptText}`,
        "【首帧生成要求】请同时参考参考图与风格提示词，保证画面风格统一、主体一致。",
        references.length > 0 ? `【参考图】共 ${references.length} 张，请严格参考参考图。` : "【参考图】本次未提供参考图，仅依据提示词与风格生成。",
        `【首帧提示词】\n${prompt}`,
      ].filter(Boolean).join("\n\n");
      const task = await generateSegmentFrameImage(token, projectId, {
        prompt: promptWithStyle,
        references,
        frame_type: "first",
        aspect_ratio: batchFirstFrameAspectRatio,
        model: batchFirstFrameModel,
        quick_channel: batchFirstFrameQuickChannel,
      });
      const imageUrl = await waitForBatchFirstFrameTask(task.task_id);
      const nextImages = Array.from(new Set([...(targetItem.generatedImages || []), imageUrl]));
      setBatchFirstFrameItems((prev) => prev.map((item, index) => (
        index === tabIndex ? { ...item, status: "success", generatedImages: nextImages, error: "" } : item
      )));
      setMessage(`已生成 ${targetItem.tabLabel} 首帧图`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "生成失败";
      setBatchFirstFrameItems((prev) => prev.map((item, index) => (
        index === tabIndex ? { ...item, status: "failed", error: errorMsg } : item
      )));
    }
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

  const flushStoryboardChangesBeforeVideoGenerate = async (token: string) => {
    if (!projectId) return;
    const episodesChanged = JSON.stringify(episodes) !== JSON.stringify(lastSavedEpisodesRef.current);
    const storyboardChanged = storyboard !== lastSavedStoryboardRef.current;
    if (!episodesChanged && !storyboardChanged) return;
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = null;
    }
    const saved = await saveScript(token, projectId, undefined, undefined, storyboard, undefined, episodes);
    const nextStoryboard = stripThinkingContent(saved.storyboard || storyboard);
    lastSavedStoryboardRef.current = nextStoryboard;
    lastSavedEpisodesRef.current = episodes;
  };

  const handleGenerateKlingRow = async ({
    globalRowIndex,
    previousGlobalRowIndex,
    headers,
    row,
    usePreviousSegmentEndFrame,
    customFirstFrameUrl,
    customLastFrameUrl,
  }: VideoGenerateRowPayload) => {
    setGeneratingGlobalRowIndex(globalRowIndex);
    setMessage("正在提交视频生成请求...");
    let submitted = false;
    let pendingRowIndex = globalRowIndex;
    try {
      if (!projectId) {
        throw new Error("项目 ID 无效，请刷新页面后重试");
      }
      const token = getToken();
      if (!token) {
        router.push("/login");
        throw new Error("登录状态已失效，请重新登录后重试");
      }

      const timelineIndex = findFieldIndex(headers, "时间轴");
      const timelineText = timelineIndex >= 0 ? (row[timelineIndex] || "") : "";
      const totalDurationSeconds = parseDurationFromTimeline(timelineText);
      const mode = videoResolution === "1080p" ? "pro" : "std";
      const duration = normalizeKlingDuration(totalDurationSeconds);
      const modelToUse = resolveStep4VideoModel(selectedVideoModel);
      const withAudio = videoAudioMode === "with_audio";
      const targetRowIndex = globalRowIndex;
      pendingRowIndex = targetRowIndex;

      await flushStoryboardChangesBeforeVideoGenerate(token);
      const refreshedSegments = await getSegments(token, projectId);
      setSegments(refreshedSegments);
      const segment = findSegmentForRow(refreshedSegments, targetRowIndex);
      if (!segment) {
        throw new Error("当前分镜还未同步到分段，请稍后重试");
      }

      const assetBindingMap = new Map<string, {
        asset_id: string;
        role: KlingAssetRole;
        name?: string;
        description?: string;
      }>();
      let firstFrameAssetId = "";
      headers.forEach((header, columnIndex) => {
        const cell = row[columnIndex] || "";
        if (!cell) return;
        const role = mapHeaderToAssetRole(header);
        if (!role) return;
        if (role === "first_frame" && usePreviousSegmentEndFrame) return;
        const ids = resolveAssetIdsFromCell(cell, projectAssets, role);
        ids.forEach((assetId) => {
          const asset = projectAssets.find((projectAsset) => projectAsset.id === assetId);
          const nextBinding = {
            asset_id: assetId,
            role,
            name: asset?.name || undefined,
            description: asset?.description || undefined,
          };
          const existingBinding = assetBindingMap.get(assetId);
          if (!existingBinding || VIDEO_ASSET_ROLE_PRIORITY[role] > VIDEO_ASSET_ROLE_PRIORITY[existingBinding.role]) {
            assetBindingMap.set(assetId, nextBinding);
          }
          if (role === "first_frame" && !firstFrameAssetId) {
            firstFrameAssetId = assetId;
          }
        });
      });
      const assetBindings = Array.from(assetBindingMap.values());
      const inlineAssetBindings = headers.flatMap((header, columnIndex) => {
        const role = mapHeaderToAssetRole(header);
        if (!role || role === "first_frame") return [];
        return extractInlineMaterialBindingsFromCell(row[columnIndex] || "", role);
      });

      const firstFrameColumnIndex = findFieldIndex(headers, "首帧图片");
      const firstFrameCellUrls = firstFrameColumnIndex >= 0 ? extractImageUrlsFromCell(row[firstFrameColumnIndex] || "") : [];
      const effectiveCustomFirstFrameUrl = customFirstFrameUrl || firstFrameCellUrls[0] || "";
      let previousSegmentVideoUrl = "";
      if (!effectiveCustomFirstFrameUrl && usePreviousSegmentEndFrame && typeof previousGlobalRowIndex === "number" && previousGlobalRowIndex >= 0) {
        const previousSegment = findSegmentForRow(refreshedSegments, previousGlobalRowIndex);
        previousSegmentVideoUrl = rowVideoUrlMap[previousGlobalRowIndex] || getSelectedOrLatestSegmentVideoUrl(previousSegment);
      }
      const usePreviousTailFrame = Boolean(previousSegmentVideoUrl) && !effectiveCustomFirstFrameUrl;

      const referenceKeySet = new Set<string>();
      assetBindings.forEach((item) => referenceKeySet.add(`asset:${item.asset_id}`));
      inlineAssetBindings.forEach((item) => referenceKeySet.add(`inline:${item.role}:${item.image_url}`));
      if (effectiveCustomFirstFrameUrl) referenceKeySet.add(`url:${effectiveCustomFirstFrameUrl}`);
      if (customLastFrameUrl) referenceKeySet.add(`url:${customLastFrameUrl}`);
      const referenceCount = referenceKeySet.size;
      if (referenceCount > MAX_VIDEO_REFERENCE_IMAGES) {
        const text = `参考素材最多只能传 ${MAX_VIDEO_REFERENCE_IMAGES} 张`;
        setActionToast({ type: "error", text });
        throw new Error(text);
      }

      const motionText = resolveRowMotionText(headers, row).motionText || "";
      const freezeFrameText = resolveRowFreezeFrameText(headers, row);

      const systemPrompt = [
        "你是短剧分镜视频生成模型的执行器。",
        `全局视觉风格：${globalStyle}。`,
        "只根据【镜头调度与内容】和参考素材生成，不要额外引用“分镜”列或其他表格说明文本。",
        "当前任务是单段生成：严格执行当前段的镜头调度与内容。",
        "仅保留当前段的定格画面描述。",
        "角色形象、场景、道具、远景位置关系图、首帧图片只作为视觉一致性参考，重复素材只使用一次。",
        `目标分辨率：${videoResolution}，画幅：${videoAspectRatio}，模式：${mode}。`,
      ].join("\n");

      const prompt = [
        "请根据以下镜头调度与内容生成单条视频。",
        "【镜头调度与内容】",
        motionText || "（空）",
        freezeFrameText ? `【定格画面】\n${freezeFrameText}` : "",
        "【生成要求】",
        `模型：${modelToUse}`,
        `模式：${mode}`,
        `分辨率：${videoResolution}`,
        `画幅比例：${videoAspectRatio}`,
        `总时长：${formatDurationLabel(totalDurationSeconds)}`,
        `首帧来源：${effectiveCustomFirstFrameUrl ? "首帧图片/素材管理结果" : usePreviousTailFrame ? "上一条分镜已选视频尾帧" : "默认首帧"}`,
        `音频：${withAudio ? "有声" : "无声"}`,
      ].filter(Boolean).join("\n");

      setManualPendingRowMap((prev) => ({
        ...prev,
        [targetRowIndex]: {
          segmentId: segment.id,
          baseVersionIds: (segment.versions || []).map((version) => version.id),
          submittedAt: Date.now(),
        },
      }));

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
      if (effectiveCustomFirstFrameUrl) {
        options.custom_first_frame_url = effectiveCustomFirstFrameUrl;
      }
      if (customLastFrameUrl) {
        options.custom_last_frame_url = customLastFrameUrl;
      }
      if (assetBindings.length > 0) {
        options.asset_bindings = assetBindings;
      }
      if (inlineAssetBindings.length > 0) {
        options.inline_asset_bindings = inlineAssetBindings;
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
      });
      submitted = true;
      try {
        const nextSegments = await getSegments(token, projectId);
        setSegments(nextSegments);
      } catch {}
      setMessage(`视频任务已提交，正在生成中（本次参考图：${referenceCount}）`);
    } catch (error) {
      if (!submitted) {
        setManualPendingRowMap((prev) => {
          const next = { ...prev };
          delete next[pendingRowIndex];
          return next;
        });
      }
      const text = error instanceof Error ? error.message : "视频生成失败";
      setMessage(text);
      setActionToast({ type: "error", text });
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
      let segment = findSegmentForRow(segments, globalRowIndex);
      if (!segment) {
        const refreshedSegments = await getSegments(token, projectId);
        setSegments(refreshedSegments);
        segment = findSegmentForRow(refreshedSegments, globalRowIndex);
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
      const inlineAssetBindings = headers.flatMap((header, index) => {
        const role = mapHeaderToAssetRole(header);
        if (!role || role === "first_frame") return [];
        return extractInlineMaterialBindingsFromCell(row[index] || "", role);
      });

      const sanitizeCellForPrompt = (text: string) => sanitizeVideoPromptCell(text);

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
          inline_asset_bindings: inlineAssetBindings,
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
    const segment = findSegmentForRow(segments, globalRowIndex);
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
    const segment = findSegmentForRow(segments, globalRowIndex);
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

  const handleUploadCustomStyleImage = (file: File) => {
    const reader = new FileReader();
    reader.onload = async () => {
      const result = String(reader.result || "").trim();
      if (!result) return;
      let normalized = result;
      if (isOversizedCustomStyleImage(normalized)) {
        normalized = await compressCustomStyleImage(normalized);
      }
      if (isOversizedCustomStyleImage(normalized)) {
        setMessage("图片过大，自动压缩后仍超限，请换一张更小的图片");
        return;
      }
      setNewCustomStyleImage(normalized);
    };
    reader.readAsDataURL(file);
  };

  const handleSaveCustomStyle = () => {
    const name = newCustomStyleName.trim();
    const prompt = newCustomStylePrompt.trim();
    if (!name) {
      setMessage("请填写风格名称");
      return;
    }
    if (!prompt) {
      setMessage("请填写风格提示词");
      return;
    }
    if (!newCustomStyleImage.trim()) {
      setMessage("请上传风格示例图");
      return;
    }
    if (isOversizedCustomStyleImage(newCustomStyleImage)) {
      setMessage("图片过大，自动压缩后仍超限，请换一张更小的图片");
      return;
    }
    const nextStyle: CustomStyleItem = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      prompt,
      image: newCustomStyleImage,
      description: `自定义风格：${prompt.slice(0, 60)}${prompt.length > 60 ? "..." : ""}`,
    };
    setCustomStyles((prev) => {
      const filtered = prev.filter((item) => item.name !== name);
      return [nextStyle, ...filtered].slice(0, MAX_CUSTOM_STYLE_COUNT);
    });
    setGlobalStyle(name);
    setActiveStyleTab("custom");
    setShowCreateCustomStyle(false);
    setNewCustomStyleName("");
    setNewCustomStylePrompt("");
    setNewCustomStyleImage("");
    setMessage(`已保存自定义风格：${name}`);
  };

  const applyGlobalStyleAndCloseModal = (styleName: string) => {
    const normalized = String(styleName || "").trim();
    if (!normalized) return;
    setGlobalStyle(normalized);
    setIsStyleModalOpen(false);
    setMessage(`已应用全局风格：${normalized}`);
  };

  const handlePreviewStyleImage = (styleName: string, imageUrl: string) => {
    const url = String(imageUrl || "").trim();
    if (!url) return;
    setBatchImagePreviewTitle(`风格预览 - ${styleName || "未命名风格"}`);
    setBatchImagePreviewUrl(url);
  };

  const currentBatchItem = batchFirstFrameItems[batchFirstFrameActiveTabIndex] || null;
  const currentBatchPromptAssetIds = useMemo(() => extractAssetTokensFromCell(currentBatchItem?.prompt || ""), [currentBatchItem?.prompt]);

  useEffect(() => {
    if (!projectId || batchFirstFrameModalEpisodeIndex === null) return;
    const persist = readBatchFirstFramePersist(projectId);
    batchFirstFrameItems.forEach((item) => {
      const key = getBatchPersistItemKey(batchFirstFrameModalEpisodeIndex, item.rowIndex);
      persist[key] = {
        prompt: String(item.prompt || ""),
        generatedImages: Array.from(new Set((item.generatedImages || []).map((url) => String(url || "").trim()).filter(Boolean))),
        appliedImageUrl: String(item.appliedImageUrl || "").trim() || undefined,
        scriptAppliedImageUrl: String(item.scriptAppliedImageUrl || "").trim() || undefined,
        references: Array.from(new Set((item.references || []).map((url) => String(url || "").trim()).filter(Boolean))),
      };
    });
    writeBatchFirstFramePersist(projectId, persist);
  }, [projectId, batchFirstFrameItems, batchFirstFrameModalEpisodeIndex]);

  const serializeBatchPromptEditor = (editor: HTMLDivElement) => {
    const cloned = editor.cloneNode(true) as HTMLDivElement;
    const tokenNodes = Array.from(cloned.querySelectorAll("span[data-batch-ref='1']")) as HTMLSpanElement[];
    tokenNodes.forEach((node) => {
      const assetId = String(node.dataset.assetId || "").trim();
      node.replaceWith(document.createTextNode(assetId ? `[AssetID:${assetId}]` : ""));
    });
    return String(cloned.innerText || "").replace(/\u00a0/g, " ").trim();
  };

  const syncBatchPromptEditorState = () => {
    const editor = batchPromptEditorRef.current;
    if (!editor) return;
    const nextPrompt = serializeBatchPromptEditor(editor);
    setBatchFirstFrameItems((prev) => prev.map((item, index) => (
      index === batchFirstFrameActiveTabIndex ? { ...item, prompt: nextPrompt } : item
    )));
  };

  useEffect(() => {
    const editor = batchPromptEditorRef.current;
    if (!editor || !currentBatchItem) return;
    const prompt = String(currentBatchItem.prompt || "");
    const editorPrompt = serializeBatchPromptEditor(editor);
    if (editorPrompt === prompt) return;
    editor.innerHTML = "";
    const regex = /\[AssetID:\s*([^\]]+)\]/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(prompt)) !== null) {
      const [raw, assetToken] = match;
      const textPart = prompt.slice(lastIndex, match.index);
      if (textPart) editor.appendChild(document.createTextNode(textPart));
      const assetId = String(assetToken || "").trim();
      if (assetId) {
        const asset = projectAssets.find((item) => item.id === assetId);
        editor.appendChild(createBatchPromptTokenNode(assetId, asset?.name || assetId));
      } else {
        editor.appendChild(document.createTextNode(raw));
      }
      lastIndex = match.index + raw.length;
    }
    const trailingText = prompt.slice(lastIndex);
    if (trailingText) editor.appendChild(document.createTextNode(trailingText));
  }, [currentBatchItem?.prompt, projectAssets]);
  const batchSyntheticFirstFrameAssets = useMemo(() => {
    if (batchFirstFrameModalEpisodeIndex === null) return [] as Asset[];
    return batchFirstFrameItems
      .map((item, index) => {
        const imageUrl = String(item.appliedImageUrl || "").trim();
        if (!imageUrl) return null;
        const syntheticId = `batch-first-frame:${batchFirstFrameModalEpisodeIndex}:${item.rowIndex}`;
        const name = `${item.tabLabel || `分镜${index + 1}`}首帧`;
        const description = removeAssetTokensFromText(item.prompt || "") || null;
        return {
          id: syntheticId,
          type: "FIRST_FRAME",
          name,
          description,
          versions: [{
            id: `${syntheticId}:v1`,
            image_url: imageUrl,
            is_selected: true,
          }],
        } as Asset;
      })
      .filter((item): item is Asset => Boolean(item));
  }, [batchFirstFrameItems, batchFirstFrameModalEpisodeIndex]);

  const batchMaterialAssets = useMemo(() => {
    const merged: Asset[] = [];
    const seenByPreviewUrl = new Set<string>();
    [...projectAssets, ...batchSyntheticFirstFrameAssets].forEach((asset) => {
      if (resolveBatchFirstFrameMaterialTabByAssetType(asset.type) !== batchFirstFrameMaterialTab) return;
      const previewUrl = getAssetPreviewUrl(asset);
      if (!previewUrl || seenByPreviewUrl.has(previewUrl)) return;
      seenByPreviewUrl.add(previewUrl);
      merged.push(asset);
    });
    return merged;
  }, [projectAssets, batchSyntheticFirstFrameAssets, batchFirstFrameMaterialTab]);
  const sharedBatchFirstFrameEntries = useMemo(() => {
    if (!projectId) return [] as Array<{ id: string; name: string; description?: string; imageUrl: string }>;
    const persisted = readBatchFirstFramePersist(projectId);
    const merged = new Map<string, { id: string; name: string; description?: string; imageUrl: string }>();
    Object.entries(persisted).forEach(([key, item]) => {
      const imageUrl = String(item?.appliedImageUrl || "").trim();
      if (!imageUrl) return;
      const [episodeIndexText, rowIndexText] = String(key).split(":", 2);
      const episodeIndex = Number(episodeIndexText);
      const rowIndex = Number(rowIndexText);
      const id = `batch-shared:${key}:${imageUrl}`;
      const name = Number.isFinite(rowIndex)
        ? `分镜${toChineseNumber(rowIndex + 1)}首帧`
        : "分镜首帧";
      const description = String(item?.prompt || "").trim() || (Number.isFinite(episodeIndex) ? `来自第 ${episodeIndex + 1} 集` : "");
      if (!merged.has(imageUrl)) {
        merged.set(imageUrl, { id, name, description, imageUrl });
      }
    });
    return Array.from(merged.values());
  }, [projectId, batchFirstFrameItems, batchFirstFrameModalEpisodeIndex]);

  const batchAllPreviewEntries = useMemo(
    () => batchFirstFrameItems.map((item, index) => ({
      tabLabel: item.tabLabel || `分镜${index + 1}`,
      imageUrl: String(item.scriptAppliedImageUrl || "").trim(),
    })),
    [batchFirstFrameItems]
  );

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
          <option value="gemini-3.1-pro-preview">Gemini 3.1 Pro Preview</option>
          <option value="deepseek-r1-250120">DeepSeek R1 (deepseek-r1)</option>
          <option value="deepseek-v3-241226">DeepSeek V3 (deepseek-v3)</option>
          <option value="gpt-4o-2024-08-06">GPT-4o (gpt-4o)</option>
          <option value="claude-3-5-sonnet-20240620">Claude 3.5 Sonnet</option>
        </select>
        {message && <span className="text-gray-500 text-sm">{message}</span>}
      </div>
      {actionToast ? (
        <div
          className={`fixed right-6 top-20 z-50 max-w-md rounded-lg border px-4 py-3 text-sm shadow-lg ${
            actionToast.type === "error"
              ? "border-red-200 bg-red-50 text-red-700"
              : actionToast.type === "success"
                ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                : "border-sky-200 bg-sky-50 text-sky-700"
          }`}
        >
          {actionToast.text}
        </div>
      ) : null}

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
                    <button
                      type="button"
                      onClick={() => setIsStyleModalOpen(true)}
                      className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs hover:bg-slate-50"
                    >
                      {globalStyle || "选择风格"}
                    </button>
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
                                  openBatchFirstFrameModal(index);
                                }}
                                className="px-3 py-1 text-xs bg-teal-600 text-white rounded hover:bg-teal-700"
                            >
                                批量生成首帧图
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
                    {String(episode.storyboardTaskThinking || "").trim() ? (
                      <div className="px-4 py-2 border-t border-amber-100 bg-amber-50">
                        <details>
                          <summary className="cursor-pointer text-xs font-medium text-amber-700">查看模型 thinking（默认收起）</summary>
                          <pre className="mt-2 max-h-56 overflow-y-auto whitespace-pre-wrap rounded border border-amber-200 bg-white p-2 text-[11px] text-amber-900">{String(episode.storyboardTaskThinking || "")}</pre>
                        </details>
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
                                    externalFirstFrameEntries={sharedBatchFirstFrameEntries}
                                    globalStyleName={globalStyle}
                                    globalStylePromptText={globalStylePromptText}
                                    onOpenStyleSelector={() => setIsStyleModalOpen(true)}
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

      {isStyleModalOpen ? (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/45 p-4" onClick={() => setIsStyleModalOpen(false)}>
          <div className="h-[85vh] w-full max-w-6xl overflow-hidden rounded-2xl bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
              <div>
                <div className="text-base font-semibold text-slate-900">选择全局风格</div>
                <div className="text-xs text-slate-500">当前风格：{globalStyle}</div>
              </div>
              <button
                type="button"
                onClick={() => setIsStyleModalOpen(false)}
                className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs hover:bg-slate-50"
              >
                关闭
              </button>
            </div>
            <div className="flex h-[calc(85vh-65px)]">
              <div className="w-40 border-r border-slate-200 bg-slate-50 p-3">
                {([
                  { key: "custom", label: "自定义风格" },
                  { key: "realistic", label: "真人写实" },
                  { key: "three_d", label: "3D风格" },
                  { key: "two_d", label: "2D风格" },
                  { key: "director", label: "导演风格" },
                ] as Array<{ key: StyleTabKey; label: string }>).map((tab) => (
                  <button
                    key={tab.key}
                    type="button"
                    onClick={() => setActiveStyleTab(tab.key)}
                    className={`mb-2 w-full rounded-lg px-3 py-2 text-left text-xs ${
                      activeStyleTab === tab.key
                        ? "bg-slate-900 text-white"
                        : "bg-white text-slate-700 hover:bg-slate-100"
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
              <div className="flex-1 overflow-y-auto p-4">
                {activeStyleTab === "custom" ? (
                  <div>
                    <div className="mb-3 flex items-center justify-between">
                      <div className="text-sm font-medium text-slate-800">我的自定义风格</div>
                      <button
                        type="button"
                        onClick={() => setShowCreateCustomStyle((prev) => !prev)}
                        className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs text-white hover:bg-indigo-700"
                      >
                        创建自定义风格
                      </button>
                    </div>

                    {showCreateCustomStyle ? (
                      <div className="mb-4 rounded-xl border border-indigo-100 bg-indigo-50/50 p-3">
                        <div className="grid gap-3 md:grid-cols-2">
                          <div>
                            <div className="mb-1 text-xs text-slate-600">风格名称</div>
                            <input
                              value={newCustomStyleName}
                              onChange={(e) => setNewCustomStyleName(e.target.value)}
                              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm"
                              placeholder="例如：暗黑悬疑纪实"
                            />
                          </div>
                          <div>
                            <div className="mb-1 text-xs text-slate-600">上传示例图</div>
                            <input
                              type="file"
                              accept="image/*"
                              onChange={(e) => {
                                const file = e.target.files?.[0];
                                if (file) handleUploadCustomStyleImage(file);
                              }}
                              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs"
                            />
                          </div>
                        </div>
                        <div className="mt-3">
                          <div className="mb-1 text-xs text-slate-600">风格提示词</div>
                          <textarea
                            value={newCustomStylePrompt}
                            onChange={(e) => setNewCustomStylePrompt(e.target.value)}
                            className="h-24 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm"
                            placeholder="输入该风格的核心视觉提示词"
                          />
                        </div>
                        {newCustomStyleImage ? (
                          <img src={newCustomStyleImage} alt="custom-style-preview" className="mt-3 h-32 w-56 rounded-lg border border-slate-200 object-cover" />
                        ) : null}
                        <div className="mt-3">
                          <button
                            type="button"
                            onClick={handleSaveCustomStyle}
                            className="rounded-lg bg-emerald-600 px-3 py-2 text-xs text-white hover:bg-emerald-700"
                          >
                            保存
                          </button>
                        </div>
                      </div>
                    ) : null}

                    {customStyles.length === 0 ? (
                      <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-10 text-center text-sm text-slate-500">
                        暂无自定义风格
                      </div>
                    ) : (
                      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                        {customStyles.map((style) => (
                          <div
                            key={style.id}
                            className={`overflow-hidden rounded-xl border text-left transition ${
                              globalStyle === style.name ? "border-indigo-500 ring-2 ring-indigo-100" : "border-slate-200 hover:border-slate-300"
                            }`}
                          >
                            <button
                              type="button"
                              onClick={() => handlePreviewStyleImage(style.name, style.image)}
                              className="block w-full"
                              title="点击预览风格图"
                            >
                              <img src={style.image} alt={style.name} className="h-28 w-full object-cover" />
                            </button>
                            <div className="p-3">
                              <div className="text-sm font-semibold text-slate-900">{style.name}</div>
                              <div className="mt-1 line-clamp-2 text-xs text-slate-500">提示词：{style.prompt || style.description}</div>
                              <div className="mt-3 flex justify-end">
                                <button
                                  type="button"
                                  onClick={() => applyGlobalStyleAndCloseModal(style.name)}
                                  className={`rounded px-3 py-1.5 text-xs ${
                                    globalStyle === style.name ? "bg-indigo-600 text-white" : "border border-indigo-200 text-indigo-700 hover:bg-indigo-50"
                                  }`}
                                >
                                  {globalStyle === style.name ? "已应用" : "应用"}
                                </button>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {(STYLE_PRESET_TABS.find((item) => item.key === activeStyleTab)?.styles || []).map((style) => (
                      <div
                        key={style.name}
                        className={`overflow-hidden rounded-xl border text-left transition ${
                          globalStyle === style.name ? "border-indigo-500 ring-2 ring-indigo-100" : "border-slate-200 hover:border-slate-300"
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => handlePreviewStyleImage(style.name, style.image)}
                          className="block w-full"
                          title="点击预览风格图"
                        >
                          <img src={style.image} alt={style.name} className="h-28 w-full object-cover" />
                        </button>
                        <div className="p-3">
                          <div className="text-sm font-semibold text-slate-900">{style.name}</div>
                          <div className="mt-1 line-clamp-2 text-xs text-slate-500">{style.description}</div>
                          <div className="mt-3 flex justify-end">
                            <button
                              type="button"
                              onClick={() => applyGlobalStyleAndCloseModal(style.name)}
                              className={`rounded px-3 py-1.5 text-xs ${
                                globalStyle === style.name ? "bg-indigo-600 text-white" : "border border-indigo-200 text-indigo-700 hover:bg-indigo-50"
                              }`}
                            >
                              {globalStyle === style.name ? "已应用" : "应用"}
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {batchFirstFrameModalEpisodeIndex !== null ? (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-black/50 px-4 py-6" onClick={closeBatchFirstFrameModal}>
          <div className="mx-auto w-full max-w-6xl rounded-2xl border border-slate-200 bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-100 bg-white px-5 py-4">
              <div className="text-sm font-semibold text-slate-900">批量生成首帧</div>
              <button
                type="button"
                onClick={closeBatchFirstFrameModal}
                className="rounded-md px-2 py-1 text-xs text-slate-500 hover:bg-slate-100"
              >
                关闭
              </button>
            </div>
            <div className="space-y-4 p-5">
              <div className="space-y-2 border-b border-slate-100 pb-2">
                <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                  <div className="flex flex-wrap items-center gap-2">
                    {BATCH_FIRST_FRAME_MATERIAL_TABS.map((tab) => (
                      <button
                        key={tab.key}
                        type="button"
                        onClick={() => setBatchFirstFrameMaterialTab(tab.key)}
                        className={`rounded px-3 py-1 text-xs ${batchFirstFrameMaterialTab === tab.key ? "bg-blue-600 text-white" : "border border-slate-200 text-slate-600"}`}
                      >
                        {tab.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="text-xs text-slate-500">所有入口共用同一素材管理弹窗，素材按类型显示在各自 tab 中。</div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {batchMaterialAssets.map((asset) => {
                  const imageUrl = getAssetPreviewUrl(asset);
                  const promptSelected = currentBatchPromptAssetIds.includes(asset.id);
                  const scriptApplied = currentBatchItem ? String(currentBatchItem.scriptAppliedImageUrl || "").trim() === imageUrl : false;
                  return (
                    <div key={asset.id} className={`overflow-hidden rounded-lg border bg-white ${scriptApplied ? "border-emerald-500 ring-2 ring-emerald-200" : "border-slate-200"}`}>
                      <img src={imageUrl || "https://via.placeholder.com/320x180?text=No+Image"} alt={asset.name} className="h-28 w-full object-cover bg-slate-100" />
                      <div className="truncate px-2 pt-2 text-xs text-slate-700">{asset.name}</div>
                      {asset.description ? <div className="line-clamp-2 px-2 pb-2 text-[11px] text-slate-500">{asset.description}</div> : <div className="px-2 pb-2 text-[11px] text-slate-300">&nbsp;</div>}
                      <div className="flex items-center justify-end gap-2 border-t border-slate-100 p-2">
                        <button
                          type="button"
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => handleApplyAssetToBatchPrompt(asset)}
                          className={`rounded px-2 py-1 text-[11px] ${promptSelected ? "bg-blue-600 text-white" : "border border-blue-200 text-blue-700 hover:bg-blue-50"}`}
                        >
                          {promptSelected ? "已应用到提示词" : "应用到提示词"}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleApplyAssetToBatchImage(asset)}
                          className={`rounded border px-2 py-1 text-[11px] ${scriptApplied ? "border-rose-200 text-rose-700 hover:bg-rose-50" : "border-emerald-200 text-emerald-700 hover:bg-emerald-50"}`}
                        >
                          {scriptApplied ? "取消应用" : "应用至剧本"}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
              {batchMaterialAssets.length === 0 ? (
                <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 px-3 py-6 text-center text-xs text-slate-400">
                  当前暂无可用素材
                </div>
              ) : null}

              {batchFirstFrameItems.length > 0 ? (
                <>
                  <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-2">
                    {batchFirstFrameItems.map((item, index) => (
                      <button
                        key={`${item.tabLabel}-${index}`}
                        type="button"
                        onClick={() => setBatchFirstFrameActiveTabIndex(index)}
                        className={`rounded px-3 py-1 text-xs ${batchFirstFrameActiveTabIndex === index ? "bg-blue-600 text-white" : "border border-slate-200 text-slate-600"}`}
                      >
                        {item.tabLabel}
                        {item.references.length > 0 ? ` · 参考${item.references.length}` : ""}
                        {item.appliedImageUrl ? " · 已入库" : ""}
                      </button>
                    ))}
                  </div>

                  {currentBatchItem ? (
                    <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                      <div className="mb-2 text-xs font-medium text-slate-700">{currentBatchItem.tabLabel}</div>
                      <div className="relative rounded-lg border border-slate-200 bg-white px-3 py-2">
                        <div
                          ref={batchPromptEditorRef}
                          contentEditable
                          suppressContentEditableWarning
                          onInput={syncBatchPromptEditorState}
                          onKeyUp={saveBatchPromptSelection}
                          onMouseUp={saveBatchPromptSelection}
                          onFocus={saveBatchPromptSelection}
                          onBlur={saveBatchPromptSelection}
                          onClick={(event) => {
                            const target = event.target as HTMLElement;
                            const tokenNode = target?.closest?.("span[data-batch-ref='1']") as HTMLElement | null;
                            if (!tokenNode) return;
                            const assetId = String(tokenNode.getAttribute("data-asset-id") || tokenNode.getAttribute("data-assetid") || "").trim();
                            if (!assetId) return;
                            const asset = projectAssets.find((item) => item.id === assetId);
                            if (!asset) return;
                            handleApplyAssetToBatchPrompt(asset);
                          }}
                          className="min-h-[96px] w-full whitespace-pre-wrap break-words text-sm outline-none"
                        />
                        {!currentBatchItem.prompt.trim() ? (
                          <span className="pointer-events-none absolute left-3 top-2 text-sm text-slate-400">
                            请输入首帧提示词（点击“应用到提示词”会将素材标签插入文本中）
                          </span>
                        ) : null}
                      </div>
                      {currentBatchItem.references.length > 0 ? (
                        <div className="mt-2 flex flex-wrap gap-2">
                          {currentBatchItem.references.map((url) => (
                            <button
                              key={url}
                              type="button"
                              onClick={() => handleRemoveBatchReference(batchFirstFrameActiveTabIndex, url)}
                              className="rounded border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-600"
                              title="点击移除参考图"
                            >
                              参考图 {currentBatchItem.references.indexOf(url) + 1} ×
                            </button>
                          ))}
                        </div>
                      ) : null}
                      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                        <div className="flex flex-wrap items-center gap-3">
                          <div className="flex items-center gap-2 text-xs text-slate-600">
                            <span>模型</span>
                            <select
                              value={batchFirstFrameModel}
                              onChange={(e) => setBatchFirstFrameModel(e.target.value)}
                              className="rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700"
                            >
                              <option value="nano-banana-2">nano-banana-2</option>
                              <option value="nano-banana-pro">nano-banana-pro</option>
                            </select>
                          </div>
                          <label className="inline-flex items-center gap-2 text-xs text-slate-600">
                            <input
                              type="checkbox"
                              checked={batchFirstFrameQuickChannel}
                              onChange={(e) => setBatchFirstFrameQuickChannel(e.target.checked)}
                              className="h-3.5 w-3.5 rounded border-slate-300"
                            />
                            快速通道
                          </label>
                          <div className="flex items-center gap-2 text-xs text-slate-600">
                            <span>风格</span>
                            <button
                              type="button"
                              onClick={() => setIsStyleModalOpen(true)}
                              className="rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700 hover:bg-slate-50"
                              title="打开与 Step4 相同的风格选择"
                            >
                              {globalStyle || "选择风格"}
                            </button>
                          </div>
                          <div className="flex items-center gap-2 text-xs text-slate-600">
                            <span>比例</span>
                            <select
                              value={batchFirstFrameAspectRatio}
                              onChange={(e) => setBatchFirstFrameAspectRatio(e.target.value as "9:16" | "3:4" | "1:1" | "4:3" | "16:9")}
                              className="rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700"
                            >
                              {BATCH_FIRST_FRAME_ASPECT_RATIO_OPTIONS.map((item) => (
                                <option key={item.value} value={item.value}>{item.label}</option>
                              ))}
                            </select>
                          </div>
                          <button
                            type="button"
                            onClick={() => {
                              void handleBatchGenerateFirstFrame(batchFirstFrameActiveTabIndex);
                            }}
                            disabled={currentBatchItem.status === "generating"}
                            className="rounded bg-emerald-600 px-3 py-1.5 text-xs text-white hover:bg-emerald-700 disabled:opacity-50"
                          >
                            {currentBatchItem.status === "generating" ? "生成中..." : "生成首帧"}
                          </button>
                        </div>
                        <button
                          type="button"
                          onClick={() => setBatchFirstFrameShowAllPreview((prev) => !prev)}
                          className="rounded border border-indigo-200 px-3 py-1.5 text-xs text-indigo-700 hover:bg-indigo-50"
                        >
                          {batchFirstFrameShowAllPreview ? "收起全部预览" : "全部预览"}
                        </button>
                      </div>
                      <div className="mt-2 text-xs text-slate-500">
                        {currentBatchItem.status === "success"
                          ? "生成成功"
                          : currentBatchItem.status === "failed"
                            ? (currentBatchItem.error || "生成失败")
                            : currentBatchItem.status === "generating"
                              ? "生成中..."
                              : ""}
                      </div>

                      {currentBatchItem.generatedImages.length > 0 ? (
                        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                          {currentBatchItem.generatedImages.map((url) => (
                            <div key={url} className="overflow-hidden rounded-lg border border-slate-200 bg-white">
                              <img
                                src={url}
                                alt="首帧图"
                                onClick={() => {
                                  setBatchImagePreviewTitle(`${currentBatchItem.tabLabel} - 生成图`);
                                  setBatchImagePreviewUrl(url);
                                }}
                                className="h-36 w-full cursor-zoom-in object-cover"
                              />
                              <div className="flex items-center justify-end gap-2 p-2">
                                <button
                                  type="button"
                                  onClick={() => handleApplyBatchGeneratedImage(batchFirstFrameActiveTabIndex, url)}
                                  className={`rounded px-2 py-1 text-xs ${currentBatchItem.appliedImageUrl === url ? "border border-rose-200 text-rose-700 hover:bg-rose-50" : "border border-emerald-200 text-emerald-700 hover:bg-emerald-50"}`}
                                >
                                  {currentBatchItem.appliedImageUrl === url ? "从素材库中移除" : "应用至素材库"}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => { void handleDeleteBatchGeneratedImage(batchFirstFrameActiveTabIndex, url); }}
                                  className="rounded border border-rose-200 px-2 py-1 text-xs text-rose-600 hover:bg-rose-50"
                                >
                                  删除
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="mt-3 rounded-lg border border-dashed border-slate-200 bg-white px-3 py-6 text-center text-xs text-slate-400">
                          生成结果将显示在输入框下方
                        </div>
                      )}

                      {batchFirstFrameShowAllPreview ? (
                        <div className="mt-4">
                          <div className="mb-2 text-xs font-semibold text-slate-700">全部预览（仅已应用，按分镜顺序）</div>
                          <div className={`grid gap-3 ${getBatchPreviewColumnClass(batchAllPreviewEntries.length)}`}>
                            {batchAllPreviewEntries.map((item, index) => (
                              <div key={`${item.tabLabel}-${index}`} className="overflow-hidden rounded-lg border border-slate-200 bg-white">
                                {item.imageUrl ? (
                                  <img
                                    src={item.imageUrl}
                                    alt={`全部预览-${index + 1}`}
                                    onClick={() => {
                                      if (!item.imageUrl) return;
                                      setBatchImagePreviewTitle(`${item.tabLabel} - 全部预览`);
                                      setBatchImagePreviewUrl(item.imageUrl);
                                    }}
                                    className="h-40 w-full cursor-zoom-in object-cover"
                                  />
                                ) : (
                                  <div className="flex h-40 w-full items-center justify-center bg-slate-100 text-xs text-slate-400">{item.tabLabel} 暂无已应用图片</div>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 px-3 py-8 text-center text-xs text-slate-400">
                  当前分镜暂无可生成项
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {batchImagePreviewUrl ? (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4" onClick={() => setBatchImagePreviewUrl(null)}>
          <div className="max-h-[90vh] w-full max-w-5xl rounded-xl bg-white p-3" onClick={(event) => event.stopPropagation()}>
            <div className="mb-2 flex items-center justify-between">
              <div className="truncate pr-3 text-sm font-medium text-slate-700">{batchImagePreviewTitle}</div>
              <button
                type="button"
                onClick={() => setBatchImagePreviewUrl(null)}
                className="rounded border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50"
              >
                关闭
              </button>
            </div>
            <img src={batchImagePreviewUrl} alt={batchImagePreviewTitle} className="max-h-[78vh] w-full rounded-lg border border-slate-200 object-contain bg-slate-100" />
          </div>
        </div>
      ) : null}

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
