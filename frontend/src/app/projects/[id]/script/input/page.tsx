"use client";

import { useEffect, useState, useRef, type ChangeEvent } from "react";
import { useParams, useRouter } from "next/navigation";
import { getScript, saveScript, generateScript, generateScriptStream, type ScriptGeneratePayload, getScriptHistory, type ScriptHistoryItem } from "@/lib/api";
import { getToken } from "@/lib/auth";
import AIContinuationModal from "./AIContinuationModal";

// ... (keep scriptOptions as is, it's long and static)
// I will include scriptOptions in the replacement if I can match the whole file or just the component.
// Since the file is truncated in read, I will use a marker to keep scriptOptions if possible, or just copy it back if I have it.
// I have scriptOptions from the previous Read. I will include it to be safe.

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

interface ScriptVersion {
  id: string;
  content: string;
  thinking: string;
  isThinkingCollapsed: boolean;
  isCollapsed: boolean;
  timestamp: number;
  label: string;
}

export default function ScriptInputPage() {
  const params = useParams<{ id: string }>();
  const projectId = params.id;
  const router = useRouter();
  
  // UI State
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [isModifying, setIsModifying] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  
  // Inputs
  const [instruction, setInstruction] = useState("");
  const [selectedModel, setSelectedModel] = useState("doubao-pro");
  const [selectedOptions, setSelectedOptions] = useState<Record<string, string[]>>({});
  const [customInputs, setCustomInputs] = useState<Record<string, string>>({});
  const [selectionOrder, setSelectionOrder] = useState<Record<string, string[]>>({});
  const CUSTOM_INPUT_KEY = "___CUSTOM_INPUT___";
  
  const [isOptionsExpanded, setIsOptionsExpanded] = useState(false);
  const [isContinuationModalOpen, setIsContinuationModalOpen] = useState(false);
  const [suggestionThinking, setSuggestionThinking] = useState("");
  const [isSuggestionThinkingCollapsed, setIsSuggestionThinkingCollapsed] = useState(true);

  // Versions Management
  const [versions, setVersions] = useState<ScriptVersion[]>([]);
  
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastSavedContentRef = useRef("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight + 2}px`;
    }
  }, [instruction]);

  const stopGeneration = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
      setIsModifying(false);
      setMessage("已停止生成");
    }
  };

  // Initial Data Fetch
  useEffect(() => {
    if (!projectId) return;
    const token = getToken();
    if (!token) {
      router.push("/login");
      return;
    }

    const fetchData = async () => {
      try {
        const [scriptData, historyData] = await Promise.all([
          getScript(token, projectId).catch(() => ({ content: "", id: null })),
          getScriptHistory(token, projectId).catch(() => ({ items: [] }))
        ]);

        const currentContent = scriptData.content ?? "";
        lastSavedContentRef.current = currentContent;

        const historyVersions: ScriptVersion[] = historyData.items.map((h: any) => ({
          id: h.id,
          content: h.content,
          thinking: "",
          isThinkingCollapsed: true,
          isCollapsed: true,
          timestamp: new Date(h.created_at).getTime(),
          label: `Version ${h.version}`
        }));

        // Combine current and history
        // If current content matches the latest history, we might duplicate? 
        // For simplicity, always create a "Current Draft" version at top.
        // Or if history exists, treat history[0] as previous, and current as active.
        
        const initialVersions = [
          {
            id: "current",
            content: currentContent,
            thinking: "",
            isThinkingCollapsed: true,
            isCollapsed: false,
            timestamp: Date.now(),
            label: historyVersions.length > 0 ? `Version ${historyVersions.length + 1} (Current)` : "Version 1 (Current)"
          },
          ...historyVersions
        ];
        
        setVersions(initialVersions);
      } catch (e) {
        console.error("Fetch failed", e);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [projectId]);

  // Auto-save active version
  useEffect(() => {
    if (loading || !projectId || versions.length === 0) return;
    
    const activeContent = versions[0].content;
    if (activeContent === lastSavedContentRef.current) return;

    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    saveTimeoutRef.current = setTimeout(async () => {
      const token = getToken();
      if (!token) return;
      
      try {
        await saveScript(token, projectId, activeContent);
        lastSavedContentRef.current = activeContent;
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
  }, [versions, projectId, loading]);

  const save = async () => {
    if (!projectId || versions.length === 0) return;
    const token = getToken();
    if (!token) return;
    
    try {
      await saveScript(token, projectId, versions[0].content);
      lastSavedContentRef.current = versions[0].content;
      setMessage("已保存");
      // Optional: Refresh history?
    } catch (error) {
      setMessage("保存失败");
    }
  };

  const handleUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    // ... (keep existing upload logic, update versions[0])
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
        // @ts-ignore
        const mammoth = await import("mammoth");
        const arrayBuffer = await file.arrayBuffer();
        const result = await mammoth.extractRawText({ arrayBuffer });
        text = result.value;
      } else {
        text = await file.text();
      }
      
      updateActiveVersion(text);
      await saveScript(token, projectId, text);
      setMessage("已导入");
    } catch (error) {
      setMessage("导入失败");
    } finally {
      setUploading(false);
      event.target.value = "";
    }
  };

  // Helper to update active version content
  const updateActiveVersion = (newContent: string) => {
    setVersions(prev => {
      const newVersions = [...prev];
      if (newVersions.length > 0) {
        newVersions[0] = { ...newVersions[0], content: newContent };
      }
      return newVersions;
    });
  };

  // ... (keep toggleOption, handleCustomInputChange, getFormattedInstruction)
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

  const handleModify = async () => {
    if (!projectId || !instruction.trim()) return;
    const token = getToken();
    if (!token) {
      router.push("/login");
      return;
    }

    setIsModifying(true);
    setMessage("AI 修改中...");

    // Create AbortController
    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    let finalInstruction = instruction;
    const formattedOptions = getFormattedInstruction();
    if (formattedOptions) {
      finalInstruction += `\n\n【高级设定】\n`;
      finalInstruction += `${formattedOptions}\n`;
    }

    // Create new version
    const newVersionId = `ver-${Date.now()}`;
    const newVersion: ScriptVersion = {
      id: newVersionId,
      content: "",
      thinking: "",
      isThinkingCollapsed: false,
      isCollapsed: false,
      timestamp: Date.now(),
      label: `Version ${versions.length + 1} (Generating...)`
    };

    // Collapse others
    setVersions(prev => [newVersion, ...prev.map(v => ({ ...v, isCollapsed: true }))]);

    try {
      await generateScriptStream(token, projectId, {
        mode: "step1_modify",
        content: versions[0]?.content || "", // Use previous active content as input
        model: selectedModel,
        instruction: finalInstruction,
      }, (chunk) => {
        setVersions(prev => {
          const current = [...prev];
          const active = { ...current[0] };
          
          if (chunk.choices?.[0]?.delta?.reasoning_content) {
            active.thinking += chunk.choices[0].delta.reasoning_content;
          }
          
          if (chunk.choices?.[0]?.delta?.content) {
            // If this is the first content chunk, collapse thinking
            if (!active.content && active.thinking) {
               active.isThinkingCollapsed = true;
            }
            active.content += chunk.choices[0].delta.content;
          }
          
          current[0] = active;
          return current;
        });
      }, abortController.signal);
      
      setMessage("AI 修改完成");
    } catch (error: any) {
      if (error.name === 'AbortError') {
        setMessage("生成已取消");
      } else {
        setMessage(`修改失败: ${error.message}`);
        console.error(error);
      }
    } finally {
      setIsModifying(false);
      abortControllerRef.current = null;
    }
  };

  const handleContinuationSubmit = async (formattedAnswers: string, mode: "continuation_paid" | "continuation_traffic") => {
    setIsModifying(true);
    setMessage(null);

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    // Create new version with existing content + separator
    const currentContent = versions[0]?.content || "";
    const markerTitle = mode === "continuation_paid" ? "🟢 AI 付费转化续写内容" : "🔴 AI 流量爆款续写内容";
    const separator = `\n\n\n==================================================\n   ${markerTitle}\n==================================================\n\n`;
    
    const newVersion: ScriptVersion = {
      id: `ver-${Date.now()}`,
      content: currentContent + separator,
      thinking: "",
      isThinkingCollapsed: false,
      isCollapsed: false,
      timestamp: Date.now(),
      label: `Version ${versions.length + 1} (Continuation)`
    };

    setVersions(prev => [newVersion, ...prev.map(v => ({ ...v, isCollapsed: true }))]);

    try {
      const token = getToken();
      if (!token) throw new Error("未登录");

      await generateScriptStream(token, projectId, {
        mode: mode,
        content: currentContent,
        model: selectedModel,
        instruction: formattedAnswers + (instruction ? `\n\n用户额外补充：${instruction}` : ""),
      }, (chunk) => {
         setVersions(prev => {
          const current = [...prev];
          const active = { ...current[0] };
          
          if (chunk.choices?.[0]?.delta?.reasoning_content) {
            active.thinking += chunk.choices[0].delta.reasoning_content;
          }
          
          if (chunk.choices?.[0]?.delta?.content) {
             if (active.thinking && !active.isThinkingCollapsed) {
               active.isThinkingCollapsed = true;
             }
             active.content += chunk.choices[0].delta.content;
          }
          
          current[0] = active;
          return current;
        });
      }, abortController.signal);
      
      setMessage("续写完成");
      setIsContinuationModalOpen(false);
    } catch (error: any) {
      if (error.name === 'AbortError') {
        setMessage("续写已取消");
      } else {
        setMessage(`续写失败: ${error.message}`);
      }
    } finally {
      setIsModifying(false);
      abortControllerRef.current = null;
    }
  };

  // Suggestion remains mostly same, just updates instruction box
  const handleSuggestion = async (mode: "suggestion_paid" | "suggestion_traffic") => {
    if (!projectId) return;
    const token = getToken();
    if (!token) {
      router.push("/login");
      return;
    }

    setIsModifying(true);
    setMessage("AI 正在生成建议...");
    setInstruction(""); // Clear existing instruction
    setSuggestionThinking(""); // Clear existing thinking
    setIsSuggestionThinkingCollapsed(false); // Expand thinking initially

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    let finalInstruction = "";
    const formattedOptions = getFormattedInstruction();
    if (formattedOptions) {
      finalInstruction += `【用户高级设定】\n`;
      finalInstruction += `${formattedOptions}\n`;
    }

    let hasCollapsedThinking = false;

    try {
      await generateScriptStream(token, projectId, {
        mode: mode,
        content: versions[0]?.content || "",
        model: selectedModel,
        instruction: finalInstruction,
      }, (chunk) => {
        if (chunk.choices?.[0]?.delta?.reasoning_content) {
          setSuggestionThinking(prev => prev + chunk.choices[0].delta.reasoning_content);
        }
        if (chunk.choices?.[0]?.delta?.content) {
          if (!hasCollapsedThinking) {
             setIsSuggestionThinkingCollapsed(true);
             hasCollapsedThinking = true;
          }
          setInstruction(prev => prev + chunk.choices[0].delta.content);
        }
      }, abortController.signal);
      setMessage("建议已生成");
    } catch (error: any) {
      if (error.name === 'AbortError') {
        setMessage("建议生成已取消");
      } else {
        setMessage(`生成建议失败: ${error.message}`);
      }
    } finally {
      setIsModifying(false);
      abortControllerRef.current = null;
    }
  };

  const handleNext = async () => {
    await save();
    router.push(`/projects/${projectId}/script/resources`);
  };

  const toggleCollapse = (index: number) => {
    setVersions(prev => {
      const newVersions = [...prev];
      newVersions[index] = { ...newVersions[index], isCollapsed: !newVersions[index].isCollapsed };
      return newVersions;
    });
  };
  
  const toggleThinking = (index: number) => {
     setVersions(prev => {
      const newVersions = [...prev];
      newVersions[index] = { ...newVersions[index], isThinkingCollapsed: !newVersions[index].isThinkingCollapsed };
      return newVersions;
    });
  };

  const handleRevert = (version: ScriptVersion) => {
    if (confirm("确定要恢复到此版本吗？这将创建一个新的当前版本。")) {
      const newVersionId = `ver-${Date.now()}`;
      const newVersion: ScriptVersion = {
        id: newVersionId,
        content: version.content,
        thinking: "",
        isThinkingCollapsed: true,
        isCollapsed: false,
        timestamp: Date.now(),
        label: `Restored from ${version.label}`
      };
      
      setVersions(prev => [newVersion, ...prev.map(v => ({ ...v, isCollapsed: true }))]);
      setMessage("已恢复版本");
    }
  };

  return (
    <div className="space-y-6">
      <div className="sticky top-0 z-40 flex items-center justify-between bg-white py-4 shadow-sm -mx-6 px-6">
        <h1 className="text-2xl font-semibold">Step 1: 修改剧本</h1>
        <div className="flex gap-3">
          {/* History Button Removed */}
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

      {loading ? (
        <div>加载中...</div>
      ) : (
        <div className="space-y-4">
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
             {/* ... Input Section (Same as before) ... */}
            <div className="mb-3 flex items-center justify-between text-sm font-medium text-slate-900">
              <span>AI 辅助修改</span>
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
                <div className="rounded-lg bg-amber-50 border border-amber-100 p-3">
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

              <textarea
                ref={textareaRef}
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                placeholder="输入修改意见（例如：增加一些对白，让节奏更紧凑...）"
                rows={3}
                className="w-full min-h-[80px] rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-indigo-500 resize-none overflow-hidden"
              />
              <div className="flex items-center justify-between gap-3">
                <div className="flex gap-3">
                  <button
                    onClick={() => handleSuggestion("suggestion_paid")}
                    disabled={isModifying}
                    className="rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 text-xs text-indigo-700 hover:bg-indigo-100 disabled:opacity-50 transition-colors"
                  >
                    💡 付费优化修改建议
                  </button>
                  <button
              onClick={() => handleSuggestion("suggestion_traffic")}
              disabled={isModifying}
              className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700 hover:bg-amber-100 disabled:opacity-50 transition-colors"
            >
              🔥 流量爆款修改建议
            </button>
            <button
              onClick={() => setIsContinuationModalOpen(true)}
              disabled={isModifying}
              className="rounded-lg border border-purple-200 bg-purple-50 px-3 py-2 text-xs text-purple-700 hover:bg-purple-100 disabled:opacity-50 transition-colors"
            >
              ✨ AI 续写
            </button>
                </div>
                <div className="flex items-center gap-3">
                  <select
                    value={selectedModel}
                    onChange={(e) => setSelectedModel(e.target.value)}
                    className="rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-indigo-500 w-48"
                  >
                    <option value="doubao-pro">Doubao Seed 2.0 Pro</option>
                  </select>
                  {isModifying ? (
                    <button
                      onClick={stopGeneration}
                      className="whitespace-nowrap rounded-lg bg-red-500 px-4 py-2 text-sm text-white hover:bg-red-600 shadow-sm transition-colors flex items-center gap-2"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                      停止生成
                    </button>
                  ) : (
                    <button
                      onClick={handleModify}
                      disabled={!instruction.trim()}
                      className="whitespace-nowrap rounded-lg bg-indigo-600 px-4 py-2 text-sm text-white hover:bg-indigo-700 disabled:bg-slate-300 shadow-sm transition-colors"
                    >
                      AI 修改
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Versions List */}
          <div className="space-y-4">
             {versions.map((version, index) => (
                <div key={version.id} className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
                   <div 
                      className="flex items-center justify-between bg-slate-50 px-4 py-3 cursor-pointer hover:bg-slate-100 transition-colors"
                      onClick={() => toggleCollapse(index)}
                   >
                      <div className="flex items-center gap-2">
                         <span className="font-semibold text-slate-700">{version.label}</span>
                         <span className="text-xs text-slate-400">{new Date(version.timestamp).toLocaleString()}</span>
                         {index > 0 && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleRevert(version);
                              }}
                              className="ml-2 px-2 py-1 text-xs font-medium text-indigo-600 bg-indigo-50 rounded hover:bg-indigo-100 transition-colors"
                            >
                              恢复此版本
                            </button>
                         )}
                      </div>
                      <span className="text-slate-500">{version.isCollapsed ? "展开 ▼" : "收起 ▲"}</span>
                   </div>
                   
                   {!version.isCollapsed && (
                      <div className="p-4 border-t border-slate-100">
                         {/* Thinking Section */}
                         {version.thinking && (
                            <div className="mb-4 rounded-lg bg-slate-50 border border-slate-100 p-3">
                               <div 
                                  className="flex items-center justify-between mb-2 cursor-pointer"
                                  onClick={() => toggleThinking(index)}
                               >
                                  <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">Thinking Process</span>
                                  <span className="text-xs text-slate-400">{version.isThinkingCollapsed ? "展开" : "收起"}</span>
                               </div>
                               <div className={`text-sm text-slate-500 leading-relaxed font-mono ${version.isThinkingCollapsed ? 'line-clamp-2' : ''}`}>
                                  {version.thinking}
                               </div>
                            </div>
                         )}
                         
                         <textarea
                            value={version.content}
                            onChange={(e) => {
                               const newContent = e.target.value;
                               setVersions(prev => {
                                  const newVersions = [...prev];
                                  newVersions[index] = { ...newVersions[index], content: newContent };
                                  return newVersions;
                               });
                            }}
                            className="w-full min-h-[600px] resize-y border-none p-0 text-sm outline-none focus:ring-0 leading-relaxed"
                            placeholder="剧本内容..."
                         />
                      </div>
                   )}
                </div>
             ))}
          </div>
        </div>
      )}

      {message && <div className="text-sm text-slate-600">{message}</div>}
      <AIContinuationModal
        isOpen={isContinuationModalOpen}
        onClose={() => setIsContinuationModalOpen(false)}
        onSubmit={handleContinuationSubmit}
      />
    </div>
  );
}
