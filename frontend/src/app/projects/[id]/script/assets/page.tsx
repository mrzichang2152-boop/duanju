"use client";

import { ReactNode, useCallback, useEffect, useState, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import Image from "next/image";
import {
  Asset,
  CharacterVoice,
  deleteAssetVersion,
  generateAsset,
  generateAssetSubject,
  getAssets,
  getAssetGenerateTaskStatus,
  getProjectVoices,
  getModels,
  getSettings,
  getScript,
  selectAssetVersion,
  uploadAssetImage,
  updateAssetConfig,
} from "@/lib/api";
import { extractDrawModels } from "@/lib/models";
import { getToken } from "@/lib/auth";
import { VoiceSelector } from "@/app/components/VoiceSelector";
import { applyTemplate } from "@/lib/templates";

const normalizeRoleKey = (name: string) => {
  const value = (name || "").trim();
  for (const sep of ["·", "：", ":", "-", "—", "｜", "|"]) {
    if (value.includes(sep)) {
      return value.split(sep, 1)[0].trim();
    }
  }
  return value;
};

const getAssetDisplayName = (name: string) => {
  const raw = (name || "").replace(/[\u3000\s]+/g, " ").trim();
  return raw.replace(/\s*(?:[·•\-—｜|:：])\s*(角色形象|角色|道具|场景)\s*$/u, "").trim();
};

const getAssetIdentityKey = (asset: Asset) => {
  const normalizedName = (asset.name || "").replace(/[\s\u3000]+/g, " ").trim();
  if (asset.type === "CHARACTER") {
    return `${asset.type}::${normalizedName.replace(/\*/g, "")}`;
  }
  if (asset.type === "CHARACTER_LOOK") {
    return `${asset.type}::${normalizedName.replace(/\s+/g, "")}`;
  }
  return `${asset.type}::${normalizedName}`;
};

/** 刷新/切页后仍显示「生成中」，并在新版本落库后自动清除 */
const ASSET_GEN_PENDING_STORAGE_KEY = "duanju-asset-gen-pending-v3";
const MAX_ASSET_GEN_PENDING_AGE_MS = 18 * 60 * 1000;

type PendingAssetGenJob = {
  sourceAssetIds: string[];
  uiKey: string;
  versionIdsSnapshot: string[];
  taskId: string;
  startedAt: number;
};

function normalizePendingJob(raw: unknown): PendingAssetGenJob | null {
  if (!raw || typeof raw !== "object") return null;
  const j = raw as Record<string, unknown>;
  const uiKey = typeof j.uiKey === "string" ? j.uiKey : "";
  if (!uiKey) return null;
  let sourceAssetIds: string[] = [];
  if (Array.isArray(j.sourceAssetIds)) {
    sourceAssetIds = j.sourceAssetIds.filter((x): x is string => typeof x === "string");
  }
  if (sourceAssetIds.length === 0 && typeof j.sourceAssetId === "string" && j.sourceAssetId) {
    sourceAssetIds = [j.sourceAssetId];
  }
  const versionIdsSnapshot = Array.isArray(j.versionIdsSnapshot)
    ? j.versionIdsSnapshot.filter((x): x is string => typeof x === "string")
    : [];
  const taskId = typeof j.taskId === "string" ? j.taskId.trim() : "";
  if (!taskId) return null;
  const startedAt = typeof j.startedAt === "number" ? j.startedAt : Date.now();
  return { uiKey, sourceAssetIds, versionIdsSnapshot, taskId, startedAt };
}

function readPendingAssetGenJobs(projectId: string): PendingAssetGenJob[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(ASSET_GEN_PENDING_STORAGE_KEY);
    if (!raw) return [];
    const all = JSON.parse(raw) as Record<string, unknown[]>;
    const list = all[projectId];
    if (!Array.isArray(list)) return [];
    return list.map(normalizePendingJob).filter((x): x is PendingAssetGenJob => x !== null);
  } catch {
    return [];
  }
}

function writePendingAssetGenJobs(projectId: string, jobs: PendingAssetGenJob[]) {
  if (typeof window === "undefined") return;
  try {
    const raw = localStorage.getItem(ASSET_GEN_PENDING_STORAGE_KEY);
    const all: Record<string, PendingAssetGenJob[]> = raw ? JSON.parse(raw) : {};
    if (jobs.length === 0) {
      delete all[projectId];
    } else {
      all[projectId] = jobs;
    }
    localStorage.setItem(ASSET_GEN_PENDING_STORAGE_KEY, JSON.stringify(all));
  } catch {
    /* ignore quota / private mode */
  }
}

function pushPendingAssetGenJob(projectId: string, job: PendingAssetGenJob) {
  const jobs = readPendingAssetGenJobs(projectId).filter((j) => j.uiKey !== job.uiKey);
  jobs.push(job);
  writePendingAssetGenJobs(projectId, jobs);
}

function removePendingAssetGenJob(projectId: string, uiKey: string) {
  const jobs = readPendingAssetGenJobs(projectId).filter((j) => j.uiKey !== uiKey);
  writePendingAssetGenJobs(projectId, jobs);
}

function reconcilePendingJobs(projectId: string, currentAssets: Asset[]): Set<string> {
  void currentAssets;
  const jobs = readPendingAssetGenJobs(projectId);
  const now = Date.now();
  const kept: PendingAssetGenJob[] = [];
  const activeUiKeys = new Set<string>();
  for (const job of jobs) {
    if (now - job.startedAt > MAX_ASSET_GEN_PENDING_AGE_MS) {
      continue;
    }
    const ids = job.sourceAssetIds.length ? job.sourceAssetIds : [];
    if (ids.length === 0) {
      continue;
    }
    kept.push(job);
    activeUiKeys.add(job.uiKey);
  }
  writePendingAssetGenJobs(projectId, kept);
  return activeUiKeys;
}

type AggregatedVersion = Asset["versions"][number] & {
  assetId: string;
  assetName: string;
};

type AggregatedAsset = Omit<Asset, "versions"> & {
  activeAssetId: string;
  sourceAssetIds: string[];
  versions: AggregatedVersion[];
};

const OPENROUTER_IMAGE_MODEL = "nano-banana-2";

const isProjectMissingError = (message: string) => {
  const normalized = (message || "").toLowerCase();
  return (
    message.includes("项目不存在") ||
    normalized.includes("project not found") ||
    normalized.includes("project not exists")
  );
};

export default function AssetsPage() {
  const MAX_PARALLEL_GENERATIONS = 3;
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const projectId = params.id;
  const scriptCacheKey = projectId ? `script-cache-${projectId}` : "";
  const [status, setStatus] = useState<string | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [assetPrompts, setAssetPrompts] = useState<Record<string, string>>({});
  const [assetModels, setAssetModels] = useState<Record<string, string>>({});
  const [assetSizes, setAssetSizes] = useState<Record<string, string>>({});
  const [imageModels, setImageModels] = useState<string[]>([]);
  const [defaultImageModel, setDefaultImageModel] = useState("");
  const [savedModel, setSavedModel] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const redirectingMissingProjectRef = useRef(false);

  const redirectToProjectsOnMissing = useCallback(() => {
    if (redirectingMissingProjectRef.current) {
      return;
    }
    redirectingMissingProjectRef.current = true;
    setStatus(null);
    setError("项目不存在或无权限，正在返回项目列表...");
    window.setTimeout(() => {
      router.replace("/projects");
    }, 900);
  }, [router]);

  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(null), 2200);
    return () => clearTimeout(timer);
  }, [message]);

  const STYLE_OPTIONS = [
    "真人电影写实", "3D 写实渲染", "3D 超写实渲染", "3D 虚幻引擎风", "3D 游戏 CG",
    "3D 半写实", "3D 皮克斯风", "3D 迪士尼风", "3D 萌系 Q 版", "3D 粘土风",
    "3D 三渲二", "3D Low Poly", "2D 动画", "2D 日式动漫", "2D 国漫风",
    "2D 美式卡通", "2D Q 版卡通", "2D 水彩油画", "2D 水墨国风", "2D 赛博风格"
  ];
  const [globalStyle, setGlobalStyle] = useState<string>("真人电影写实");
  const [assetStyles, setAssetStyles] = useState<Record<string, string>>({});
  const [voicesByCharacter, setVoicesByCharacter] = useState<Record<string, CharacterVoice>>({});

  const saveTimeouts = useRef<Record<string, NodeJS.Timeout>>({});

  const triggerAutoSave = useCallback(
    (
      assetId: string,
      updates: {
        prompt?: string;
        model?: string;
        size?: string;
        style?: string;
      }
    ) => {
      if (!projectId) return;

      if (saveTimeouts.current[assetId]) {
        clearTimeout(saveTimeouts.current[assetId]);
      }

      saveTimeouts.current[assetId] = setTimeout(async () => {
        const token = getToken();
        if (!token) return;
        try {
          await updateAssetConfig(token, projectId, assetId, updates);
        } catch (e) {
          console.error("Auto-save failed", e);
        } finally {
          delete saveTimeouts.current[assetId];
        }
      }, 2000);
    },
    [projectId]
  );

  const handleGlobalStyleChange = (newStyle: string) => {
    setGlobalStyle(newStyle);
    const newAssetStyles: Record<string, string> = {};
    assets.forEach((asset) => {
      newAssetStyles[asset.id] = newStyle;
      triggerAutoSave(asset.id, { style: newStyle });
    });
    setAssetStyles(newAssetStyles);
  };

  const SUPPORTED_SIZES = [
    { label: "竖屏 (9:16)", value: "9:16" },
    { label: "竖构图 (3:4)", value: "3:4" },
    { label: "方图 (1:1)", value: "1:1" },
    { label: "横构图 (4:3)", value: "4:3" },
    { label: "横屏 (16:9)", value: "16:9" },
  ];

  const getAssetDefaultSize = useCallback(() => {
    return "16:9";
  }, []);
  const [configLoading, setConfigLoading] = useState(false);
  const [previewImageUrl, setPreviewImageUrl] = useState<string | null>(null);
  const [generatingUiKeys, setGeneratingUiKeys] = useState<Set<string>>(new Set());
  const [scriptContent, setScriptContent] = useState("");
  const [scriptLoading, setScriptLoading] = useState(false);
  const [modifyingImage, setModifyingImage] = useState<{
    uiKey: string;
    sourceAssetId: string;
    versionId: string;
    url: string;
  } | null>(null);
  const [modificationPrompt, setModificationPrompt] = useState("");
  const [uploadingAssetIds, setUploadingAssetIds] = useState<Set<string>>(new Set());
  const [uploadTarget, setUploadTarget] = useState<{ aggregatedAssetId: string; sourceAssetId: string } | null>(null);
  const [selectingVersionKey, setSelectingVersionKey] = useState<string | null>(null);
  const [deletingVersionKey, setDeletingVersionKey] = useState<string | null>(null);
  const [generatingSubjectAssetIds, setGeneratingSubjectAssetIds] = useState<Set<string>>(new Set());
  const [subjectFallbackConfirm, setSubjectFallbackConfirm] = useState<{
    uiAssetId: string;
    targetAssetId: string;
    hint: string;
  } | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const defaultTemplate =
    "为{{type_cn}} {{name}} 生成高质量、写实风格的参考图，包含细节描述、风格、光照与色调。{{description}}";

  const getAssetTypeLabel = useCallback((assetType: string) => {
    if (assetType === "CHARACTER") {
      return "角色";
    }
    if (assetType === "CHARACTER_LOOK") {
      return "角色形象";
    }
    if (assetType === "SCENE") {
      return "场景";
    }
    if (assetType === "PROP") {
      return "道具";
    }
    return assetType;
  }, []);

  const getAssetDisplayTitle = useCallback(
    (asset: AggregatedAsset) => getAssetDisplayName(asset.name),
    []
  );

  const renderAssetTemplate = useCallback(
    (template: string, asset: Asset) =>
      applyTemplate(template, {
        name: getAssetDisplayName(asset.name),
        type: asset.type,
        type_cn: getAssetTypeLabel(asset.type),
        description: asset.description ?? "",
      }),
    [getAssetTypeLabel]
  );

  const buildCharacterPrompt = useCallback((description?: string | null) => {
    return description?.trim() || "";
  }, []);

  const buildCharacterLookPrompt = useCallback((description?: string | null) => {
    return description?.trim() || "";
  }, []);

  const loadAssets = useCallback(async (opts?: { preserveError?: boolean }) => {
    if (!projectId) {
      return;
    }
    const token = getToken();
    if (!token) {
      window.location.href = "/login";
      return;
    }
    if (!opts?.preserveError) {
      setError(null);
    }
    try {
      const result = await getAssets(token, projectId);
      setAssets(result);
      setGeneratingUiKeys(reconcilePendingJobs(projectId, result));
      setAssetPrompts((prev) => {
        const next = { ...prev };
        result.forEach((asset) => {
          if (asset.prompt) {
            next[asset.id] = asset.prompt;
          } else {
            const current = next[asset.id];
            if (!current || !current.trim()) {
              if (asset.type === "CHARACTER") {
                const characterPrompt = buildCharacterPrompt(asset.description);
                next[asset.id] = characterPrompt || renderAssetTemplate(defaultTemplate, asset);
              } else if (asset.type === "CHARACTER_LOOK") {
                const lookPrompt = buildCharacterLookPrompt(asset.description);
                next[asset.id] = lookPrompt || renderAssetTemplate(defaultTemplate, asset);
              } else {
                next[asset.id] = renderAssetTemplate(defaultTemplate, asset);
              }
            }
          }
        });
        return next;
      });
      setAssetModels((prev) => {
        const next = { ...prev };
        result.forEach((asset) => {
          if (asset.model) {
            next[asset.id] = asset.model;
          } else if (!next[asset.id]) {
            next[asset.id] = defaultImageModel;
          }
        });
        return next;
      });
      setAssetSizes((prev) => {
        const next = { ...prev };
        result.forEach((asset) => {
          if (asset.size) {
            next[asset.id] = asset.size;
          } else if (!next[asset.id]) {
            next[asset.id] = getAssetDefaultSize();
          }
        });
        return next;
      });
      setAssetStyles((prev) => {
        const next = { ...prev };
        result.forEach((asset) => {
          if (asset.style) {
            next[asset.id] = asset.style;
          } else if (!next[asset.id]) {
            next[asset.id] = globalStyle;
          }
        });
        return next;
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "获取素材失败";
      if (isProjectMissingError(errorMessage)) {
        redirectToProjectsOnMissing();
        return;
      }
      setError(errorMessage);
    }
  }, [
    buildCharacterLookPrompt,
    buildCharacterPrompt,
    defaultTemplate,
    projectId,
    redirectToProjectsOnMissing,
    renderAssetTemplate,
  ]);

  useEffect(() => {
    void loadAssets();
  }, [loadAssets]);

  useEffect(() => {
    if (!projectId) return;
    const timer = window.setInterval(() => {
      const jobs = readPendingAssetGenJobs(projectId);
      if (jobs.length === 0) return;
      const token = getToken();
      if (!token) return;
      void Promise.all(
        jobs.map(async (job) => {
          try {
            const status = await getAssetGenerateTaskStatus(token, projectId, job.taskId);
            if (status.status === "COMPLETED" || status.status === "FAILED") {
              removePendingAssetGenJob(projectId, job.uiKey);
              if (status.status === "FAILED") {
                setError(status.error || "素材生成失败");
              }
            }
          } catch {
          }
        })
      ).finally(() => {
        void loadAssets({ preserveError: true });
      });
    }, 3000);
    return () => window.clearInterval(timer);
  }, [projectId, loadAssets]);

  const loadConfig = useCallback(async () => {
    const token = getToken();
    if (!token) {
      window.location.href = "/login";
      return;
    }
    setConfigLoading(true);
    setError(null);
    try {
      await getSettings(token);
      const modelsRaw = await getModels(token);
      const drawIds = extractDrawModels(modelsRaw);
      const merged: string[] = [];
      const seen = new Set<string>();
      for (const id of drawIds) {
        const k = id.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        merged.push(id);
      }
      if (!seen.has(OPENROUTER_IMAGE_MODEL.toLowerCase())) {
        merged.push(OPENROUTER_IMAGE_MODEL);
      }
      setImageModels(merged.length ? merged : [OPENROUTER_IMAGE_MODEL]);
      setDefaultImageModel(OPENROUTER_IMAGE_MODEL);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
    } finally {
      setConfigLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  const loadScript = useCallback(async () => {
    if (!projectId) {
      return;
    }
    const token = getToken();
    if (!token) {
      window.location.href = "/login";
      return;
    }
    setScriptLoading(true);
    try {
      const result = await getScript(token, projectId);
      const SEPARATOR = "\n\n=== 原文剧本 (请勿删除此行) ===\n\n";
      const content = result.content ?? "";
      if (content.includes(SEPARATOR)) {
        setScriptContent(content.split(SEPARATOR)[1]);
      } else {
        setScriptContent(content);
      }
      if (scriptCacheKey) {
        localStorage.setItem(
          scriptCacheKey,
          JSON.stringify({
            content: content.includes(SEPARATOR) ? content.split(SEPARATOR)[1] : content,
          })
        );
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "加载失败";
      if (isProjectMissingError(errorMessage)) {
        redirectToProjectsOnMissing();
        return;
      }
      if (scriptCacheKey) {
        const cached = localStorage.getItem(scriptCacheKey);
        if (cached) {
          try {
            const parsed = JSON.parse(cached) as { content?: string };
            setScriptContent(parsed.content ?? "");
            setError("远端加载失败，已恢复本地缓存");
            return;
          } catch {
          }
        }
      }
      setScriptContent("");
      setError(errorMessage);
    } finally {
      setScriptLoading(false);
    }
  }, [projectId, redirectToProjectsOnMissing, scriptCacheKey]);

  useEffect(() => {
    void loadScript();
  }, [loadScript]);

  useEffect(() => {
    if (!projectId) {
      return;
    }
    const token = getToken();
    if (!token) {
      return;
    }
    getProjectVoices(token, projectId)
      .then((list) => {
        const mapped: Record<string, CharacterVoice> = {};
        list.forEach((item) => {
          mapped[item.character_name] = item;
          mapped[normalizeRoleKey(item.character_name)] = item;
        });
        setVoicesByCharacter(mapped);
      })
      .catch(() => {
        setVoicesByCharacter({});
      });
  }, [projectId]);

  const runGenerate = async (asset: AggregatedAsset) => {
    if (!projectId) {
      return;
    }
    const token = getToken();
    if (!token) {
      window.location.href = "/login";
      return;
    }
    const uiKey = getAssetIdentityKey(asset);
    if (generatingUiKeys.has(uiKey)) {
      return;
    }
    if (readPendingAssetGenJobs(projectId).length >= MAX_PARALLEL_GENERATIONS) {
      setStatus(`最多同时生成 ${MAX_PARALLEL_GENERATIONS} 张，请等待已有任务完成`);
      return;
    }
    const activeAssetId =
      modifyingImage && modifyingImage.uiKey === uiKey
        ? modifyingImage.sourceAssetId
        : asset.activeAssetId;
    const sourceAssetIds = [...asset.sourceAssetIds];
    const versionIdsSnapshot = sourceAssetIds.flatMap((id) => {
      const raw = assets.find((a) => a.id === id);
      return raw ? raw.versions.map((v) => v.id) : [];
    });

    setError(null);
    setStatus(
      `生成中（${readPendingAssetGenJobs(projectId).length + 1}/${MAX_PARALLEL_GENERATIONS}）...`
    );

    let shouldClearPending = false;
    try {
      if (modifyingImage && modifyingImage.uiKey === uiKey) {
        const rawRefUrl = (modifyingImage.url || "").trim();
        const isLocalLikeRef =
          rawRefUrl.startsWith("data:image") ||
          rawRefUrl.startsWith("/static/") ||
          ((rawRefUrl.startsWith("http://") || rawRefUrl.startsWith("https://")) &&
            rawRefUrl.includes("/static/") &&
            (rawRefUrl.includes("localhost") ||
              rawRefUrl.includes("127.0.0.1") ||
              rawRefUrl.includes(":8003")));
        let refImageUrl = rawRefUrl;
        if (isLocalLikeRef) {
          const sourceAsset = assets.find((item) => item.id === modifyingImage.sourceAssetId) ?? asset;
          const remoteVersion = [...sourceAsset.versions]
            .reverse()
            .find((version) => {
              const versionUrl = (version.image_url || "").trim();
              if (!(versionUrl.startsWith("http://") || versionUrl.startsWith("https://"))) {
                return false;
              }
              if (
                versionUrl.includes("/static/") &&
                (versionUrl.includes("localhost") ||
                  versionUrl.includes("127.0.0.1") ||
                  versionUrl.includes(":8003"))
              ) {
                return false;
              }
              return true;
            });
          if (remoteVersion?.image_url) {
            refImageUrl = remoteVersion.image_url;
            setStatus("检测到本地参考图，已自动切换到该素材的最新远程版本后继续生成...");
          }
          // 否则仍提交当前参考地址，由后端结合 PUBLIC_BASE_URL 解析 /static 与 data 图
        }
        const task = await generateAsset(token, projectId, activeAssetId, {
          prompt: modificationPrompt || undefined,
          model: assetModels[activeAssetId] || undefined,
          ref_image_url: refImageUrl,
          style: assetStyles[activeAssetId] || globalStyle,
          options: {
            aspect_ratio: assetSizes[activeAssetId] || getAssetDefaultSize(),
            size: "4K",
          },
        });
        pushPendingAssetGenJob(projectId, {
          sourceAssetIds,
          uiKey,
          versionIdsSnapshot,
          taskId: task.task_id,
          startedAt: Date.now(),
        });
        setGeneratingUiKeys(reconcilePendingJobs(projectId, assets));
      } else {
        let refImageUrl: string | undefined;
        if (asset.type === "CHARACTER_LOOK") {
          const roleName = normalizeRoleKey(asset.name);
          const matchedAssets = characterAssets.filter(
            (item) => normalizeRoleKey(item.name) === roleName
          );
          const selectedCandidate = matchedAssets
            .map((item) => ({
              asset: item,
              version: item.versions.find((version) => version.is_selected && Boolean((version.image_url || "").trim())),
            }))
            .find((item) => Boolean(item.version));
          if (selectedCandidate?.version) {
            refImageUrl = selectedCandidate.version.image_url;
          } else {
            setError("请先在角色素材中选中一张图片，再生成该角色形象");
            setStatus(null);
            return;
          }
        }

        const task = await generateAsset(token, projectId, activeAssetId, {
          prompt: assetPrompts[activeAssetId] || undefined,
          model: assetModels[activeAssetId] || undefined,
          ref_image_url: refImageUrl,
          style: assetStyles[activeAssetId] || globalStyle,
          options: {
            aspect_ratio: assetSizes[activeAssetId] || getAssetDefaultSize(),
            size: "4K",
          },
        });
        pushPendingAssetGenJob(projectId, {
          sourceAssetIds,
          uiKey,
          versionIdsSnapshot,
          taskId: task.task_id,
          startedAt: Date.now(),
        });
        setGeneratingUiKeys(reconcilePendingJobs(projectId, assets));
      }
      setStatus("任务已提交，正在生成中...");
    } catch (err) {
      shouldClearPending = true;
      const msg = err instanceof Error ? err.message : "生成失败";
      setError(msg);
      setStatus(null);
    } finally {
      if (shouldClearPending) {
        removePendingAssetGenJob(projectId, uiKey);
      }
      void loadAssets({ preserveError: true });
    }
  };

  const runGenerateSubject = async (asset: AggregatedAsset) => {
    if (!projectId) return;
    const token = getToken();
    if (!token) {
      window.location.href = "/login";
      return;
    }
    if (asset.type !== "CHARACTER_LOOK") {
      setError("仅角色形象支持生成主体");
      return;
    }
    const selectedVersion = asset.versions.find(
      (item) => item.is_selected && Boolean((item.image_url || "").trim())
    );
    if (!selectedVersion) {
      setError("请先选中角色形象图片，再生成主体");
      return;
    }
    const targetAssetId = selectedVersion.assetId || asset.activeAssetId;
    const roleKey = normalizeRoleKey(asset.name);
    const voice = voicesByCharacter[roleKey] || voicesByCharacter[asset.name];
    if (!voice?.voice_id || (voice.voice_type || "").toUpperCase() !== "KLING_CUSTOM") {
      setError("请先上传角色音频文件，再生成主体");
      return;
    }

    setError(null);
    setStatus("正在生成主体...");
    setGeneratingSubjectAssetIds((prev) => {
      const next = new Set(prev);
      next.add(asset.activeAssetId);
      return next;
    });
    try {
      await generateAssetSubject(token, projectId, targetAssetId);
      setStatus("主体生成成功");
      setMessage("主体生成成功");
      setSubjectFallbackConfirm(null);
    } catch (err) {
      setMessage(null);
      const errMsg = err instanceof Error ? err.message : "生成主体失败";
      if (errMsg.includes("未通过“音色绑定主体”检测")) {
        setSubjectFallbackConfirm({ uiAssetId: asset.activeAssetId, targetAssetId, hint: errMsg });
        setStatus(null);
        return;
      }
      setError(errMsg);
      setStatus(null);
    } finally {
      setGeneratingSubjectAssetIds((prev) => {
        const next = new Set(prev);
        next.delete(asset.activeAssetId);
        return next;
      });
    }
  };

  const openUploadPicker = (asset: AggregatedAsset) => {
    if (uploadingAssetIds.has(asset.id)) {
      return;
    }
    setUploadTarget({ aggregatedAssetId: asset.id, sourceAssetId: asset.activeAssetId });
    uploadInputRef.current?.click();
  };

  const handleUploadChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = event.target.files?.[0];
    event.target.value = "";
    if (!selectedFile || !uploadTarget || !projectId) {
      return;
    }
    if (!selectedFile.type.startsWith("image/")) {
      setError("仅支持上传图片文件");
      return;
    }
    const token = getToken();
    if (!token) {
      window.location.href = "/login";
      return;
    }
    setError(null);
    setStatus("上传中...");
    setUploadingAssetIds((prev) => {
      const next = new Set(prev);
      next.add(uploadTarget.aggregatedAssetId);
      return next;
    });
    try {
      await uploadAssetImage(token, projectId, uploadTarget.sourceAssetId, selectedFile);
      await loadAssets();
      setStatus("上传完成");
    } catch (err) {
      setError(err instanceof Error ? err.message : "上传失败");
      setStatus(null);
    } finally {
      setUploadingAssetIds((prev) => {
        const next = new Set(prev);
        next.delete(uploadTarget.aggregatedAssetId);
        return next;
      });
      setUploadTarget(null);
    }
  };

  const handleSelectVersion = async (asset: AggregatedAsset, version: AggregatedVersion) => {
    if (!projectId || version.is_selected) return;
    const token = getToken();
    if (!token) {
      window.location.href = "/login";
      return;
    }
    const actionKey = `${version.assetId}:${version.id}`;
    setSelectingVersionKey(actionKey);
    setError(null);
    try {
      await selectAssetVersion(token, projectId, version.assetId, version.id);
      await loadAssets();
      setStatus(`已选中 ${getAssetDisplayName(asset.name)} 的版本${asset.versions.findIndex((item) => item.id === version.id) + 1}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "选中版本失败");
    } finally {
      setSelectingVersionKey(null);
    }
  };

  const handleDeleteVersion = async (version: AggregatedVersion) => {
    if (!projectId) return;
    const token = getToken();
    if (!token) {
      window.location.href = "/login";
      return;
    }
    const actionKey = `${version.assetId}:${version.id}`;
    setDeletingVersionKey(actionKey);
    setError(null);
    try {
      await deleteAssetVersion(token, projectId, version.assetId, version.id);
      await loadAssets();
      setStatus("删除版本成功");
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除版本失败");
    } finally {
      setDeletingVersionKey(null);
    }
  };

  const aggregatedAssets = Object.values(
    assets.reduce<Record<string, AggregatedAsset>>((acc, asset) => {
      const key = getAssetIdentityKey(asset);
      if (!acc[key]) {
        acc[key] = {
          ...asset,
          activeAssetId: asset.id,
          sourceAssetIds: [asset.id],
          versions: asset.versions.map((version) => ({
            ...version,
            assetId: asset.id,
            assetName: asset.name,
          })),
        };
        return acc;
      }
      const current = acc[key];
      const hasSelected = asset.versions.some((version) => version.is_selected);
      const currentHasSelected = current.versions.some((version) => version.is_selected);
      if (hasSelected || !currentHasSelected) {
        current.activeAssetId = asset.id;
        current.description = asset.description;
        current.prompt = asset.prompt;
        current.model = asset.model;
        current.size = asset.size;
        current.style = asset.style;
      }
      current.sourceAssetIds.push(asset.id);
      current.versions.push(
        ...asset.versions.map((version) => ({
          ...version,
          assetId: asset.id,
          assetName: asset.name,
        }))
      );
      return acc;
    }, {})
  );

  const characterAssets = aggregatedAssets.filter((asset) => asset.type === "CHARACTER");
  const lookAssets = aggregatedAssets.filter((asset) => asset.type === "CHARACTER_LOOK");
  const otherAssets = aggregatedAssets.filter(
    (asset) => asset.type !== "CHARACTER" && asset.type !== "CHARACTER_LOOK"
  );

  const looksByRole = lookAssets.reduce<Record<string, AggregatedAsset[]>>((acc, asset) => {
    const baseName = normalizeRoleKey(asset.name);
    if (!acc[baseName]) {
      acc[baseName] = [];
    }
    acc[baseName].push(asset);
    return acc;
  }, {});

  const renderAssetContent = (asset: AggregatedAsset, afterPrompt?: ReactNode) => {
    const editableAssetId = asset.activeAssetId;
    const uiKeyRow = getAssetIdentityKey(asset);
    return (
    <>
      {(() => {
        const isGeneratingCurrent = generatingUiKeys.has(uiKeyRow);
        const isUploadingCurrent = uploadingAssetIds.has(asset.id);
        const isConcurrencyFull =
          generatingUiKeys.size >= MAX_PARALLEL_GENERATIONS && !isGeneratingCurrent;
        return (
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div className="text-sm font-semibold">
          {getAssetDisplayTitle(asset)}
        </div>
        <div className="flex w-full items-center gap-2 md:w-auto">
          {(() => {
            const resolvedDefault =
              defaultImageModel || OPENROUTER_IMAGE_MODEL;
            const raw = (assetModels[editableAssetId] ?? "").trim();
            const currentModel = raw || resolvedDefault;
            const selectOptions = [...imageModels];
            if (
              currentModel &&
              !selectOptions.some((m) => m === currentModel)
            ) {
              selectOptions.unshift(currentModel);
            }
            if (selectOptions.length === 0) {
              selectOptions.push(resolvedDefault);
            }
            return (
              <select
                value={currentModel}
                onChange={(event) => {
                  const newVal = event.target.value;
                  setAssetModels((prev) => ({
                    ...prev,
                    [editableAssetId]: newVal,
                  }));
                  triggerAutoSave(editableAssetId, { model: newVal });
                }}
                disabled={configLoading && imageModels.length === 0}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs md:w-44"
                title="绘画模型（由后端映射为 GRSAI 接口 model）"
              >
                {selectOptions.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            );
          })()}
          <select
            value={assetSizes[editableAssetId] || getAssetDefaultSize()}
            onChange={(e) => {
              const newVal = e.target.value;
              setAssetSizes((prev) => ({ ...prev, [editableAssetId]: newVal }));
              triggerAutoSave(editableAssetId, { size: newVal });
            }}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs md:w-32"
          >
            {SUPPORTED_SIZES.map((size) => (
              <option key={size.value} value={size.value}>
                {size.label}
              </option>
            ))}
          </select>
          <select
            value={assetStyles[editableAssetId] || globalStyle}
            onChange={(e) => {
              const newVal = e.target.value;
              setAssetStyles((prev) => ({ ...prev, [editableAssetId]: newVal }));
              triggerAutoSave(editableAssetId, { style: newVal });
            }}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs md:w-32"
          >
            {STYLE_OPTIONS.map((style) => (
              <option key={style} value={style}>
                {style}
              </option>
            ))}
          </select>
          {modifyingImage?.uiKey !== uiKeyRow && (
            <>
              <button
                onClick={() => openUploadPicker(asset)}
                disabled={isUploadingCurrent}
                className="whitespace-nowrap rounded-lg border border-slate-200 px-3 py-2 text-xs"
              >
                {isUploadingCurrent ? "上传中..." : "上传图片"}
              </button>
              <button
                onClick={() => runGenerate(asset)}
                disabled={isGeneratingCurrent || isConcurrencyFull}
                className="whitespace-nowrap rounded-lg border border-slate-200 px-3 py-2 text-xs"
              >
                {isGeneratingCurrent ? "生成中..." : "生成素材"}
              </button>
              {asset.type === "CHARACTER_LOOK" ? (
                <button
                  onClick={() => runGenerateSubject(asset)}
                  disabled={generatingSubjectAssetIds.has(asset.activeAssetId)}
                  className="whitespace-nowrap rounded-lg border border-slate-200 px-3 py-2 text-xs"
                >
                  {generatingSubjectAssetIds.has(asset.activeAssetId) ? "生成中..." : "生成主体"}
                </button>
              ) : null}
            </>
          )}
        </div>
      </div>
        );
      })()}

      {modifyingImage?.uiKey === uiKeyRow ? (
        <div className="mt-3 rounded-lg border border-indigo-200 bg-indigo-50 p-3">
          <div className="mb-2 flex items-center justify-between text-xs font-medium text-indigo-900">
            <span>AI 辅助修改模式</span>
            <button
              onClick={() => {
                setModifyingImage(null);
                setModificationPrompt("");
              }}
              className="text-indigo-600 hover:text-indigo-800"
            >
              取消修改
            </button>
          </div>
          <div className="flex gap-4">
            <div className="relative h-24 w-24 flex-shrink-0 overflow-hidden rounded-lg border border-indigo-200 bg-white">
              <Image
                src={modifyingImage.url}
                alt="参考图"
                fill
                unoptimized
                referrerPolicy="no-referrer"
                className="object-cover"
              />
            </div>
            <div className="flex flex-1 flex-col gap-2">
              <textarea
                value={modificationPrompt}
                onChange={(e) => setModificationPrompt(e.target.value)}
                className="w-full flex-1 rounded-lg border border-indigo-200 px-3 py-2 text-xs focus:border-indigo-500 focus:ring-indigo-500"
                placeholder="请输入修改意见（例如：把头发改成红色，背景换成森林...）"
                rows={3}
              />
              <button
                onClick={() => runGenerate(asset)}
                disabled={
                  generatingUiKeys.has(uiKeyRow) ||
                  (generatingUiKeys.size >= MAX_PARALLEL_GENERATIONS &&
                    !generatingUiKeys.has(uiKeyRow))
                }
                className="self-end rounded-lg bg-indigo-600 px-3 py-1.5 text-xs text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                {generatingUiKeys.has(uiKeyRow) ? "修改中..." : "生成素材"}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex flex-col gap-2 md:flex-row md:items-start">
          <textarea
            value={assetPrompts[editableAssetId] ?? ""}
            onChange={(event) => {
              const newVal = event.target.value;
              setAssetPrompts((prev) => ({ ...prev, [editableAssetId]: newVal }));
              triggerAutoSave(editableAssetId, { prompt: newVal });
            }}
            className="w-full flex-1 rounded-lg border border-slate-200 px-3 py-2 text-xs"
            placeholder="提示词（可选）"
            rows={3}
          />
        </div>
      )}

      {afterPrompt ? <div className="mt-3">{afterPrompt}</div> : null}

      {asset.versions.length === 0 ? (
        <div className="mt-2 text-xs text-slate-500">暂无素材，请点击上方“生成素材”</div>
      ) : (
        <div className="mt-3">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {asset.versions.map((version, index) => (
              <div key={version.id} className="rounded-lg border border-slate-200">
                <div
                  className="relative cursor-pointer bg-slate-50 p-2"
                  onClick={() => {
                    setPreviewImageUrl(version.image_url);
                  }}
                >
                  <div className="absolute right-2 top-2 z-10 flex items-center gap-1">
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        void handleDeleteVersion(version);
                      }}
                      disabled={deletingVersionKey === `${version.assetId}:${version.id}`}
                      className="rounded bg-white/90 px-2 py-1 text-xs text-rose-700 shadow-sm disabled:opacity-50"
                    >
                      {deletingVersionKey === `${version.assetId}:${version.id}` ? "删除中" : "删除"}
                    </button>
                  </div>
                  <div className="absolute left-2 top-2 z-10 rounded bg-black/60 px-2 py-1 text-[11px] text-white">
                    {`版本${index + 1}`}
                    {version.is_selected ? " · 已选中" : ""}
                  </div>
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      setModifyingImage({
                        uiKey: getAssetIdentityKey(asset),
                        sourceAssetId: version.assetId,
                        versionId: version.id,
                        url: version.image_url,
                      });
                      setModificationPrompt("");
                    }}
                    className="absolute bottom-2 left-2 z-10 rounded-md bg-white/90 px-2 py-1 text-xs text-indigo-600 shadow-sm"
                  >
                    AI修改
                  </button>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      void handleSelectVersion(asset, version);
                    }}
                    disabled={version.is_selected || selectingVersionKey === `${version.assetId}:${version.id}`}
                    className="absolute bottom-2 right-2 z-10 rounded-md bg-white/90 px-2 py-1 text-xs text-sky-700 shadow-sm disabled:opacity-50"
                  >
                    {version.is_selected
                      ? "已选中"
                      : selectingVersionKey === `${version.assetId}:${version.id}`
                        ? "选中中"
                        : "选中"}
                  </button>
                  <Image
                    src={version.image_url}
                    alt={`${getAssetDisplayName(asset.name)}-版本${index + 1}`}
                    width={900}
                    height={1200}
                    sizes="(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw"
                    unoptimized
                    referrerPolicy="no-referrer"
                    className="h-auto w-full object-contain"
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
    );
  };

  const renderAssetCard = (asset: AggregatedAsset) => (
    <div key={asset.id} className="rounded-lg border border-slate-200 p-3">
      {renderAssetContent(asset)}
    </div>
  );

  return (
    <div className="space-y-6 relative">
      {error && (
        <div className="fixed top-20 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 shadow-lg">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-5 w-5 text-red-500"
            viewBox="0 0 20 20"
            fill="currentColor"
          >
            <path
              fillRule="evenodd"
              d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
              clipRule="evenodd"
            />
          </svg>
          <span>{error}</span>
          <button
            onClick={() => setError(null)}
            className="ml-2 rounded-full p-1 hover:bg-red-100"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-4 w-4 text-red-500"
              viewBox="0 0 20 20"
              fill="currentColor"
            >
              <path
                fillRule="evenodd"
                d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                clipRule="evenodd"
              />
            </svg>
          </button>
        </div>
      )}
      {message && (
        <div className="fixed top-20 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700 shadow-lg">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-5 w-5 text-emerald-500"
            viewBox="0 0 20 20"
            fill="currentColor"
          >
            <path
              fillRule="evenodd"
              d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.707a1 1 0 00-1.414-1.414L9 10.172 7.707 8.879a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
              clipRule="evenodd"
            />
          </svg>
          <span>{message}</span>
          <button
            onClick={() => setMessage(null)}
            className="ml-2 rounded-full p-1 hover:bg-emerald-100"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-4 w-4 text-emerald-500"
              viewBox="0 0 20 20"
              fill="currentColor"
            >
              <path
                fillRule="evenodd"
                d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                clipRule="evenodd"
              />
            </svg>
          </button>
        </div>
      )}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Step 3: 生成素材</h1>
        <div className="flex items-center gap-2">
          <button
            onClick={() => router.push(`/projects/${projectId}/script/resources`)}
            className="rounded-lg border border-slate-200 px-4 py-2 text-sm hover:bg-slate-50 text-slate-600"
          >
            上一步
          </button>
          <button
            onClick={() => router.push(`/projects/${projectId}/script/storyboard`)}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm text-white hover:bg-slate-800"
          >
            下一步：一键生成分镜
          </button>
        </div>
      </div>
      <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm">
        <div className="font-semibold">原文剧本 (参考)</div>
        {scriptLoading ? <div className="mt-2 text-slate-400">加载中...</div> : null}
        <textarea
          value={scriptContent}
          readOnly
          className="mt-3 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700"
          rows={6}
          placeholder="暂无剧本内容"
        />
      </div>
      <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm">
        <div className="flex items-center justify-between font-semibold">
          <span>素材列表</span>
          <div className="flex items-center gap-2">
            <span className="text-xs font-normal text-slate-500">全局风格：</span>
            <select
              value={globalStyle}
              onChange={(e) => handleGlobalStyleChange(e.target.value)}
              className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-normal"
            >
              {STYLE_OPTIONS.map((style) => (
                <option key={style} value={style}>
                  {style}
                </option>
              ))}
            </select>
          </div>
        </div>
        {status ? <div className="mt-2 text-blue-600">{status}</div> : null}
        {configLoading ? <div className="mt-1 text-xs text-slate-400">模型加载中...</div> : null}
        {assets.length === 0 ? (
          <div className="mt-2 text-slate-600">{error ? "素材加载失败，请稍后重试。" : "尚未提取素材。"}</div>
        ) : (
          <div className="mt-4 space-y-4">
            {characterAssets.map((asset) => (
              <div key={asset.id} className="rounded-lg border border-sky-200 border-l-4 border-l-sky-300 bg-sky-50/50 p-3">
                {renderAssetContent(
                  asset,
                  <div className="rounded-lg border border-slate-100 bg-slate-50 p-3">
                    <div className="mb-2 text-xs font-semibold text-slate-600">角色音频（自动创建 Kling 自定义音色）</div>
                    <VoiceSelector
                      projectId={projectId}
                      characterName={normalizeRoleKey(asset.name)}
                      initialVoice={
                        voicesByCharacter[normalizeRoleKey(asset.name)] || voicesByCharacter[asset.name]
                      }
                      onVoiceUpdate={(updated) =>
                        setVoicesByCharacter((prev) => ({
                          ...prev,
                          [updated.character_name]: updated,
                          [normalizeRoleKey(asset.name)]: updated,
                          [asset.name]: updated,
                        }))
                      }
                    />
                  </div>
                )}
                {looksByRole[normalizeRoleKey(asset.name)]?.length ? (
                  <div className="mt-4 border-t border-slate-200 pt-3">
                    <div className="text-xs font-semibold text-slate-600">角色形象</div>
                    <div className="mt-3 space-y-3">
                      {looksByRole[normalizeRoleKey(asset.name)].map((look) => (
                        <div
                          key={look.id}
                          className="rounded-lg border border-slate-200 p-3"
                        >
                          {renderAssetContent(look)}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            ))}
            {otherAssets.map((asset) => renderAssetCard(asset))}
          </div>
        )}
      </div>
      {subjectFallbackConfirm ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-2xl">
            <div className="text-base font-semibold text-slate-900">主体生成确认</div>
            <div className="mt-3 text-sm leading-6 text-slate-600">
              {subjectFallbackConfirm.hint}
              <div className="mt-2">是否继续以“不绑定音色”方式生成主体？</div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setSubjectFallbackConfirm(null)}
                className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700"
              >
                暂不生成
              </button>
              <button
                type="button"
                onClick={async () => {
                  if (!projectId) return;
                  const token = getToken();
                  if (!token) {
                    window.location.href = "/login";
                    return;
                  }
                  const target = subjectFallbackConfirm;
                  if (!target) return;
                  setSubjectFallbackConfirm(null);
                  setError(null);
                  setStatus("正在生成主体（不绑定音色）...");
                  setGeneratingSubjectAssetIds((prev) => {
                    const next = new Set(prev);
                    next.add(target.uiAssetId);
                    return next;
                  });
                  try {
                    await generateAssetSubject(token, projectId, target.targetAssetId, { allow_without_voice: true });
                    setStatus("主体生成成功（未绑定音色）");
                    setMessage("主体生成成功（未绑定音色）");
                  } catch (err) {
                    setMessage(null);
                    setError(err instanceof Error ? err.message : "生成主体失败");
                    setStatus(null);
                  } finally {
                    setGeneratingSubjectAssetIds((prev) => {
                      const next = new Set(prev);
                      next.delete(target.uiAssetId);
                      return next;
                    });
                  }
                }}
                className="rounded-lg bg-slate-900 px-3 py-2 text-sm text-white"
              >
                继续生成（不绑定音色）
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {previewImageUrl ? (
        <div
          className="fixed inset-0 z-50 overflow-auto bg-black/70 p-4"
          onClick={() => setPreviewImageUrl(null)}
        >
          <div className="mx-auto flex min-h-full items-center justify-center">
            <Image
              src={previewImageUrl}
              alt="预览"
              width={1800}
              height={2400}
              sizes="100vw"
              unoptimized
              referrerPolicy="no-referrer"
              className="max-w-full object-contain"
              priority
            />
          </div>
        </div>
      ) : null}
      <input
        ref={uploadInputRef}
        type="file"
        accept="image/*"
        onChange={handleUploadChange}
        className="hidden"
      />
    </div>
  );
}
