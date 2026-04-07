"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { getScript, saveScript, startStep2Task, getStep2TaskStatus, type Step2TaskTarget } from "@/lib/api";
import { getToken } from "@/lib/auth";

const SEPARATOR = "\n\n=== 原文剧本 (请勿删除此行) ===\n\n";
const STEP2_PENDING_MAX_AGE_MS = 30 * 60 * 1000;
const STEP2_TABS: Array<{ key: Step2TaskTarget; label: string; placeholder: string }> = [
  { key: "character", label: "角色", placeholder: "点击“AI 自动提取”生成角色基础设定..." },
  { key: "prop", label: "道具", placeholder: "点击“AI 自动提取”生成核心道具列表..." },
  { key: "scene", label: "场景", placeholder: "点击“AI 自动提取”生成核心场景列表..." },
];

type Step2SectionMap = Record<Step2TaskTarget, string>;
type Step2Status = "idle" | "running" | "completed" | "failed";
type Step2TabState = {
  status: Step2Status;
  taskId?: string;
  error?: string;
};
type Step2PendingTask = {
  op: "extract" | "modify";
  target: Step2TaskTarget;
  taskId: string;
  startedAt: number;
  baselineVersion?: number;
};

const createEmptySections = (): Step2SectionMap => ({
  character: "",
  prop: "",
  scene: "",
});

const createEmptyTabStates = (): Record<Step2TaskTarget, Step2TabState> => ({
  character: { status: "idle" },
  prop: { status: "idle" },
  scene: { status: "idle" },
});

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

function splitResourcesSections(text: string): Step2SectionMap {
  const source = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!source) {
    return createEmptySections();
  }
  const aliases = new Map<string, Step2TaskTarget>([
    ["角色", "character"],
    ["角色列表", "character"],
    ["道具", "prop"],
    ["道具列表", "prop"],
    ["场景", "scene"],
    ["场景列表", "scene"],
  ]);
  const result = createEmptySections();
  let current: Step2TaskTarget | "" = "";
  let foundSection = false;
  let buffer: string[] = [];

  const flush = () => {
    if (current) {
      result[current] = buffer.join("\n").trim();
    }
    buffer = [];
  };

  for (const rawLine of source.split("\n")) {
    const normalized = rawLine.trim().replace(/^#+\s*/, "").replace(/[：:]$/, "").trim();
    const target = aliases.get(normalized);
    if (target) {
      foundSection = true;
      flush();
      current = target;
      continue;
    }
    if (current) {
      buffer.push(rawLine);
    }
  }
  flush();

  if (foundSection) {
    return result;
  }
  return {
    character: source,
    prop: "",
    scene: "",
  };
}

function composeResourcesSections(sections: Step2SectionMap) {
  if (!Object.values(sections).some((value) => String(value || "").trim())) {
    return "";
  }
  return STEP2_TABS.map((tab) => `## ${tab.label}\n\n${String(sections[tab.key] || "").trim()}`.trimEnd())
    .join("\n\n")
    .trim();
}

export default function ScriptResourcesPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const projectId = params.id;
  const [originalContent, setOriginalContent] = useState("");
  const [resourceSections, setResourceSections] = useState<Step2SectionMap>(createEmptySections);
  const [tabStates, setTabStates] = useState<Record<Step2TaskTarget, Step2TabState>>(createEmptyTabStates);
  const [activeTab, setActiveTab] = useState<Step2TaskTarget>("character");
  const [loading, setLoading] = useState(true);
  const [instruction, setInstruction] = useState("");
  const [selectedModel, setSelectedModel] = useState("gemini-3-pro");
  const [message, setMessage] = useState<string | null>(null);
  const [currentScriptVersion, setCurrentScriptVersion] = useState(0);

  const pendingTaskStorageKey = projectId ? `step2-pending-tasks-${projectId}` : "";
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastSavedResourcesRef = useRef("");

  const resourcesContent = useMemo(() => composeResourcesSections(resourceSections), [resourceSections]);
  const hasRunningTask = useMemo(
    () => Object.values(tabStates).some((item) => item.status === "running"),
    [tabStates]
  );
  const activeTabState = tabStates[activeTab];

  const readPendingTasks = (): Step2PendingTask[] => {
    if (!pendingTaskStorageKey || typeof window === "undefined") return [];
    try {
      const raw = localStorage.getItem(pendingTaskStorageKey);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as Step2PendingTask[];
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((item) => {
        if (!item || typeof item !== "object") return false;
        if (!["extract", "modify"].includes(String(item.op))) return false;
        if (!["character", "prop", "scene"].includes(String(item.target))) return false;
        if (!String(item.taskId || "").trim()) return false;
        return Date.now() - Number(item.startedAt || 0) <= STEP2_PENDING_MAX_AGE_MS;
      });
    } catch {
      return [];
    }
  };

  const writePendingTasks = (tasks: Step2PendingTask[]) => {
    if (!pendingTaskStorageKey || typeof window === "undefined") return;
    if (tasks.length === 0) {
      localStorage.removeItem(pendingTaskStorageKey);
      return;
    }
    localStorage.setItem(pendingTaskStorageKey, JSON.stringify(tasks));
  };

  const upsertPendingTask = (task: Step2PendingTask) => {
    const tasks = readPendingTasks().filter((item) => item.target !== task.target || item.op !== task.op);
    tasks.push(task);
    writePendingTasks(tasks);
  };

  const removePendingTask = (target: Step2TaskTarget, op?: Step2PendingTask["op"]) => {
    const tasks = readPendingTasks().filter((item) => !(item.target === target && (!op || item.op === op)));
    writePendingTasks(tasks);
  };

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
    localStorage.setItem(`resources-model-${projectId}`, selectedModel);
  }, [projectId, selectedModel]);

  useEffect(() => {
    if (!pendingTaskStorageKey || typeof window === "undefined") return;
    const pending = readPendingTasks();
    if (pending.length === 0) return;
    setTabStates((prev) => {
      const next = { ...prev };
      pending.forEach((item) => {
        next[item.target] = {
          status: "running",
          taskId: item.taskId,
          error: "",
        };
      });
      return next;
    });
    setMessage("检测到上次仍在执行的 Step2 任务，正在恢复状态...");
  }, [pendingTaskStorageKey]);

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
        if (fullContent.includes(SEPARATOR)) {
          const [resourcesPart, originalPart] = fullContent.split(SEPARATOR);
          const cleanedResources = stripThinkingContent(resourcesPart);
          const cleanedOriginal = stripThinkingContent(originalPart);
          setResourceSections(splitResourcesSections(cleanedResources));
          lastSavedResourcesRef.current = cleanedResources;
          setOriginalContent(cleanedOriginal);
          return;
        }
        setOriginalContent(stripThinkingContent(fullContent));
        setResourceSections(createEmptySections());
        lastSavedResourcesRef.current = "";
      })
      .catch(() => setMessage("加载失败"))
      .finally(() => setLoading(false));
  }, [projectId, router]);

  useEffect(() => {
    if (!pendingTaskStorageKey || !projectId) return;
    const token = getToken();
    if (!token) return;
    let timer: number | null = null;

    const poll = async () => {
      const pendingTasks = readPendingTasks();
      if (pendingTasks.length === 0) return;
      const nextPending: Step2PendingTask[] = [];
      let nextSections = { ...resourceSections };
      let nextOriginal = originalContent;
      let nextVersion = currentScriptVersion;
      let latestScriptLoaded = false;
      let hasCompletedTask = false;
      let latestNotice = "";
      const nextTabStates = { ...tabStates };

      const results = await Promise.all(
        pendingTasks.map(async (task) => {
          try {
            const status = await getStep2TaskStatus(token, projectId, task.taskId);
            return { task, status, error: null as string | null };
          } catch (error) {
            return {
              task,
              status: null,
              error: error instanceof Error ? error.message : "任务状态查询失败",
            };
          }
        })
      );

      for (const item of results) {
        const { task, status, error } = item;
        if (error) {
          nextTabStates[task.target] = { status: "failed", error };
          latestNotice = error;
          continue;
        }
        if (!status) {
          nextPending.push(task);
          continue;
        }
        if (status.status === "FAILED") {
          nextTabStates[task.target] = { status: "failed", error: status.error || "任务执行失败" };
          latestNotice = status.error || `${STEP2_TABS.find((tab) => tab.key === task.target)?.label || "当前"}任务失败`;
          continue;
        }
        if (status.status !== "COMPLETED") {
          nextPending.push(task);
          nextTabStates[task.target] = {
            status: "running",
            taskId: task.taskId,
            error: "",
          };
          continue;
        }

        let resultContent = typeof status.result?.content === "string" ? stripThinkingContent(status.result.content) : "";
        const resultVersion = Number(status.result?.version || 0);
        if (!resultContent) {
          const latest = await getScript(token, projectId);
          const fullContent = latest.content ?? "";
          nextVersion = Math.max(nextVersion, Number(latest.version || 0));
          if (fullContent.includes(SEPARATOR)) {
            const [resourcesPart, originalPart] = fullContent.split(SEPARATOR);
            nextSections = splitResourcesSections(stripThinkingContent(resourcesPart));
            nextOriginal = stripThinkingContent(originalPart);
            latestScriptLoaded = true;
            resultContent = nextSections[task.target] || "";
          }
        }

        if (resultContent) {
          nextSections[task.target] = resultContent;
          nextTabStates[task.target] = { status: "completed", taskId: task.taskId, error: "" };
          nextVersion = Math.max(nextVersion, resultVersion);
          hasCompletedTask = true;
          latestNotice = `${STEP2_TABS.find((tab) => tab.key === task.target)?.label || "当前分类"}${task.op === "modify" ? "修改完成" : "提取完成"}`;
        } else {
          nextTabStates[task.target] = { status: "failed", error: "任务已完成，但未读取到结果，请重试" };
          latestNotice = "任务已完成，但未读取到结果，请重试";
        }
      }

      setTabStates(nextTabStates);
      if (latestNotice) {
        setMessage(latestNotice);
      }
      if (latestScriptLoaded) {
        setOriginalContent(nextOriginal);
      }
      if (hasCompletedTask || latestScriptLoaded) {
        setResourceSections(nextSections);
        lastSavedResourcesRef.current = composeResourcesSections(nextSections);
      }
      if (nextVersion > 0) {
        setCurrentScriptVersion(nextVersion);
      }
      writePendingTasks(nextPending);
    };

    void poll();
    timer = window.setInterval(() => {
      void poll();
    }, 2500);
    return () => {
      if (timer) window.clearInterval(timer);
    };
  }, [pendingTaskStorageKey, projectId, resourceSections, originalContent, currentScriptVersion]);

  useEffect(() => {
    if (loading || !projectId) return;
    if (resourcesContent === lastSavedResourcesRef.current) return;

    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(async () => {
      const token = getToken();
      if (!token) return;
      try {
        const saved = await saveScript(token, projectId, resourcesContent + SEPARATOR + originalContent);
        lastSavedResourcesRef.current = resourcesContent;
        setCurrentScriptVersion(Number(saved.version || 0));
        setMessage("已自动保存");
      } catch (error) {
        console.error("Auto-save failed", error);
      }
    }, 2000);

    return () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    };
  }, [loading, projectId, resourcesContent, originalContent]);

  const startTargetTask = async (target: Step2TaskTarget, op: "extract" | "modify") => {
    if (!projectId) return;
    const token = getToken();
    if (!token) return;
    const payload =
      op === "extract"
        ? {
            op,
            target,
            original_content: originalContent,
            model: selectedModel,
          }
        : {
            op,
            target,
            original_content: originalContent,
            resources_content: resourceSections[target],
            model: selectedModel,
            instruction,
          };
    const task = await startStep2Task(token, projectId, payload);
    upsertPendingTask({
      op,
      target,
      taskId: task.task_id,
      startedAt: Date.now(),
      baselineVersion: currentScriptVersion,
    });
    setTabStates((prev) => ({
      ...prev,
      [target]: {
        status: "running",
        taskId: task.task_id,
        error: "",
      },
    }));
  };

  const handleExtract = async () => {
    if (!projectId) return;
    if (!originalContent.trim()) {
      setMessage("请先在 Step 1 输入剧本内容");
      return;
    }
    setTabStates((prev) => ({
      ...prev,
      character: { status: "running", error: "", taskId: prev.character.taskId },
      prop: { status: "running", error: "", taskId: prev.prop.taskId },
      scene: { status: "running", error: "", taskId: prev.scene.taskId },
    }));
    setMessage("正在并发提取角色、道具、场景...");
    const results = await Promise.allSettled(STEP2_TABS.map((tab) => startTargetTask(tab.key, "extract")));
    const failed = results.find((item) => item.status === "rejected") as PromiseRejectedResult | undefined;
    if (failed) {
      setMessage(failed.reason instanceof Error ? failed.reason.message : "提取任务创建失败");
    }
  };

  const handleModify = async () => {
    if (!instruction.trim()) return;
    if (!resourceSections[activeTab].trim()) {
      setMessage(`请先生成或填写${STEP2_TABS.find((tab) => tab.key === activeTab)?.label || "当前分类"}内容`);
      return;
    }
    try {
      setTabStates((prev) => ({
        ...prev,
        [activeTab]: { status: "running", taskId: prev[activeTab].taskId, error: "" },
      }));
      setMessage(`正在修改${STEP2_TABS.find((tab) => tab.key === activeTab)?.label || "当前分类"}...`);
      await startTargetTask(activeTab, "modify");
    } catch (error) {
      removePendingTask(activeTab, "modify");
      setTabStates((prev) => ({
        ...prev,
        [activeTab]: { status: "failed", error: error instanceof Error ? error.message : "修改失败" },
      }));
      setMessage(error instanceof Error ? error.message : "修改失败");
    }
  };

  const save = async () => {
    if (!projectId) return;
    const token = getToken();
    if (!token) return;
    try {
      const saved = await saveScript(token, projectId, resourcesContent + SEPARATOR + originalContent);
      lastSavedResourcesRef.current = resourcesContent;
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
    try {
      const saved = await saveScript(token, projectId, resourcesContent + SEPARATOR + originalContent);
      lastSavedResourcesRef.current = resourcesContent;
      setCurrentScriptVersion(Number(saved.version || 0));
      router.push(`/projects/${projectId}/script/assets`);
    } catch {
      setMessage("保存失败，请稍后重试");
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Step 2: 提取资源</h1>
        <div className="flex gap-3">
          <button
            onClick={handleExtract}
            disabled={hasRunningTask}
            className="rounded-lg border border-slate-200 px-4 py-2 text-sm hover:bg-slate-50 disabled:opacity-50"
          >
            {hasRunningTask ? "提取中..." : "AI 自动提取"}
          </button>
          <button
            onClick={save}
            className="rounded-lg border border-slate-200 px-4 py-2 text-sm hover:bg-slate-50"
          >
            保存
          </button>
          <button
            onClick={() => router.push(`/projects/${projectId}/script/input`)}
            className="rounded-lg border border-slate-200 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50"
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

      {message ? <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700">{message}</div> : null}

      {loading ? (
        <div>加载中...</div>
      ) : (
        <div className="grid h-[calc(100vh-200px)] grid-cols-2 gap-6">
          <div className="flex flex-col gap-2">
            <h3 className="font-medium text-slate-700">原文剧本 (参考)</h3>
            <div className="h-full w-full overflow-auto whitespace-pre-wrap rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
              {originalContent || "暂无原文内容，请返回 Step 1 添加。"}
            </div>
          </div>

          <div className="flex h-full flex-col gap-2">
            <div className="flex items-center justify-between">
              <h3 className="font-medium text-slate-700">提取结果</h3>
              <div className="flex items-center gap-2 text-xs text-slate-500">
                {STEP2_TABS.map((tab) => {
                  const state = tabStates[tab.key];
                  const color =
                    state.status === "running"
                      ? "bg-amber-500"
                      : state.status === "completed"
                        ? "bg-emerald-500"
                        : state.status === "failed"
                          ? "bg-rose-500"
                          : "bg-slate-300";
                  return (
                    <span key={tab.key} className="inline-flex items-center gap-1 rounded-full border border-slate-200 px-2 py-1">
                      <span className={`h-2 w-2 rounded-full ${color}`} />
                      {tab.label}
                    </span>
                  );
                })}
              </div>
            </div>

            <div className="flex h-full flex-col gap-2">
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
                      placeholder={`输入对${STEP2_TABS.find((tab) => tab.key === activeTab)?.label || "当前分类"}的修改意见...`}
                      className="flex-1 rounded-lg border border-slate-200 px-2 py-1.5 text-xs outline-none focus:border-indigo-500"
                    />
                    <button
                      onClick={handleModify}
                      disabled={activeTabState.status === "running" || !instruction.trim()}
                      className="whitespace-nowrap rounded-lg bg-indigo-600 px-3 py-1.5 text-xs text-white hover:bg-indigo-700 disabled:bg-slate-300"
                    >
                      {activeTabState.status === "running" ? "..." : `AI 修改${STEP2_TABS.find((tab) => tab.key === activeTab)?.label || ""}`}
                    </button>
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white p-2">
                {STEP2_TABS.map((tab) => {
                  const isActive = tab.key === activeTab;
                  const state = tabStates[tab.key];
                  return (
                    <button
                      key={tab.key}
                      type="button"
                      onClick={() => setActiveTab(tab.key)}
                      className={`rounded-lg px-3 py-2 text-sm transition ${
                        isActive ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-50"
                      }`}
                    >
                      {tab.label}
                      {state.status === "running" ? " · 处理中" : ""}
                      {state.status === "failed" ? " · 失败" : ""}
                    </button>
                  );
                })}
              </div>

              <div className="flex items-center justify-between px-1 text-xs text-slate-500">
                <span>{STEP2_TABS.find((tab) => tab.key === activeTab)?.label || "当前分类"}</span>
                <span>
                  {activeTabState.status === "running"
                    ? "处理中"
                    : activeTabState.status === "completed"
                      ? "已完成"
                      : activeTabState.status === "failed"
                        ? activeTabState.error || "处理失败"
                        : "待处理"}
                </span>
              </div>

              <textarea
                value={resourceSections[activeTab] || ""}
                onChange={(e) => {
                  const nextValue = e.target.value;
                  setResourceSections((prev) => ({ ...prev, [activeTab]: nextValue }));
                  setTabStates((prev) => ({
                    ...prev,
                    [activeTab]: prev[activeTab].status === "failed" ? { status: "idle" } : prev[activeTab],
                  }));
                }}
                className="flex-1 w-full resize-none rounded-xl border border-slate-200 p-4 text-sm outline-none focus:ring-2 focus:ring-slate-200"
                placeholder={STEP2_TABS.find((tab) => tab.key === activeTab)?.placeholder || ""}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
