"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { getScript, saveScript, startStep2Task, getStep2TaskStatus } from "@/lib/api";
import { getToken } from "@/lib/auth";

const SEPARATOR = "\n\n=== 原文剧本 (请勿删除此行) ===\n\n";
const STEP2_PENDING_MAX_AGE_MS = 30 * 60 * 1000;

type Step2PendingTask = {
  op: "extract" | "modify" | "sync";
  taskId: string;
  startedAt: number;
  baselineVersion?: number;
};

function stripThinkingContent(text: string) {
  const source = String(text || "");
  let cleaned = source.replace(/<think>[\s\S]*?<\/think>/gi, "");
  if (/<think>/i.test(cleaned) && !/<\/think>/i.test(cleaned)) {
    const thinkStart = cleaned.search(/<think>/i);
    if (thinkStart >= 0) {
      cleaned = cleaned.slice(0, thinkStart);
    }
  }
  return cleaned.replace(/<\/?think>/gi, "").trim();
}

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
  const [currentScriptVersion, setCurrentScriptVersion] = useState(0);

  const pendingTaskStorageKey = projectId ? `step2-pending-task-${projectId}` : "";
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastSavedContentRef = useRef("");

  const persistPendingTask = (task: Step2PendingTask) => {
    if (!pendingTaskStorageKey || typeof window === "undefined") return;
    localStorage.setItem(pendingTaskStorageKey, JSON.stringify(task));
  };

  const clearPendingTask = () => {
    if (!pendingTaskStorageKey || typeof window === "undefined") return;
    localStorage.removeItem(pendingTaskStorageKey);
  };

  useEffect(() => {
    if (!pendingTaskStorageKey || typeof window === "undefined") return;
    try {
      const raw = localStorage.getItem(pendingTaskStorageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Step2PendingTask;
      const op = parsed?.op;
      const taskId = String(parsed?.taskId || "").trim();
      const startedAt = Number(parsed?.startedAt || 0);
      if (!op || !taskId || !startedAt || Date.now() - startedAt > STEP2_PENDING_MAX_AGE_MS) {
        localStorage.removeItem(pendingTaskStorageKey);
        return;
      }
      if (op === "modify") {
        setIsModifying(true);
        setMessage("检测到上次仍在 AI 修改中，请稍候...");
      } else if (op === "extract") {
        setGenerating(true);
        setMessage("检测到上次仍在提取资源中，请稍候...");
      } else {
        setGenerating(true);
        setMessage("检测到上次仍在同步素材中，请稍候...");
      }
    } catch {
      localStorage.removeItem(pendingTaskStorageKey);
    }
  }, [pendingTaskStorageKey]);

  useEffect(() => {
    if (!pendingTaskStorageKey || typeof window === "undefined" || !projectId) return;
    const token = getToken();
    if (!token) return;
    let timer: number | null = null;
    const poll = async () => {
      try {
        const raw = localStorage.getItem(pendingTaskStorageKey);
        if (!raw) return;
        const pending = JSON.parse(raw) as Step2PendingTask;
        const startedAt = Number(pending?.startedAt || 0);
        if (!pending?.op || !startedAt || Date.now() - startedAt > STEP2_PENDING_MAX_AGE_MS) {
          clearPendingTask();
          setGenerating(false);
          setIsModifying(false);
          return;
        }
        const taskId = String(pending.taskId || "").trim();
        if (!taskId) return;
        const status = await getStep2TaskStatus(token, projectId, taskId);
        if (status.status === "FAILED") {
          clearPendingTask();
          setGenerating(false);
          setIsModifying(false);
          setMessage(status.error || "任务执行失败");
          return;
        }
        if (status.status !== "COMPLETED") {
          return;
        }
        if (pending.op === "sync") {
          clearPendingTask();
          setGenerating(false);
          setIsModifying(false);
          setMessage("素材同步完成");
          return;
        }
        const latest = await getScript(token, projectId);
        const fullContent = latest.content ?? "";
        if (!fullContent.includes(SEPARATOR)) {
          return;
        }
        const [res, orig] = fullContent.split(SEPARATOR);
        const cleanedResources = stripThinkingContent(res || "");
        const cleanedOriginal = stripThinkingContent(orig || "");
        if (!cleanedResources.trim()) {
          return;
        }
        setResourcesContent(cleanedResources);
        lastSavedContentRef.current = cleanedResources;
        setOriginalContent(cleanedOriginal);
        setCurrentScriptVersion(Number(latest.version || 0));
        clearPendingTask();
        setGenerating(false);
        setIsModifying(false);
        setMessage(pending.op === "modify" ? "AI 修改完成" : "提取完成");
      } catch {
      }
    };
    void poll();
    timer = window.setInterval(() => {
      void poll();
    }, 2500);
    return () => {
      if (timer) window.clearInterval(timer);
    };
  }, [pendingTaskStorageKey, projectId]);

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
        setCurrentScriptVersion(Number(data.version || 0));
        const fullContent = data.content ?? "";
        
        // Try to split existing resources and original content
        if (fullContent.includes(SEPARATOR)) {
          const [res, orig] = fullContent.split(SEPARATOR);
          const cleanedResources = stripThinkingContent(res);
          const cleanedOriginal = stripThinkingContent(orig);
          setResourcesContent(cleanedResources);
          lastSavedContentRef.current = cleanedResources;
          setOriginalContent(cleanedOriginal);
        } else {
          // If no separator, assume it's all original content (from Step 1)
          // But if it already looks like resources (starts with template header), handle that?
          // For now, assume Step 1 output is raw text.
          setOriginalContent(stripThinkingContent(fullContent));
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
        const saved = await saveScript(token, projectId, fullContent);
        lastSavedContentRef.current = resourcesContent;
        setCurrentScriptVersion(Number(saved.version || 0));
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
      const task = await startStep2Task(token, projectId, {
        op: "extract",
        original_content: originalContent,
        model: selectedModel,
      });
      persistPendingTask({
        op: "extract",
        taskId: task.task_id,
        startedAt: Date.now(),
        baselineVersion: currentScriptVersion,
      });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "提取失败");
      clearPendingTask();
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
      const task = await startStep2Task(token, projectId, {
        op: "modify",
        original_content: originalContent,
        resources_content: resourcesContent,
        model: selectedModel,
        instruction,
      });
      persistPendingTask({
        op: "modify",
        taskId: task.task_id,
        startedAt: Date.now(),
        baselineVersion: currentScriptVersion,
      });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "修改失败");
      clearPendingTask();
      setIsModifying(false);
    }
  };

  const save = async () => {
    if (!projectId) return;
    const token = getToken();
    if (!token) return;

    const fullContent = resourcesContent + SEPARATOR + originalContent;
    try {
      const saved = await saveScript(token, projectId, fullContent);
      setCurrentScriptVersion(Number(saved.version || 0));
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
      const fullContent = resourcesContent + SEPARATOR + originalContent;
      const saved = await saveScript(token, projectId, fullContent);
      setCurrentScriptVersion(Number(saved.version || 0));
      const task = await startStep2Task(token, projectId, {
        op: "sync",
        original_content: originalContent,
        resources_content: resourcesContent,
      });
      persistPendingTask({
        op: "sync",
        taskId: task.task_id,
        startedAt: Date.now(),
        baselineVersion: Number(saved.version || 0),
      });
      router.push(`/projects/${projectId}/script/assets`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "同步失败");
      clearPendingTask();
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
