"use client";

import { ReactNode, useCallback, useEffect, useState, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import Image from "next/image";
import {
  Asset,
  CharacterVoice,
  generateAsset,
  getAssets,
  getModels,
  getProjectVoices,
  getSettings,
  getScript,
  updateAssetConfig,
  deleteAssetVersion,
  selectAssetVersion,
} from "@/lib/api";
import { getToken } from "@/lib/auth";
import { VoiceSelector } from "@/app/components/VoiceSelector";
import { extractModels, filterModels } from "@/lib/models";
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

export default function AssetsPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const projectId = params.id;
  const scriptCacheKey = projectId ? `script-cache-${projectId}` : "";
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [assetPrompts, setAssetPrompts] = useState<Record<string, string>>({});
  const [assetModels, setAssetModels] = useState<Record<string, string>>({});
  const [assetSizes, setAssetSizes] = useState<Record<string, string>>({});
  const [imageModels, setImageModels] = useState<string[]>([]);
  const [defaultImageModel, setDefaultImageModel] = useState("");
  const [savedModel, setSavedModel] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  
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
    { label: "竖屏 (1792x2304)", value: "1792x2304" },
    { label: "横屏 (2304x1792)", value: "2304x1792" },
    { label: "方图 (2048x2048)", value: "2048x2048" },
  ];

  const getAssetDefaultSize = useCallback((type: string) => {
    // User requested default to landscape for all types (Character, Look, Scene, Prop)
    return "2304x1792";
  }, []);
  const [configLoading, setConfigLoading] = useState(false);
  const [previewImageUrl, setPreviewImageUrl] = useState<string | null>(null);
  const [generatingAssetId, setGeneratingAssetId] = useState<string | null>(null);
  const [scriptContent, setScriptContent] = useState("");
  const [scriptLoading, setScriptLoading] = useState(false);
  const [modifyingImage, setModifyingImage] = useState<{
    assetId: string;
    versionId: string;
    url: string;
  } | null>(null);
  const [modificationPrompt, setModificationPrompt] = useState("");
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

  const renderAssetTemplate = useCallback(
    (template: string, asset: Asset) =>
      applyTemplate(template, {
        name: asset.name,
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

  const loadAssets = useCallback(async () => {
    if (!projectId) {
      return;
    }
    const token = getToken();
    if (!token) {
      window.location.href = "/login";
      return;
    }
    setError(null);
    try {
      const result = await getAssets(token, projectId);
      setAssets(result);
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
            next[asset.id] = getAssetDefaultSize(asset.type);
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
      setError(err instanceof Error ? err.message : "获取素材失败");
    }
  }, [
    buildCharacterLookPrompt,
    buildCharacterPrompt,
    defaultTemplate,
    projectId,
    renderAssetTemplate,
  ]);

  useEffect(() => {
    void loadAssets();
  }, [loadAssets]);

  const loadConfig = useCallback(async () => {
    const token = getToken();
    if (!token) {
      window.location.href = "/login";
      return;
    }
    setConfigLoading(true);
    setError(null);
    try {
      const [modelsRaw, settings] = await Promise.all([getModels(token), getSettings(token)]);
      const models = extractModels(modelsRaw);
      const filtered = filterModels(models, "image");
      if (!filtered.includes("doubao-seedream-4-5-251128")) {
        filtered.unshift("doubao-seedream-4-5-251128");
      }
      setImageModels(filtered);
      setDefaultImageModel("doubao-seedream-4-5-251128");
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
      setError(err instanceof Error ? err.message : "加载失败");
    } finally {
      setScriptLoading(false);
    }
  }, [projectId, scriptCacheKey]);

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

  const runGenerate = async (asset: Asset) => {
    if (!projectId) {
      return;
    }
    const token = getToken();
    if (!token) {
      window.location.href = "/login";
      return;
    }
    setLoading(true);
    setError(null);
    setStatus("生成中...");
    setGeneratingAssetId(asset.id);
    try {
      if (modifyingImage && modifyingImage.assetId === asset.id) {
        await generateAsset(token, projectId, asset.id, {
          prompt: modificationPrompt || undefined,
          model: assetModels[asset.id] || undefined,
          ref_image_url: modifyingImage.url,
          style: assetStyles[asset.id] || globalStyle,
          options: {
            size: assetSizes[asset.id] || getAssetDefaultSize(asset.type),
          },
        });
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
              version: item.versions.find((v) => v.is_selected),
            }))
            .find((item) => item.version);
          if (selectedCandidate?.version) {
            refImageUrl = selectedCandidate.version.image_url;
          } else {
            setError("请先在对应角色素材中选中参考图，再生成该角色形象");
            setStatus(null);
            return;
          }
        }

        await generateAsset(token, projectId, asset.id, {
          prompt: assetPrompts[asset.id] || undefined,
          model: assetModels[asset.id] || undefined,
          ref_image_url: refImageUrl,
          style: assetStyles[asset.id] || globalStyle,
          options: {
            size: assetSizes[asset.id] || getAssetDefaultSize(asset.type),
          },
        });
      }
      await loadAssets();
      setStatus("生成完成");
    } catch (err) {
      setError(err instanceof Error ? err.message : "生成失败");
      setStatus(null);
    } finally {
      setLoading(false);
      setGeneratingAssetId(null);
    }
  };

  const runSelect = async (assetId: string, versionId: string) => {
    if (!projectId) {
      return;
    }
    const token = getToken();
    if (!token) {
      window.location.href = "/login";
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await selectAssetVersion(token, projectId, assetId, versionId);
      await loadAssets();
    } catch (err) {
      setError(err instanceof Error ? err.message : "选择失败");
    } finally {
      setLoading(false);
    }
  };

  const runDeleteVersion = async (assetId: string, versionId: string) => {
    if (!projectId) {
      return;
    }
    const token = getToken();
    if (!token) {
      window.location.href = "/login";
      return;
    }
    if (!window.confirm("确认删除该图片吗？")) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await deleteAssetVersion(token, projectId, assetId, versionId);
      await loadAssets();
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除失败");
    } finally {
      setLoading(false);
    }
  };

  const characterAssets = assets.filter((asset) => asset.type === "CHARACTER");
  const lookAssets = assets.filter((asset) => asset.type === "CHARACTER_LOOK");
  const otherAssets = assets.filter(
    (asset) => asset.type !== "CHARACTER" && asset.type !== "CHARACTER_LOOK"
  );

  const looksByRole = lookAssets.reduce<Record<string, Asset[]>>((acc, asset) => {
    const baseName = normalizeRoleKey(asset.name);
    if (!acc[baseName]) {
      acc[baseName] = [];
    }
    acc[baseName].push(asset);
    return acc;
  }, {});

  const selectedTemplateByRole = characterAssets.reduce<Record<string, boolean>>(
    (acc, asset) => {
      acc[normalizeRoleKey(asset.name)] = asset.versions.some(
        (version) => version.is_selected
      );
      return acc;
    },
    {}
  );

  const renderAssetContent = (asset: Asset, afterPrompt?: ReactNode) => (
    <>
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div className="text-sm font-semibold">
          {asset.name} · {getAssetTypeLabel(asset.type)}
        </div>
        <div className="flex w-full items-center gap-2 md:w-auto">
          <input
            value={assetModels[asset.id] ?? ""}
            onChange={(event) => {
              const newVal = event.target.value;
              setAssetModels((prev) => ({ ...prev, [asset.id]: newVal }));
              triggerAutoSave(asset.id, { model: newVal });
            }}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs md:w-60"
            placeholder={`模型（可选）默认：${defaultImageModel || "未设置"}`}
            list="image-models"
          />
          <select
            value={assetSizes[asset.id] || getAssetDefaultSize(asset.type)}
            onChange={(e) => {
              const newVal = e.target.value;
              setAssetSizes((prev) => ({ ...prev, [asset.id]: newVal }));
              triggerAutoSave(asset.id, { size: newVal });
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
            value={assetStyles[asset.id] || globalStyle}
            onChange={(e) => {
              const newVal = e.target.value;
              setAssetStyles((prev) => ({ ...prev, [asset.id]: newVal }));
              triggerAutoSave(asset.id, { style: newVal });
            }}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs md:w-32"
          >
            {STYLE_OPTIONS.map((style) => (
              <option key={style} value={style}>
                {style}
              </option>
            ))}
          </select>
          {modifyingImage?.assetId !== asset.id && (
            <button
              onClick={() => runGenerate(asset)}
              disabled={loading || generatingAssetId === asset.id}
              className="whitespace-nowrap rounded-lg border border-slate-200 px-3 py-2 text-xs"
            >
              {generatingAssetId === asset.id ? "生成中..." : "生成版本"}
            </button>
          )}
        </div>
      </div>

      {modifyingImage?.assetId === asset.id ? (
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
                disabled={loading || generatingAssetId === asset.id}
                className="self-end rounded-lg bg-indigo-600 px-3 py-1.5 text-xs text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                {generatingAssetId === asset.id ? "修改中..." : "生成修改版"}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex flex-col gap-2 md:flex-row md:items-start">
          <textarea
            value={assetPrompts[asset.id] ?? ""}
            onChange={(event) => {
              const newVal = event.target.value;
              setAssetPrompts((prev) => ({ ...prev, [asset.id]: newVal }));
              triggerAutoSave(asset.id, { prompt: newVal });
            }}
            className="w-full flex-1 rounded-lg border border-slate-200 px-3 py-2 text-xs"
            placeholder="提示词（可选）"
            rows={3}
          />
        </div>
      )}

      {afterPrompt ? <div className="mt-3">{afterPrompt}</div> : null}

      {asset.versions.length === 0 ? (
        <div className="mt-2 text-xs text-slate-500">暂无版本</div>
      ) : (
        <div className="mt-3">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {asset.versions.map((version) => (
              <div
                key={version.id}
                className={`rounded-lg border ${
                  version.is_selected ? "border-slate-900" : "border-slate-200"
                }`}
              >
                <div
                  className="relative cursor-pointer bg-slate-50 p-2"
                  onClick={() => {
                    runSelect(asset.id, version.id);
                    setPreviewImageUrl(version.image_url);
                  }}
                >
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      void runDeleteVersion(asset.id, version.id);
                    }}
                    className="absolute right-2 top-2 z-10 rounded-md bg-white/90 px-2 py-1 text-xs text-red-500 shadow-sm"
                  >
                    删除
                  </button>
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      setModifyingImage({
                        assetId: asset.id,
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
                    onClick={(event) => {
                      event.stopPropagation();
                      runSelect(asset.id, version.id);
                    }}
                    className="absolute bottom-2 right-2 z-10 rounded-md bg-white/90 px-2 py-1 text-xs text-slate-700 shadow-sm"
                  >
                    选取
                  </button>
                  {version.is_selected ? (
                    <div className="absolute bottom-2 right-12 z-10 rounded-full bg-slate-900/90 px-2 py-1 text-[10px] text-white">
                      已选
                    </div>
                  ) : null}
                  <Image
                    src={version.image_url}
                    alt={`${asset.name}-版本${version.id.slice(0, 4)}`}
                    width={900}
                    height={1200}
                    sizes="(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw"
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

  const renderAssetCard = (asset: Asset) => (
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
            下一步：生成分镜
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
          <div className="mt-2 text-slate-600">尚未提取素材。</div>
        ) : (
          <div className="mt-4 space-y-4">
            {characterAssets.map((asset) => (
              <div key={asset.id} className="rounded-lg border border-sky-200 border-l-4 border-l-sky-300 bg-sky-50/50 p-3">
                {renderAssetContent(
                  asset,
                  <div className="rounded-lg border border-slate-100 bg-slate-50 p-3">
                    <div className="mb-2 text-xs font-semibold text-slate-600">角色音色</div>
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
              className="max-w-full object-contain"
              priority
            />
          </div>
        </div>
      ) : null}
      <datalist id="image-models">
        {imageModels.map((model) => (
          <option key={model} value={model} />
        ))}
      </datalist>
    </div>
  );
}
