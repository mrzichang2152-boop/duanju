"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import {
  Segment,
  getSegments,
  getScript,
  generateSegment,
  getModels,
  getSettings,
} from "@/lib/api";
import { getToken } from "@/lib/auth";
import { extractModels, filterModels } from "@/lib/models";

export default function VideoPage() {
  const params = useParams<{ id: string }>();
  const projectId = params.id;
  const [segments, setSegments] = useState<Segment[]>([]);
  const [scriptContent, setScriptContent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [generatingSegmentId, setGeneratingSegmentId] = useState<string | null>(null);
  const [videoModels, setVideoModels] = useState<string[]>([]);
  const [defaultVideoModel, setDefaultVideoModel] = useState("");
  const [selectedModel, setSelectedModel] = useState("");

  const loadConfig = useCallback(async () => {
    const token = getToken();
    if (!token) return;
    try {
      const [modelsRaw, settings] = await Promise.all([getModels(token), getSettings(token)]);
      const models = extractModels(modelsRaw);
      const videos = filterModels(models, "video");
      setVideoModels(videos);
      setDefaultVideoModel(settings.default_model_video);
      setSelectedModel(settings.default_model_video || (videos.length > 0 ? videos[0] : ""));
    } catch (err) {
      console.error(err);
    }
  }, []);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  const loadData = useCallback(async () => {
    if (!projectId) return;
    const token = getToken();
    if (!token) {
      window.location.href = "/login";
      return;
    }
    setError(null);
    try {
      const [segmentsData, scriptData] = await Promise.all([
        getSegments(token, projectId),
        getScript(token, projectId),
      ]);
      setSegments(segmentsData);
      setScriptContent(scriptData.content || "");
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
    }
  }, [projectId]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const runGenerateOne = async (segmentId: string) => {
    if (!projectId) return;
    const token = getToken();
    if (!token) return;

    setGeneratingSegmentId(segmentId);
    setError(null);
    try {
      await generateSegment(token, projectId, {
        segment_id: segmentId,
        model: selectedModel || undefined,
      });
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "生成失败");
    } finally {
      setGeneratingSegmentId(null);
    }
  };

  const parseMarkdownTable = (markdown: string) => {
    const lines = markdown.split('\n');
    const tableRows: string[][] = [];
    let headers: string[] = [];
    let headerFound = false;
    let tableEnded = false;
    
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
         if (headerFound) tableEnded = true;
         continue;
      }
      
      if (tableEnded && headerFound) break;

      if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
         if (!headerFound) {
             if (trimmed.includes("画面生成提示词") || trimmed.includes("画面内容")) {
                // Split by | and filter out empty strings from start/end
                const parts = trimmed.split('|');
                if (parts.length > 0 && parts[0].trim() === '') parts.shift();
                if (parts.length > 0 && parts[parts.length - 1].trim() === '') parts.pop();
                headers = parts.map(p => p.trim());
                headerFound = true;
             }
             continue;
         }

         if (headerFound) {
            // Skip separator line
            if (trimmed.replace(/\||-|:|\s/g, '') === '') continue;

            const parts = trimmed.split('|');
            if (parts.length > 0 && parts[0].trim() === '') parts.shift();
            if (parts.length > 0 && parts[parts.length - 1].trim() === '') parts.pop();
            
            const row = parts.map(p => p.trim());
            tableRows.push(row);
         }
      } else {
         if (headerFound) tableEnded = true;
      }
    }
    
    return { headers, rows: tableRows };
  };

  const { headers, rows } = parseMarkdownTable(scriptContent);

  // If no table found, we might want to show a warning or fallback
  const hasTable = headers.length > 0 && rows.length > 0;

  const getSegmentForRow = (rowIndex: number) => {
    // order_index is 1-based
    return segments.find(s => s.order_index === rowIndex + 1);
  };

  const getVideoUrl = (segment: Segment | undefined) => {
    if (!segment) return null;
    const selected = segment.versions.find(v => v.is_selected);
    if (selected) return selected.video_url;
    // Fallback to latest success
    const success = segment.versions.filter(v => v.status === "COMPLETED");
    if (success.length > 0) {
        return success[success.length - 1].video_url;
    }
    return null;
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Step 5: 分段视频工作台</h1>
        <div className="flex items-center gap-4">
           <select 
             value={selectedModel}
             onChange={(e) => setSelectedModel(e.target.value)}
             className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
           >
             <option value="">选择视频模型</option>
             {videoModels.map(m => (
               <option key={m} value={m}>{m}</option>
             ))}
           </select>
           <a
             href={projectId ? `/projects/${projectId}/final` : "/projects"}
             className="rounded-lg bg-slate-900 px-4 py-2 text-sm text-white"
           >
             下一步：成片
           </a>
        </div>
      </div>

      {error && (
        <div className="rounded-lg bg-red-50 p-4 text-sm text-red-600">
          {error}
        </div>
      )}

      {hasTable ? (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-slate-700">
              <tr>
                {headers.map((h, i) => (
                  <th key={i} className="whitespace-nowrap px-4 py-3 font-semibold">
                    {h}
                  </th>
                ))}
                <th className="px-4 py-3 font-semibold text-right">生成视频</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row, rowIndex) => {
                const segment = getSegmentForRow(rowIndex);
                const videoUrl = getVideoUrl(segment);
                const isGenerating = generatingSegmentId === segment?.id || segment?.status === "PENDING_GENERATION"; 

                return (
                  <tr key={rowIndex} className="hover:bg-slate-50">
                    {row.map((cell, cellIndex) => (
                      <td key={cellIndex} className="max-w-xs truncate px-4 py-3 text-slate-600" title={cell}>
                        {cell}
                      </td>
                    ))}
                    <td className="px-4 py-3 min-w-[200px]">
                      <div className="flex flex-col items-end gap-2">
                        {segment ? (
                          <>
                             {videoUrl ? (
                               <div className="relative h-24 w-40 overflow-hidden rounded-lg bg-black border border-slate-200">
                                 <video 
                                   src={videoUrl} 
                                   controls 
                                   className="h-full w-full object-cover"
                                 />
                               </div>
                             ) : (
                               <div className="flex h-24 w-40 items-center justify-center rounded-lg bg-slate-100 text-xs text-slate-400 border border-slate-200">
                                 {segment.status === "COMPLETED" ? "无视频" : segment.status}
                               </div>
                             )}
                             
                             <button
                               onClick={() => runGenerateOne(segment.id)}
                               disabled={isGenerating || !selectedModel}
                               className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors"
                             >
                               {isGenerating ? "生成中..." : videoUrl ? "重新生成" : "生成视频"}
                             </button>
                          </>
                        ) : (
                          <span className="text-xs text-slate-400">未同步</span>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-slate-500">
          <p>未检测到分镜脚本表格，请先完成 Step 3 分镜生成。</p>
        </div>
      )}
    </div>
  );
}
