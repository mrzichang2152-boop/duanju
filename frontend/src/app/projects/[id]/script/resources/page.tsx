"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { generateScript, getScript, saveScript, extractAssets } from "@/lib/api";
import { getToken } from "@/lib/auth";

const SEPARATOR = "\n\n=== 原文剧本 (请勿删除此行) ===\n\n";

export default function ScriptResourcesPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const projectId = params.id;
  const [originalContent, setOriginalContent] = useState("");
  const [resourcesContent, setResourcesContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [isModifying, setIsModifying] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [selectedModel, setSelectedModel] = useState("gemini-3-pro");
  
  useEffect(() => {
    if (!projectId) return;
    const key = `resources-model-${projectId}`;
    const saved = localStorage.getItem(key);
    if (saved) {
      setSelectedModel(saved);
    }
  }, [projectId]);

  useEffect(() => {
    if (!projectId || !selectedModel) return;
    const key = `resources-model-${projectId}`;
    localStorage.setItem(key, selectedModel);
  }, [projectId, selectedModel]);

  const [message, setMessage] = useState<string | null>(null);

  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastSavedContentRef = useRef("");

  // Load initial script
  useEffect(() => {
    if (!projectId) return;
    const token = getToken();
    if (!token) {
      router.push("/login");
      return;
    }

    getScript(token, projectId)
      .then((data) => {
        const fullContent = data.content ?? "";
        
        // Try to split existing resources and original content
        if (fullContent.includes(SEPARATOR)) {
          const [res, orig] = fullContent.split(SEPARATOR);
          setResourcesContent(res.trim());
          lastSavedContentRef.current = res.trim();
          setOriginalContent(orig.trim());
        } else {
          // If no separator, assume it's all original content (from Step 1)
          // But if it already looks like resources (starts with template header), handle that?
          // For now, assume Step 1 output is raw text.
          setOriginalContent(fullContent);
          setResourcesContent("");
          lastSavedContentRef.current = "";
        }
      })
      .catch(() => setMessage("加载失败"))
      .finally(() => setLoading(false));
  }, [projectId, router]);

  // Auto-save effect
  useEffect(() => {
    if (loading || !projectId) return;
    if (resourcesContent === lastSavedContentRef.current) return;

    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);

    saveTimeoutRef.current = setTimeout(async () => {
      const token = getToken();
      if (!token) return;
      const fullContent = resourcesContent + SEPARATOR + originalContent;
      try {
        await saveScript(token, projectId, fullContent);
        lastSavedContentRef.current = resourcesContent;
        setMessage("已自动保存");
      } catch (e) {
        console.error("Auto-save failed", e);
      }
    }, 2000);

    return () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    };
  }, [resourcesContent, originalContent, projectId, loading]);

  const handleExtract = async () => {
    if (!projectId) return;
    const token = getToken();
    if (!token) return;

    if (!originalContent.trim()) {
      setMessage("请先在 Step 1 输入剧本内容");
      return;
    }

    setGenerating(true);
    setMessage("正在提取资源...");
    
    try {
      // Use original content for extraction
      const result = await generateScript(token, projectId, {
        mode: "extract_resources",
        content: originalContent, // Extract from the raw script
        model: selectedModel,
      });
      
      if (result.content) {
        setResourcesContent(result.content);
        setMessage("提取完成");
      } else {
        setMessage("提取失败：AI 未返回可用内容，请重试");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "提取失败");
    } finally {
      setGenerating(false);
    }
  };

  const handleModify = async () => {
    if (!projectId || !instruction.trim()) return;
    const token = getToken();
    if (!token) {
      router.push("/login");
      return;
    }

    setIsModifying(true);
    setMessage("AI 修改中...");
    try {
      const result = await generateScript(token, projectId, {
        mode: "step2_modify",
        content: resourcesContent, // Modify the extracted resources
        model: selectedModel,
        instruction: instruction,
      });
      if (result.content) {
        setResourcesContent(result.content);
        setMessage("AI 修改完成");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "修改失败");
    } finally {
      setIsModifying(false);
    }
  };

  const save = async () => {
    if (!projectId) return;
    const token = getToken();
    if (!token) return;

    const fullContent = resourcesContent + SEPARATOR + originalContent;
    try {
      await saveScript(token, projectId, fullContent);
      setMessage("已保存");
    } catch {
      setMessage("保存失败");
    }
  };

  const handleNext = async () => {
    if (!projectId) return;
    const token = getToken();
    if (!token) return;

    setGenerating(true);
    setMessage("保存并同步素材...");
    try {
      await save();
      await extractAssets(token, projectId);
      setMessage("同步完成");
      router.push(`/projects/${projectId}/script/assets`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "同步失败");
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Step 2: 提取资源</h1>
        <div className="flex gap-3">
          <button
            onClick={handleExtract}
            disabled={generating}
            className="rounded-lg border border-slate-200 px-4 py-2 text-sm hover:bg-slate-50 disabled:opacity-50"
          >
            {generating ? "提取中..." : "AI 自动提取"}
          </button>
          <button
            onClick={save}
            className="rounded-lg border border-slate-200 px-4 py-2 text-sm hover:bg-slate-50"
          >
            保存
          </button>
          <button
            onClick={() => router.push(`/projects/${projectId}/script/input`)}
            className="rounded-lg border border-slate-200 px-4 py-2 text-sm hover:bg-slate-50 text-slate-600"
          >
            上一步
          </button>
          <button
            onClick={handleNext}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm text-white hover:bg-slate-800"
          >
            下一步：生成素材
          </button>
        </div>
      </div>
      {message && <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700">{message}</div>}

      {loading ? (
        <div>加载中...</div>
      ) : (
        <div className="grid grid-cols-2 gap-6 h-[calc(100vh-200px)]">
          {/* Left: Original Script (Read-only or Reference) */}
          <div className="flex flex-col gap-2">
            <h3 className="font-medium text-slate-700">原文剧本 (参考)</h3>
            <div className="w-full h-full rounded-xl border border-slate-200 bg-slate-50 p-4 overflow-auto whitespace-pre-wrap text-sm text-slate-600">
              {originalContent || "暂无原文内容，请返回 Step 1 添加。"}
            </div>
          </div>

          {/* Right: Extracted Resources (Editable) */}
          <div className="flex flex-col gap-2 h-full">
            <div className="flex items-center justify-between">
              <h3 className="font-medium text-slate-700">提取结果</h3>
            </div>
            <div className="flex flex-col h-full gap-2">
              <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
                <div className="mb-2 text-xs font-medium text-slate-900">AI 辅助修改</div>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <select
                    value={selectedModel}
                    onChange={(e) => setSelectedModel(e.target.value)}
                    className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs outline-none focus:border-indigo-500 sm:w-32"
                  >
                    <option value="gemini-3-pro">Gemini 3 Pro</option>
                  </select>
                  <div className="flex flex-1 gap-2">
                    <input
                      type="text"
                      value={instruction}
                      onChange={(e) => setInstruction(e.target.value)}
                      placeholder="输入修改意见..."
                      className="flex-1 rounded-lg border border-slate-200 px-2 py-1.5 text-xs outline-none focus:border-indigo-500"
                    />
                    <button
                      onClick={handleModify}
                      disabled={isModifying || !instruction.trim()}
                      className="whitespace-nowrap rounded-lg bg-indigo-600 px-3 py-1.5 text-xs text-white hover:bg-indigo-700 disabled:bg-slate-300"
                    >
                      {isModifying ? "..." : "AI 修改"}
                    </button>
                  </div>
                </div>
              </div>

              <textarea
                value={resourcesContent}
                onChange={(e) => setResourcesContent(e.target.value)}
                className="flex-1 w-full resize-none rounded-xl border border-slate-200 p-4 text-sm outline-none focus:ring-2 focus:ring-slate-200"
                placeholder="点击“AI 自动提取”生成资源列表..."
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
