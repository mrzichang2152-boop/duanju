"use client";

import { useEffect, useRef, useState } from "react";
import { CharacterVoice, uploadCharacterVoiceSampleOnly } from "@/lib/api";
import { getToken } from "@/lib/auth";

interface VoiceSelectorProps {
  projectId: string;
  characterName: string;
  initialVoice?: CharacterVoice | null;
  onVoiceUpdate: (voice: CharacterVoice) => void;
}

const detectAudioDuration = async (file: File): Promise<number | null> =>
  new Promise((resolve) => {
    const objectUrl = URL.createObjectURL(file);
    const audio = new Audio();
    let settled = false;
    const finalize = (duration: number | null) => {
      if (settled) return;
      settled = true;
      audio.pause();
      audio.src = "";
      URL.revokeObjectURL(objectUrl);
      resolve(duration);
    };
    const timeoutId = setTimeout(() => finalize(null), 5000);
    audio.preload = "metadata";
    audio.onloadedmetadata = () => {
      clearTimeout(timeoutId);
      const duration = Number(audio.duration);
      if (Number.isFinite(duration) && duration > 0) {
        finalize(duration);
        return;
      }
      finalize(null);
    };
    audio.onerror = () => {
      clearTimeout(timeoutId);
      finalize(null);
    };
    audio.src = objectUrl;
  });

export function VoiceSelector({
  projectId,
  characterName,
  initialVoice,
  onVoiceUpdate,
}: VoiceSelectorProps) {
  const [currentVoice, setCurrentVoice] = useState<CharacterVoice | null>(initialVoice ?? null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [duration, setDuration] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setCurrentVoice(initialVoice ?? null);
  }, [initialVoice]);

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] || null;
    event.target.value = "";
    if (!file) return;

    setError("");
    setStatus("");
    if (!file.type.startsWith("audio/")) {
      setError("仅支持音频文件");
      return;
    }

    const detectedDuration = await detectAudioDuration(file);
    setDuration(detectedDuration);
    if (!detectedDuration || detectedDuration < 5 || detectedDuration > 30) {
      setError("音频时长需在 5-30 秒");
      return;
    }

    const token = getToken();
    if (!token) {
      window.location.href = "/login";
      return;
    }

    try {
      setUploading(true);
      setStatus("上传中...");
      const updated = await uploadCharacterVoiceSampleOnly(token, projectId, characterName, file, {
        title: `${characterName}-voice`,
        duration_sec: detectedDuration,
      });
      setCurrentVoice(updated);
      onVoiceUpdate(updated);
      setStatus("样本上传成功（未自动创建 Kling 音色）");
    } catch (err) {
      setError(err instanceof Error ? err.message : "上传失败");
      setStatus("");
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="space-y-2 rounded-lg border border-slate-200 bg-white p-3">
      <div className="flex items-center gap-2">
        <audio controls src={currentVoice?.preview_url || undefined} className="h-8 min-w-0 flex-1" />
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
          className="shrink-0 rounded bg-indigo-600 px-3 py-1.5 text-xs text-white hover:bg-indigo-700 disabled:opacity-50"
        >
          {uploading ? "上传中..." : "上传5-30秒音频"}
        </button>
      </div>
      <div className="text-[11px] text-slate-500">
        仅支持 5-30 秒音频，上传后仅保存样本，不会自动创建 Kling 自定义音色。
      </div>
      {duration ? <div className="text-[11px] text-slate-500">最近音频时长：{duration.toFixed(1)} 秒</div> : null}
      {status ? <div className="text-[11px] text-emerald-600">{status}</div> : null}
      {error ? <div className="text-[11px] text-rose-600">{error}</div> : null}
      <input ref={inputRef} type="file" accept="audio/*" className="hidden" onChange={handleFileChange} />
    </div>
  );
}
