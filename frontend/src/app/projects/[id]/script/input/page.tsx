"use client";

import { useEffect, useState, useRef, type ChangeEvent } from "react";
import { useParams, useRouter } from "next/navigation";
import { getScript, saveScript, generateScript } from "@/lib/api";
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

export default function ScriptInputPage() {
  const params = useParams<{ id: string }>();
  const projectId = params.id;
  const router = useRouter();
  const [content, setContent] = useState("");
  const [previousContent, setPreviousContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [isModifying, setIsModifying] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [selectedModel, setSelectedModel] = useState("gemini3flash");
  const [message, setMessage] = useState<string | null>(null);

  const [selectedOptions, setSelectedOptions] = useState<Record<string, string[]>>({});
  const [customInputs, setCustomInputs] = useState<Record<string, string>>({});
  // Track the order of all selections (options + custom input)
  const [selectionOrder, setSelectionOrder] = useState<Record<string, string[]>>({});
  const CUSTOM_INPUT_KEY = "___CUSTOM_INPUT___";

  const [isOptionsExpanded, setIsOptionsExpanded] = useState(false);

  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastSavedContentRef = useRef(content);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight + 2}px`;
    }
  }, [instruction]);

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
      .catch(() => setContent(""))
      .finally(() => setLoading(false));
  }, [projectId]);

  // Auto-save effect
  useEffect(() => {
    if (loading || !projectId) return;
    
    // Skip if content hasn't changed from last save
    if (content === lastSavedContentRef.current) return;

    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

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
    }, 2000); // 2 seconds debounce

    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, [content, projectId, loading]);

  const save = async () => {
    if (!projectId) return;
    const token = getToken();
    if (!token) {
      router.push("/login");
      return;
    }
    setMessage(null);
    try {
      const result = await saveScript(token, projectId, content);
      setContent(result.content ?? "");
      lastSavedContentRef.current = result.content ?? "";
      setMessage("已保存");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存失败");
    }
  };

  const handleUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    if (!projectId) return;
    const token = getToken();
    if (!token) {
      router.push("/login");
      return;
    }
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
    setMessage(null);
    try {
      let text = "";
      if (isDocx) {
        // Dynamic import to avoid build errors if types are missing
        // @ts-ignore
        const mammoth = await import("mammoth");
        const arrayBuffer = await file.arrayBuffer();
        const result = await mammoth.extractRawText({ arrayBuffer });
        text = result.value;
      } else {
        text = await file.text();
      }
      
      setContent(text);
      await saveScript(token, projectId, text);
      setMessage("已导入");
    } catch (error) {
      console.error(error);
      setMessage(error instanceof Error ? error.message : "导入失败");
    } finally {
      setUploading(false);
      event.target.value = "";
    }
  };

  const toggleOption = (label: string, option: string) => {
    // Update selectedOptions (for backward compatibility/easy check)
    setSelectedOptions((prev) => {
      const current = prev[label] || [];
      if (current.includes(option)) {
        return { ...prev, [label]: current.filter((item) => item !== option) };
      } else {
        return { ...prev, [label]: [...current, option] };
      }
    });

    // Update selectionOrder
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
    setCustomInputs((prev) => ({
      ...prev,
      [label]: value,
    }));

    setSelectionOrder((prev) => {
      const current = prev[label] || [];
      const hasCustom = current.includes(CUSTOM_INPUT_KEY);
      const isNotEmpty = value.trim().length > 0;

      if (isNotEmpty && !hasCustom) {
        // Add custom input key if it becomes non-empty
        return { ...prev, [label]: [...current, CUSTOM_INPUT_KEY] };
      } else if (!isNotEmpty && hasCustom) {
        // Remove custom input key if it becomes empty
        return { ...prev, [label]: current.filter((item) => item !== CUSTOM_INPUT_KEY) };
      }
      return prev;
    });
  };

  const getFormattedInstruction = () => {
    let formattedText = "";
    
    scriptOptions.forEach((category) => {
      const activeItems = category.items
        .map((item) => {
          const orderList = selectionOrder[item.label] || [];
          if (orderList.length === 0) return null;
          
          const valuedString = orderList
            .map((v, i) => {
              const actualValue = v === CUSTOM_INPUT_KEY ? customInputs[item.label] : v;
              if (!actualValue) return null;
              return i === 0 ? `${actualValue}(主)` : `${actualValue}(辅)`;
            })
            .filter(Boolean)
            .join(", ");
          
          if (!valuedString) return null;
          return `-${item.label}：${valuedString}`;
        })
        .filter(Boolean);

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

    let finalInstruction = instruction;
    
    // Build instruction based on selectionOrder
    const formattedOptions = getFormattedInstruction();

    if (formattedOptions) {
      finalInstruction += `\n\n【附加设定】\n`;
      finalInstruction += `${formattedOptions}\n`;
    }

    try {
      const result = await generateScript(token, projectId, {
        mode: "step1_modify",
        content: content,
        model: selectedModel,
        instruction: finalInstruction,
      });
      if (result.content) {
        setPreviousContent(content);
        setContent(result.content);
        setMessage("AI 修改完成");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "修改失败");
    } finally {
      setIsModifying(false);
    }
  };

  const handleSuggestion = async (mode: "suggestion_paid" | "suggestion_traffic") => {
    if (!projectId) return;
    const token = getToken();
    if (!token) {
      router.push("/login");
      return;
    }

    setIsModifying(true);
    setMessage("AI 正在生成建议...");

    let finalInstruction = "";
    
    // Build instruction based on selectionOrder
    const formattedOptions = getFormattedInstruction();

    if (formattedOptions) {
      finalInstruction += `【用户高级设定】\n`;
      finalInstruction += `${formattedOptions}\n`;
    }

    try {
      const result = await generateScript(token, projectId, {
        mode: mode,
        content: content,
        model: selectedModel,
        instruction: finalInstruction,
      });
      if (result.content) {
        setInstruction(result.content);
        setMessage("建议已生成");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "生成建议失败");
    } finally {
      setIsModifying(false);
    }
  };

  const handleNext = async () => {
    await save();
    router.push(`/projects/${projectId}/script/resources`);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Step 1: 修改剧本</h1>
        <div className="flex gap-3">
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
            <div className="mb-3 text-sm font-medium text-slate-900">AI 辅助修改</div>
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
                              {/* Option Chips */}
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
                              
                              {/* Manual Input Area */}
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
                                {(() => {
                                  const orderList = selectionOrder[item.label] || [];
                                  const customIndex = orderList.indexOf(CUSTOM_INPUT_KEY);
                                  const hasCustomInput = customIndex !== -1;
                                  const isCustomMain = customIndex === 0;
                                  
                                  if (!hasCustomInput) return null;
                                  
                                  return (
                                    <span className="absolute -top-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full bg-amber-400 text-[10px] font-bold text-white shadow-sm ring-2 ring-white z-10">
                                      {isCustomMain ? "主" : "辅"}
                                    </span>
                                  );
                                })()}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
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
                </div>
                <div className="flex items-center gap-3">
                  <select
                    value={selectedModel}
                    onChange={(e) => setSelectedModel(e.target.value)}
                    className="rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-indigo-500 w-48"
                  >
                    <option value="gemini3flash">Gemini 3 Flash</option>
                    <option value="gemini3.1">Gemini 3.1 Pro</option>
                  </select>
                  <button
                    onClick={handleModify}
                    disabled={isModifying || !instruction.trim()}
                    className="whitespace-nowrap rounded-lg bg-indigo-600 px-4 py-2 text-sm text-white hover:bg-indigo-700 disabled:bg-slate-300"
                  >
                    {isModifying ? "修改中..." : "AI 修改"}
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div className="flex gap-4">
            {previousContent && (
              <div className="flex-1 rounded-xl border border-slate-200 bg-slate-50 p-4 shadow-sm">
                <div className="mb-2 flex items-center justify-between text-xs font-medium text-slate-500">
                  <span>修改前版本</span>
                  <div className="flex gap-2">
                    <button
                      onClick={() => {
                        setContent(previousContent);
                        setPreviousContent(null);
                      }}
                      className="text-indigo-600 hover:text-indigo-800"
                    >
                      恢复此版本
                    </button>
                    <button
                      onClick={() => setPreviousContent(null)}
                      className="text-slate-400 hover:text-slate-600"
                    >
                      关闭对比
                    </button>
                  </div>
                </div>
                <textarea
                  value={previousContent}
                  readOnly
                  className="h-[600px] w-full resize-none border-none bg-transparent p-0 text-sm outline-none focus:ring-0"
                />
              </div>
            )}
            <div className="flex-1 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              {previousContent && (
                <div className="mb-2 text-xs font-medium text-slate-500">
                  当前版本 (可编辑)
                </div>
              )}
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                className="h-[600px] w-full resize-none border-none p-0 text-sm outline-none focus:ring-0"
                placeholder="在此输入或粘贴剧本内容..."
              />
            </div>
          </div>
        </div>
      )}

      {message && <div className="text-sm text-slate-600">{message}</div>}
    </div>
  );
}
