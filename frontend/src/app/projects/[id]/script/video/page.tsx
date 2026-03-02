"use client";

import { useCallback, useEffect, useState, useRef } from "react";
import { useParams } from "next/navigation";
import {
  Segment,
  getSegments,
  getScript,
  generateSegment,
  getModels,
  getSettings,
  saveScript,
} from "@/lib/api";
import { getToken } from "@/lib/auth";
import { extractModels, filterModels } from "@/lib/models";

function AutoResizeTextarea({ value, onChange, className }: { value: string, onChange: (v: string) => void, className?: string }) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const adjustHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${textarea.scrollHeight}px`;
    }
  }, []);

  useEffect(() => {
    adjustHeight();
  }, [value, adjustHeight]);

  return (
    <textarea
      ref={textareaRef}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={className}
      rows={1}
      style={{ resize: 'none', overflow: 'hidden' }}
    />
  );
}

export default function VideoPage() {
  const params = useParams<{ id: string }>();
  const projectId = params.id;
  const [segments, setSegments] = useState<Segment[]>([]);
  const [scriptContent, setScriptContent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [generatingSegmentId, setGeneratingSegmentId] = useState<string | null>(null);
  const [videoModels, setVideoModels] = useState<string[]>([]);
  const [defaultVideoModel, setDefaultVideoModel] = useState("");
  const [selectedModel, setSelectedModel] = useState("");

  const [tableHeaders, setTableHeaders] = useState<string[]>([]);
  const [tableRows, setTableRows] = useState<string[][]>([]);
  const [tableRange, setTableRange] = useState<{start: number, end: number} | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [originalScriptLines, setOriginalScriptLines] = useState<string[]>([]);

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
      parseTable(scriptData.content || "");
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
    }
  }, [projectId]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const parseTable = (markdown: string) => {
    const lines = markdown.split('\n');
    setOriginalScriptLines(lines);

    let headers: string[] = [];
    let rows: string[][] = [];
    let headerFound = false;
    let tableEnded = false;
    let startLine = -1;
    let endLine = -1;

    const cleanSplit = (line: string) => {
      const placeholder = "___PIPE___";
      const protectedLine = line.replace(/\\\|/g, placeholder);
      const parts = protectedLine.split('|').map(p => p.replace(new RegExp(placeholder, 'g'), '|'));
      if (parts.length > 0 && parts[0].trim() === '') parts.shift();
      if (parts.length > 0 && parts[parts.length - 1].trim() === '') parts.pop();
      return parts;
    };

    const unescapeCell = (cell: string) => {
      return cell.trim().replace(/<br\s*\/?>/gi, '\n');
    };
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      
      if (!trimmed) {
         if (headerFound) {
             tableEnded = true;
             endLine = i; // End at the empty line
             break; 
         }
         continue;
      }
      
      if (tableEnded && headerFound) break;

      if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
         if (!headerFound) {
             if (trimmed.includes("画面生成提示词") || trimmed.includes("画面内容")) {
                startLine = i;
                const parts = cleanSplit(trimmed);
                headers = parts.map(p => p.trim());
                headerFound = true;
             }
             continue;
         }

         if (headerFound) {
            // Skip separator line
            if (trimmed.replace(/\||-|:|\s/g, '') === '') continue;

            const parts = cleanSplit(trimmed);
            const row = parts.map(unescapeCell);
            rows.push(row);
            endLine = i + 1; // Update end line continuously
         }
      } else {
         if (headerFound) {
             tableEnded = true;
             endLine = i;
             break;
         }
      }
    }
    
    if (headerFound && rows.length > 0) {
        setTableHeaders(headers);
        setTableRows(rows);
        setTableRange({ start: startLine, end: endLine });
    } else {
        setTableHeaders([]);
        setTableRows([]);
        setTableRange(null);
    }
  };

  const handleCellChange = (rowIndex: number, cellIndex: number, value: string) => {
    const newRows = [...tableRows];
    newRows[rowIndex] = [...newRows[rowIndex]];
    newRows[rowIndex][cellIndex] = value;
    setTableRows(newRows);
  };

  const handleSave = async () => {
    if (!projectId || !tableRange) return;
    const token = getToken();
    if (!token) return;

    setIsSaving(true);
    setMessage(null);
    setError(null);

    try {
        const escapeCell = (cell: string) => {
            return cell.replace(/\|/g, '\\|').replace(/\n/g, '<br>');
        };

        // Reconstruct table markdown
        const headerLine = `| ${tableHeaders.join(' | ')} |`;
        const separatorLine = `| ${tableHeaders.map(() => '---').join(' | ')} |`;
        const rowLines = tableRows.map(row => `| ${row.map(escapeCell).join(' | ')} |`);
        
        const newTableLines = [headerLine, separatorLine, ...rowLines];
        
        // Merge with original lines
        const newLines = [
            ...originalScriptLines.slice(0, tableRange.start),
            ...newTableLines,
            ...originalScriptLines.slice(tableRange.end)
        ];
        
        const newContent = newLines.join('\n');
        
        await saveScript(token, projectId, newContent);
        setScriptContent(newContent);
        setOriginalScriptLines(newLines);
        // Update range end
        setTableRange({ 
            start: tableRange.start, 
            end: tableRange.start + newTableLines.length 
        });
        setMessage("保存成功");
    } catch (err) {
        setError(err instanceof Error ? err.message : "保存失败");
    } finally {
        setIsSaving(false);
    }
  };

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

  const hasTable = tableHeaders.length > 0 && tableRows.length > 0;

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
  
  const getColumnWidthClass = (header: string) => {
      if (header.includes("画面生成提示词") || header.includes("画面内容")) return "min-w-[400px]";
      if (header.includes("对白") || header.includes("动作")) return "min-w-[200px]";
      return "min-w-[100px]";
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Step 5: 分段视频工作台</h1>
        <div className="flex items-center gap-4">
           {hasTable && (
               <button
                 onClick={handleSave}
                 disabled={isSaving}
                 className="rounded-lg bg-indigo-50 px-4 py-2 text-sm font-medium text-indigo-600 hover:bg-indigo-100 disabled:opacity-50"
               >
                 {isSaving ? "保存中..." : "保存修改"}
               </button>
           )}
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
      
      {message && (
        <div className="rounded-lg bg-green-50 p-4 text-sm text-green-600">
          {message}
        </div>
      )}

      {hasTable ? (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-slate-700">
              <tr>
                {tableHeaders.map((h, i) => (
                  <th key={i} className={`whitespace-nowrap px-4 py-3 font-semibold ${getColumnWidthClass(h)}`}>
                    {h}
                  </th>
                ))}
                <th className="px-4 py-3 font-semibold text-right min-w-[160px]">生成视频</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {tableRows.map((row, rowIndex) => {
                const segment = getSegmentForRow(rowIndex);
                const videoUrl = getVideoUrl(segment);
                const isGenerating = generatingSegmentId === segment?.id || segment?.status === "PENDING_GENERATION"; 

                return (
                  <tr key={rowIndex} className="hover:bg-slate-50">
                    {row.map((cell, cellIndex) => (
                      <td key={cellIndex} className="px-4 py-3 align-top">
                        <AutoResizeTextarea
                            value={cell}
                            onChange={(val) => handleCellChange(rowIndex, cellIndex, val)}
                            className="w-full bg-transparent outline-none focus:bg-white focus:ring-1 focus:ring-indigo-500 rounded px-1 py-0.5"
                        />
                      </td>
                    ))}
                    <td className="px-4 py-3 align-top">
                      <div className="flex flex-col items-end gap-2">
                        {segment ? (
                          <>
                             {videoUrl ? (
                               <div className="relative h-24 w-40 overflow-hidden rounded-lg bg-black border border-slate-200 group">
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
