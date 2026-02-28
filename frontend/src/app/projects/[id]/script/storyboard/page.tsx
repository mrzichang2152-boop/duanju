"use client";

import { useEffect, useState, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import { generateScript, getScript, saveScript } from "@/lib/api";
import { getToken } from "@/lib/auth";
import { ScriptEditor } from "@/app/components/ScriptEditor";

const SEPARATOR = "\n\n=== 原文剧本 (请勿删除此行) ===\n\n";

export default function ScriptStoryboardPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const projectId = params.id;
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastSavedContentRef = useRef("");

  // Load script
  useEffect(() => {
    if (!projectId) return;
    const token = getToken();
    if (!token) {
      router.push("/login");
      return;
    }

    getScript(token, projectId)
      .then((data) => {
        setContent(data.content ?? "");
        lastSavedContentRef.current = data.content ?? "";
      })
      .catch((err) => setMessage("加载失败"))
      .finally(() => setLoading(false));
  }, [projectId, router]);

  // Auto-save effect
  useEffect(() => {
    if (loading || !projectId) return;
    if (content === lastSavedContentRef.current) return;

    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);

    saveTimeoutRef.current = setTimeout(async () => {
      const token = getToken();
      if (!token) return;
      try {
        await saveScript(token, projectId, content);
        lastSavedContentRef.current = content;
        setMessage("已自动保存");
      } catch (e) {
        console.error("Auto-save failed", e);
      }
    }, 2000);

    return () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    };
  }, [content, projectId, loading]);

  const handleGenerate = async () => {
    if (!projectId) return;
    const token = getToken();
    if (!token) return;

    setGenerating(true);
    setMessage("正在生成分镜...");

    try {
      // We send the full content (Resources + Original) to the API
      // The API uses it to generate the Table
      const result = await generateScript(token, projectId, {
        mode: "generate_storyboard",
        content: content,
      });

      if (result.content) {
        // The result is just the Table (template_storyboard output)
        // We need to construct the final script: Resources + Table
        // If we have a separator, we take the part before it (Resources)
        // If not, we might lose resources if we are not careful.
        // But Step 2 ensures Resources + Separator + Original.
        
        let newContent = result.content;
        
        let resourcesPart = "";
        if (content.includes(SEPARATOR)) {
          resourcesPart = content.split(SEPARATOR)[0];
        } else if (content.trim().startsWith("【人物小传")) {
          const tableIndex = content.indexOf("| 场次 |");
          if (tableIndex > -1) {
            resourcesPart = content.substring(0, tableIndex).trim();
          } else {
            resourcesPart = content.trim();
          }
        }

        if (resourcesPart) {
          newContent = resourcesPart + "\n\n" + result.content;
        }

        setContent(newContent);
        lastSavedContentRef.current = newContent;
        setMessage("生成完成");
        // Save automatically
        await saveScript(token, projectId, newContent);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "生成失败");
    } finally {
      setGenerating(false);
    }
  };

  const handleSave = (newContent: string) => {
    setContent(newContent);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Step 3: 生成分镜</h1>
        <div className="flex gap-3">
          <button
            onClick={handleGenerate}
            disabled={generating}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {generating ? "生成中..." : "AI 生成分镜"}
          </button>
          <a
            href={`/projects/${projectId}/script/assets`}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm text-white hover:bg-slate-800"
          >
            下一步：生成素材
          </a>
        </div>
      </div>

      {loading ? (
        <div>加载中...</div>
      ) : (
        <div className="w-full rounded-xl border border-slate-200 bg-white shadow-sm min-h-[600px]">
           <ScriptEditor content={content} onChange={handleSave} />
        </div>
      )}
      {message && <div className="text-sm text-slate-600">{message}</div>}
    </div>
  );
}
