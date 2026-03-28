"use client";

import { useEffect, useState, useRef, type ChangeEvent } from "react";
import { useParams, useRouter } from "next/navigation";
import { getScript, saveScript, generateScriptStream, type ScriptEpisodePayload, type ScriptGeneratePayload } from "@/lib/api";
import { getToken } from "@/lib/auth";

const scriptOptions = [
  {
    category: "受众维度",
    items: [
      { label: "性别取向", options: ["女性向", "男性向", "男女通吃", "女性爽感为主+男性观感兼容", "男性爽感为主+女性情感线增强"] },
      { label: "年龄层", options: ["12–16 青少年", "16–22 校园人群", "22–30 都市青年", "30–40 成熟职场", "40+ 中年群体", "银发市场"] },
      { label: "城市层级", options: ["一线城市", "新一线", "二三线", "下沉市场（四线及县域）", "海外华人市场"] },
      { label: "教育 / 认知层级", options: ["高知市场（逻辑强、现实议题）", "泛大众娱乐市场", "下沉爽感市场", "亚文化圈层", "垂直兴趣人群（电竞/金融/二次元）"] },
      { label: "消费偏好", options: ["情绪消费型（爽、甜）", "思考型（悬疑、现实）", "视觉刺激型", "情感陪伴型", "价值认同型"] }
    ]
  },
  {
    category: "时间维度",
    items: [
      { label: "现实历史", options: ["先秦", "汉唐", "宋明", "清末", "民国", "抗战时期", "改革开放", "90年代", "千禧年前后"] },
      { label: "当代", options: ["当下都市", "新媒体时代", "资本寒冬背景", "AI时代", "平台经济时代"] },
      { label: "未来", options: ["近未来（10–30年）", "赛博朋克", "AI统治", "星际殖民", "宇宙文明博弈", "末世废土"] },
      { label: "时间结构玩法", options: ["时间循环", "重生", "多时间线", "平行时空", "双时空对照", "记忆穿梭", "因果悖论"] }
    ]
  },
  {
    category: "空间维度",
    items: [
      { label: "现实空间", options: ["都市", "校园", "官场", "商业世界", "娱乐圈", "医疗系统", "军营", "监狱", "边境", "海外城市"] },
      { label: "架空空间", options: ["架空王朝", "江湖", "修真界", "魔法世界", "兽人世界", "末世废土", "赛博城市", "游戏世界", "副本世界", "平行宇宙", "多重宇宙"] }
    ]
  },
  {
    category: "世界复杂度",
    items: [
      { label: "世界复杂度", options: ["单一现实世界", "双世界（现实+异界）", "多世界切换", "无限副本", "宇宙级文明体系", "神明体系", "多文明博弈"] }
    ]
  },
  {
    category: "故事类型",
    items: [
      { label: "现实向", options: ["职场", "商战", "权谋", "宫斗", "官场", "刑侦", "谍战", "家庭伦理", "医疗", "军旅", "财经资本", "创业"] },
      { label: "情感向", options: ["甜宠", "先婚后爱", "暗恋", "青梅竹马", "破镜重圆", "追妻火葬场", "双强互撩", "修罗场", "女性成长"] },
      { label: "爽文向", options: ["重生逆袭", "都市爽文", "系统流", "无敌流", "升级流", "打脸流", "复仇流"] },
      { label: "类型融合", options: ["科幻+悬疑", "商战+爱情", "权谋+爽文", "末世+情感", "都市+系统", "现实+幻想"] }
    ]
  },
  {
    category: "爽点机制",
    items: [
      { label: "设定爽", options: ["重生", "穿越", "穿书", "系统绑定", "双身份", "隐藏大佬", "读心术", "预知未来", "时间暂停", "无限流", "觉醒血脉", "超能力", "金手指", "记忆继承", "马甲流"] },
      { label: "行为爽", options: ["打脸", "反杀", "碾压", "身份揭晓", "财富暴涨", "智商碾压", "权谋操控", "绝地翻盘", "极限救场"] },
      { label: "情感爽", options: ["甜宠", "互撩", "暗恋成真", "修罗场", "追妻火葬场", "高糖密集", "虐后甜", "情感对峙"] }
    ]
  },
  {
    category: "冲突类型",
    items: [
      { label: "冲突类型", options: ["人 vs 人", "人 vs 家族", "人 vs 权力结构", "人 vs 资本", "人 vs 社会偏见", "人 vs 规则", "人 vs 命运", "人 vs 自我", "人 vs 世界崩坏", "多势力博弈", "隐藏真相型"] }
    ]
  },
  {
    category: "主角驱动力",
    items: [
      { label: "主角驱动力", options: ["复仇", "生存", "改命", "权力野心", "事业成功", "成神成王", "拯救世界", "保护家人", "爱情执念", "证明自己", "解谜真相", "自我救赎"] }
    ]
  },
  {
    category: "成长弧线",
    items: [
      { label: "成长弧线", options: ["升级流", "黑化", "觉醒", "成熟成长", "价值观转变", "堕落", "赎罪", "无成长爽剧", "群体成长", "反派成长"] }
    ]
  },
  {
    category: "结构形式",
    items: [
      { label: "结构形式", options: ["单主线", "双线并行", "三线交叉", "群像并行", "单元剧", "副本式", "无限流闯关", "线性叙事", "倒叙", "插叙", "多时间线", "双时空对照", "时间循环", "碎片化叙事", "高反转密度"] }
    ]
  },
  {
    category: "节奏密度",
    items: [
      { label: "节奏密度", options: ["慢燃", "情绪堆积", "快节奏", "爆点密集", "三分钟一爽点", "五分钟一反转", "情绪过山车", "稳定递增", "高压持续", "低开高走"] }
    ]
  },
  {
    category: "形态",
    items: [
      { label: "形态", options: ["竖屏短剧", "横屏短剧", "网剧", "长剧", "电影", "动画", "漫改", "网文", "游戏改编", "IP宇宙系列"] }
    ]
  },
  {
    category: "IP延展方向",
    items: [
      { label: "IP延展方向", options: ["第二季", "前传", "外传", "配角衍生", "同世界不同主角", "平行宇宙扩展", "游戏副本化", "动画化", "海外改编"] }
    ]
  },
  {
    category: "价值层（思想内核）",
    items: [
      {
        label: "核心命题（Theme）",
        type: "textarea",
        placeholder: "本剧真正讨论的问题是：\n本剧的价值立场是：\n你想观众思考什么？\n\n例：\n在高度资本化社会中，爱情是否还能纯粹？\n在权力结构里，普通人是否只能成为棋子？"
      },
      {
        label: "价值冲突对立轴",
        type: "textarea",
        placeholder: "你必须明确：\n主角代表的价值：\n反派代表的价值：\n两者的本质对立是什么？"
      },
      {
        label: "情绪主轴",
        type: "textarea",
        placeholder: "主体情绪氛围是？\n情绪波形曲线是？\n观众持续体验什么心理状态？\n\n例如：\n轻松爽感 + 阶段性压抑释放\n高压窒息 + 真相揭露快感"
      }
    ]
  },
  {
    category: "人物层（不可标准化的部分）",
    items: [
      {
        label: "主角人格设定",
        type: "textarea",
        placeholder: "他真正害怕什么？\n他最大的缺陷是什么？\n他内心最深执念是什么？\n他隐藏的伤痛是什么？"
      },
      {
        label: "主角独特魅力点",
        type: "textarea",
        placeholder: "他凭什么让观众追？\n是机智？极端冷静？病娇？极端正义？反社会天才？\n但最终需要一句原创定义。"
      },
      {
        label: "反派核心逻辑",
        type: "textarea",
        placeholder: "他为什么相信自己是对的？\n他愿意牺牲什么？\n他和主角的相似点是什么？"
      }
    ]
  },
  {
    category: "结构层（关键原创变量）",
    items: [
      {
        label: "起点事件设计",
        type: "textarea",
        placeholder: "第一幕真正改变命运的具体事件是什么？\n必须具体到场景。"
      },
      {
        label: "中点反转设计",
        type: "textarea",
        placeholder: "哪个资源结构被颠覆？\n哪个秘密被揭开？\n主角获得什么？\n主角失去什么？"
      },
      {
        label: "黑暗时刻",
        type: "textarea",
        placeholder: "主角几乎失去一切的具体事件是什么？\n是否涉及背叛？\n是否涉及牺牲？"
      },
      {
        label: "终极对决形式",
        type: "textarea",
        placeholder: "是智斗？\n是公开揭露？\n是情感崩塌？\n是暴力冲突？\n是结构性胜利？"
      }
    ]
  },
  {
    category: "资源层（不可枚举部分）",
    items: [
      {
        label: "资源流动路径",
        type: "textarea",
        placeholder: "第一阶段谁掌权？\n第二阶段谁反转？\n中点谁掌握信息？\n结局谁真正赢？"
      }
    ]
  },
  {
    category: "世界观深度层",
    items: [
      {
        label: "世界核心规则冲突",
        type: "textarea",
        placeholder: "例如：\n在修真世界里，最强规则是什么？\n在商战世界里，资本运作的真实底层逻辑是什么？\n在官场世界里，潜规则是什么？"
      }
    ]
  },
  {
    category: "商业层不可枚举变量",
    items: [
      {
        label: "差异化卖点（USP）",
        type: "textarea",
        placeholder: "这个故事和市场同类型最大差异是什么？\n如果回答不出来，就容易同质化。"
      },
      {
        label: "标志性场景",
        type: "textarea",
        placeholder: "能剪预告片的场景是什么？\n能出圈的名场面是什么？\n能做传播的台词是什么？"
      }
    ]
  },
  {
    category: "IP战略层",
    items: [
      {
        label: "宇宙扩展核心钩子",
        type: "textarea",
        placeholder: "还有哪些未解谜团？\n还有哪些未揭示势力？\n还有哪些角色可单独成剧？"
      }
    ]
  }
];

const TextareaAutoResize = ({ 
  value, 
  onChange, 
  placeholder, 
  disabled, 
  className,
  isGenerating
}: {
  value: string;
  onChange: (e: ChangeEvent<HTMLTextAreaElement>) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  isGenerating?: boolean;
}) => {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
            if (ref.current) {
              // Only reset height to allow shrinking if not generating or if value is empty to prevent jitter
              if (!isGenerating || !value) {
                ref.current.style.height = 'auto';
              }
              // Set new height based on scrollHeight
              ref.current.style.height = `${ref.current.scrollHeight}px`;
            }
          }, [value, isGenerating]);

  return (
    <textarea
      ref={ref}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      disabled={disabled}
      className={className}
      rows={1}
    />
  );
};

export default function ScriptInputPage() {
  const params = useParams<{ id: string }>();
  const projectId = params.id;
  const router = useRouter();
  
  // UI State
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [isModifying, setIsModifying] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [debugEnabled, setDebugEnabled] = useState(false);
  const [loadDebug, setLoadDebug] = useState({
    startedAt: "",
    finishedAt: "",
    error: "",
    cacheRestored: false,
    apiBase: process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3000/api",
    tokenPresent: false,
  });
  
  // Inputs
  const [selectedModel, setSelectedModel] = useState("gemini-3-pro");

  useEffect(() => {
    if (!projectId) return;
    const key = `script-model-${projectId}`;
    const saved = localStorage.getItem(key);
    if (saved) {
      setSelectedModel(saved);
    }
  }, [projectId]);

  useEffect(() => {
    if (!projectId || !selectedModel) return;
    const key = `script-model-${projectId}`;
    localStorage.setItem(key, selectedModel);
  }, [projectId, selectedModel]);

  useEffect(() => {
    const saved = localStorage.getItem("script-load-debug") === "1";
    setDebugEnabled(saved);
  }, []);

  const [selectedOptions, setSelectedOptions] = useState<Record<string, string[]>>({});
  const [customInputs, setCustomInputs] = useState<Record<string, string>>({});
  const [selectionOrder, setSelectionOrder] = useState<Record<string, string[]>>({});
  const CUSTOM_INPUT_KEY = "___CUSTOM_INPUT___";
  
  const [isOptionsExpanded, setIsOptionsExpanded] = useState(false);
  const [suggestionThinking, setSuggestionThinking] = useState("");
  const [isSuggestionThinkingCollapsed, setIsSuggestionThinkingCollapsed] = useState(true);

  // Script Content State (Replaces Versions)
  const [scriptContent, setScriptContent] = useState("");
  const [scriptThinking, setScriptThinking] = useState("");
  const [isScriptThinkingCollapsed, setIsScriptThinkingCollapsed] = useState(true);

  // Outline State
  const [showOriginalScript, setShowOriginalScript] = useState(false);
  const [showOutline, setShowOutline] = useState(true);
  const [outlineContent, setOutlineContent] = useState("");
  const [outlineThinking, setOutlineThinking] = useState("");
  const [isOutlineThinkingCollapsed, setIsOutlineThinkingCollapsed] = useState(true);
  const [isExtractingOutline, setIsExtractingOutline] = useState(false);
  const [selectedSuggestionMode, setSelectedSuggestionMode] = useState<"suggestion_paid" | "suggestion_traffic" | null>(null);

  // Split Script State
  interface EpisodeVersion {
    id: string;
    name: string;
    content: string;
    thinking: string;
    createdAt: number;
  }

  interface Episode {
    title: string;
    versions: EpisodeVersion[];
    currentVersionId: string;
    userInput: string;
    thinking: string; // For suggestion thinking
    isThinkingCollapsed: boolean;
    isGenerating: boolean;
  }
  type RawEpisode = {
    title?: string;
    content?: string;
    thinking?: string;
    userInput?: string;
    isThinkingCollapsed?: boolean;
    versions?: EpisodeVersion[];
    currentVersionId?: string;
  };
  
  const generateId = () => Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
  const getErrorMessage = (error: unknown) => (error instanceof Error ? error.message : "未知错误");
  
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [expandedEpisodes, setExpandedEpisodes] = useState<Set<number>>(new Set()); // Default all collapsed
  const [isSplittingScript, setIsSplittingScript] = useState(false);
  const [showSplitScript, setShowSplitScript] = useState(true);

  // Sync scriptContent with episodes whenever episodes change (e.g. version switching)
  useEffect(() => {
    if (episodes.length > 0) {
      const newContent = episodes.map(ep => {
        const currentVersion = ep.versions.find(v => v.id === ep.currentVersionId) || ep.versions[0];
        return `${ep.title || ""}\n${currentVersion.content || ""}`;
      }).join("\n\n");
      
      // Only update if content is actually different to avoid unnecessary updates
      // Using a functional update check or just direct comparison if scriptContent is in closure
      // We don't want to depend on scriptContent to avoid reverting manual edits unless episodes change
      setScriptContent(prev => {
        if (prev !== newContent) {
            return newContent;
        }
        return prev;
      });
    }
  }, [episodes]);

  const SEPARATOR = "\n\n=== 原文剧本 (请勿删除此行) ===\n\n";
  const scriptCacheKey = projectId ? `script-cache-${projectId}` : "";
  const resourcesPartRef = useRef<string>("");

  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastSavedContentRef = useRef("");
  const lastSavedThinkingRef = useRef("");
  const lastSavedOutlineRef = useRef("");
  const lastSavedEpisodesRef = useRef<Episode[]>([]);
  const abortControllersRef = useRef<Record<number, AbortController>>({});
  const globalAbortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      if (globalAbortControllerRef.current) {
        globalAbortControllerRef.current.abort();
      }
      Object.values(abortControllersRef.current).forEach(c => c.abort());
    };
  }, []);

  const stopGeneration = () => {
    if (globalAbortControllerRef.current) {
      globalAbortControllerRef.current.abort();
      globalAbortControllerRef.current = null;
      setIsModifying(false);
      setMessage("已停止生成");
    }
  };

  // Initial Data Fetch
  useEffect(() => {
    if (!projectId) {
      setLoading(false);
      setMessage("项目 ID 无效");
      return;
    }
    const token = getToken();
    if (!token) {
      setLoading(false);
      router.push("/login");
      return;
    }

    const fetchData = async () => {
      setLoadDebug((prev) => ({
        ...prev,
        startedAt: new Date().toISOString(),
        finishedAt: "",
        error: "",
        cacheRestored: false,
        tokenPresent: Boolean(token),
      }));
      try {
        const scriptData = await getScript(token, projectId);
        
        // Handle content loading and separation of resources
        let currentContent = scriptData.content ?? "";
        if (currentContent.includes(SEPARATOR)) {
          const parts = currentContent.split(SEPARATOR);
          resourcesPartRef.current = parts[0];
          currentContent = parts.slice(1).join(SEPARATOR);
        } else {
          resourcesPartRef.current = "";
        }

        const currentThinking = scriptData.thinking ?? "";
        lastSavedContentRef.current = currentContent;
        lastSavedThinkingRef.current = currentThinking;
        lastSavedOutlineRef.current = scriptData.outline ?? "";
        
        setScriptContent(currentContent);
        setScriptThinking(currentThinking);
        setIsScriptThinkingCollapsed(true);

        // Always show original script if content exists and episodes are empty
        if (currentContent && (!scriptData.episodes || scriptData.episodes.length === 0)) {
           setShowOriginalScript(true);
        }

        if (scriptData.outline) {
            setOutlineContent(scriptData.outline);
        }

        if (scriptData.episodes && scriptData.episodes.length > 0) {
            const mappedEpisodes = (scriptData.episodes as RawEpisode[]).map((ep, index) => {
                const versions: EpisodeVersion[] = ep.versions && ep.versions.length > 0 
                  ? ep.versions 
                  : [{
                      id: generateId(),
                      name: "原版",
                      content: ep.content || "",
                      thinking: ep.thinking || "",
                      createdAt: Date.now()
                  }];
                
                const currentVersionId = ep.currentVersionId || versions[0].id;
                
                return {
                  title: ep.title || `第${index + 1}集`,
                  versions,
                  currentVersionId,
                  userInput: ep.userInput || "",
                  thinking: ep.thinking || "", // Global suggestion thinking
                  isThinkingCollapsed: ep.isThinkingCollapsed ?? true,
                  isGenerating: false
                };
            });
            setEpisodes(mappedEpisodes);
            lastSavedEpisodesRef.current = mappedEpisodes;
            setShowSplitScript(true);
        } else {
            lastSavedEpisodesRef.current = [];
        }
        setLoadDebug((prev) => ({
          ...prev,
          finishedAt: new Date().toISOString(),
          error: "",
          cacheRestored: false,
        }));
        if (scriptCacheKey) {
          localStorage.setItem(
            scriptCacheKey,
            JSON.stringify({
              content: currentContent,
              thinking: currentThinking,
              outline: scriptData.outline ?? "",
              episodes: scriptData.episodes ?? [],
            })
          );
        }
      } catch (e) {
        let restored = false;
        if (scriptCacheKey) {
          const cached = localStorage.getItem(scriptCacheKey);
          if (cached) {
            try {
              const parsed = JSON.parse(cached) as {
                content?: string;
                thinking?: string;
                outline?: string;
                episodes?: Episode[];
              };
              setScriptContent(parsed.content ?? "");
              setScriptThinking(parsed.thinking ?? "");
              setOutlineContent(parsed.outline ?? "");
              if (Array.isArray(parsed.episodes) && parsed.episodes.length > 0) {
                setEpisodes(parsed.episodes);
                setShowSplitScript(true);
              }
              restored = true;
            } catch {
              restored = false;
            }
          }
        }
        if (restored) {
          setMessage("远端加载失败，已恢复本地缓存");
          setLoadDebug((prev) => ({
            ...prev,
            finishedAt: new Date().toISOString(),
            error: e instanceof Error ? e.message : "加载失败",
            cacheRestored: true,
          }));
        } else {
          const errorMessage = e instanceof Error ? e.message : "加载失败";
          setMessage(errorMessage);
          setLoadDebug((prev) => ({
            ...prev,
            finishedAt: new Date().toISOString(),
            error: errorMessage,
            cacheRestored: false,
          }));
        }
        console.error("Fetch failed", e);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [projectId]);

  useEffect(() => {
    if (!projectId || loading || !scriptCacheKey) return;
    localStorage.setItem(
      scriptCacheKey,
      JSON.stringify({
        content: scriptContent,
        thinking: scriptThinking,
        outline: outlineContent,
        episodes,
      })
    );
  }, [projectId, loading, scriptCacheKey, scriptContent, scriptThinking, outlineContent, episodes]);

  // Auto-save
  useEffect(() => {
    if (loading || !projectId) return;
    
    const episodesChanged = JSON.stringify(episodes) !== JSON.stringify(lastSavedEpisodesRef.current);

    if (scriptContent === lastSavedContentRef.current && 
        scriptThinking === lastSavedThinkingRef.current && 
        outlineContent === lastSavedOutlineRef.current &&
        !episodesChanged) return;

    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    saveTimeoutRef.current = setTimeout(async () => {
      const token = getToken();
      if (!token) return;
      
      try {
        let finalContent = scriptContent;
        if (resourcesPartRef.current) {
          finalContent = resourcesPartRef.current + SEPARATOR + scriptContent;
        }
        const episodesToSave: ScriptEpisodePayload[] = episodes.map(({ isGenerating, ...rest }) => rest);
        
        await saveScript(token, projectId, finalContent, scriptThinking, undefined, outlineContent, episodesToSave);
        
        lastSavedContentRef.current = scriptContent;
        lastSavedThinkingRef.current = scriptThinking || "";
        lastSavedOutlineRef.current = outlineContent || "";
        lastSavedEpisodesRef.current = episodes;
        setMessage("已自动保存");
      } catch (e) {
        console.error("Auto-save failed", e);
      }
    }, 2000);

    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, [scriptContent, scriptThinking, outlineContent, episodes, projectId, loading]);

  const save = async () => {
    if (!projectId) return;
    const token = getToken();
    if (!token) return;
    
    try {
      let finalContent = scriptContent;
      if (resourcesPartRef.current) {
        finalContent = resourcesPartRef.current + SEPARATOR + finalContent;
      }
      
      // Filter out UI-only fields from episodes before saving
      const episodesToSave: ScriptEpisodePayload[] = episodes.map(({ isGenerating, ...rest }) => {
        // Ensure content is populated from current version for downstream consumption (e.g. Step 4)
        const currentVersion = rest.versions.find(v => v.id === rest.currentVersionId) || rest.versions[0];
        return {
          ...rest,
          content: currentVersion ? currentVersion.content : ""
        };
      });
      
      await saveScript(token, projectId, finalContent, scriptThinking, undefined, outlineContent, episodesToSave);
      lastSavedContentRef.current = scriptContent;
      lastSavedThinkingRef.current = scriptThinking || "";
      lastSavedOutlineRef.current = outlineContent || "";
      lastSavedEpisodesRef.current = episodes;
      setMessage("已保存");
    } catch {
      setMessage("保存失败");
    }
  };

  const handleUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    if (!projectId) return;
    const token = getToken();
    if (!token) return;
    const file = event.target.files?.[0];
    if (!file) return;

    const lowerName = file.name.toLowerCase();
    const isDocx = lowerName.endsWith(".docx");
    const isTxt = lowerName.endsWith(".txt");

    if (!isTxt && !isDocx) {
      setMessage("仅支持 .txt 或 .docx");
      event.target.value = "";
      return;
    }

    setUploading(true);
    try {
      let text = "";
      if (isDocx) {
        const mammoth = await import("mammoth");
        const arrayBuffer = await file.arrayBuffer();
        const result = await mammoth.extractRawText({ arrayBuffer });
        text = result.value;
      } else {
        text = await file.text();
      }
      
      setScriptContent(text);
      await saveScript(token, projectId, text);
      setMessage("已导入");
    } catch {
      setMessage("导入失败");
    } finally {
      setUploading(false);
      event.target.value = "";
    }
  };

  const toggleOption = (label: string, option: string) => {
    setSelectedOptions((prev) => {
      const current = prev[label] || [];
      if (current.includes(option)) {
        return { ...prev, [label]: current.filter((item) => item !== option) };
      } else {
        return { ...prev, [label]: [...current, option] };
      }
    });

    setSelectionOrder((prev) => {
      const current = prev[label] || [];
      if (current.includes(option)) {
        return { ...prev, [label]: current.filter((item) => item !== option) };
      } else {
        return { ...prev, [label]: [...current, option] };
      }
    });
  };

  const handleCustomInputChange = (label: string, value: string) => {
    setCustomInputs((prev) => ({ ...prev, [label]: value }));

    setSelectionOrder((prev) => {
      const current = prev[label] || [];
      const hasCustom = current.includes(CUSTOM_INPUT_KEY);
      const isNotEmpty = value.trim().length > 0;

      if (isNotEmpty && !hasCustom) {
        return { ...prev, [label]: [...current, CUSTOM_INPUT_KEY] };
      } else if (!isNotEmpty && hasCustom) {
        return { ...prev, [label]: current.filter((item) => item !== CUSTOM_INPUT_KEY) };
      }
      return prev;
    });
  };

  const getFormattedInstruction = () => {
    let formattedText = "";
    scriptOptions.forEach((category) => {
      const activeItems = category.items.map((item) => {
        const orderList = selectionOrder[item.label] || [];
        if (orderList.length === 0) return null;
        const valuedString = orderList.map((v, i) => {
          const actualValue = v === CUSTOM_INPUT_KEY ? customInputs[item.label] : v;
          if (!actualValue) return null;
          return i === 0 ? `${actualValue}(主)` : `${actualValue}(辅)`;
        }).filter(Boolean).join(", ");
        if (!valuedString) return null;
        return `-${item.label}：${valuedString}`;
      }).filter(Boolean);

      if (activeItems.length > 0) {
        formattedText += `${category.category}\n${activeItems.join("\n")}\n`;
      }
    });
    return formattedText.trim();
  };

  const handleExtractOutline = async () => {
    if (!projectId) return;
    const token = getToken();
    if (!token) {
      router.push("/login");
      return;
    }

    setIsExtractingOutline(true);
    setOutlineContent(""); // Clear existing
    setOutlineThinking(""); // Clear existing thinking
    setIsOutlineThinkingCollapsed(false); // Expand initially
    setShowOutline(true);
    setMessage("AI 正在提炼大纲...");

    const abortController = new AbortController();
    globalAbortControllerRef.current = abortController;

    let hasCollapsedThinking = false;

    try {
      await generateScriptStream(token, projectId, {
        mode: "extract_outline",
        content: scriptContent,
        model: selectedModel,
        instruction: "",
      }, (chunk) => {
        const delta = chunk.choices?.[0]?.delta;
        if (delta?.reasoning_content) {
          setOutlineThinking(prev => prev + delta.reasoning_content);
        }
        if (delta?.content) {
          if (!hasCollapsedThinking) {
             setIsOutlineThinkingCollapsed(true);
             hasCollapsedThinking = true;
          }
          setOutlineContent(prev => prev + delta.content);
        }
      }, abortController.signal);
      
      setMessage("大纲提炼完成");
    } catch (error: unknown) {
      if (error instanceof Error && error.name === "AbortError") {
        setMessage("提炼已取消");
      } else {
        setMessage(`提炼失败: ${getErrorMessage(error)}`);
      }
    } finally {
      setIsExtractingOutline(false);
      globalAbortControllerRef.current = null;
    }
  };

  const updateEpisodeInput = (index: number, value: string) => {
    setEpisodes(prev => {
       const newEpisodes = [...prev];
       if (newEpisodes[index]) {
          newEpisodes[index] = { ...newEpisodes[index], userInput: value };
       }
       return newEpisodes;
    });
  };

  const toggleEpisodeThinking = (index: number) => {
     setEpisodes(prev => {
        const newEpisodes = [...prev];
        if (newEpisodes[index]) {
           newEpisodes[index] = { 
              ...newEpisodes[index], 
              isThinkingCollapsed: !newEpisodes[index].isThinkingCollapsed 
           };
        }
        return newEpisodes;
     });
  };

  const handleEpisodeModify = async (index: number, source: "mode" | "custom") => {
     if (!projectId) return;
     const token = getToken();
     if (!token) {
       router.push("/login");
       return;
     }
     
     const episode = episodes[index];
     if (!episode || episode.isGenerating) return;

     // Validation for AI Modify button
     if (source === "mode" && !selectedSuggestionMode) {
       setMessage("请先在“基础设定”中选择“用户付费型”或“流量爆款型”");
        // Clear message after 3 seconds
        setTimeout(() => setMessage(null), 3000);
        return;
     }

     const currentInput = episode.userInput;

     // Set generating state and clear input for output
     setEpisodes(prev => {
        const newEpisodes = [...prev];
        if (newEpisodes[index]) {
           newEpisodes[index] = { 
              ...newEpisodes[index], 
              isGenerating: true,
              thinking: "",
              isThinkingCollapsed: true 
           };
        }
        return newEpisodes;
     });
     
     // Determine prompt
     let instruction = "";
     const formattedOptions = getFormattedInstruction();
     
     if (source === "custom") {
        instruction = formattedOptions 
           ? `【用户高级设定】\n${formattedOptions}\n\n【用户指令】\n${currentInput}`
           : `【用户指令】\n${currentInput}`;
     } else {
        instruction = formattedOptions 
           ? `请根据以下配置参数，为当前剧本分集提供修改建议：\n\n${formattedOptions}`
           : "请为当前剧本分集提供修改建议：";
     }
     
     // Construct Content: Outline + Episode Content
     const currentVersion = episode.versions.find(v => v.id === episode.currentVersionId) || episode.versions[0];
     const contextContent = `【剧本大纲】\n${outlineContent}\n\n【当前分集】\n${currentVersion.content}`;
     
     // Mode
     const mode = source === "custom" ? "step0_modify" : (selectedSuggestionMode || "suggestion_paid");

     const abortController = new AbortController();
     abortControllersRef.current[index] = abortController;

     let thinkingBuffer = "";

     // If source is custom, prepare new version
     let targetVersionId = episode.currentVersionId;
     if (source === "custom") {
        const newVersionId = generateId();
        targetVersionId = newVersionId;
        
        setEpisodes(prev => {
           const newEpisodes = [...prev];
           if (newEpisodes[index]) {
              const currentEp = { ...newEpisodes[index] };
              const newVersion: EpisodeVersion = {
                  id: newVersionId,
                  name: `修改版 ${currentEp.versions.length}`, // Version name
                  content: "",
                  thinking: "",
                  createdAt: Date.now()
              };
              currentEp.versions = [...currentEp.versions, newVersion];
              currentEp.currentVersionId = newVersionId;
              currentEp.isGenerating = true;
              currentEp.userInput = ""; // Clear input for custom mode
              newEpisodes[index] = currentEp;
           }
           return newEpisodes;
        });
     }

     try {
        await generateScriptStream(token, projectId, {
           mode: mode,
           content: contextContent,
           model: selectedModel,
           instruction: instruction
        }, (chunk) => {
           const reasoning = chunk.choices?.[0]?.delta?.reasoning_content;
           const content = chunk.choices?.[0]?.delta?.content;

           if (reasoning) {
              thinkingBuffer += reasoning;
           }

           setEpisodes(prev => {
              const newEpisodes = [...prev];
              if (!newEpisodes[index]) return newEpisodes;

              const currentEp = { ...newEpisodes[index] };
              
              if (source === "custom") {
                  // Update specific version
                  currentEp.versions = currentEp.versions.map(v => {
                      if (v.id === targetVersionId) {
                          return {
                              ...v,
                              thinking: thinkingBuffer,
                              content: v.content + (content || "")
                          };
                      }
                      return v;
                  });
              } else {
                  // Suggestion Mode: Update episode thinking and userInput
                  currentEp.thinking = thinkingBuffer;
                  if (content) {
                     currentEp.userInput += content;
                  }
              }
              
              newEpisodes[index] = currentEp;
              return newEpisodes;
           });
        }, abortController.signal);
     } catch (e: unknown) {
        if (!(e instanceof Error && e.name === "AbortError")) {
           setMessage(`生成失败: ${getErrorMessage(e)}`);
        }
     } finally {
        setEpisodes(prev => {
           const newEpisodes = [...prev];
           if (newEpisodes[index]) {
              newEpisodes[index] = { ...newEpisodes[index], isGenerating: false };
           }
           return newEpisodes;
        });
        delete abortControllersRef.current[index];
     }
  };

  const handleSplitScript = async () => {
    if (!projectId) return;
    const currentScript = scriptContent;
    if (!currentScript) {
      setMessage("暂无剧本内容");
      return;
    }

    setIsSplittingScript(true);
    setEpisodes([]); // Clear existing
    setShowSplitScript(true);

    // 1. Try regex splitting first
    // Extremely loose regex to ensure we catch all episodes regardless of what follows
    // Matches "第x集" or "EPx" at start of line (or after newline)
    // Does NOT enforce separators (colon, etc.) to avoid missing episodes with weird suffixes
    const episodePattern = "(?:^|[\\r\\n]+)\\s*(第\\s*[0-9一二三四五六七八九十百零]+\\s*集|(?:EP|Ep|ep|Episode)\\s*\\d+)";
    const matchRegex = new RegExp(episodePattern, 'gi');
    
    // Check if we have any occurrences
    const matches = currentScript.match(matchRegex);
    console.log("Split Script - Matches found:", matches);
    
    if (matches && matches.length > 0) {
       // Regex split successful
       // Use capturing group in regex to keep the delimiters (episode titles) in the result
       const splitParts = currentScript.split(new RegExp(episodePattern, 'i'));
       console.log("Split Script - Split parts count:", splitParts.length);
       
       const newEpisodes: Episode[] = [];
       
       // splitParts structure: 
       // [preamble, title1, content1, title2, content2, ...]
       // We start from i=1 to skip potential preamble (text before first episode marker)
       for (let i = 1; i < splitParts.length; i += 2) {
          const title = splitParts[i];
          let content = splitParts[i+1] || "";
          
          // Clean up leading separators (colon, dot, whitespace) from content
          // This handles cases like "第一集：内容" where the colon was not consumed by regex
          content = content.replace(/^[:：.\s\t]+/, "");

          if (content.trim()) {
             const cleanContent = content.trim();
             const initialVersion: EpisodeVersion = {
               id: generateId(),
               name: "原版",
               content: cleanContent,
               thinking: "",
               createdAt: Date.now()
             };
             
             newEpisodes.push({ 
               title, 
               versions: [initialVersion],
               currentVersionId: initialVersion.id,
               userInput: "",
               thinking: "",
               isThinkingCollapsed: true,
               isGenerating: false
             });
          }
       }
       
       if (newEpisodes.length > 0) {
          console.log("Split Script - Successfully split into episodes:", newEpisodes.length);
          setEpisodes(newEpisodes);
          setExpandedEpisodes(new Set());
          setIsSplittingScript(false);
          setMessage("分集已完成 (本地拆分)");
          return;
       }
    }

    // 2. If regex fails (or only 1 episode found), call AI
    const token = getToken();
    if (!token) {
      router.push("/login");
      return;
    }

    setMessage("AI 正在拆分剧本...");
    const abortController = new AbortController();
    globalAbortControllerRef.current = abortController;

    let fullContent = "";

    try {
      await generateScriptStream(token, projectId, {
        mode: "split_script", 
        content: currentScript,
        model: selectedModel,
        instruction: "",
      }, (chunk) => {
        if (chunk.choices?.[0]?.delta?.content) {
          fullContent += chunk.choices[0].delta.content;
        }
      }, abortController.signal);
      
      // Parse fullContent
      const aiMatches = fullContent.match(matchRegex);
      if (aiMatches && aiMatches.length > 0) {
         const splitParts = fullContent.split(new RegExp(episodePattern, 'i'));
         const newEpisodes: Episode[] = [];
         for (let i = 1; i < splitParts.length; i += 2) {
            const title = splitParts[i];
            const content = splitParts[i+1] || "";
             const cleanContent = content.trim();
             const initialVersion: EpisodeVersion = {
               id: generateId(),
               name: "原版",
               content: cleanContent,
               thinking: "",
               createdAt: Date.now()
             };
             
             newEpisodes.push({ 
               title, 
               versions: [initialVersion],
               currentVersionId: initialVersion.id,
               userInput: "",
               thinking: "",
               isThinkingCollapsed: true,
               isGenerating: false
            });
         }
         setEpisodes(newEpisodes);
         setExpandedEpisodes(new Set());
         setMessage("分集已完成");
      } else {
         // Fallback if AI didn't output standard format
         const initialVersion: EpisodeVersion = {
            id: generateId(),
            name: "原版",
            content: fullContent,
            thinking: "",
            createdAt: Date.now()
         };
         
         setEpisodes([{ 
            title: "全集", 
            versions: [initialVersion],
            currentVersionId: initialVersion.id,
            userInput: "",
            thinking: "",
            isThinkingCollapsed: true,
            isGenerating: false
         }]);
         setExpandedEpisodes(new Set());
         setMessage("分集完成 (未识别到明确分集标记)");
      }

    } catch (error: unknown) {
      if (error instanceof Error && error.name === "AbortError") {
        setMessage("拆分已取消");
      } else {
        setMessage(`拆分失败: ${getErrorMessage(error)}`);
      }
    } finally {
      setIsSplittingScript(false);
      globalAbortControllerRef.current = null;
    }
  };

  const handleNext = async () => {
    await save();
    router.push(`/projects/${projectId}/script/resources`);
  };

  return (
    <div className="space-y-6">
      <div className="sticky top-0 z-40 flex items-center justify-between bg-white py-4 shadow-sm -mx-6 px-6">
        <h1 className="text-2xl font-semibold">Step 1: 修改剧本</h1>
        <div className="flex gap-3">
          <button
            onClick={() => {
              const next = !debugEnabled;
              setDebugEnabled(next);
              localStorage.setItem("script-load-debug", next ? "1" : "0");
            }}
            className={`rounded-lg border px-3 py-2 text-xs ${debugEnabled ? "border-amber-300 bg-amber-50 text-amber-700" : "border-slate-200 text-slate-600 hover:bg-slate-50"}`}
          >
            调试{debugEnabled ? "开" : "关"}
          </button>
          <label className="cursor-pointer rounded-lg border border-slate-200 px-4 py-2 text-sm hover:bg-slate-50">
            {uploading ? "导入中..." : "导入剧本 (.txt / .docx)"}
            <input
              type="file"
              accept=".txt,.docx"
              className="hidden"
              onChange={handleUpload}
              disabled={uploading}
            />
          </label>
          <button
            onClick={save}
            className="rounded-lg border border-slate-200 px-4 py-2 text-sm hover:bg-slate-50"
          >
            保存
          </button>
          <button
            onClick={handleNext}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm text-white hover:bg-slate-800"
          >
            下一步：提取资源
          </button>
        </div>
      </div>

      {debugEnabled ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {`projectId=${projectId || "N/A"} | api=${loadDebug.apiBase} | token=${loadDebug.tokenPresent ? "yes" : "no"} | start=${loadDebug.startedAt || "-"} | end=${loadDebug.finishedAt || "-"} | cache=${loadDebug.cacheRestored ? "yes" : "no"} | error=${loadDebug.error || "-"}`}
        </div>
      ) : null}

      {loading ? (
        <div>加载中...</div>
      ) : (
        <div className="space-y-4">
          {/* Original Script Section */}
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between">
               <h3 className="font-semibold text-slate-900">原文剧本</h3>
               <div className="flex items-center gap-2">
                 <button 
                   onClick={handleExtractOutline}
                   disabled={isExtractingOutline || !scriptContent}
                   className="rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-1 text-xs text-indigo-700 hover:bg-indigo-100 disabled:opacity-50 transition-colors"
                 >
                   {isExtractingOutline ? "提炼中..." : "提炼剧本大纲"}
                 </button>
                 <button 
                   onClick={handleSplitScript}
                   disabled={isSplittingScript || !scriptContent}
                   className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-1 text-xs text-blue-700 hover:bg-blue-100 disabled:opacity-50 transition-colors"
                 >
                   {isSplittingScript ? "拆分中..." : "剧本分集"}
                 </button>
                 <button 
                   onClick={() => setShowOriginalScript(!showOriginalScript)}
                   className="text-xs text-slate-500 hover:text-slate-700"
                 >
                   {showOriginalScript ? "收起" : "展开"}
                 </button>
               </div>
            </div>
            
            {showOriginalScript && (
               <textarea
                  value={scriptContent}
                  onChange={(e) => setScriptContent(e.target.value)}
                  className="mt-3 w-full p-3 bg-slate-50 rounded-lg text-sm text-slate-700 whitespace-pre-wrap border border-slate-100 min-h-[300px] focus:outline-none focus:border-indigo-500 resize-y"
                  placeholder="在此输入剧本内容..."
               />
            )}

            {/* Outline Display */}
            {(outlineContent || outlineThinking || isExtractingOutline) && (
               <div className="mt-4 border-t border-slate-100 pt-3">
                  <div className="flex items-center justify-between mb-2">
                     <h4 className="font-medium text-slate-800 text-sm">剧本大纲</h4>
                     <button 
                       onClick={() => setShowOutline(!showOutline)}
                       className="text-xs text-slate-500 hover:text-slate-700"
                     >
                       {showOutline ? "收起" : "展开"}
                     </button>
                  </div>

                  {showOutline && (
                    <>
                      {outlineThinking && (
                        <div className="rounded-lg bg-amber-50 border border-amber-100 p-3 mb-3">
                          <div 
                            className="flex items-center justify-between mb-2 cursor-pointer"
                            onClick={() => setIsOutlineThinkingCollapsed(!isOutlineThinkingCollapsed)}
                          >
                            <span className="text-xs font-bold text-amber-500 uppercase tracking-wider">AI 思考过程</span>
                            <span className="text-xs text-amber-500">{isOutlineThinkingCollapsed ? "展开" : "收起"}</span>
                          </div>
                          <div className={`text-sm text-slate-600 leading-relaxed font-mono ${isOutlineThinkingCollapsed ? 'line-clamp-2' : ''}`}>
                            {outlineThinking}
                          </div>
                        </div>
                      )}

                      <div className="p-3 bg-white rounded-lg text-sm text-slate-700 whitespace-pre-wrap border border-slate-200">
                         {outlineContent || (isExtractingOutline && !outlineThinking ? "正在提炼..." : "")}
                      </div>
                    </>
                  )}
               </div>
            )}
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
             {/* ... Input Section ... */}
            <div className="mb-3 flex items-center justify-between text-sm font-medium text-slate-900">
              <span>基础设定</span>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setSelectedSuggestionMode(prev => prev === "suggestion_paid" ? null : "suggestion_paid")}
                  className={`rounded-lg border px-3 py-2 text-xs transition-colors disabled:opacity-50 ${
                    selectedSuggestionMode === "suggestion_paid"
                      ? "border-indigo-600 bg-indigo-600 text-white"
                      : "border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100"
                  }`}
                >
                  用户付费型
                </button>
                <button
                  onClick={() => setSelectedSuggestionMode(prev => prev === "suggestion_traffic" ? null : "suggestion_traffic")}
                  className={`rounded-lg border px-3 py-2 text-xs transition-colors disabled:opacity-50 ${
                    selectedSuggestionMode === "suggestion_traffic"
                      ? "border-amber-600 bg-amber-600 text-white"
                      : "border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100"
                  }`}
                >
                  流量爆款型
                </button>
              </div>
            </div>
            <div className="flex flex-col gap-3">
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <button
                  onClick={() => setIsOptionsExpanded(!isOptionsExpanded)}
                  className="flex w-full items-center justify-between text-sm font-medium text-slate-700 hover:text-indigo-600"
                >
                  <span>高级设定 (受众、题材、爽点等)</span>
                  <span>{isOptionsExpanded ? "收起 ▲" : "展开 ▼"}</span>
                </button>

                {isOptionsExpanded && (
                  <div className="mt-4 space-y-6 border-t border-slate-200 pt-4 max-h-[400px] overflow-y-auto">
                    {scriptOptions.map((category) => (
                      <div key={category.category}>
                        <div className="mb-3 font-semibold text-indigo-900">{category.category}</div>
                        <div className="space-y-4 pl-2">
                          {category.items.map((item) => (
                            <div key={item.label}>
                              <div className="mb-2 text-xs font-medium text-slate-500">{item.label}</div>
                              {"options" in item && item.options && (
                                <div className="flex flex-wrap gap-2 mb-2">
                                  {item.options.map((option) => {
                                    const orderList = selectionOrder[item.label] || [];
                                    const orderIndex = orderList.indexOf(option);
                                    const isSelected = orderIndex !== -1;
                                    const isMain = orderIndex === 0;

                                    return (
                                      <button
                                        key={option}
                                        onClick={() => toggleOption(item.label, option)}
                                        className={`relative rounded-full border px-3 py-1 text-xs transition-colors ${
                                          isSelected
                                            ? "border-indigo-600 bg-indigo-600 text-white pr-6"
                                            : "border-slate-200 bg-white text-slate-600 hover:border-indigo-300"
                                        }`}
                                      >
                                        {option}
                                        {isSelected && (
                                          <span className="absolute -top-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-amber-400 text-[10px] font-bold text-white shadow-sm ring-1 ring-white">
                                            {isMain ? "主" : "辅"}
                                          </span>
                                        )}
                                      </button>
                                    );
                                  })}
                                </div>
                              )}
                              <div className="relative w-full mt-1">
                                {"type" in item && item.type === "textarea" ? (
                                  <textarea
                                    placeholder={item.placeholder}
                                    value={customInputs[item.label] || ""}
                                    onChange={(e) => handleCustomInputChange(item.label, e.target.value)}
                                    rows={4}
                                    className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 outline-none focus:border-indigo-500 placeholder:text-slate-400"
                                  />
                                ) : (
                                  <input
                                    type="text"
                                    placeholder="其他 / 补充说明 (选填)"
                                    value={customInputs[item.label] || ""}
                                    onChange={(e) => handleCustomInputChange(item.label, e.target.value)}
                                    className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 outline-none focus:border-indigo-500"
                                  />
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              
              {/* Suggestion Thinking Section */}
              {suggestionThinking && (
                <div className="rounded-lg bg-amber-50 border border-amber-100 p-3 mb-3">
                  <div 
                    className="flex items-center justify-between mb-2 cursor-pointer"
                    onClick={() => setIsSuggestionThinkingCollapsed(!isSuggestionThinkingCollapsed)}
                  >
                    <span className="text-xs font-bold text-amber-500 uppercase tracking-wider">AI 思考过程</span>
                    <span className="text-xs text-amber-500">{isSuggestionThinkingCollapsed ? "展开" : "收起"}</span>
                  </div>
                  <div className={`text-sm text-slate-600 leading-relaxed font-mono ${isSuggestionThinkingCollapsed ? 'line-clamp-2' : ''}`}>
                    {suggestionThinking}
                  </div>
                </div>
              )}

              {/* Script Modification Thinking Section */}
              {scriptThinking && (
                <div className="rounded-lg bg-indigo-50 border border-indigo-100 p-3 mb-3">
                  <div 
                    className="flex items-center justify-between mb-2 cursor-pointer"
                    onClick={() => setIsScriptThinkingCollapsed(!isScriptThinkingCollapsed)}
                  >
                    <span className="text-xs font-bold text-indigo-500 uppercase tracking-wider">AI 思考过程 (修改)</span>
                    <span className="text-xs text-indigo-500">{isScriptThinkingCollapsed ? "展开" : "收起"}</span>
                  </div>
                  <div className={`text-sm text-slate-600 leading-relaxed font-mono ${isScriptThinkingCollapsed ? 'line-clamp-2' : ''}`}>
                    {scriptThinking}
                  </div>
                </div>
              )}

            </div>
          </div>

          {/* Split Script Display */}
          {(showSplitScript && (episodes.length > 0 || isSplittingScript)) && (
             <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                <div className="flex items-center justify-between mb-4">
                   <h3 className="font-semibold text-slate-900">剧本分集</h3>
                   <button 
                     onClick={() => setShowSplitScript(false)}
                     className="text-xs text-slate-500 hover:text-slate-700"
                   >
                     收起
                   </button>
                </div>
                
                {isSplittingScript && episodes.length === 0 && (
                   <div className="text-sm text-slate-500 py-4 text-center">正在进行剧本分集...</div>
                )}

                <div className="space-y-4">
                   {episodes.map((episode, index) => {
                      const isExpanded = expandedEpisodes.has(index);
                      const currentVersion = episode.versions.find(v => v.id === episode.currentVersionId) || episode.versions[0];
                      // Use version thinking if available, otherwise fallback to episode thinking (suggestions)
                      const displayThinking = currentVersion.thinking || episode.thinking;
                      
                      return (
                      <div key={index} className="rounded-lg border border-slate-200 bg-slate-50 overflow-hidden">
                         <div 
                           className="bg-slate-100 px-3 py-2 border-b border-slate-200 flex justify-between items-center cursor-pointer hover:bg-slate-200 transition-colors"
                           onClick={() => {
                              const newSet = new Set(expandedEpisodes);
                              if (isExpanded) {
                                 newSet.delete(index);
                              } else {
                                 newSet.add(index);
                              }
                              setExpandedEpisodes(newSet);
                           }}
                         >
                            <span className="font-medium text-sm text-slate-700">{episode.title || `第 ${index + 1} 集`}</span>
                            <div className="flex items-center gap-3">
                                {isExpanded && episode.versions.length > 1 && (
                                    <div className="flex bg-white rounded-md border border-slate-200 p-0.5" onClick={(e) => e.stopPropagation()}>
                                        {episode.versions.map((v) => (
                                            <button
                                                key={v.id}
                                                onClick={() => {
                                                    setEpisodes(prev => {
                                                        const newEpisodes = [...prev];
                                                        if (newEpisodes[index]) {
                                                            newEpisodes[index] = { ...newEpisodes[index], currentVersionId: v.id };
                                                        }
                                                        return newEpisodes;
                                                    });
                                                }}
                                                className={`px-2 py-0.5 text-xs rounded transition-colors ${
                                                    episode.currentVersionId === v.id 
                                                    ? "bg-indigo-100 text-indigo-700 font-medium" 
                                                    : "text-slate-500 hover:text-slate-700 hover:bg-slate-50"
                                                }`}
                                            >
                                                {v.name}
                                            </button>
                                        ))}
                                    </div>
                                )}
                                <span className="text-xs text-slate-500">{isExpanded ? "收起" : "展开"}</span>
                            </div>
                         </div>
                         {isExpanded && (
                            <div className="p-3">
                               {/* Thinking Section */}
                               {displayThinking && (
                                 <div className="rounded-lg bg-amber-50 border border-amber-100 p-3 mb-3">
                                   <div 
                                     className="flex items-center justify-between mb-2 cursor-pointer"
                                     onClick={() => toggleEpisodeThinking(index)}
                                   >
                                     <span className="text-xs font-bold text-amber-500 uppercase tracking-wider">AI 思考过程</span>
                                     <span className="text-xs text-amber-500">{episode.isThinkingCollapsed ? "展开" : "收起"}</span>
                                   </div>
                                   <div className={`text-sm text-slate-600 leading-relaxed font-mono ${episode.isThinkingCollapsed ? 'hidden' : ''}`}>
                                     {displayThinking}
                                   </div>
                                 </div>
                               )}

                               <div className="w-full bg-transparent text-sm text-slate-700 whitespace-pre-wrap min-h-[100px] mb-4">
                             {currentVersion.content}
                           </div>

                               {/* Input Box */}
                               <div className="relative">
                                 <TextareaAutoResize
                                   value={episode.userInput}
                                   onChange={(e) => updateEpisodeInput(index, e.target.value)}
                                   className="w-full p-3 bg-white rounded-lg text-sm text-slate-700 border border-slate-200 focus:outline-none focus:border-indigo-500 resize-none overflow-hidden min-h-[80px]"
                                   placeholder="在此输入指令，或查看 AI 修改建议..."
                                   isGenerating={episode.isGenerating}
                                 />
                                 {episode.isGenerating && (
                                    <div className="absolute right-3 bottom-3 text-xs text-slate-400 animate-pulse">
                                       生成中...
                                    </div>
                                 )}
                               </div>

                               {/* Buttons */}
                               <div className="flex justify-end gap-2 mt-2">
                                 <button
                                   onClick={() => {
                                      if (episode.isGenerating) {
                                         abortControllersRef.current[index]?.abort();
                                      } else {
                                         handleEpisodeModify(index, "mode");
                                      }
                                   }}
                                   className={`px-3 py-1.5 text-white text-xs rounded transition-colors ${
                                      episode.isGenerating 
                                      ? "bg-slate-400 hover:bg-slate-500" 
                                      : "bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50"
                                   }`}
                                 >
                                   {episode.isGenerating ? "取消" : "AI 修改"}
                                 </button>
                                 <button
                                   onClick={() => handleEpisodeModify(index, "custom")}
                                   disabled={episode.isGenerating || !episode.userInput.trim()}
                                   className="px-3 py-1.5 bg-slate-800 text-white text-xs rounded hover:bg-slate-900 disabled:opacity-50 transition-colors"
                                 >
                                   发送
                                 </button>
                               </div>
                            </div>
                         )}
                      </div>
                      );
                   })}
                </div>
             </div>
          )}


        </div>
      )}

      {message && (
        <div className="fixed bottom-6 left-1/2 transform -translate-x-1/2 bg-slate-800 text-white px-6 py-3 rounded-full shadow-lg z-50 text-sm font-medium animate-in fade-in slide-in-from-bottom-4">
          {message}
        </div>
      )}
    </div>
  );
}
