"use client";

import { useState } from "react";
import { getModels, getSettings, updateSettings } from "@/lib/api";
import { getToken } from "@/lib/auth";
import { extractModels } from "@/lib/models";

export default function SettingsPage() {
  const [endpoint, setEndpoint] = useState("https://api.wuyinkeji.com");
  const [apiKey, setApiKey] = useState("");
  const [modelText, setModelText] = useState("gemini-3-pro");
  const [modelImage, setModelImage] = useState("nanoBanana2");
  const [modelVideo, setModelVideo] = useState("sora2");
  const [allowSync, setAllowSync] = useState(false);
  const [hasKey, setHasKey] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [models, setModels] = useState<string[]>([]);

  const load = async () => {
    const token = getToken();
    if (!token) {
      window.location.href = "/login";
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await getSettings(token);
      setEndpoint(result.endpoint);
      setModelText(result.default_model_text);
      setModelImage(result.default_model_image);
      setModelVideo(result.default_model_video);
      setAllowSync(result.allow_sync);
      setHasKey(result.has_key);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
    } finally {
      setLoading(false);
    }
  };

  const save = async () => {
    const token = getToken();
    if (!token) {
      window.location.href = "/login";
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await updateSettings(token, {
        endpoint,
        api_key: apiKey || undefined,
        default_model_text: modelText,
        default_model_image: modelImage,
        default_model_video: modelVideo,
        allow_sync: allowSync,
      });
      setHasKey(result.has_key);
      setApiKey("");
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setLoading(false);
    }
  };

  const loadModels = async () => {
    const token = getToken();
    if (!token) {
      window.location.href = "/login";
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await getModels(token);
      const nextModels = extractModels(result);
      setModels(nextModels);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-2xl rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <h1 className="text-xl font-semibold">设置中心</h1>
      <div className="mt-6 space-y-4">
        <div className="flex items-center justify-between text-sm text-slate-600">
          <span>LinkAPI 配置</span>
          <div className="flex gap-2">
            <button
              onClick={load}
              disabled={loading}
              className="rounded-lg border border-slate-200 px-3 py-1 text-xs text-slate-600"
            >
              {loading ? "加载中..." : "读取云端"}
            </button>
            <button
              onClick={loadModels}
              disabled={loading}
              className="rounded-lg border border-slate-200 px-3 py-1 text-xs text-slate-600"
            >
              读取模型
            </button>
          </div>
        </div>
        <div>
          <label className="text-sm text-slate-600">LinkAPI Endpoint</label>
          <input
            value={endpoint}
            onChange={(event) => setEndpoint(event.target.value)}
            className="mt-2 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="text-sm text-slate-600">LinkAPI Key</label>
          <input
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            className="mt-2 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
            type="password"
            placeholder={hasKey ? "已保存（输入可更新）支持 AK|SK / JSON" : "请输入 Key（支持 AK|SK / JSON）"}
          />
        </div>
        <div>
          <label className="text-sm text-slate-600">默认文本模型</label>
          <input
            value={modelText}
            onChange={(event) => setModelText(event.target.value)}
            className="mt-2 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
            placeholder="例如：gemini-3-pro"
            list="linkapi-models"
          />
        </div>
        <div>
          <label className="text-sm text-slate-600">默认生图模型</label>
          <input
            value={modelImage}
            onChange={(event) => setModelImage(event.target.value)}
            className="mt-2 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
            placeholder="例如：nanoBanana2"
            list="linkapi-models"
          />
        </div>
        <div>
          <label className="text-sm text-slate-600">默认视频模型</label>
          <input
            value={modelVideo}
            onChange={(event) => setModelVideo(event.target.value)}
            className="mt-2 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
            placeholder="例如：sora2"
            list="linkapi-models"
          />
        </div>
        <datalist id="linkapi-models">
          {models.map((model) => (
            <option key={model} value={model} />
          ))}
        </datalist>
        <label className="flex items-center gap-3 text-sm text-slate-600">
          <input
            type="checkbox"
            checked={allowSync}
            onChange={(event) => setAllowSync(event.target.checked)}
          />
          允许同步到云端（将加密存储）
        </label>
        <button
          onClick={save}
          disabled={loading}
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm text-white"
        >
          保存
        </button>
        {saved ? <div className="text-sm text-emerald-600">已保存</div> : null}
        {error ? <div className="text-sm text-red-500">{error}</div> : null}
      </div>
    </div>
  );
}
