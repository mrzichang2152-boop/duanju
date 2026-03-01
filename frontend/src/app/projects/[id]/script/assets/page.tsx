"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Image from "next/image";
import {
  Asset,
  extractAssets,
  generateAsset,
  getAssets,
  getModels,
  getSettings,
  getScript,
  deleteAssetVersion,
  selectAssetVersion,
} from "@/lib/api";
import { getToken } from "@/lib/auth";
import { extractModels, filterModels } from "@/lib/models";
import { applyTemplate } from "@/lib/templates";

export default function AssetsPage() {
  const params = useParams<{ id: string }>();
  const projectId = params.id;
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [assetPrompts, setAssetPrompts] = useState<Record<string, string>>({});
  const [assetModels, setAssetModels] = useState<Record<string, string>>({});
  const [imageModels, setImageModels] = useState<string[]>([]);
  const [defaultImageModel, setDefaultImageModel] = useState("");
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
    if (!description) {
      return "";
    }
    const ageMatch = description.match(/年龄[:：]\s*([^\n；;。]+)/);
    const appearanceMatch = description.match(/外貌[:：]\s*([\s\S]*)/);
    const age = ageMatch?.[1]?.trim() ?? "";
    let appearance = appearanceMatch?.[1]?.trim() ?? "";
    if (appearance) {
      const stopLabels = [
        "身份：",
        "性格：",
        "动机/目标：",
        "目标：",
        "形象要求：",
        "角色描述：",
        "装备：",
        "口头禅：",
        "背景：",
      ];
      let cutIndex = appearance.length;
      stopLabels.forEach((label) => {
        const idx = appearance.indexOf(label);
        if (idx !== -1 && idx < cutIndex) {
          cutIndex = idx;
        }
      });
      appearance = appearance.slice(0, cutIndex).trim();
      appearance = appearance.replace(/^[：:\s]+/, "").trim();
    }
    const parts = [];
    if (age) {
      parts.push(`年龄：${age}`);
    }
    if (appearance) {
      parts.push(`外貌：${appearance}`);
    }
    return parts.join("\n");
  }, []);

  const buildCharacterLookPrompt = useCallback((description?: string | null) => {
    if (!description) {
      return "";
    }
    const match = description.match(/形象要求[:：]\s*([\s\S]*)/);
    if (match?.[1]) {
      return match[1].trim();
    }
    return description.trim();
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
        });
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
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
      setScriptContent(result.content ?? "");
    } catch (err) {
      setScriptContent("");
      setError(err instanceof Error ? err.message : "加载失败");
    } finally {
      setScriptLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void loadScript();
  }, [loadScript]);

  const runExtract = async () => {
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
      const result = await extractAssets(token, projectId);
      setStatus(result.status);
      await loadAssets();
    } catch (err) {
      setError(err instanceof Error ? err.message : "提取失败");
    } finally {
      setLoading(false);
    }
  };

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
        });
      } else {
        if (
          asset.type === "CHARACTER_LOOK" &&
          !selectedTemplateByRole[normalizeRoleKey(asset.name)]
        ) {
          const roleName = normalizeRoleKey(asset.name);
          const baseAsset = characterAssets.find(
            (item) => normalizeRoleKey(item.name) === roleName
          );
          const selectable =
            baseAsset?.versions.find((version) => version.is_selected) ??
            baseAsset?.versions[baseAsset?.versions.length - 1];
          if (!baseAsset || !selectable) {
            setError("请先生成角色模板图片");
            setStatus(null);
            return;
          }
          await selectAssetVersion(token, projectId, baseAsset.id, selectable.id);
          await loadAssets();
        }
        await generateAsset(token, projectId, asset.id, {
          prompt: assetPrompts[asset.id] || undefined,
          model: assetModels[asset.id] || undefined,
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

  const normalizeRoleKey = (name: string) => name.split("·", 1)[0].trim();

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

  const renderAssetContent = (asset: Asset) => (
    <>
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div className="text-sm font-semibold">
          {asset.name} · {getAssetTypeLabel(asset.type)}
        </div>
        <div className="flex w-full items-center gap-2 md:w-auto">
          <input
            value={assetModels[asset.id] ?? ""}
            onChange={(event) =>
              setAssetModels((prev) => ({ ...prev, [asset.id]: event.target.value }))
            }
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs md:w-60"
            placeholder={`模型（可选）默认：${defaultImageModel || "未设置"}`}
            list="image-models"
          />
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
            onChange={(event) =>
              setAssetPrompts((prev) => ({ ...prev, [asset.id]: event.target.value }))
            }
            className="w-full flex-1 rounded-lg border border-slate-200 px-3 py-2 text-xs"
            placeholder="提示词（可选）"
            rows={3}
          />
        </div>
      )}

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
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Step 4: 生成素材</h1>
        <div className="flex items-center gap-2">
          <a
            href={projectId ? `/projects/${projectId}/script/video` : "/projects"}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm text-white hover:bg-indigo-700"
          >
            下一步：分段视频
          </a>
        </div>
      </div>
      <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm">
        <div className="font-semibold">素材提取</div>
        <p className="mt-2 text-slate-600">从剧本中提取角色、道具与场景清单。</p>
        <button
          onClick={runExtract}
          disabled={loading}
          className="mt-4 rounded-lg border border-slate-200 px-4 py-2 text-sm"
        >
          {loading ? "提取中..." : "开始提取"}
        </button>
        {status ? <div className="mt-3 text-slate-600">状态：{status}</div> : null}
      </div>
      <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm">
        <div className="font-semibold">剧本</div>
        {scriptLoading ? <div className="mt-2 text-slate-400">加载中...</div> : null}
        <textarea
          value={scriptContent}
          readOnly
          className="mt-3 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700"
          rows={12}
          placeholder="暂无剧本内容"
        />
      </div>
      <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm">
        <div className="font-semibold">素材列表</div>
        {error ? <div className="mt-2 text-red-500">{error}</div> : null}
        <div className="mt-2 text-xs text-slate-500">
          默认模型：{defaultImageModel || "未设置"}
        </div>
        {configLoading ? <div className="mt-1 text-xs text-slate-400">模型加载中...</div> : null}
        {assets.length === 0 ? (
          <div className="mt-2 text-slate-600">尚未提取素材。</div>
        ) : (
          <div className="mt-4 space-y-4">
            {characterAssets.map((asset) => (
              <div key={asset.id} className="rounded-lg border border-slate-200 p-3">
                {renderAssetContent(asset)}
                {looksByRole[asset.name]?.length ? (
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
