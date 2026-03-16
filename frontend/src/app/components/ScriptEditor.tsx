import React, { useState, useEffect, useRef, useCallback } from 'react';
import { getToken } from "@/lib/auth";
import { generateTTS, getProjectVoices, type CharacterVoice } from "@/lib/api";

interface ScriptEditorProps {
  content: string;
  onChange: (newContent: string) => void;
  projectId?: string;
  rowStartIndex?: number;
  generatingGlobalRowIndex?: number | null;
  generatedRowIndexSet?: Set<number>;
  onGenerateKlingRow?: (params: {
    globalRowIndex: number;
    headers: string[];
    row: string[];
    spec: string;
  }) => void;
}

type Block = 
  | { type: 'text'; value: string }
  | { type: 'table'; headers: string[]; rows: string[][] };

type VoiceTagItem = { label: string; tag: string; desc: string };
type VoiceTagGroup = { key: "basic" | "advanced" | "tone" | "audio" | "special"; title: string; tags: VoiceTagItem[] };
type VoiceSegment = { id: string; text: string };
type VoiceEmotionIntensity = "slightly" | "very" | "extremely";
type VoiceAccentLevel = "slight" | "normal" | "strong";

const VOICE_TAG_GROUPS: VoiceTagGroup[] = [
  {
    key: "basic",
    title: "基本情绪",
    tags: [
      { label: "开心", tag: "(happy)", desc: "轻快愉悦" },
      { label: "悲伤", tag: "(sad)", desc: "低落伤感" },
      { label: "生气", tag: "(angry)", desc: "恼火不满" },
      { label: "愤怒", tag: "(extremely angry)", desc: "极度愤怒，更具爆发感" },
      { label: "兴奋", tag: "(excited)", desc: "高能激动" },
      { label: "平静", tag: "(calm)", desc: "沉稳平和" },
      { label: "紧张", tag: "(nervous)", desc: "焦虑不安" },
      { label: "自信", tag: "(confident)", desc: "坚定有力" },
      { label: "惊讶", tag: "(surprised)", desc: "震惊诧异" },
      { label: "满足", tag: "(satisfied)", desc: "满足肯定" },
      { label: "欣喜", tag: "(delighted)", desc: "非常高兴" },
      { label: "害怕", tag: "(scared)", desc: "惧怕恐慌" },
      { label: "担忧", tag: "(worried)", desc: "忧虑顾虑" },
      { label: "烦躁", tag: "(upset)", desc: "烦闷受挫" },
      { label: "沮丧", tag: "(frustrated)", desc: "受阻恼火" },
      { label: "抑郁", tag: "(depressed)", desc: "压抑低沉" },
      { label: "共情", tag: "(empathetic)", desc: "理解安抚" },
      { label: "尴尬", tag: "(embarrassed)", desc: "局促不安" },
      { label: "厌恶", tag: "(disgusted)", desc: "反感排斥" },
      { label: "感动", tag: "(moved)", desc: "触动人心" },
      { label: "自豪", tag: "(proud)", desc: "骄傲肯定" },
      { label: "放松", tag: "(relaxed)", desc: "轻松自然" },
      { label: "感激", tag: "(grateful)", desc: "感谢表达" },
      { label: "好奇", tag: "(curious)", desc: "探索询问" },
      { label: "讽刺", tag: "(sarcastic)", desc: "反讽语气" },
    ],
  },
  {
    key: "advanced",
    title: "高级情绪",
    tags: [
      { label: "轻蔑", tag: "(disdainful)", desc: "轻视鄙夷" },
      { label: "不悦", tag: "(unhappy)", desc: "不高兴" },
      { label: "焦躁", tag: "(anxious)", desc: "急躁不安" },
      { label: "失控", tag: "(hysterical)", desc: "情绪激烈" },
      { label: "冷漠", tag: "(indifferent)", desc: "漠不关心" },
      { label: "不确定", tag: "(uncertain)", desc: "不笃定" },
      { label: "怀疑", tag: "(doubtful)", desc: "质疑口吻" },
      { label: "困惑", tag: "(confused)", desc: "不解迷茫" },
      { label: "失望", tag: "(disappointed)", desc: "期望落空" },
      { label: "懊悔", tag: "(regretful)", desc: "后悔遗憾" },
      { label: "内疚", tag: "(guilty)", desc: "自责愧疚" },
      { label: "羞愧", tag: "(ashamed)", desc: "羞惭难当" },
      { label: "嫉妒", tag: "(jealous)", desc: "妒忌心理" },
      { label: "羡慕", tag: "(envious)", desc: "向往拥有" },
      { label: "有希望", tag: "(hopeful)", desc: "期待未来" },
      { label: "乐观", tag: "(optimistic)", desc: "积极向上" },
      { label: "悲观", tag: "(pessimistic)", desc: "消极预期" },
      { label: "怀旧", tag: "(nostalgic)", desc: "追忆过去" },
      { label: "孤独", tag: "(lonely)", desc: "孤单无助" },
      { label: "无聊", tag: "(bored)", desc: "兴致缺缺" },
      { label: "蔑视", tag: "(contemptuous)", desc: "强烈鄙夷" },
      { label: "同情", tag: "(sympathetic)", desc: "表示同情" },
      { label: "怜悯", tag: "(compassionate)", desc: "深度关怀" },
      { label: "坚定", tag: "(determined)", desc: "意志坚决" },
      { label: "认命", tag: "(resigned)", desc: "接受结果" },
    ],
  },
  {
    key: "tone",
    title: "语调标记",
    tags: [
      { label: "匆忙", tag: "(in a hurry tone)", desc: "语速急促" },
      { label: "大喊", tag: "(shouting)", desc: "提高音量" },
      { label: "尖叫", tag: "(screaming)", desc: "极高音量" },
      { label: "低语", tag: "(whispering)", desc: "轻声耳语" },
      { label: "轻柔", tag: "(soft tone)", desc: "柔和细腻" },
    ],
  },
  {
    key: "audio",
    title: "音频效果",
    tags: [
      { label: "大笑", tag: "(laughing)", desc: "完整笑声" },
      { label: "轻笑", tag: "(chuckling)", desc: "轻微笑声" },
      { label: "抽泣", tag: "(sobbing)", desc: "哭泣颤抖" },
      { label: "嚎哭", tag: "(crying loudly)", desc: "大声哭泣" },
      { label: "叹气", tag: "(sighing)", desc: "长呼气" },
      { label: "呻吟", tag: "(groaning)", desc: "不适抱怨" },
      { label: "喘息", tag: "(panting)", desc: "气息急促" },
      { label: "倒吸气", tag: "(gasping)", desc: "突然吸气" },
      { label: "哈欠", tag: "(yawning)", desc: "疲惫呵欠" },
      { label: "打鼾", tag: "(snoring)", desc: "睡眠鼻息" },
    ],
  },
  {
    key: "special",
    title: "特效",
    tags: [
      { label: "观众笑", tag: "(audience laughing)", desc: "观众笑声" },
      { label: "背景笑", tag: "(background laughter)", desc: "背景氛围笑" },
      { label: "群体笑", tag: "(crowd laughing)", desc: "多人笑声" },
      { label: "短停顿", tag: "(break)", desc: "短暂停顿" },
      { label: "长停顿", tag: "(long-break)", desc: "更长停顿" },
    ],
  },
];

const KLING_COLUMN = "Kling视频生成";
const KLING_DEFAULT_SPEC = "pro|1|false";
const KLING_SPEC_OPTIONS = [
  { value: "std|1|true", label: "标准（std）x 1s 时长 x 有参考视频" },
  { value: "std|1|false", label: "标准（std）x 1s 时长 x 无参考视频" },
  { value: "pro|1|true", label: "高品质（pro）x 1s 时长 x 有参考视频" },
  { value: "pro|1|false", label: "高品质（pro）x 1s 时长 x 无参考视频" },
];

export function ScriptEditor({
  content,
  onChange,
  projectId,
  rowStartIndex = 0,
  generatingGlobalRowIndex = null,
  generatedRowIndexSet,
  onGenerateKlingRow,
}: ScriptEditorProps) {
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [projectAssets, setProjectAssets] = useState<any[]>([]);
  const [projectVoices, setProjectVoices] = useState<CharacterVoice[]>([]);
  const [voiceModal, setVoiceModal] = useState<{ blockIndex: number; rowIndex: number; colIndex: number } | null>(null);
  const [voiceSourceText, setVoiceSourceText] = useState("");
  const [voiceSegments, setVoiceSegments] = useState<VoiceSegment[]>([]);
  const [voiceCharacter, setVoiceCharacter] = useState("");
  const [voiceVolume, setVoiceVolume] = useState(0);
  const [voiceSpeed, setVoiceSpeed] = useState(1);
  const [voicePitch, setVoicePitch] = useState(0);
  const [activeVoiceSegmentId, setActiveVoiceSegmentId] = useState<string | null>(null);
  const [voiceGeneratingSegmentId, setVoiceGeneratingSegmentId] = useState<string | null>(null);
  const [voiceTagGroupKey, setVoiceTagGroupKey] = useState<VoiceTagGroup["key"]>("basic");
  const [voiceEmotionIntensity, setVoiceEmotionIntensity] = useState<VoiceEmotionIntensity>("very");
  const [voiceAccentLevel, setVoiceAccentLevel] = useState<VoiceAccentLevel>("normal");
  const [voicePauseSeconds, setVoicePauseSeconds] = useState(1.2);
  const [voiceSegmentAudioMap, setVoiceSegmentAudioMap] = useState<Record<string, string>>({});
  const [voiceError, setVoiceError] = useState("");
  const [voiceSelection, setVoiceSelection] = useState<{ start: number; end: number; text: string }>({ start: 0, end: 0, text: "" });
  const voiceAudioRefs = useRef<Record<string, HTMLAudioElement | null>>({});
  const voiceTextareaRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});
  // Initialize with specific value to ensure first sync happens if content is present
  const lastSerializedRef = useRef<string>('__INITIAL_EMPTY__'); 
  const isInternalUpdate = useRef(false);

  // Fetch project assets once
  useEffect(() => {
    if (projectId) {
      const fetchAssets = async () => {
        try {
          const token = getToken();
          const res = await fetch(`/api/projects/${projectId}/assets`, {
            headers: token ? {
              'Authorization': `Bearer ${token}`
            } : undefined
          });
          if (res.ok) {
            const data = await res.json();
            setProjectAssets(data);
          }
        } catch (e) {
          console.error("Failed to fetch project assets", e);
        }
      };
      fetchAssets();
    }
  }, [projectId]);

  useEffect(() => {
    if (!projectId) return;
    const token = getToken();
    if (!token) return;
    getProjectVoices(token, projectId)
      .then((items) => {
        setProjectVoices(items);
        if (items.length > 0) {
          setVoiceCharacter((prev) => prev || items[0].character_name);
        }
      })
      .catch(() => {
        setProjectVoices([]);
      });
  }, [projectId]);

  // Parse markdown content into blocks
  const parseMarkdown = useCallback((markdown: string): Block[] => {
    const lines = markdown.split('\n');
    const newBlocks: Block[] = [];
    let currentTextLines: string[] = [];
    let currentTableLines: string[] = [];
    let inTable = false;

    // Helper to check if a line looks like a table separator
    const isSeparatorLine = (line: string) => {
      const trimmed = line.trim();
      // Must contain only separator characters: | - : and whitespace
      // And must have at least one dash
      // And must have a pipe
      return /^[\s\|\-:]+$/.test(trimmed) && trimmed.includes('-') && trimmed.includes('|');
    };

    // Helper to check if a line looks like a table row
    const isTableLine = (line: string) => {
      const trimmed = line.trim();
      // Must contain a pipe, or start with pipe
      return trimmed.startsWith('|') || trimmed.startsWith('｜') || trimmed.includes('|');
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      // Check for table start
      if (!inTable) {
        const nextLine = lines[i + 1];
        if (isTableLine(line) && nextLine && isSeparatorLine(nextLine)) {
           // Flush text
           if (currentTextLines.length > 0) {
             newBlocks.push({ type: 'text', value: currentTextLines.join('\n') });
             currentTextLines = [];
           }
           inTable = true;
           currentTableLines.push(line);
        } else {
           currentTextLines.push(line);
        }
      } else {
        // Inside table
        if (isTableLine(line)) {
          currentTableLines.push(line);
        } else {
          // Table ended by non-table line
          inTable = false;
          if (currentTableLines.length > 0) {
            newBlocks.push(parseTableBlock(currentTableLines));
            currentTableLines = [];
          }
          currentTextLines.push(line);
        }
      }
    }

    // Flush remaining buffers
    if (inTable && currentTableLines.length > 0) {
      newBlocks.push(parseTableBlock(currentTableLines));
    }
    if (currentTextLines.length > 0) {
      newBlocks.push({ type: 'text', value: currentTextLines.join('\n') });
    }

    return newBlocks;
  }, []);

  const parseTableBlock = (lines: string[]): Block => {
    // lines[0]: header, lines[1]: separator, lines[2+]: rows
    const headerLine = lines[0];
    const rowLines = lines.slice(2);

    const cleanSplit = (line: string) => {
      // Split by pipe but handle escaped pipes
      const placeholder = "___PIPE___";
      const protectedLine = line.replace(/\\\|/g, placeholder);
      const parts = protectedLine.split('|').map(p => p.replace(new RegExp(placeholder, 'g'), '|'));
      
      // Markdown tables have empty first/last elements if lines start/end with |
      if (parts.length > 0 && parts[0].trim() === '') parts.shift();
      if (parts.length > 0 && parts[parts.length - 1].trim() === '') parts.pop();
      return parts; 
    };

    const headers = cleanSplit(headerLine).map(h => h.trim());
    const rows = rowLines.map(line => cleanSplit(line).map(c => c.trim().replace(/<br\s*\/?>/gi, '\n')));
    const klingIndex = headers.indexOf(KLING_COLUMN);
    if (klingIndex < 0) {
      headers.push(KLING_COLUMN);
      rows.forEach((row) => row.push(KLING_DEFAULT_SPEC));
    } else {
      rows.forEach((row) => {
        if (!row[klingIndex]) {
          row[klingIndex] = KLING_DEFAULT_SPEC;
        }
      });
    }

    return { type: 'table', headers, rows };
  };

  const getColumnWidthClass = (header: string) => {
    const text = header.replace(/\s+/g, '');
    if (text === KLING_COLUMN) return 'min-w-[300px] w-[300px]';
    if (text.includes('集数') || text.includes('时长')) return 'w-[80px] min-w-[80px]';
    if (text.includes('场景') || text.includes('人物') || text.includes('角色')) return 'w-[150px] min-w-[150px]';
    if (text.includes('剧情') || text.includes('内容') || text.includes('台词') || text.includes('画面')) return 'min-w-[400px]';
    if (text.includes('爽点') || text.includes('反转') || text.includes('钩子') || text.includes('备注')) return 'w-[180px] min-w-[180px]';
    return 'min-w-[120px]';
  };

  const serializeBlocks = useCallback((currentBlocks: Block[]): string => {
    return currentBlocks.map(block => {
      if (block.type === 'text') {
        return block.value;
      } else {
        // Convert table back to markdown
        // Ensure all rows have same number of columns
        const headers = block.headers;
        const rows = block.rows;
        
        // Calculate max width for alignment (optional, but good for readability)
        // For now just simple joining
        const headerLine = `| ${headers.join(' | ')} |`;
        const separatorLine = `| ${headers.map(() => '---').join(' | ')} |`;
        const rowLines = rows.map(row => `| ${row.map(c => c.replace(/\n/g, '<br>')).join(' | ')} |`);
        
        return [headerLine, separatorLine, ...rowLines].join('\n');
      }
    }).join('\n');
  }, []);

  // Handle external content updates
  useEffect(() => {
    // If it's an internal update, we ignore it as we already have the latest blocks
    if (isInternalUpdate.current) {
        return;
    }

    // Sync if content changed externally
    if (content !== lastSerializedRef.current) {
      setBlocks(parseMarkdown(content));
      lastSerializedRef.current = content;
    }
  }, [content, parseMarkdown]);

  // Update content when blocks change (internal change)
  useEffect(() => {
    if (isInternalUpdate.current) {
      const newContent = serializeBlocks(blocks);
      if (newContent !== content) {
        lastSerializedRef.current = newContent;
        onChange(newContent);
      }
      isInternalUpdate.current = false;
    }
  }, [blocks, serializeBlocks, onChange, content]);

  const updateBlock = (index: number, value: string) => {
    isInternalUpdate.current = true;
    setBlocks(prev => prev.map((b, i) => i === index && b.type === 'text' ? { ...b, value } : b));
  };

  const updateTable = (blockIndex: number, rowIndex: number, colIndex: number, value: string) => {
    isInternalUpdate.current = true;
    setBlocks(prev => prev.map((b, i) => {
      if (i === blockIndex && b.type === 'table') {
        const newRows = [...b.rows];
        newRows[rowIndex] = [...newRows[rowIndex]];
        newRows[rowIndex][colIndex] = value;
        return { ...b, rows: newRows };
      }
      return b;
    }));
  };

  const openVoiceModal = (blockIndex: number, rowIndex: number, colIndex: number, initialText: string) => {
    const initialSegmentId = `voice-segment-${Date.now()}`;
    setVoiceModal({ blockIndex, rowIndex, colIndex });
    setVoiceSourceText(initialText);
    setVoiceSegments([{ id: initialSegmentId, text: "" }]);
    setActiveVoiceSegmentId(initialSegmentId);
    setVoiceVolume(0);
    setVoiceSpeed(1);
    setVoicePitch(0);
    setVoiceSegmentAudioMap({});
    setVoiceError("");
    setVoiceSelection({ start: 0, end: 0, text: "" });
    setVoiceTagGroupKey("basic");
    setVoiceEmotionIntensity("very");
    setVoiceAccentLevel("normal");
    setVoicePauseSeconds(1.2);
    if (projectVoices.length > 0) {
      setVoiceCharacter((prev) => prev || projectVoices[0].character_name);
    }
  };

  const closeVoiceModal = () => {
    setVoiceModal(null);
    setVoiceGeneratingSegmentId(null);
  };

  const syncVoiceSelection = useCallback((segmentId: string) => {
    const textarea = voiceTextareaRefs.current[segmentId];
    if (!textarea) return;
    const start = textarea.selectionStart ?? 0;
    const end = textarea.selectionEnd ?? start;
    const segment = voiceSegments.find((item) => item.id === segmentId);
    const text = (segment?.text || "").slice(start, end);
    setActiveVoiceSegmentId(segmentId);
    setVoiceSelection({ start, end, text });
  }, [voiceSegments]);

  const addVoiceSegment = (text = "") => {
    const newId = `voice-segment-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setVoiceSegments((prev) => [...prev, { id: newId, text }]);
    setActiveVoiceSegmentId(newId);
    setVoiceSelection({ start: 0, end: 0, text: "" });
    requestAnimationFrame(() => {
      const nextEl = voiceTextareaRefs.current[newId];
      if (!nextEl) return;
      nextEl.focus();
    });
  };

  const updateVoiceSegment = (segmentId: string, text: string) => {
    setVoiceSegments((prev) => prev.map((item) => (item.id === segmentId ? { ...item, text } : item)));
  };

  const removeVoiceSegment = (segmentId: string) => {
    setVoiceSegments((prev) => {
      if (prev.length <= 1) return prev;
      const filtered = prev.filter((item) => item.id !== segmentId);
      const fallbackId = filtered[0]?.id || null;
      if (activeVoiceSegmentId === segmentId) {
        setActiveVoiceSegmentId(fallbackId);
        setVoiceSelection({ start: 0, end: 0, text: "" });
      }
      return filtered;
    });
    setVoiceSegmentAudioMap((prev) => {
      const next = { ...prev };
      delete next[segmentId];
      return next;
    });
    delete voiceAudioRefs.current[segmentId];
    delete voiceTextareaRefs.current[segmentId];
  };

  const combinedVoiceText = voiceSegments
    .map((item) => item.text.trim())
    .filter(Boolean)
    .join("\n");

  const activeTagGroup = VOICE_TAG_GROUPS.find((group) => group.key === voiceTagGroupKey) || VOICE_TAG_GROUPS[0];
  const isEmotionGroup = activeTagGroup.key === "basic" || activeTagGroup.key === "advanced";
  const formatVoiceTag = (tag: string) => {
    if (!isEmotionGroup) return tag;
    const normalized = tag.trim();
    if (!normalized.startsWith("(") || !normalized.endsWith(")")) return tag;
    const inner = normalized.slice(1, -1).trim();
    if (!inner) return tag;
    if (
      inner.startsWith("slightly ") ||
      inner.startsWith("very ") ||
      inner.startsWith("extremely ")
    ) {
      return normalized;
    }
    return `(${voiceEmotionIntensity} ${inner})`;
  };

  const insertVoiceTag = (tag: string) => {
    const finalTag = formatVoiceTag(tag);
    if (!activeVoiceSegmentId) {
      if (voiceSegments.length === 0) {
        addVoiceSegment(`${finalTag} `);
      }
      return;
    }
    const textarea = voiceTextareaRefs.current[activeVoiceSegmentId];
    const targetSegment = voiceSegments.find((item) => item.id === activeVoiceSegmentId);
    if (!textarea || !targetSegment) return;
    const start = textarea.selectionStart ?? 0;
    const end = textarea.selectionEnd ?? start;
    const hasSelection = end > start;
    const currentText = targetSegment.text;
    const selectedText = currentText.slice(start, end);
    const insertion = hasSelection ? `${finalTag}${selectedText}` : `${finalTag} `;
    const nextText = `${currentText.slice(0, start)}${insertion}${currentText.slice(end)}`;
    const nextCaret = start + insertion.length;
    updateVoiceSegment(activeVoiceSegmentId, nextText);
    requestAnimationFrame(() => {
      const nextEl = voiceTextareaRefs.current[activeVoiceSegmentId];
      if (!nextEl) return;
      nextEl.focus();
      nextEl.selectionStart = nextCaret;
      nextEl.selectionEnd = nextCaret;
      setVoiceSelection({ start: nextCaret, end: nextCaret, text: "" });
    });
  };

  const insertCustomPause = () => {
    const safeSeconds = Math.max(0.2, Math.min(8, Number.isFinite(voicePauseSeconds) ? voicePauseSeconds : 1.2));
    const pauseTag = `(pause:${safeSeconds.toFixed(1)}s)`;
    if (!activeVoiceSegmentId) {
      if (voiceSegments.length === 0) {
        addVoiceSegment(`${pauseTag} `);
      }
      return;
    }
    const textarea = voiceTextareaRefs.current[activeVoiceSegmentId];
    const targetSegment = voiceSegments.find((item) => item.id === activeVoiceSegmentId);
    if (!textarea || !targetSegment) return;
    const start = textarea.selectionStart ?? 0;
    const end = textarea.selectionEnd ?? start;
    const hasSelection = end > start;
    const currentText = targetSegment.text;
    const selectedText = currentText.slice(start, end);
    const insertion = hasSelection ? `${pauseTag}${selectedText}` : `${pauseTag} `;
    const nextText = `${currentText.slice(0, start)}${insertion}${currentText.slice(end)}`;
    const nextCaret = start + insertion.length;
    updateVoiceSegment(activeVoiceSegmentId, nextText);
    requestAnimationFrame(() => {
      const nextEl = voiceTextareaRefs.current[activeVoiceSegmentId];
      if (!nextEl) return;
      nextEl.focus();
      nextEl.selectionStart = nextCaret;
      nextEl.selectionEnd = nextCaret;
      setVoiceSelection({ start: nextCaret, end: nextCaret, text: "" });
    });
  };

  const insertAccentTag = () => {
    const accentTag =
      voiceAccentLevel === "slight"
        ? "[slight emphasis]"
        : voiceAccentLevel === "strong"
        ? "[strong emphasis]"
        : "[emphasis]";
    if (!activeVoiceSegmentId) {
      if (voiceSegments.length === 0) {
        addVoiceSegment(`${accentTag} `);
      }
      return;
    }
    const textarea = voiceTextareaRefs.current[activeVoiceSegmentId];
    const targetSegment = voiceSegments.find((item) => item.id === activeVoiceSegmentId);
    if (!textarea || !targetSegment) return;
    const start = textarea.selectionStart ?? 0;
    const end = textarea.selectionEnd ?? start;
    const hasSelection = end > start;
    const currentText = targetSegment.text;
    const selectedText = currentText.slice(start, end);
    const insertion = hasSelection ? `${accentTag}${selectedText}` : `${accentTag} `;
    const nextText = `${currentText.slice(0, start)}${insertion}${currentText.slice(end)}`;
    const nextCaret = start + insertion.length;
    updateVoiceSegment(activeVoiceSegmentId, nextText);
    requestAnimationFrame(() => {
      const nextEl = voiceTextareaRefs.current[activeVoiceSegmentId];
      if (!nextEl) return;
      nextEl.focus();
      nextEl.selectionStart = nextCaret;
      nextEl.selectionEnd = nextCaret;
      setVoiceSelection({ start: nextCaret, end: nextCaret, text: "" });
    });
  };

  const applyVoiceTextToCell = () => {
    if (!voiceModal) return;
    if (!combinedVoiceText) return;
    updateTable(voiceModal.blockIndex, voiceModal.rowIndex, voiceModal.colIndex, combinedVoiceText);
  };

  const generateVoiceForSegment = async (segmentId: string) => {
    if (!projectId) return;
    if (!voiceCharacter) return;
    const segment = voiceSegments.find((item) => item.id === segmentId);
    const ttsText = segment?.text.trim() || "";
    if (!ttsText) return;
    const token = getToken();
    if (!token) return;

    setVoiceGeneratingSegmentId(segmentId);
    setVoiceError("");
    try {
      const result = await generateTTS(token, projectId, {
        character_name: voiceCharacter,
        text: ttsText,
        speed: voiceSpeed,
        volume: voiceVolume,
        pitch: voicePitch,
      });
      const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8002/api";
      const backendBase = apiBase.endsWith("/api") ? apiBase.slice(0, -4) : apiBase;
      const fullUrl = result.audio_url.startsWith("http") ? result.audio_url : `${backendBase}${result.audio_url}`;
      setVoiceSegmentAudioMap((prev) => ({
        ...prev,
        [segmentId]: fullUrl,
      }));
    } catch (error) {
      setVoiceError(error instanceof Error ? error.message : "生成配音失败");
    } finally {
      setVoiceGeneratingSegmentId(null);
    }
  };

  return (
    <>
    <div className="w-full bg-white rounded-xl border border-slate-200 overflow-hidden shadow-sm">
      {(() => {
        let globalRowCursor = rowStartIndex;
        return blocks.map((block, index) => {
        if (block.type === 'text') {
          return (
            <TextBlock 
              key={index} 
              value={block.value} 
              onChange={(v) => updateBlock(index, v)} 
            />
          );
        } else {
          const blockRowBase = globalRowCursor;
          globalRowCursor += block.rows.length;
          return (
            <div key={index} className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead className="text-xs text-slate-500 uppercase bg-slate-50 border-b border-slate-100">
                  <tr>
                    {block.headers.map((header, i) => (
                      <th 
                        key={i} 
                        className={`px-4 py-3 font-medium whitespace-nowrap ${getColumnWidthClass(header)}`}
                      >
                        {header}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {block.rows.map((row, rowIndex) => (
                    <tr key={rowIndex} className="hover:bg-slate-50 group">
                      {block.headers.map((header, colIndex) => {
                        const normalizedHeader = header.replace(/\s+/g, '');
                        const isKlingColumn = normalizedHeader === KLING_COLUMN;
                        const cell = row[colIndex] || '';
                        const globalRowIndex = blockRowBase + rowIndex;
                        const normalized = header.replace(/\s+/g, '');
                        const isDialogueColumn = normalized.includes('内容') || normalized.includes('台词');
                        return (
                          <td 
                            key={colIndex} 
                            className={`px-4 py-3 min-w-[150px] relative align-top ${getColumnWidthClass(header)}`}
                          >
                            {isDialogueColumn && !isKlingColumn ? (
                              <button
                                onClick={(event) => {
                                  event.stopPropagation();
                                  openVoiceModal(index, rowIndex, colIndex, cell);
                                }}
                                className="absolute right-2 top-2 rounded-md border border-indigo-200 bg-white px-2 py-1 text-[11px] text-indigo-700 hover:bg-indigo-50"
                              >
                                生成配音
                              </button>
                            ) : null}
                            {isKlingColumn ? (
                              <div className="flex flex-col items-center gap-2">
                                <select
                                  value={cell || KLING_DEFAULT_SPEC}
                                  onChange={(event) => updateTable(index, rowIndex, colIndex, event.target.value)}
                                  className="w-full rounded border border-slate-200 px-2 py-1 text-xs"
                                >
                                  {KLING_SPEC_OPTIONS.map((option) => (
                                    <option key={option.value} value={option.value}>
                                      {option.label}
                                    </option>
                                  ))}
                                </select>
                                <button
                                  onClick={() =>
                                    onGenerateKlingRow?.({
                                      globalRowIndex,
                                      headers: block.headers,
                                      row: block.headers.map((_, i) => row[i] || ""),
                                      spec: cell || KLING_DEFAULT_SPEC,
                                    })
                                  }
                                  disabled={generatingGlobalRowIndex === globalRowIndex}
                                  className={`rounded px-3 py-1 text-xs text-white ${
                                    generatingGlobalRowIndex === globalRowIndex
                                      ? "bg-slate-400"
                                      : "bg-blue-600 hover:bg-blue-700"
                                  }`}
                                >
                                  {generatingGlobalRowIndex === globalRowIndex ? "生成中..." : "Kling生成"}
                                </button>
                                {generatedRowIndexSet?.has(globalRowIndex) ? (
                                  <span className="text-xs text-green-600">已生成</span>
                                ) : null}
                              </div>
                            ) : (
                              <TableCell
                                value={cell}
                                onChange={(v) => updateTable(index, rowIndex, colIndex, v)}
                                projectId={projectId}
                                projectAssets={projectAssets}
                              />
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
      });
      })()}
    </div>
    {voiceModal ? (
      <div className="fixed inset-0 z-50 overflow-y-auto bg-black/40 px-4 py-6">
        <div className="mx-auto w-full max-w-4xl rounded-2xl border border-slate-200 bg-white shadow-xl">
          <div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-100 bg-white px-5 py-4">
            <div className="text-sm font-semibold text-slate-900">文本转语音</div>
            <button onClick={closeVoiceModal} className="rounded-md px-2 py-1 text-xs text-slate-500 hover:bg-slate-100">关闭</button>
          </div>
          <div className="grid grid-cols-1 gap-4 p-5 lg:grid-cols-[1fr_360px]">
            <div className="space-y-4">
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                <div className="mb-2 text-xs font-semibold text-slate-500">表格内容/台词原文</div>
                <div className="max-h-28 overflow-y-auto whitespace-pre-wrap text-sm text-slate-700">{voiceSourceText || "空"}</div>
              </div>
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold text-slate-800">台词片段</div>
                <button
                  onClick={() => addVoiceSegment("")}
                  className="rounded-lg border border-indigo-200 px-3 py-1.5 text-xs text-indigo-700 hover:bg-indigo-50"
                >
                  + 创建台词
                </button>
              </div>
              <div className="space-y-3 max-h-[420px] overflow-y-auto pr-1">
                {voiceSegments.map((segment, index) => (
                  <div
                    key={segment.id}
                    className={`rounded-xl border p-3 ${
                      activeVoiceSegmentId === segment.id ? "border-indigo-300 bg-indigo-50/30" : "border-slate-200 bg-white"
                    }`}
                  >
                    <div className="mb-2 flex items-center justify-between">
                      <div className="text-xs font-semibold text-slate-600">第 {index + 1} 段</div>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => addVoiceSegment(voiceSourceText)}
                          className="rounded border border-slate-200 px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-50"
                        >
                          复制原文新建
                        </button>
                        <button
                          onClick={() => removeVoiceSegment(segment.id)}
                          disabled={voiceSegments.length <= 1}
                          className="rounded border border-rose-200 px-2 py-1 text-[11px] text-rose-600 hover:bg-rose-50 disabled:opacity-50"
                        >
                          删除
                        </button>
                      </div>
                    </div>
                    <textarea
                      ref={(el) => {
                        voiceTextareaRefs.current[segment.id] = el;
                      }}
                      value={segment.text}
                      onFocus={() => setActiveVoiceSegmentId(segment.id)}
                      onChange={(event) => {
                        updateVoiceSegment(segment.id, event.target.value);
                        requestAnimationFrame(() => syncVoiceSelection(segment.id));
                      }}
                      onSelect={() => syncVoiceSelection(segment.id)}
                      onKeyUp={() => syncVoiceSelection(segment.id)}
                      onMouseUp={() => syncVoiceSelection(segment.id)}
                      className="h-28 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:border-indigo-500"
                      placeholder="在此输入或粘贴本段台词，可在右侧插入标签"
                    />
                    <div className="mt-2 flex items-center justify-between">
                      <div className="text-[11px] text-slate-500">
                        {segment.text.length} 字符 · 已选 {activeVoiceSegmentId === segment.id ? voiceSelection.text.length : 0} 字符
                      </div>
                      <button
                        onClick={() => generateVoiceForSegment(segment.id)}
                        disabled={voiceGeneratingSegmentId === segment.id || !segment.text.trim() || !voiceCharacter}
                        className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs text-white hover:bg-indigo-700 disabled:opacity-50"
                      >
                        {voiceGeneratingSegmentId === segment.id ? "生成中..." : "生成该段语音"}
                      </button>
                    </div>
                    {voiceSegmentAudioMap[segment.id] ? (
                      <audio
                        ref={(el) => {
                          voiceAudioRefs.current[segment.id] = el;
                        }}
                        controls
                        src={voiceSegmentAudioMap[segment.id]}
                        className="mt-2 h-10 w-full"
                      />
                    ) : null}
                  </div>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={applyVoiceTextToCell}
                  disabled={!combinedVoiceText}
                  className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                  应用全部片段到单元格
                </button>
              </div>
              {voiceError ? <div className="text-xs text-rose-600">{voiceError}</div> : null}
            </div>
            <div className="space-y-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
              <div>
                <div className="mb-2 text-xs font-semibold text-slate-700">说话人</div>
                <select
                  value={voiceCharacter}
                  onChange={(event) => setVoiceCharacter(event.target.value)}
                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm"
                >
                  {projectVoices.map((voice) => (
                    <option key={voice.id} value={voice.character_name}>
                      {voice.character_name}
                    </option>
                  ))}
                </select>
                {projectVoices.length === 0 ? (
                  <div className="mt-2 text-[11px] text-amber-600">未检测到角色音色，请先在 Step2 配置。</div>
                ) : null}
              </div>
              <div>
                <div className="mb-2 flex items-center justify-between text-xs font-semibold text-slate-700">
                  <span>生成音量</span>
                  <span>{voiceVolume}</span>
                </div>
                <input
                  type="range"
                  min={-12}
                  max={12}
                  step={1}
                  value={voiceVolume}
                  onChange={(event) => setVoiceVolume(Number(event.target.value))}
                  className="w-full accent-indigo-600"
                />
              </div>
              <div>
                <div className="mb-2 flex items-center justify-between text-xs font-semibold text-slate-700">
                  <span>生成语速</span>
                  <span>{voiceSpeed.toFixed(1)}x</span>
                </div>
                <input
                  type="range"
                  min={0.5}
                  max={2}
                  step={0.1}
                  value={voiceSpeed}
                  onChange={(event) => setVoiceSpeed(Number(event.target.value))}
                  className="w-full accent-indigo-600"
                />
              </div>
              <div>
                <div className="mb-2 flex items-center justify-between text-xs font-semibold text-slate-700">
                  <span>生成音高</span>
                  <span>{voicePitch > 0 ? `+${voicePitch.toFixed(1)}` : voicePitch.toFixed(1)}</span>
                </div>
                <input
                  type="range"
                  min={-2}
                  max={2}
                  step={0.1}
                  value={voicePitch}
                  onChange={(event) => setVoicePitch(Number(event.target.value))}
                  className="w-full accent-indigo-600"
                />
              </div>
              <div className="space-y-3 border-t border-slate-200 pt-4">
                <div className="text-xs font-semibold text-slate-700">Fish 标签库</div>
                <div className="grid grid-cols-5 gap-1">
                  {VOICE_TAG_GROUPS.map((group) => (
                    <button
                      key={group.key}
                      onClick={() => setVoiceTagGroupKey(group.key)}
                      className={`rounded px-1.5 py-1 text-[10px] ${
                        voiceTagGroupKey === group.key
                          ? "bg-indigo-600 text-white"
                          : "bg-white text-slate-600 border border-slate-200 hover:bg-slate-100"
                      }`}
                    >
                      {group.title}
                    </button>
                  ))}
                </div>
                <div className="max-h-[300px] overflow-y-auto space-y-2 rounded-lg border border-slate-200 bg-white p-2">
                  {activeTagGroup.tags.map((item) => (
                    <button
                      key={item.tag}
                      onClick={() => insertVoiceTag(item.tag)}
                      className="w-full rounded border border-violet-200 bg-violet-50 px-2 py-1.5 text-left hover:bg-violet-100"
                    >
                      <div className="text-[11px] font-medium text-violet-800">{item.label} {item.tag}</div>
                      <div className="text-[10px] text-violet-600">{item.desc}</div>
                    </button>
                  ))}
                </div>
                <div className="space-y-2 rounded-lg border border-slate-200 bg-white p-2">
                  <div className="text-[11px] font-medium text-slate-700">强度调节</div>
                  <div className="grid grid-cols-3 gap-1">
                    {[
                      { key: "slightly" as const, label: "轻微" },
                      { key: "very" as const, label: "明显" },
                      { key: "extremely" as const, label: "极强" },
                    ].map((item) => (
                      <button
                        key={item.key}
                        onClick={() => setVoiceEmotionIntensity(item.key)}
                        className={`rounded px-2 py-1 text-[11px] ${
                          voiceEmotionIntensity === item.key
                            ? "bg-indigo-600 text-white"
                            : "border border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100"
                        }`}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                  <div className="text-[10px] text-slate-500">
                    当前情绪标签示例：({voiceEmotionIntensity} happy)
                  </div>
                </div>
                <div className="space-y-2 rounded-lg border border-slate-200 bg-white p-2">
                  <div className="text-[11px] font-medium text-slate-700">重音</div>
                  <div className="grid grid-cols-3 gap-1">
                    {[
                      { key: "slight" as const, label: "轻重音", tag: "[slight emphasis]" },
                      { key: "normal" as const, label: "标准", tag: "[emphasis]" },
                      { key: "strong" as const, label: "强重音", tag: "[strong emphasis]" },
                    ].map((item) => (
                      <button
                        key={item.key}
                        onClick={() => setVoiceAccentLevel(item.key)}
                        className={`rounded px-2 py-1 text-[11px] ${
                          voiceAccentLevel === item.key
                            ? "bg-indigo-600 text-white"
                            : "border border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100"
                        }`}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                  <div className="flex items-center justify-between">
                    <div className="text-[10px] text-slate-500">
                      当前重音标签：{voiceAccentLevel === "slight" ? "[slight emphasis]" : voiceAccentLevel === "strong" ? "[strong emphasis]" : "[emphasis]"}
                    </div>
                    <button
                      onClick={insertAccentTag}
                      className="rounded border border-indigo-200 px-2 py-1 text-[11px] text-indigo-700 hover:bg-indigo-50"
                    >
                      插入重音
                    </button>
                  </div>
                </div>
                <div className="space-y-2 rounded-lg border border-slate-200 bg-white p-2">
                  <div className="text-[11px] font-medium text-slate-700">自定义停顿</div>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={0.2}
                      max={8}
                      step={0.1}
                      value={voicePauseSeconds}
                      onChange={(event) => setVoicePauseSeconds(Number(event.target.value))}
                      className="w-20 rounded border border-slate-200 px-2 py-1 text-[11px] text-slate-700"
                    />
                    <span className="text-[11px] text-slate-500">秒</span>
                    <button
                      onClick={insertCustomPause}
                      className="rounded border border-indigo-200 px-2 py-1 text-[11px] text-indigo-700 hover:bg-indigo-50"
                    >
                      插入停顿
                    </button>
                  </div>
                  <div className="text-[10px] text-slate-500">
                    将插入 (pause:{Math.max(0.2, Math.min(8, voicePauseSeconds || 1.2)).toFixed(1)}s)，后端会转换为停顿控制标签。
                  </div>
                </div>
                <div className="text-[11px] text-slate-500">
                  先点击某个“台词片段”输入框，再点标签即可插入到该片段光标或选中位置。
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    ) : null}
    </>
  );
}

function TableCell({ value, onChange, projectId, projectAssets }: { value: string, onChange: (v: string) => void, projectId?: string, projectAssets?: any[] }) {
  const [isEditing, setIsEditing] = useState(false);
  const [assetImages, setAssetImages] = useState<{id: string, url: string}[]>([]);

  // Parse asset IDs and text for display
  const { displayText, assetIds } = React.useMemo(() => {
    // Allow optional whitespace after colon
    const assetIdRegex = /\[AssetID:\s*([a-zA-Z0-9-]+)\]/g;
    const ids: string[] = [];
    let text = value;
    let match;
    
    // Extract IDs
    while ((match = assetIdRegex.exec(value)) !== null) {
      ids.push(match[1]);
    }
    
    // Remove tags for display
    text = value.replace(assetIdRegex, '').trim();
    
    return { displayText: text, assetIds: ids };
  }, [value]);

  useEffect(() => {
    if (assetIds.length > 0 && projectId && projectAssets && projectAssets.length > 0) {
      const selectedImages: {id: string, url: string}[] = [];
      for (const asset of projectAssets) {
        if (assetIds.includes(asset.id)) {
          const selectedVersion = asset.versions?.find((v: any) => v.is_selected);
          if (selectedVersion && selectedVersion.image_url) {
            selectedImages.push({
              id: asset.id,
              url: `/api/projects/${projectId}/assets/${asset.id}/image`
            });
          }
        }
      }
      setAssetImages(selectedImages);
    } else {
       setAssetImages([]);
    }
  }, [assetIds, projectId, projectAssets]);

  if (isEditing) {
    return (
      <AutoResizeTextarea
        autoFocus
        value={value}
        onChange={(v) => onChange(v)}
        onBlur={() => setIsEditing(false)}
        className="w-full bg-transparent border border-blue-200 rounded p-1 text-slate-700 resize-none overflow-hidden min-h-[24px] leading-relaxed focus:outline-none focus:ring-1 focus:ring-blue-500"
      />
    );
  }

  return (
    <div 
      onClick={() => setIsEditing(true)}
      className="min-h-[24px] cursor-text"
    >
      <div className="whitespace-pre-wrap text-slate-700 leading-relaxed">
        {displayText || <span className="text-slate-300 italic">空</span>}
      </div>
      
      {assetImages.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {assetImages.map((img) => (
            <div key={img.id} className="relative group/img">
               <img 
                 src={img.url} 
                 alt="Asset" 
                 className="w-16 h-16 object-cover rounded border border-slate-200 shadow-sm"
                 onError={(e) => {
                   // Show placeholder for broken images
                   const target = e.target as HTMLImageElement;
                   target.onerror = null; // Prevent infinite loop
                   target.src = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2NCIgaGVpZ2h0PSI2NCIgdmlld0JveD0iMCAwIDY0IDY0IiBmaWxsPSJub25lIiBzdHJva2U9IiM5NGEzYjgiIHN0cm9rZS13aWR0aD0iMiI+PHJlY3QgeD0iMiIgeT0iMiIgd2lkdGg9IjYwIiBoZWlnaHQ9IjYwIiByeD0iNCIvPjx0ZXh0IHg9IjMyIiB5PSIzNSIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZm9udC1mYW1pbHk9InNhbnMtc2VyaWYiIGZvbnQtc2l6ZT0iMTQiIGZpbGw9IiM5NGEzYjgiPkltZzwvdGV4dD48L3N2Zz4=';
                   target.title = `Image load failed: ${img.id}`;
                 }}
               />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AutoResizeTextarea({ value, onChange, className, ...props }: { value: string, onChange: (v: string) => void, className?: string } & Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'onChange'>) {
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

  // Adjust on mount and window resize
  useEffect(() => {
    adjustHeight();
    window.addEventListener('resize', adjustHeight);
    return () => window.removeEventListener('resize', adjustHeight);
  }, [adjustHeight]);

  return (
    <textarea
      ref={textareaRef}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={className}
      rows={1}
      {...props}
    />
  );
}

function TextBlock({ value, onChange }: { value: string, onChange: (v: string) => void }) {
  const [isEditing, setIsEditing] = useState(false);

  if (isEditing) {
    return (
      <div className="p-4 border-b border-slate-100 last:border-0 relative group">
        <AutoResizeTextarea
          autoFocus
          value={value}
          onChange={onChange}
          onBlur={() => setIsEditing(false)}
          className="w-full min-h-[100px] resize-none outline-none text-slate-700 leading-relaxed font-mono text-sm bg-slate-50 p-2 rounded overflow-hidden"
          placeholder="输入剧本内容..."
        />
      </div>
    );
  }

  return (
    <div 
      onClick={() => setIsEditing(true)}
      className="p-4 border-b border-slate-100 last:border-0 cursor-text min-h-[50px] hover:bg-slate-50 transition-colors"
    >
      {value.split('\n').map((line, i) => {
         const trimmed = line.trim();
         // Headers
         if (trimmed.startsWith('# ')) return <h1 key={i} className="text-2xl font-bold mb-4 text-slate-900">{trimmed.substring(2)}</h1>;
         if (trimmed.startsWith('## ')) return <h2 key={i} className="text-xl font-bold mb-3 text-slate-800">{trimmed.substring(3)}</h2>;
         if (trimmed.startsWith('### ')) return <h3 key={i} className="text-lg font-bold mb-2 text-slate-800">{trimmed.substring(4)}</h3>;
         
         // List items
         if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
           return (
             <div key={i} className="flex items-start mb-1 ml-4">
               <span className="mr-2">•</span>
               <span>{renderInlineMarkdown(trimmed.substring(2))}</span>
             </div>
           );
         }

         // Empty lines
         if (!trimmed) return <div key={i} className="h-4"></div>;

         // Regular paragraph
         return (
           <div key={i} className="mb-2 text-slate-700 leading-relaxed">
             {renderInlineMarkdown(line)}
           </div>
         );
      })}
    </div>
  );
}

function renderInlineMarkdown(text: string) {
  // Simple bold parsing: **text**
  const parts = text.split(/(\*\*.*?\*\*)/g);
  return parts.map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={index} className="font-bold text-slate-900">{part.slice(2, -2)}</strong>;
    }
    return part;
  });
}
