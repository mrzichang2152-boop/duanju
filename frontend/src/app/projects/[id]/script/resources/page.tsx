"use client";

import { useEffect, useRef, useState, useMemo } from "react";
import { useParams, useRouter } from "next/navigation";
import { generateScript, getScript, saveScript, extractAssets, getProjectVoices, CharacterVoice } from "@/lib/api";
import { getToken } from "@/lib/auth";
import { VoiceSelector } from "@/app/components/VoiceSelector";

const SEPARATOR = "\n\n=== 原文剧本 (请勿删除此行) ===\n\n";

export default function ScriptResourcesPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const projectId = params.id;
  const [content, setContent] = useState("");
  const [originalContent, setOriginalContent] = useState("");
  const [resourcesContent, setResourcesContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [isModifying, setIsModifying] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [selectedModel, setSelectedModel] = useState("doubao-seed-2-0-pro-260215");
  const [activeTab, setActiveTab] = useState<"text" | "voices">("text");
  const [voices, setVoices] = useState<Record<string, CharacterVoice>>({});
  const [tabAutoSwitched, setTabAutoSwitched] = useState(false);
  
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

  // Load voices
  useEffect(() => {
    if (!projectId) return;
    const token = getToken();
    if (!token) return;
    getProjectVoices(token, projectId).then(data => {
      const map: Record<string, CharacterVoice> = {};
      data.forEach(v => {
        map[v.character_name] = v;
      });
      setVoices(map);
    }).catch(console.error);
  }, [projectId]);

  const characters = useMemo(() => {
    if (!resourcesContent) return [];
    const lines = resourcesContent.split('\n');
    const chars: string[] = [];
    let inCharList = false;
    let roleNamePrefixFound = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (
        trimmed.startsWith("# 角色列表") ||
        trimmed.startsWith("### 角色列表") ||
        trimmed.startsWith("【角色列表】") ||
        trimmed === "角色列表"
      ) {
        inCharList = true;
        continue;
      }
      if (
        (trimmed.startsWith("# ") || trimmed.startsWith("### ")) &&
        !trimmed.includes("角色列表")
      ) {
        inCharList = false;
      }
      if (inCharList && trimmed.startsWith("## ")) {
        let name = trimmed.substring(3).trim();
        if (name.includes("：")) name = name.split("：")[0].trim();
        if (name.includes(":")) name = name.split(":")[0].trim();
        if (name) chars.push(name);
      }
      if (inCharList && (trimmed.startsWith("角色名：") || trimmed.startsWith("角色名:"))) {
        roleNamePrefixFound = true;
        let name = trimmed.replace("角色名：", "").replace("角色名:", "").trim();
        if (name.includes("（")) name = name.split("（")[0].trim();
        if (name.includes("(")) name = name.split("(")[0].trim();
        if (name.includes("：")) name = name.split("：")[0].trim();
        if (name.includes(":")) name = name.split(":")[0].trim();
        if (name) chars.push(name);
      }
    }
    if (chars.length === 0 && roleNamePrefixFound) {
      return [];
    }
    if (chars.length === 0) {
      const roleNameLines = lines
        .map((l) => l.trim())
        .filter((l) => l.startsWith("角色名：") || l.startsWith("角色名:"))
        .map((l) => l.replace("角色名：", "").replace("角色名:", "").trim())
        .map((name) => {
          let result = name;
          if (result.includes("（")) result = result.split("（")[0].trim();
          if (result.includes("(")) result = result.split("(")[0].trim();
          if (result.includes("：")) result = result.split("：")[0].trim();
          if (result.includes(":")) result = result.split(":")[0].trim();
          return result;
        })
        .filter(Boolean);
      if (roleNameLines.length > 0) {
        return [...new Set(roleNameLines)];
      }
       return lines
        .filter(l => l.trim().startsWith("## "))
        .map(l => {
          let name = l.trim().substring(3).trim();
          if (name.includes("：")) name = name.split("：")[0].trim();
          if (name.includes(":")) name = name.split(":")[0].trim();
          return name;
        })
        .filter(n => n && !n.includes("道具") && !n.includes("场景")); // Basic filtering
    }
    return [...new Set(chars)]; // Unique names
  }, [resourcesContent]);

  useEffect(() => {
    if (!tabAutoSwitched && characters.length > 0) {
      setActiveTab("voices");
      setTabAutoSwitched(true);
    }
  }, [characters.length, tabAutoSwitched]);

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
        setContent(fullContent);
        
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
      .catch((err) => setMessage("加载失败"))
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
    } catch (error) {
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
              <div className="flex bg-slate-100 rounded-lg p-1 text-xs">
                <button 
                  className={`px-3 py-1 rounded-md transition-all ${activeTab === "text" ? "bg-white shadow text-slate-900 font-medium" : "text-slate-500 hover:text-slate-700"}`}
                  onClick={() => setActiveTab("text")}
                >
                  文本编辑
                </button>
                <button 
                  className={`px-3 py-1 rounded-md transition-all ${activeTab === "voices" ? "bg-white shadow text-slate-900 font-medium" : "text-slate-500 hover:text-slate-700"}`}
                  onClick={() => setActiveTab("voices")}
                >
                  角色音色
                </button>
              </div>
            </div>
            
            {activeTab === "text" ? (
              <div className="flex flex-col h-full gap-2">
                {/* AI Modify Panel for Resources */}
                <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
                  <div className="mb-2 text-xs font-medium text-slate-900">AI 辅助修改</div>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <select
                      value={selectedModel}
                      onChange={(e) => setSelectedModel(e.target.value)}
                      className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs outline-none focus:border-indigo-500 sm:w-32"
                    >
                      <option value="doubao-seed-2-0-pro-260215">Doubao 2.0 Pro</option>
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
            ) : (
              <div className="flex-1 overflow-y-auto rounded-xl border border-slate-200 bg-white p-4">
                {characters.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-full text-slate-500">
                    <p>未检测到角色。</p>
                    <p className="text-xs mt-2">请先在文本编辑模式下提取资源，或手动添加角色名字段（支持“角色名：xxx”格式）。</p>
                  </div>
                ) : (
                  <div className="space-y-6">
                    <div className="text-xs text-slate-500 bg-slate-50 p-3 rounded-lg border border-slate-100">
                      在此为每个角色配置音色。这些配置将在 Step 4 生成分镜和配音时使用。
                      <br/>支持选择 Fish Audio 预设音色、输入自定义 Model ID 或上传音频克隆音色。
                    </div>
                    {characters.map(char => (
                      <div key={char} className="flex flex-col gap-2 border-b border-slate-100 pb-4 last:border-0">
                        <div className="font-medium text-sm text-slate-900">{char}</div>
                        <VoiceSelector 
                          projectId={projectId} 
                          characterName={char} 
                          initialVoice={voices[char]} 
                          onVoiceUpdate={(v) => setVoices(prev => ({ ...prev, [char]: v }))}
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
      {message && <div className="text-sm text-slate-600">{message}</div>}
    </div>
  );
}
