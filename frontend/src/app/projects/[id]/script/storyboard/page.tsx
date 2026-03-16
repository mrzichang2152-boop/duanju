"use client";

import { useEffect, useMemo, useState, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import { generateScript, generateSegment, generateTTS, getProjectVoices, getScript, getSegments, saveScript, type CharacterVoice, type Episode, type Segment } from "@/lib/api";
import { getToken } from "@/lib/auth";
import { ScriptEditor } from "@/app/components/ScriptEditor";

const SEPARATOR = "\n\n=== 原文剧本 (请勿删除此行) ===\n\n";
const STYLE_OPTIONS = [
  "真人电影写实", "3D 写实渲染", "3D 超写实渲染", "3D 虚幻引擎风", "3D 游戏 CG",
  "3D 半写实", "3D 皮克斯风", "3D 迪士尼风", "3D 萌系 Q 版", "3D 粘土风",
  "3D 三渲二", "3D Low Poly", "2D 动画", "2D 日式动漫", "2D 国漫风",
  "2D 美式卡通", "2D Q 版卡通", "2D 水彩油画", "2D 水墨国风", "2D 赛博风格",
];

const STYLE_PROMPT_MAP: Record<string, string> = Object.fromEntries(
  STYLE_OPTIONS.map((style) => [style, `全局视觉风格：${style}。请保持整集分镜在美术气质、光影语气、镜头审美上的统一。`])
);
const KLING_COLUMN = "Kling视频生成";
const KLING_MODELS = ["Kling-V3-Omni", "Kling-Video-O1"];
const KLING_DEFAULT_MODEL = "Kling-V3-Omni";
const KLING_DEFAULT_SPEC = "pro|1|false";
const TABLE_HEADER_KEYWORDS = ["时间轴", "镜头", "景别", "机位", "运镜", "内容", "台词", "画面", "提示词", "prompt", "角色", "场景", "道具", "备注"];
const COLUMN_MEANING_MAP: Record<string, string> = {
  时间轴: "镜头在整段视频中的时间位置与节奏",
  镜头景别与机位: "镜头远近、视角和机位关系",
  运镜手法: "镜头运动方式与运动路径",
  "内容/台词": "该镜头中人物动作、对白与叙事信息",
  画面描述: "画面主体、环境、构图、光影与氛围",
  角色形象: "角色外观与服装造型的视觉约束",
  形象: "角色或主体参考形象信息",
  道具: "需要出现并保持一致的道具元素",
  场景: "拍摄场景、空间结构与环境状态",
  备注: "补充的导演要求与约束条件",
};

function parseKlingSpec(value: string) {
  const [modeRaw, durationRaw, referenceRaw] = value.split("|");
  const mode = modeRaw === "std" ? "std" : "pro";
  const duration = Number.parseInt(durationRaw || "1", 10) || 1;
  const referenceVideo = referenceRaw === "true";
  return { mode, duration, referenceVideo };
}

function countStoryboardRows(markdown: string) {
  const lines = markdown.split("\n");
  let headerFound = false;
  let rowCount = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (headerFound) break;
      continue;
    }
    if (!trimmed.startsWith("|") || !trimmed.includes("|")) {
      if (headerFound) break;
      continue;
    }
    const parts = trimmed.split("|").map((p) => p.trim()).filter(Boolean);
    if (!headerFound) {
      const joined = parts.join(" ").toLowerCase();
      const isHeader = parts.length >= 3 && TABLE_HEADER_KEYWORDS.some((keyword) => joined.includes(keyword.toLowerCase()));
      if (isHeader) headerFound = true;
      continue;
    }
    if (trimmed.replace(/\||-|:|\s/g, "") === "") continue;
    rowCount += 1;
  }
  return rowCount;
}

export default function ScriptStoryboardPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const projectId = params.id;
  const [content, setContent] = useState("");
  const [storyboard, setStoryboard] = useState("");
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState("doubao-seed-2-0-pro-260215");
  const [globalStyle, setGlobalStyle] = useState("真人电影写实");
  const [isScriptCollapsed, setIsScriptCollapsed] = useState(false);
  const [voices, setVoices] = useState<CharacterVoice[]>([]);
  const [ttsCharacter, setTtsCharacter] = useState("");
  const [ttsText, setTtsText] = useState("");
  const [ttsAudioUrl, setTtsAudioUrl] = useState("");
  const [ttsGenerating, setTtsGenerating] = useState(false);
  const [videoModel, setVideoModel] = useState(KLING_DEFAULT_MODEL);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [generatingGlobalRowIndex, setGeneratingGlobalRowIndex] = useState<number | null>(null);

  // Episode state
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [generatingEpisodes, setGeneratingEpisodes] = useState<Set<number>>(new Set());
  const [expandedEpisodes, setExpandedEpisodes] = useState<Set<number>>(new Set([0])); // Default expand first

  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastSavedContentRef = useRef("");
  const lastSavedStoryboardRef = useRef("");
  const lastSavedEpisodesRef = useRef<Episode[]>([]);

  // Load/Save selected model from/to localStorage
  useEffect(() => {
    if (!projectId) return;
    const key = `storyboard-model-${projectId}`;
    const saved = localStorage.getItem(key);
    if (saved) {
      setSelectedModel(saved);
    }
  }, [projectId]);

  useEffect(() => {
    if (!projectId || !selectedModel) return;
    const key = `storyboard-model-${projectId}`;
    localStorage.setItem(key, selectedModel);
  }, [projectId, selectedModel]);

  useEffect(() => {
    if (!projectId) return;
    const key = `storyboard-style-${projectId}`;
    const saved = localStorage.getItem(key);
    if (saved && STYLE_OPTIONS.includes(saved)) {
      setGlobalStyle(saved);
    }
  }, [projectId]);

  useEffect(() => {
    if (!projectId || !globalStyle) return;
    const key = `storyboard-style-${projectId}`;
    localStorage.setItem(key, globalStyle);
  }, [projectId, globalStyle]);

  useEffect(() => {
    if (!projectId) return;
    const token = getToken();
    if (!token) return;
    getProjectVoices(token, projectId)
      .then((items) => {
        setVoices(items);
        if (items.length > 0) {
          setTtsCharacter(items[0].character_name);
        }
      })
      .catch(() => {
        setVoices([]);
      });
  }, [projectId]);

  // Load script
  useEffect(() => {
    if (!projectId) return;
    const token = getToken();
    if (!token) {
      router.push("/login");
      return;
    }

    getScript(token, projectId)
      .then(async (data) => {
        setContent(data.content ?? "");
        const initialStoryboard = data.storyboard || "";
        setStoryboard(initialStoryboard);
        
        lastSavedContentRef.current = data.content ?? "";
        lastSavedStoryboardRef.current = initialStoryboard;

        if (data.episodes && data.episodes.length > 0) {
            // Handle episodes that might have content nested in versions (from Step 1)
            const loadedEpisodes = data.episodes.map((ep: any) => {
                if (!ep.content && ep.versions && Array.isArray(ep.versions) && ep.versions.length > 0) {
                     const current = ep.versions.find((v: any) => v.id === ep.currentVersionId) || ep.versions[0];
                     return { ...ep, content: current.content || "" };
                }
                return ep;
            });
            setEpisodes(loadedEpisodes);
            lastSavedEpisodesRef.current = loadedEpisodes;
        } else {
            // Fallback: if no episodes, maybe we should treat the whole content as one episode?
            // For now, keep episodes empty and show fallback UI if needed, 
            // but user asked for "like Step 1", so we prioritize episodes.
            // If episodes are empty but content exists, we could suggest splitting, 
            // but Step 4 is about generating storyboard.
            // Let's assume user has episodes if they followed the flow.
        }
        const segmentData = await getSegments(token, projectId);
        setSegments(segmentData);
      })
      .catch((err) => setMessage("加载失败"))
      .finally(() => setLoading(false));
  }, [projectId, router]);

  const generatedRowIndexSet = useMemo(() => {
    const set = new Set<number>();
    segments.forEach((segment, index) => {
      if (segment.versions?.some((version) => version.video_url)) {
        set.add(index);
      }
    });
    return set;
  }, [segments]);

  // Sync storyboard string from episodes
  useEffect(() => {
    if (episodes.length > 0) {
        const combinedStoryboard = episodes
            .map(ep => `### ${ep.title}\n\n${ep.storyboard || ""}`)
            .join("\n\n");
        
        if (combinedStoryboard !== storyboard) {
            setStoryboard(combinedStoryboard);
        }
    }
  }, [episodes]);

  // Auto-save effect
  useEffect(() => {
    if (loading || !projectId) return;
    
    const episodesChanged = JSON.stringify(episodes) !== JSON.stringify(lastSavedEpisodesRef.current);
    const storyboardChanged = storyboard !== lastSavedStoryboardRef.current;

    if (!episodesChanged && !storyboardChanged) return;

    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);

    saveTimeoutRef.current = setTimeout(async () => {
      const token = getToken();
      if (!token) return;
      try {
        // Save storyboard (combined) AND episodes (with individual storyboards)
        // We preserve content, thinking, outline by passing undefined (or we could pass them if we had them in state)
        // But getScript loads them. Here we only have content in state.
        // To be safe, we should probably fetch latest or just pass what we have.
        // content state is loaded.
        
        // Filter out UI-only fields from episodes if any (Episode interface in api.ts doesn't have UI fields except isThinkingCollapsed)
        // We cast to any to be safe with strict types if needed
        const episodesToSave = episodes.map(({ isThinkingCollapsed, ...rest }) => rest);

        await saveScript(token, projectId, undefined, undefined, storyboard, undefined, episodesToSave as any[]);
        
        lastSavedStoryboardRef.current = storyboard;
        lastSavedEpisodesRef.current = episodes;
        setMessage("已自动保存");
      } catch (e) {
        console.error("Auto-save failed", e);
      }
    }, 2000);

    return () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    };
  }, [episodes, storyboard, projectId, loading]);

  const handleGenerateEpisode = async (index: number) => {
    if (!projectId) return;
    const token = getToken();
    if (!token) return;

    const episode = episodes[index];
    if (!episode) return;

    setGeneratingEpisodes(prev => new Set(prev).add(index));
    setMessage(`正在生成 ${episode.title} 的分镜...`);

    try {
      // Use the episode content to generate storyboard
      // We pass the episode content as 'content' to the API
      // The system prompt (PROMPT_STORYBOARD) expects script content
      const result = await generateScript(token, projectId, {
        mode: "generate_storyboard",
        content: episode.content, // Use episode content
        model: selectedModel,
        instruction: STYLE_PROMPT_MAP[globalStyle] || `全局视觉风格：${globalStyle}`,
      });

      if (result.content) {
        setEpisodes(prev => {
            const newEpisodes = [...prev];
            newEpisodes[index] = { ...newEpisodes[index], storyboard: result.content };
            return newEpisodes;
        });
        setMessage(`${episode.title} 分镜生成完成`);
        
        // Auto-expand the episode if not expanded
        if (!expandedEpisodes.has(index)) {
            setExpandedEpisodes(prev => new Set(prev).add(index));
        }
      }
    } catch (e) {
      console.error(e);
      setMessage(`${episode.title} 生成失败`);
    } finally {
      setGeneratingEpisodes(prev => {
          const newSet = new Set(prev);
          newSet.delete(index);
          return newSet;
      });
    }
  };

  const toggleEpisodeExpand = (index: number) => {
      setExpandedEpisodes(prev => {
          const newSet = new Set(prev);
          if (newSet.has(index)) {
              newSet.delete(index);
          } else {
              newSet.add(index);
          }
          return newSet;
      });
  };

  const handleEpisodeStoryboardChange = (index: number, newStoryboard: string) => {
      setEpisodes(prev => {
          const newEpisodes = [...prev];
          newEpisodes[index] = { ...newEpisodes[index], storyboard: newStoryboard };
          return newEpisodes;
      });
  };

  const handleGenerateKlingRow = async ({
    globalRowIndex,
    headers,
    row,
    spec,
  }: {
    globalRowIndex: number;
    headers: string[];
    row: string[];
    spec: string;
  }) => {
    const token = getToken();
    if (!token || !projectId) return;
    const segment = segments[globalRowIndex];
    if (!segment) {
      setMessage("当前行还未同步到分段，请等待自动保存后重试");
      return;
    }
    setGeneratingGlobalRowIndex(globalRowIndex);
    try {
      const { mode, duration, referenceVideo } = parseKlingSpec(spec || KLING_DEFAULT_SPEC);
      const promptParts: string[] = [];
      const meaningParts: string[] = [];
      let imageUrl = "";

      headers.forEach((header, index) => {
        const cell = row[index] || "";
        if (!cell) return;
        if (["形象", "场景", "道具"].includes(header)) {
          const match = cell.match(/!\[.*?\]\((.*?)\)/);
          if (match?.[1] && !imageUrl) imageUrl = match[1];
        } else if (header !== KLING_COLUMN && header !== "生成视频") {
          meaningParts.push(`- ${header}：${COLUMN_MEANING_MAP[header] || "该字段用于描述当前镜头的重要信息"}`);
          promptParts.push(`${header}: ${cell}`);
        }
      });

      const prompt = [
        "请基于同一行分镜信息生成视频，必须严格理解每一列含义并综合所有字段。",
        "【列含义】",
        ...meaningParts,
        "【当前行取值】",
        ...promptParts,
        "【生成要求】",
        `模式：${mode}`,
        `时长：${duration}s`,
        `是否参考视频：${referenceVideo ? "是" : "否"}`,
        "音频：无声",
      ].join("\n");

      const modelToUse = KLING_MODELS.includes(videoModel) ? videoModel : KLING_DEFAULT_MODEL;
      const options: Record<string, string | number | boolean> = {
        prompt,
        model: modelToUse,
        mode,
        duration,
        reference_video: referenceVideo,
        with_audio: false,
      };
      if (imageUrl) {
        options.image_url = imageUrl;
      }

      await generateSegment(token, projectId, {
        segment_id: segment.id,
        prompt,
        model: modelToUse,
        options,
      });
      const refreshedSegments = await getSegments(token, projectId);
      setSegments(refreshedSegments);
      setMessage("视频生成任务已提交");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "视频生成失败");
    } finally {
      setGeneratingGlobalRowIndex(null);
    }
  };

  const handleGenerateTTS = async () => {
    if (!projectId || !ttsCharacter || !ttsText.trim()) return;
    const token = getToken();
    if (!token) return;
    setTtsGenerating(true);
    setMessage("正在生成角色台词音频...");
    try {
      const result = await generateTTS(token, projectId, {
        character_name: ttsCharacter,
        text: ttsText.trim(),
      });
      const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8002/api";
      const backendBase = apiBase.endsWith("/api") ? apiBase.slice(0, -4) : apiBase;
      const fullUrl = result.audio_url.startsWith("http") ? result.audio_url : `${backendBase}${result.audio_url}`;
      setTtsAudioUrl(fullUrl);
      setMessage("角色台词音频生成完成");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "角色台词音频生成失败");
    } finally {
      setTtsGenerating(false);
    }
  };

  if (loading) return <div>加载中...</div>;

  return (
    <div className="h-full flex flex-col space-y-4">
      <div className="flex justify-between items-center">
        <h2 className="text-xl font-bold">Step 4: 生成分镜脚本</h2>
        <div className="flex items-center gap-2">
          <button
            onClick={() => router.push(`/projects/${projectId}/script/assets`)}
            className="rounded-lg border border-slate-200 px-4 py-2 text-sm hover:bg-slate-50 text-slate-600"
          >
            上一步
          </button>
          <button
            onClick={() => router.push(`/projects/${projectId}/script/video`)}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm text-white hover:bg-slate-800"
          >
            下一步：生成分段视频
          </button>
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm">
        <div className="flex justify-between items-center mb-2">
          <div className="font-semibold">原文剧本 (参考)</div>
          <button
            onClick={() => setIsScriptCollapsed(!isScriptCollapsed)}
            className="text-xs text-slate-500 hover:text-slate-700"
          >
            {isScriptCollapsed ? "展开" : "收起"}
          </button>
        </div>
        {!isScriptCollapsed && (
          <textarea
            value={content}
            readOnly
            className="w-full h-32 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700 resize-none"
            placeholder="暂无剧本内容"
          />
        )}
      </div>

      <div className="flex items-center gap-4">
        <select
          value={selectedModel}
          onChange={(e) => setSelectedModel(e.target.value)}
          className="border p-2 rounded text-sm"
        >
          <option value="doubao-seed-2-0-pro-260215">豆包Pro (doubao-seed-2-0-pro)</option>
          <option value="deepseek-r1-250120">DeepSeek R1 (deepseek-r1)</option>
          <option value="deepseek-v3-241226">DeepSeek V3 (deepseek-v3)</option>
          <option value="gpt-4o-2024-08-06">GPT-4o (gpt-4o)</option>
          <option value="claude-3-5-sonnet-20240620">Claude 3.5 Sonnet</option>
        </select>
        <select
          value={videoModel}
          onChange={(e) => setVideoModel(e.target.value)}
          className="border p-2 rounded text-sm"
        >
          {KLING_MODELS.map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
        </select>
        {message && <span className="text-gray-500 text-sm">{message}</span>}
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
        <div className="text-sm font-semibold text-slate-900">角色台词配音（Fish Audio）</div>
        {voices.length === 0 ? (
          <div className="text-xs text-slate-500">
            当前项目未配置角色音色，请先到 Step 2 的“角色音色”页签配置后再生成台词音频。
          </div>
        ) : (
          <div className="space-y-2">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
              <select
                value={ttsCharacter}
                onChange={(e) => setTtsCharacter(e.target.value)}
                className="rounded border border-slate-200 px-3 py-2 text-sm"
              >
                {voices.map((voice) => (
                  <option key={voice.id} value={voice.character_name}>
                    {voice.character_name}
                  </option>
                ))}
              </select>
              <input
                value={ttsText}
                onChange={(e) => setTtsText(e.target.value)}
                className="md:col-span-2 rounded border border-slate-200 px-3 py-2 text-sm"
                placeholder="输入台词内容后生成音频"
              />
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={handleGenerateTTS}
                disabled={ttsGenerating || !ttsCharacter || !ttsText.trim()}
                className="rounded bg-indigo-600 px-4 py-2 text-xs text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                {ttsGenerating ? "生成中..." : "生成角色台词音频"}
              </button>
              {ttsAudioUrl ? (
                <audio controls src={ttsAudioUrl} className="h-9" />
              ) : null}
            </div>
          </div>
        )}
      </div>

      {episodes.length > 0 ? (
        <div className="flex-1 overflow-y-auto space-y-4 pb-10">
            <div className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-500">全局风格：</span>
                    <select
                        value={globalStyle}
                        onChange={(e) => setGlobalStyle(e.target.value)}
                        className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs"
                    >
                        {STYLE_OPTIONS.map((style) => (
                            <option key={style} value={style}>
                                {style}
                            </option>
                        ))}
                    </select>
                </div>
            </div>
            {(() => {
              let rowCursor = 0;
              return episodes.map((episode, index) => {
                const rowStartIndex = rowCursor;
                rowCursor += countStoryboardRows(episode.storyboard || "");
                return (
                <div key={index} className="border border-slate-200 rounded-xl overflow-hidden bg-white">
                    <div 
                        className="bg-slate-50 px-4 py-3 flex justify-between items-center cursor-pointer hover:bg-slate-100 transition-colors"
                        onClick={() => toggleEpisodeExpand(index)}
                    >
                        <div className="font-semibold text-slate-800">{episode.title || `第 ${index + 1} 集`}</div>
                        <div className="flex items-center gap-3">
                            <button
                                onClick={(e) => {
                                    e.stopPropagation();
                                    handleGenerateEpisode(index);
                                }}
                                disabled={generatingEpisodes.has(index)}
                                className="px-3 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
                            >
                                {generatingEpisodes.has(index) ? "生成中..." : "生成分镜"}
                            </button>
                            <span className="text-slate-400 text-xs">
                                {expandedEpisodes.has(index) ? "收起" : "展开"}
                            </span>
                        </div>
                    </div>
                    
                    {expandedEpisodes.has(index) && (
                        <div className="p-4 border-t border-slate-200">
                             <div className="mb-4">
                                <div className="text-xs font-semibold text-slate-500 mb-2">本集剧本:</div>
                                <div className="p-3 bg-slate-50 rounded text-xs text-slate-600 max-h-32 overflow-y-auto whitespace-pre-wrap border border-slate-100">
                                    {episode.content}
                                </div>
                             </div>
                             
                             <div>
                                <div className="text-xs font-semibold text-slate-500 mb-2">分镜脚本:</div>
                                <ScriptEditor
                                    content={episode.storyboard || ""}
                                    onChange={(newContent) => handleEpisodeStoryboardChange(index, newContent)}
                                    projectId={projectId}
                                    rowStartIndex={rowStartIndex}
                                    generatingGlobalRowIndex={generatingGlobalRowIndex}
                                    generatedRowIndexSet={generatedRowIndexSet}
                                    onGenerateKlingRow={handleGenerateKlingRow}
                                />
                             </div>
                        </div>
                    )}
                </div>
                );
              });
            })()}
        </div>
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center text-slate-500 border-2 border-dashed border-slate-200 rounded-xl">
             <p className="mb-2">暂无分集数据</p>
             <p className="text-sm">请先在 Step 1 生成并拆分剧本</p>
             <button 
                onClick={() => router.push(`/projects/${projectId}/script/input`)}
                className="mt-4 px-4 py-2 bg-slate-100 hover:bg-slate-200 rounded-lg text-sm text-slate-700"
             >
                前往 Step 1
             </button>
        </div>
      )}
    </div>
  );
}
