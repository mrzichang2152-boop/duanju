"use client";

import { useState, useRef, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { generateScript, saveScript, parseScriptFile, CharacterProfile } from "@/lib/api";
import { getToken } from "@/lib/auth";

// AutoResizeTextarea component
function AutoResizeTextarea({
  value,
  onChange,
  className,
  placeholder,
  minHeight = "100px"
}: {
  value: string;
  onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  className?: string;
  placeholder?: string;
  minHeight?: string;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = "auto";
      textarea.style.height = `${textarea.scrollHeight}px`;
    }
  }, [value]);

  return (
    <textarea
      ref={textareaRef}
      value={value}
      onChange={onChange}
      className={className}
      rows={1}
      placeholder={placeholder}
      style={{ resize: "none", overflow: "hidden", minHeight }}
    />
  );
}

// AI Continuation Modal
function AIContinueModal({
  isOpen,
  onClose,
  onSubmit,
  loading
}: {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (prompt: string) => void;
  loading: boolean;
}) {
  const [prompt, setPrompt] = useState("");

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg p-6 m-4">
        <h3 className="text-xl font-bold mb-4 text-slate-900">AI 续写设置</h3>
        <p className="text-sm text-slate-500 mb-4">
          AI 将根据已有的剧本内容、写作规范和角色设定为您续写新的集数。请输入您对后续剧情的具体要求。
        </p>
        <textarea
          className="w-full p-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-slate-500 focus:border-transparent outline-none mb-6 min-h-[120px]"
          placeholder="请输入续写要求（例如：主角遭遇重大挫折，反派登场...）"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
        <div className="flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
            disabled={loading}
          >
            取消
          </button>
          <button
            onClick={() => onSubmit(prompt)}
            disabled={loading || !prompt.trim()}
            className="px-4 py-2 bg-slate-900 text-white rounded-lg hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? "正在生成..." : "开始续写"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function SetupPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  const [theme, setTheme] = useState("");
  const [characters, setCharacters] = useState<CharacterProfile[]>([{ name: "", bio: "" }]);
  
  // Episode Versioning Types
  interface EpisodeVersion {
    id: string;
    content: string;
    createdAt: number;
    prompt?: string;
  }

  interface Episode {
    id: string;
    versions: EpisodeVersion[];
    selectedVersionId: string;
  }

  // Initialize with one empty episode
  const [episodes, setEpisodes] = useState<Episode[]>(() => {
    const verId = crypto.randomUUID();
    return [{
      id: crypto.randomUUID(),
      versions: [{ id: verId, content: "", createdAt: Date.now() }],
      selectedVersionId: verId
    }];
  });
  
  // Modification State
  const [modifyingEpId, setModifyingEpId] = useState<string | null>(null);
  const [modifyPrompt, setModifyPrompt] = useState("");
  const [isModifying, setIsModifying] = useState(false);
  
  // Collapsed state
  const [isCharsSectionCollapsed, setIsCharsSectionCollapsed] = useState(false);
  const [collapsedChars, setCollapsedChars] = useState<Set<number>>(new Set());
  const [collapsedEps, setCollapsedEps] = useState<Set<string>>(new Set()); // Changed to Set<string> (episode IDs)

  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // AI Continuation State
  const [showContinueModal, setShowContinueModal] = useState(false);
  const [continuing, setContinuing] = useState(false);

  const toggleChar = (index: number) => {
    const newSet = new Set(collapsedChars);
    if (newSet.has(index)) newSet.delete(index);
    else newSet.add(index);
    setCollapsedChars(newSet);
  };

  const toggleEp = (id: string) => {
    const newSet = new Set(collapsedEps);
    if (newSet.has(id)) newSet.delete(id);
    else newSet.add(id);
    setCollapsedEps(newSet);
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const token = getToken();
    if (!token) {
      router.push("/login");
      return;
    }

    setUploading(true);
    setError(null);

    try {
      const result = await parseScriptFile(token, file);
      // setTheme(result.theme); // Disabled as per user request
      setCharacters(result.characters.length > 0 ? result.characters : [{ name: "", bio: "" }]);
      
      if (result.episodes.length > 0) {
        const newEpisodes: Episode[] = result.episodes.map(content => {
          const verId = crypto.randomUUID();
          return {
            id: crypto.randomUUID(),
            versions: [{ id: verId, content, createdAt: Date.now(), prompt: "Initial Import" }],
            selectedVersionId: verId
          };
        });
        setEpisodes(newEpisodes);
      } else {
        const verId = crypto.randomUUID();
        setEpisodes([{
          id: crypto.randomUUID(),
          versions: [{ id: verId, content: "", createdAt: Date.now() }],
          selectedVersionId: verId
        }]);
      }
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "文件解析失败");
    } finally {
      setUploading(false);
      // Reset file input so user can upload same file again if needed
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  };

  const handleAddCharacter = () => setCharacters([...characters, { name: "", bio: "" }]);
  const handleRemoveCharacter = (index: number) => {
    const newChars = [...characters];
    newChars.splice(index, 1);
    setCharacters(newChars);
    
    const newCollapsed = new Set<number>();
    collapsedChars.forEach(i => {
      if (i < index) newCollapsed.add(i);
      else if (i > index) newCollapsed.add(i - 1);
    });
    setCollapsedChars(newCollapsed);
  };
  const handleCharacterChange = (index: number, field: keyof CharacterProfile, value: string) => {
    const newChars = [...characters];
    newChars[index] = { ...newChars[index], [field]: value };
    setCharacters(newChars);
  };

  const handleAddEpisode = () => {
    const verId = crypto.randomUUID();
    setEpisodes([...episodes, {
      id: crypto.randomUUID(),
      versions: [{ id: verId, content: "", createdAt: Date.now() }],
      selectedVersionId: verId
    }]);
  };
  
  const handleRemoveEpisode = (index: number) => {
    const epToRemove = episodes[index];
    const newEps = [...episodes];
    newEps.splice(index, 1);
    setEpisodes(newEps);
    
    if (epToRemove) {
      const newCollapsed = new Set(collapsedEps);
      newCollapsed.delete(epToRemove.id);
      setCollapsedEps(newCollapsed);
    }
  };

  const handleEpisodeChange = (index: number, value: string) => {
    const newEps = [...episodes];
    const ep = newEps[index];
    const currentVerIndex = ep.versions.findIndex(v => v.id === ep.selectedVersionId);
    if (currentVerIndex !== -1) {
      const newVersions = [...ep.versions];
      newVersions[currentVerIndex] = { ...newVersions[currentVerIndex], content: value };
      newEps[index] = { ...ep, versions: newVersions };
      setEpisodes(newEps);
    }
  };

  const handleSwitchVersion = (epIndex: number, versionId: string) => {
    const newEps = [...episodes];
    newEps[epIndex] = { ...newEps[epIndex], selectedVersionId: versionId };
    setEpisodes(newEps);
  };

  const handleModifyEpisode = async (epIndex: number) => {
    if (!modifyPrompt.trim()) return;
    
    const token = getToken();
    if (!token) {
      router.push("/login");
      return;
    }

    setIsModifying(true);
    setError(null);

    // Construct Context
    // Use the *selected* version content for all episodes to form the context
    const fullScript = episodes.map((e, i) => {
      const ver = e.versions.find(v => v.id === e.selectedVersionId);
      return `第${i + 1}集：${ver?.content || ""}`;
    }).join("\n");

    const context = `
【写作规范】
${theme || "无"}

【角色设定】
${characters.map((c, i) => `角色${i + 1}（${c.name}）：${c.bio || "暂无简介"}`).join("\n")}

【完整剧本】
${fullScript}
    `.trim();

    try {
      // We are modifying the specific episode at epIndex
      // The instruction is the user prompt
      // We pass the full context
      // And we might want to explicitly say "Modify Episode X" in the instruction wrapper if the backend doesn't know X.
      // But our backend prompt says "对【指定集数】的内容进行修改". 
      // So we should include "请修改第X集：..." in the instruction passed to backend?
      // Or just pass the instruction and let the system prompt handle it combined with the fact that we are focusing on it?
      // The backend prompt uses:
      // user_prompt = f"""{context_block}\n\n【修改要求】\n{instruction_block}"""
      // So we should make sure the instruction is clear about WHICH episode.
      
      const targetEpLabel = `第${epIndex + 1}集`;
      const finalInstruction = `针对${targetEpLabel}进行修改。修改要求：${modifyPrompt}`;

      const result = await generateScript(token, params.id, {
        mode: "step0_modify",
        content: context,
        instruction: finalInstruction
      });

      // Add new version
      const newVerId = crypto.randomUUID();
      const newVersion: EpisodeVersion = {
        id: newVerId,
        content: result.content, // Assuming result.content is the new episode text
        createdAt: Date.now(),
        prompt: modifyPrompt
      };

      const newEps = [...episodes];
      newEps[epIndex] = {
        ...newEps[epIndex],
        versions: [...newEps[epIndex].versions, newVersion],
        selectedVersionId: newVerId
      };
      setEpisodes(newEps);
      
      // Reset modification state
      setModifyPrompt("");
      setModifyingEpId(null);
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "修改失败");
    } finally {
      setIsModifying(false);
    }
  };

  const handleAIContinue = async (prompt: string) => {
    const token = getToken();
    if (!token) {
      router.push("/login");
      return;
    }

    setContinuing(true);
    setError(null);

    // Construct full context using selected versions
    const context = `
【基础写作规范】
${theme || "无"}

【上文分集内容】
${episodes.map((e, i) => {
  const ver = e.versions.find(v => v.id === e.selectedVersionId);
  return `第${i + 1}集：${ver?.content || ""}`;
}).join("\n")}

【角色设定信息】
${characters.map((c, i) => `${c.name}：${c.bio || "暂无简介"}`).join("\n")}

【用户续写要求】
${prompt}
    `.trim();

    try {
      const result = await generateScript(token, params.id, {
        mode: "step0_continue",
        content: context,
        instruction: prompt
      });
      
      const verId = crypto.randomUUID();
      const newEpisode: Episode = {
        id: crypto.randomUUID(),
        versions: [{ id: verId, content: result.content, createdAt: Date.now(), prompt: "AI Continuation" }],
        selectedVersionId: verId
      };
      
      setEpisodes([...episodes, newEpisode]);
      setShowContinueModal(false);
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "续写失败");
    } finally {
      setContinuing(false);
    }
  };

  const handleGenerate = async () => {
    const token = getToken();
    if (!token) {
      router.push("/login");
      return;
    }

    if (!theme.trim()) {
      setError("请输入写作规范");
      return;
    }

    setLoading(true);
    setError(null);

    const fullScript = episodes.map((e, i) => {
      const ver = e.versions.find(v => v.id === e.selectedVersionId);
      return `第${i + 1}集：${ver?.content || ""}`;
    }).join("\n");

    const prompt = `
【写作规范】
${theme}

【角色设定】
${characters.map((c, i) => `角色${i + 1}（${c.name}）：${c.bio || "暂无简介"}`).join("\n")}

【分集大纲】
${fullScript}
    `.trim();

    try {
      // Generate the script using the new step0_generate mode
      const result = await generateScript(token, params.id, {
        mode: "step0_generate",
        content: "", 
        instruction: prompt
      });

      // Save the generated script
      await saveScript(token, params.id, result.content);

      // Navigate to Step 1 (Input/Modify page)
      router.push(`/projects/${params.id}/script/input`);
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "生成失败");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-[1600px] mx-auto p-6">
      <h1 className="text-2xl font-bold mb-6">Step 0: 脚本向导</h1>
      
      <div className="space-y-8">
        {/* Upload, Norms, Characters, Episodes */}
        
        {/* File Upload */}
        <div className="p-6 bg-slate-50 border border-dashed border-slate-300 rounded-lg">
          <h2 className="text-lg font-medium text-slate-700 mb-2">自动提取内容</h2>
          <p className="text-sm text-slate-500 mb-4">
            您可以上传剧本文件（txt, word, pdf），AI将自动提取角色和分集大纲。
          </p>
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileUpload}
            className="hidden"
            accept=".txt,.md,.docx,.pdf"
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading || loading}
            className="px-4 py-2 bg-white border border-slate-300 rounded-md shadow-sm text-sm font-medium text-slate-700 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-slate-500 disabled:opacity-50"
          >
            {uploading ? "正在解析..." : "上传剧本文件"}
          </button>
        </div>

        {/* Writing Norms */}
        <div>
          <label className="block text-lg font-semibold text-slate-700 mb-4">写作规范</label>
          <AutoResizeTextarea
            className="w-full p-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-slate-500 focus:border-transparent outline-none"
            value={theme}
            onChange={(e) => setTheme(e.target.value)}
            placeholder="请输入写作规范（如：文风要求、格式禁忌、特殊强调等）..."
            minHeight="120px"
          />
        </div>

        {/* Characters (Collapsible) */}
        <div className="bg-slate-50 p-6 rounded-lg border border-slate-200">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-lg font-semibold text-slate-800">角色设定</h2>
            <button
              onClick={() => setIsCharsSectionCollapsed(!isCharsSectionCollapsed)}
              className="text-slate-500 hover:text-slate-700 text-sm font-medium px-2 py-1"
            >
              {isCharsSectionCollapsed ? "展开" : "收起"}
            </button>
          </div>
          
          {!isCharsSectionCollapsed && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {characters.map((char, index) => (
                  <div key={index} className="flex flex-col gap-2 p-4 border border-slate-200 rounded-lg bg-white shadow-sm">
                    <div className="flex justify-between items-center">
                      <div className="font-medium text-slate-700 truncate pr-2" title={char.name || `角色 ${index + 1}`}>
                        {char.name || `角色 ${index + 1}`}
                      </div>
                      <div className="flex gap-2 text-sm flex-shrink-0">
                        <button 
                          onClick={() => toggleChar(index)}
                          className="text-slate-500 hover:text-slate-700 px-2 py-1"
                        >
                          {collapsedChars.has(index) ? "展开" : "收起"}
                        </button>
                        {characters.length > 1 && (
                          <button
                            onClick={() => handleRemoveCharacter(index)}
                            className="text-red-500 hover:text-red-700 px-2 py-1"
                          >
                            删除
                          </button>
                        )}
                      </div>
                    </div>
                    {!collapsedChars.has(index) && (
                      <>
                        <input
                          type="text"
                          className="w-full p-2 border border-slate-300 rounded-md focus:ring-2 focus:ring-slate-500 focus:border-transparent outline-none text-sm font-medium"
                          placeholder="角色姓名"
                          value={char.name}
                          onChange={(e) => handleCharacterChange(index, "name", e.target.value)}
                        />
                        <AutoResizeTextarea
                          className="w-full p-2 border border-slate-300 rounded-md focus:ring-2 focus:ring-slate-500 focus:border-transparent outline-none text-sm"
                          placeholder="人物小传/描述"
                          value={char.bio}
                          onChange={(e) => handleCharacterChange(index, "bio", e.target.value)}
                          minHeight="120px"
                        />
                      </>
                    )}
                  </div>
                ))}
              </div>
              <button
                onClick={handleAddCharacter}
                className="mt-4 flex w-full items-center justify-center p-4 border-2 border-dashed border-slate-300 rounded-lg hover:border-slate-400 hover:bg-slate-50 text-slate-500 transition-colors"
              >
                + 添加角色
              </button>
            </div>
          )}
        </div>

        {/* Episodes */}
        <div>
          <h2 className="text-lg font-semibold mb-4">剧本正文</h2>
          <div className="space-y-4">
            {episodes.map((ep, index) => {
              const currentVersion = ep.versions.find(v => v.id === ep.selectedVersionId);
              return (
                <div key={ep.id} className="flex flex-col gap-2 p-4 border border-slate-200 rounded-lg bg-white shadow-sm">
                  <div className="flex justify-between items-center">
                    <div className="font-medium text-slate-700">第{index + 1}集</div>
                    <div className="flex gap-2 text-sm">
                      <button 
                        onClick={() => toggleEp(ep.id)}
                        className="text-slate-500 hover:text-slate-700 px-2 py-1"
                      >
                        {collapsedEps.has(ep.id) ? "展开" : "收起"}
                      </button>
                      {episodes.length > 1 && (
                        <button
                          onClick={() => handleRemoveEpisode(index)}
                          className="text-red-500 hover:text-red-700 px-2 py-1"
                        >
                          删除
                        </button>
                      )}
                    </div>
                  </div>
                  {!collapsedEps.has(ep.id) && (
                    <>
                      {/* Version Selector */}
                      {ep.versions.length > 1 && (
                        <div className="flex gap-2 mb-2 overflow-x-auto pb-2">
                          {ep.versions.map((ver, vIndex) => (
                            <button
                              key={ver.id}
                              onClick={() => handleSwitchVersion(index, ver.id)}
                              className={`px-3 py-1 text-xs rounded-full border transition-colors whitespace-nowrap ${
                                ver.id === ep.selectedVersionId 
                                  ? 'bg-slate-800 text-white border-slate-800' 
                                  : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                              }`}
                              title={ver.prompt ? `提示词: ${ver.prompt}` : `版本 ${vIndex + 1}`}
                            >
                              版本 {vIndex + 1}
                            </button>
                          ))}
                        </div>
                      )}
                      
                      <AutoResizeTextarea
                        className="w-full p-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-slate-500 focus:border-transparent outline-none"
                        value={currentVersion?.content || ""}
                        onChange={(e) => handleEpisodeChange(index, e.target.value)}
                        placeholder={`请输入第${index + 1}集的主要剧情...`}
                        minHeight="150px"
                      />
                      
                      {/* Modification Input */}
                      <div className="mt-3 pt-3 border-t border-slate-100">
                        <div className="flex gap-2 items-center">
                          <div className="flex-1 relative">
                            <input
                              type="text"
                              placeholder="输入修改要求，AI将为您生成新版本..."
                              className="w-full pl-3 pr-10 py-2 border border-slate-300 rounded-md text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none transition-shadow"
                              value={modifyingEpId === ep.id ? modifyPrompt : ""}
                              onChange={(e) => {
                                if (modifyingEpId !== ep.id) {
                                  setModifyingEpId(ep.id);
                                  setModifyPrompt(e.target.value);
                                } else {
                                  setModifyPrompt(e.target.value);
                                }
                              }}
                              onFocus={() => {
                                if (modifyingEpId !== ep.id) {
                                  setModifyingEpId(ep.id);
                                  setModifyPrompt("");
                                }
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' && !isModifying && modifyPrompt.trim()) {
                                  handleModifyEpisode(index);
                                }
                              }}
                            />
                          </div>
                          <button
                            onClick={() => handleModifyEpisode(index)}
                            disabled={isModifying || (modifyingEpId === ep.id && !modifyPrompt.trim()) || (modifyingEpId !== ep.id && !modifyPrompt.trim() && modifyingEpId !== null)} 
                            className="px-4 py-2 bg-indigo-600 text-white text-sm rounded-md hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap shadow-sm transition-colors flex items-center gap-2"
                          >
                            {isModifying && modifyingEpId === ep.id ? (
                              <>
                                <span className="animate-spin text-white">⟳</span>
                                修改中...
                              </>
                            ) : (
                              "AI 修改"
                            )}
                          </button>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>
          <div className="mt-4 flex gap-4">
            <button
              onClick={handleAddEpisode}
              className="px-4 py-2 text-sm text-slate-600 border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors"
            >
              + 添加集数
            </button>
            <button
              onClick={() => setShowContinueModal(true)}
              className="px-4 py-2 text-sm text-indigo-600 border border-indigo-200 bg-indigo-50 rounded-lg hover:bg-indigo-100 transition-colors flex items-center gap-2"
            >
              ✨ AI 续写
            </button>
          </div>
        </div>
      </div>

      {/* Footer: Error & Generate */}
      <div className="mt-8 pt-6 border-t border-slate-200 flex flex-col items-end gap-4">
        {error && (
          <div className="p-4 bg-red-50 text-red-700 rounded-lg border border-red-100 w-full md:w-auto">
            {error}
          </div>
        )}
        <button
          onClick={handleGenerate}
          disabled={loading}
          className="px-8 py-4 bg-slate-900 text-white rounded-lg hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed font-medium transition-colors text-lg shadow-lg w-full md:w-auto"
        >
          {loading ? "正在生成剧本..." : "生成剧本"}
        </button>
      </div>

      {/* AI Continuation Modal */}
      <AIContinueModal
        isOpen={showContinueModal}
        onClose={() => setShowContinueModal(false)}
        onSubmit={handleAIContinue}
        loading={continuing}
      />
    </div>
  );
}
