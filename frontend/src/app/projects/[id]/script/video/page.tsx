"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  CharacterVoice,
  deleteEpisodeAudioSegment,
  deleteEpisodeSfxVersion,
  extractEpisodeOriginalVocal,
  extractEpisodeAudioPipeline,
  Episode,
  EpisodeAudioPipelineResult,
  FreeSoundSound,
  FreeSoundTag,
  EpisodeSfxSegmentResult,
  ElevenLabsModel,
  ElevenLabsVoiceModel,
  generateEpisodeSfxAudio,
  generateEpisodeSegmentS2S,
  getFreeSoundTags,
  getElevenLabsModels,
  getElevenLabsVoices,
  getProjectVoices,
  mergeEpisodeDubbedAudio,
  muxEpisodeDubbedVideo,
  searchFreeSoundSounds,
  Segment,
  getSegments,
  getScript,
  transcribeEpisodeSegment,
  transcribeEpisodeAudio,
  uploadEpisodeBgmAudio,
  updateEpisodeAudioSplits,
} from "@/lib/api";
import { getToken } from "@/lib/auth";

type EpisodeClip = { url: string; label: string; duration?: number };

type EpisodeRow = {
  episodeIndex: number;
  title: string;
  scriptContent: string;
  rowCount: number;
  startOrder: number;
  endOrder: number;
  segments: Segment[];
  clips: EpisodeClip[];
};

type SplitWaveformProps = {
  waveform: number[];
  durationSec: number;
  splitPoints: number[];
  waveformZoom: number;
  onChange: (next: number[]) => void;
};

type VideoPointSelectorProps = {
  src: string;
  durationSec: number;
  points: number[];
  onChange: (next: number[]) => void;
  selectedSegmentIndex: number;
  onSelectSegment: (next: number) => void;
  onApplyCutPoints?: () => void;
  applyingCutPoints?: boolean;
  applyCutPointsDisabled?: boolean;
  onInvalidChange?: (message: string) => void;
  sfxSegmentResults?: EpisodeSfxSegmentResult[];
  selectedSfxResult?: EpisodeSfxSegmentResult | null;
  selectedSfxVersionMap?: Record<number, number>;
  deletingSfxVersionKey?: string | null;
  onDeleteSfxVersion?: (segment: EpisodeSfxSegmentResult) => void;
  onSelectSfxVersion?: (segmentIndex: number, version: number) => void;
  showEditorPanel?: boolean;
};

type InlineAudioPlayerProps = {
  src: string;
};

type EpisodeSfxDraft = {
  splitPoints: number[];
  selectedSegmentIndex: number;
  selectedSfxVersionMap?: Record<number, number>;
  segmentsReady: boolean;
  backgroundSoundPrompt: string;
  startSec?: number;
  endSec?: number;
};

type FxPlacedSound = {
  placementId: string;
  soundId: number;
  name: string;
  previewUrl: string;
  durationSec: number;
  startSec: number;
};

type EpisodeFxDraft = {
  selectedTag: string;
  searchKeyword: string;
  selectedSoundId: number;
  placedSounds: FxPlacedSound[];
};

type VideoStepPersistState = {
  episodePipelineMap: Record<number, EpisodeAudioPipelineResult>;
  splitDraftMap: Record<number, number[]>;
  sfxDraftMap: Record<number, EpisodeSfxDraft>;
  splitAppliedEpisodeIndexes: number[];
  segmentVoiceMap: Record<string, string>;
  segmentModelMap: Record<string, string>;
  expandedScriptEpisodeIndexes: number[];
  mergedVideoUrlMap: Record<number, string>;
  fxDraftMap: Record<number, EpisodeFxDraft>;
};

type EpisodeEditorTab = "ambient" | "fx" | "dialogue" | "bgm";

const SFX_SEGMENT_MIN_SEC = 0.5;
const SFX_SEGMENT_MAX_SEC = 30;

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
      const isHeader =
        parts.length >= 3 &&
        ["时间轴", "镜头", "景别", "机位", "运镜", "内容", "台词", "画面", "提示词", "prompt"].some((keyword) =>
          joined.includes(keyword)
        );
      if (isHeader) headerFound = true;
      continue;
    }
    if (trimmed.replace(/\||-|:|\s/g, "") === "") continue;
    rowCount += 1;
  }
  return rowCount;
}

function getSelectedOrLatestSegmentVideoUrl(segment?: Segment) {
  const versions = segment?.versions || [];
  if (versions.length === 0) return "";
  const selected = versions.find((version) => version.is_selected && version.video_url);
  if (selected?.video_url) return selected.video_url;
  const completed = versions.filter(
    (version) => (version.status || "").toUpperCase().includes("COMPLETED") || (version.status || "").toUpperCase().includes("SUCCESS")
  ).filter((version) => version.video_url);
  if (completed.length > 0) return completed[0].video_url;
  const latest = versions.find((version) => Boolean(version.video_url));
  return latest?.video_url || "";
}

function formatSeconds(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "--";
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  const remain = total % 60;
  return `${minutes}:${String(remain).padStart(2, "0")}`;
}

function resolveBackendMediaUrl(url: string) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3000/api";
  const backendBase = apiBase.endsWith("/api") ? apiBase.slice(0, -4) : apiBase;
  return `${backendBase}${raw.startsWith("/") ? raw : `/${raw}`}`;
}

function toChineseNumber(index: number) {
  const map = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
  if (index <= 10) return index === 10 ? "十" : map[index];
  if (index < 20) return `十${map[index - 10]}`;
  if (index === 20) return "二十";
  return String(index);
}

function normalizeRoleKey(name: string) {
  const value = (name || "").trim();
  for (const sep of ["·", "：", ":", "-", "—", "｜", "|"]) {
    if (value.includes(sep)) {
      return value.split(sep, 1)[0].trim();
    }
  }
  return value;
}

function normalizeRangePoints(splitPoints: number[], durationSec: number): [number, number] {
  const safeDuration = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0;
  if (safeDuration <= 0) return [0, 0];
  const values = splitPoints.map((item) => Number(item)).filter((item) => Number.isFinite(item));
  const minGap = safeDuration >= 0.4 ? 0.2 : Math.max(0.02, safeDuration * 0.25);
  if (values.length < 2) return [0, Number(safeDuration.toFixed(3))];
  const sorted = [...values].sort((a, b) => a - b);
  let start = Math.max(0, Math.min(safeDuration, sorted[0]));
  let end = Math.max(0, Math.min(safeDuration, sorted[sorted.length - 1]));
  if (end - start < minGap) {
    if (end >= safeDuration) {
      start = Math.max(0, end - minGap);
    } else {
      end = Math.min(safeDuration, start + minGap);
    }
  }
  if (end - start < minGap) {
    start = 0;
    end = safeDuration;
  }
  return [Number(start.toFixed(3)), Number(end.toFixed(3))];
}

function formatSecondLabel(value: number) {
  const safe = Number.isFinite(value) && value > 0 ? value : 0;
  return `${safe.toFixed(2)}s`;
}

function formatTrackLabel(seconds: number) {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const mins = Math.floor(safe / 60);
  const remains = safe - mins * 60;
  return `${mins}:${remains.toFixed(2).padStart(5, "0")}`;
}

function InlineAudioPlayer({ src }: InlineAudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const progress = safeDuration > 0 ? Math.min(safeDuration, Math.max(0, currentTime)) : 0;

  const handleTogglePlay = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      try {
        await audio.play();
        setIsPlaying(true);
      } catch {
        setIsPlaying(false);
      }
      return;
    }
    audio.pause();
    setIsPlaying(false);
  }, []);

  return (
    <div className="flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-2">
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onLoadedMetadata={(event) => setDuration(event.currentTarget.duration || 0)}
        onDurationChange={(event) => setDuration(event.currentTarget.duration || 0)}
        onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime || 0)}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onEnded={() => {
          setIsPlaying(false);
          setCurrentTime(0);
        }}
        className="hidden"
      />
      <button
        type="button"
        onClick={() => void handleTogglePlay()}
        className="flex h-6 w-6 items-center justify-center rounded-full border border-slate-300 text-xs text-slate-700 hover:bg-slate-50"
      >
        {isPlaying ? "❚❚" : "▶"}
      </button>
      <div className="w-24 shrink-0 text-xs text-slate-600">{`${formatSecondLabel(progress)} / ${formatSecondLabel(safeDuration)}`}</div>
      <input
        type="range"
        min={0}
        max={safeDuration > 0 ? safeDuration : 1}
        step={0.01}
        value={safeDuration > 0 ? progress : 0}
        onChange={(event) => {
          const next = Number(event.target.value);
          const audio = audioRef.current;
          if (!audio || !Number.isFinite(next)) return;
          audio.currentTime = next;
          setCurrentTime(next);
        }}
        className="h-1 w-full cursor-pointer accent-slate-700"
      />
    </div>
  );
}

function SplitWaveform({ waveform, durationSec, splitPoints, waveformZoom, onChange }: SplitWaveformProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const safeDuration = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0;
  const [startPoint, endPoint] = useMemo(
    () => normalizeRangePoints(splitPoints, safeDuration),
    [splitPoints, safeDuration]
  );
  useEffect(() => {
    if (draggingIndex === null) return;
    const onPointerMove = (event: PointerEvent) => {
      const track = trackRef.current;
      if (!track || safeDuration <= 0) return;
      const rect = track.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
      const sec = Number((ratio * safeDuration).toFixed(3));
      const minGap = safeDuration >= 0.4 ? 0.2 : Math.max(0.02, safeDuration * 0.25);
      if (draggingIndex === 0) {
        const nextStart = Math.min(sec, Math.max(0, endPoint - minGap));
        onChange([nextStart, endPoint]);
        return;
      }
      const nextEnd = Math.max(sec, Math.min(safeDuration, startPoint + minGap));
      onChange([startPoint, nextEnd]);
    };
    const onPointerUp = () => setDraggingIndex(null);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    };
  }, [draggingIndex, endPoint, onChange, safeDuration, startPoint]);
  const startLeft = safeDuration > 0 ? `${(startPoint / safeDuration) * 100}%` : "0%";
  const endLeft = safeDuration > 0 ? `${(endPoint / safeDuration) * 100}%` : "100%";
  const selectionLeft = safeDuration > 0 ? `${(startPoint / safeDuration) * 100}%` : "0%";
  const selectionWidth = safeDuration > 0 ? `${Math.max(0, ((endPoint - startPoint) / safeDuration) * 100)}%` : "0%";
  return (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded border border-slate-200 bg-white">
        <div ref={trackRef} className="relative h-20 min-w-full overflow-hidden" style={{ width: `${Math.max(100, waveformZoom * 100)}%` }}>
          <div className="absolute inset-0 flex items-end gap-[1px] px-1 pb-1 pt-1">
            {(waveform.length > 0 ? waveform : new Array(180).fill(0)).map((value, index) => {
              const h = `${Math.max(4, Math.round(Number(value || 0) * 100))}%`;
              return <div key={`wf-${index}`} className="flex-1 rounded-sm bg-slate-300/90" style={{ height: h }} />;
            })}
          </div>
          <div className="absolute bottom-0 top-0 bg-indigo-100/40" style={{ left: selectionLeft, width: selectionWidth }} />
          <button
            type="button"
            onPointerDown={() => setDraggingIndex(0)}
            className="absolute top-0 h-full w-0.5 -translate-x-1/2 cursor-ew-resize bg-indigo-600"
            style={{ left: startLeft }}
            title={`起点 ${startPoint.toFixed(2)}s`}
          />
          <button
            type="button"
            onPointerDown={() => setDraggingIndex(1)}
            className="absolute top-0 h-full w-0.5 -translate-x-1/2 cursor-ew-resize bg-indigo-600"
            style={{ left: endLeft }}
            title={`终点 ${endPoint.toFixed(2)}s`}
          />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
        <span>{`总时长 ${formatSeconds(safeDuration)}`}</span>
        <span>{`起点 ${formatSeconds(startPoint)}`}</span>
        <span>{`终点 ${formatSeconds(endPoint)}`}</span>
      </div>
    </div>
  );
}

function normalizeSfxPoints(points: number[], durationSec: number) {
  const safeDuration = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0;
  if (safeDuration <= 0) return [];
  return [...new Set(points.map((item) => Number(item)).filter((item) => Number.isFinite(item) && item > 0 && item < safeDuration).map((item) => Number(item.toFixed(3))))].sort((a, b) => a - b);
}

function buildSfxSegments(points: number[], durationSec: number) {
  const safeDuration = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0;
  if (safeDuration <= 0) return [] as Array<{ startSec: number; endSec: number; durationSec: number }>;
  const normalizedPoints = normalizeSfxPoints(points, safeDuration);
  if (normalizedPoints.length < 1) return [];
  const boundaries = [0, ...normalizedPoints, safeDuration];
  return boundaries.slice(0, -1).map((startSec, index) => {
    const endSec = boundaries[index + 1];
    const duration = Number((endSec - startSec).toFixed(3));
    return {
      startSec: Number(startSec.toFixed(3)),
      endSec: Number(endSec.toFixed(3)),
      durationSec: Math.max(0, duration),
    };
  }).filter((segment) => segment.durationSec > 0);
}

function isSfxSegmentDurationsValid(points: number[], durationSec: number, minSec = SFX_SEGMENT_MIN_SEC, maxSec = SFX_SEGMENT_MAX_SEC) {
  const segments = buildSfxSegments(points, durationSec);
  if (segments.length <= 0) return true;
  return segments.every((segment) => segment.durationSec >= minSec && segment.durationSec <= maxSec);
}

function VideoPointSelector({
  src,
  durationSec,
  points,
  onChange,
  selectedSegmentIndex,
  onSelectSegment,
  onApplyCutPoints,
  applyingCutPoints = false,
  applyCutPointsDisabled = false,
  onInvalidChange,
  sfxSegmentResults = [],
  selectedSfxResult = null,
  selectedSfxVersionMap = {},
  deletingSfxVersionKey = null,
  onDeleteSfxVersion,
  onSelectSfxVersion,
  showEditorPanel = true,
}: VideoPointSelectorProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [metadataDuration, setMetadataDuration] = useState(0);
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const safeDuration = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : metadataDuration;
  const safePoints = useMemo(() => normalizeSfxPoints(points, safeDuration), [points, safeDuration]);
  const segments = useMemo(() => buildSfxSegments(safePoints, safeDuration), [safePoints, safeDuration]);
  const safeSelectedSegmentIndex = segments.length > 0 ? Math.min(Math.max(0, selectedSegmentIndex), segments.length - 1) : 0;
  const selectedSegment = segments[safeSelectedSegmentIndex] || null;
  const selectedAudioUrl = resolveBackendMediaUrl(String(selectedSfxResult?.audio_url || ""));
  const segmentSfxResults = useMemo(() => {
    const grouped: Record<number, EpisodeSfxSegmentResult[]> = {};
    sfxSegmentResults.forEach((item) => {
      const segmentIndex = Math.max(0, Number(item.segment_index || 0));
      if (!grouped[segmentIndex]) grouped[segmentIndex] = [];
      grouped[segmentIndex].push(item);
    });
    Object.values(grouped).forEach((items) => {
      items.sort((a, b) => Number(a.version || 1) - Number(b.version || 1));
    });
    return grouped;
  }, [sfxSegmentResults]);
  const stopSegmentPlayback = useCallback(() => {
    const video = videoRef.current;
    const audio = audioRef.current;
    if (video) video.pause();
    if (audio) audio.pause();
    setIsPlaying(false);
  }, []);

  useEffect(() => {
    if (draggingIndex === null) return;
    const handlePointerMove = (event: PointerEvent) => {
      const track = trackRef.current;
      if (!track || safeDuration <= 0) return;
      const rect = track.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
      const nextSec = Number((ratio * safeDuration).toFixed(3));
      const nextPoints = [...safePoints];
      nextPoints[draggingIndex] = nextSec;
      const normalizedNext = normalizeSfxPoints(nextPoints, safeDuration);
      onChange(normalizedNext);
    };
    const handlePointerUp = () => setDraggingIndex(null);
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };
  }, [draggingIndex, onChange, safeDuration, safePoints]);

  const handleTogglePlay = async () => {
    const video = videoRef.current;
    if (!video) return;
    const audio = audioRef.current;
    if (!video.paused || isPlaying) {
      stopSegmentPlayback();
      return;
    }
    if (video.paused) {
      try {
        if (selectedSegment) {
          video.currentTime = selectedSegment.startSec;
          setCurrentTime(selectedSegment.startSec);
          if (audio && selectedAudioUrl) {
            audio.currentTime = 0;
          }
        }
        if (audio && selectedAudioUrl) {
          await Promise.all([video.play(), audio.play()]);
        } else {
          await video.play();
        }
        setIsPlaying(true);
      } catch {
        stopSegmentPlayback();
        setIsPlaying(false);
      }
      return;
    }
  };

  useEffect(
    () => () => {
      const audio = audioRef.current;
      if (audio) audio.pause();
    },
    []
  );

  const safeCurrentTime = Math.max(0, Math.min(safeDuration || 0, currentTime || 0));
  const progressRatio = safeDuration > 0 ? safeCurrentTime / safeDuration : 0;
  const progressLeft = safeDuration > 0 ? `${progressRatio * 100}%` : "0%";

  return (
    <div className="space-y-2">
      <audio ref={audioRef} src={selectedAudioUrl} preload="metadata" className="hidden" />
      <video
        ref={videoRef}
        key={src}
        src={src}
        preload="metadata"
        onTimeUpdate={(event) => {
          const nextTime = event.currentTarget.currentTime || 0;
          setCurrentTime(nextTime);
          const audio = audioRef.current;
          if (selectedSegment && nextTime >= selectedSegment.endSec) {
            event.currentTarget.pause();
            event.currentTarget.currentTime = selectedSegment.startSec;
            setCurrentTime(selectedSegment.startSec);
            if (audio) {
              audio.pause();
              audio.currentTime = 0;
            }
            setIsPlaying(false);
            return;
          }
          if (audio && selectedAudioUrl && !audio.paused && selectedSegment) {
            const expectedAudioTime = Math.max(0, nextTime - selectedSegment.startSec);
            const drift = Math.abs((audio.currentTime || 0) - expectedAudioTime);
            if (drift > 0.12) {
              audio.currentTime = expectedAudioTime;
            }
          }
        }}
        onLoadedMetadata={(event) => setMetadataDuration(event.currentTarget.duration || 0)}
        onPlay={() => setIsPlaying(true)}
        onPause={() => {
          const audio = audioRef.current;
          if (audio && !audio.paused) audio.pause();
          setIsPlaying(false);
        }}
        className="w-full rounded border border-amber-100 bg-black"
      />
      {showEditorPanel ? (
      <div className="rounded border border-amber-100 bg-white p-2">
        <div
          ref={trackRef}
          className="relative h-2 cursor-pointer rounded bg-slate-200"
          onClick={(event) => {
            if ((event.target as HTMLElement)?.dataset?.pointMarker === "true") return;
            if (safeDuration <= 0) return;
            const track = trackRef.current;
            if (!track) return;
            const rect = track.getBoundingClientRect();
            const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
            const nextSec = Number((ratio * safeDuration).toFixed(3));
            const video = videoRef.current;
            if (video) video.currentTime = nextSec;
            const audio = audioRef.current;
            if (audio && selectedAudioUrl && selectedSegment) {
              audio.currentTime = Math.max(0, nextSec - selectedSegment.startSec);
            }
            setCurrentTime(nextSec);
          }}
        >
          <div className="absolute bottom-0 left-0 top-0 rounded bg-slate-300/65" style={{ width: progressLeft }} />
          <div className="absolute top-1/2 h-4 w-0.5 -translate-x-1/2 -translate-y-1/2 bg-slate-700" style={{ left: progressLeft }} />
          {safePoints.map((point, index) => (
            <button
              key={`${point}-${index}`}
              type="button"
              data-point-marker="true"
              onPointerDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setDraggingIndex(index);
              }}
              onClick={(event) => {
                event.stopPropagation();
                const video = videoRef.current;
                if (!video) return;
                video.currentTime = point;
                setCurrentTime(point);
              }}
              className="absolute top-1/2 h-5 w-2 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize rounded-sm border border-indigo-700 bg-indigo-500"
              style={{ left: `${(point / safeDuration) * 100}%` }}
              title={`截取点 ${formatSeconds(point)}`}
            />
          ))}
        </div>
        {segments.length > 0 ? (
          <div className="mt-2 rounded border border-amber-100 bg-amber-50/40 px-1 py-2">
            <div className="flex items-start gap-1">
              {segments.map((segment, index) => {
                const versions = segmentSfxResults[index] || [];
                const segmentWidthPercent =
                  safeDuration > 0 ? Math.max(1, ((segment.endSec - segment.startSec) / safeDuration) * 100) : 100 / segments.length;
                return (
                  <div key={`sfx-col-${index}`} className="shrink-0 space-y-1 px-1" style={{ width: `${segmentWidthPercent}%` }}>
                    {versions.length > 0 ? (
                      versions.map((item) => {
                        const startSec = Math.max(0, Number(item.start_sec || 0));
                        const endSec = Math.max(startSec, Number(item.end_sec || startSec));
                        const version = Math.max(1, Number(item.version || 1));
                        const deletingKey = `${index}:${version}`;
                        const selectedVersion = Number(selectedSfxVersionMap[index] || versions[versions.length - 1]?.version || 1);
                        const isSelected = selectedVersion === version;
                        const isPlayingVersion = selectedSfxResult
                          ? Number(selectedSfxResult.segment_index || 0) === index && Number(selectedSfxResult.version || 1) === version
                          : false;
                        return (
                          <div key={`${index}-${version}-${item.updated_at || ""}`} className="rounded border border-amber-100 bg-white px-2 py-1">
                            <div className="mb-1 flex items-center justify-between gap-1">
                              <div className="truncate text-[11px] text-amber-700">{`版本${version}${isPlayingVersion ? "（当前播放）" : ""}`}</div>
                              <div className="flex items-center gap-1">
                                <button
                                  type="button"
                                  onClick={() => onSelectSfxVersion?.(index, version)}
                                  className={`rounded border px-1.5 py-0.5 text-[11px] ${
                                    isSelected
                                      ? "border-emerald-300 bg-emerald-100 text-emerald-700"
                                      : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                                  }`}
                                >
                                  {isSelected ? "已选中" : "选中"}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => onDeleteSfxVersion?.(item)}
                                  disabled={deletingSfxVersionKey === deletingKey}
                                  className="rounded border border-rose-200 bg-rose-50 px-1.5 py-0.5 text-[11px] text-rose-700 hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                  {deletingSfxVersionKey === deletingKey ? "删除中..." : "删除"}
                                </button>
                              </div>
                            </div>
                            <div className="h-2 rounded bg-amber-100/90">
                              <div className={`h-2 rounded ${isSelected ? "bg-amber-500" : "bg-amber-300"}`} style={{ width: "100%" }} />
                            </div>
                            <div className="mt-1 truncate text-[11px] text-amber-700">{`${formatTrackLabel(startSec)} - ${formatTrackLabel(endSec)}`}</div>
                          </div>
                        );
                      })
                    ) : (
                      <div className="rounded border border-dashed border-slate-200 bg-white px-1.5 py-1 text-[11px] text-slate-400">{`第${index + 1}段暂无`}</div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}
        {segments.length > 0 ? (
          <div className="relative mt-2 h-9">
            {segments.map((segment, index) => {
              const centerRatio = safeDuration > 0 ? (segment.startSec + segment.endSec) / 2 / safeDuration : 0;
              const clampedRatio = Math.max(0, Math.min(1, centerRatio));
              return (
                <button
                  key={`${segment.startSec}-${segment.endSec}-${index}`}
                  type="button"
                  onClick={() => {
                    onSelectSegment(index);
                    const video = videoRef.current;
                    if (!video) return;
                    video.currentTime = segment.startSec;
                    setCurrentTime(segment.startSec);
                  }}
                  className={`absolute top-0 -translate-x-1/2 rounded border px-2 py-1 text-[11px] ${
                    index === safeSelectedSegmentIndex
                      ? "border-amber-400 bg-amber-100 text-amber-800"
                      : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                  }`}
                  style={{ left: `${clampedRatio * 100}%` }}
                >
                  {`第${index + 1}段`}
                </button>
              );
            })}
          </div>
        ) : null}
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-600">
          <span>{`截取点 ${safePoints.length} 个`}</span>
          <span>{`当前 ${formatSeconds(safeCurrentTime)} / ${formatSeconds(safeDuration)}`}</span>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            onClick={() => void handleTogglePlay()}
            className="rounded border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-700 hover:bg-slate-100"
          >
            {isPlaying ? "暂停" : selectedSegment ? `播放第${safeSelectedSegmentIndex + 1}段` : "播放"}
          </button>
          <button
            type="button"
            onClick={() => {
              if (safeDuration <= 0) return;
              const nextFromCurrent = normalizeSfxPoints([...safePoints, safeCurrentTime], safeDuration);
              if (nextFromCurrent.length > safePoints.length) {
                onChange(nextFromCurrent);
                return;
              }
              const baseSegments =
                segments.length > 0
                  ? segments
                  : [{ startSec: 0, endSec: safeDuration, durationSec: safeDuration }];
              const longestSegment = baseSegments.slice().sort((a, b) => b.durationSec - a.durationSec)[0];
              const fallbackPoint = Number((((longestSegment?.startSec || 0) + (longestSegment?.endSec || safeDuration)) / 2).toFixed(3));
              const nextFromFallback = normalizeSfxPoints([...safePoints, fallbackPoint], safeDuration);
              if (nextFromFallback.length > safePoints.length) {
                onChange(nextFromFallback);
                return;
              }
              onInvalidChange?.("当前时间附近已有截取点，请先移动播放位置后再添加");
            }}
            className="rounded border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 hover:bg-slate-50"
          >
            添加截取点
          </button>
          <button
            type="button"
            onClick={() => {
              if (safePoints.length <= 0) return;
              onChange(safePoints.slice(0, -1));
            }}
            className="rounded border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={safePoints.length <= 0}
          >
            撤销截取点
          </button>
          <button
            type="button"
            onClick={() => onChange([])}
            className="rounded border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 hover:bg-slate-50"
          >
            清空截取点
          </button>
          <button
            type="button"
            onClick={() => onApplyCutPoints?.()}
            disabled={applyCutPointsDisabled || applyingCutPoints}
            className="ml-auto rounded border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs text-emerald-700 hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {applyingCutPoints ? "应用中..." : "应用截取点"}
          </button>
        </div>
      </div>
      ) : null}
    </div>
  );
}

export default function VideoPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const projectId = params.id;
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [downloadMessage, setDownloadMessage] = useState<string | null>(null);
  const [downloadMessageType, setDownloadMessageType] = useState<"info" | "success" | "error">("info");
  const [actionToast, setActionToast] = useState<{ type: "error" | "success"; text: string } | null>(null);
  const [extractingEpisodeIndex, setExtractingEpisodeIndex] = useState<number | null>(null);
  const [updatingSplitEpisodeIndex, setUpdatingSplitEpisodeIndex] = useState<number | null>(null);
  const [mergingDubbedEpisodeIndex, setMergingDubbedEpisodeIndex] = useState<number | null>(null);
  const [muxingDubbedVideoEpisodeIndex, setMuxingDubbedVideoEpisodeIndex] = useState<number | null>(null);
  const [generatingSfxEpisodeIndex, setGeneratingSfxEpisodeIndex] = useState<number | null>(null);
  const [s2sSegmentKey, setS2sSegmentKey] = useState<string | null>(null);
  const [deletingSegmentKey, setDeletingSegmentKey] = useState<string | null>(null);
  const [transcribingSegmentEpisodeIndex, setTranscribingSegmentEpisodeIndex] = useState<number | null>(null);
  const [transcribingSegmentKey, setTranscribingSegmentKey] = useState<string | null>(null);
  const [transcribingEpisodeIndex, setTranscribingEpisodeIndex] = useState<number | null>(null);
  const [deletingSfxVersionKey, setDeletingSfxVersionKey] = useState<string | null>(null);
  const [extractingOriginalVocalEpisodeIndex, setExtractingOriginalVocalEpisodeIndex] = useState<number | null>(null);
  const [playingRangeEpisodeIndex, setPlayingRangeEpisodeIndex] = useState<number | null>(null);
  const [applyingSfxSegmentsEpisodeIndex, setApplyingSfxSegmentsEpisodeIndex] = useState<number | null>(null);
  const [uploadingBgmEpisodeIndex, setUploadingBgmEpisodeIndex] = useState<number | null>(null);
  const [loadingFxTagsEpisodeIndex, setLoadingFxTagsEpisodeIndex] = useState<number | null>(null);
  const [searchingFxEpisodeIndex, setSearchingFxEpisodeIndex] = useState<number | null>(null);
  const [clipDurationMap, setClipDurationMap] = useState<Record<string, number>>({});
  const [bgmUploadFileMap, setBgmUploadFileMap] = useState<Record<number, File | null>>({});
  const [fxDraftMap, setFxDraftMap] = useState<Record<number, EpisodeFxDraft>>({});
  const [fxTagMap, setFxTagMap] = useState<Record<number, FreeSoundTag[]>>({});
  const [fxSearchResultMap, setFxSearchResultMap] = useState<Record<number, FreeSoundSound[]>>({});
  const [expandedScriptEpisodeSet, setExpandedScriptEpisodeSet] = useState<Set<number>>(new Set());
  const [collapsedSfxEpisodeSet, setCollapsedSfxEpisodeSet] = useState<Set<number>>(new Set());
  const [episodeEditorTabMap, setEpisodeEditorTabMap] = useState<Record<number, EpisodeEditorTab>>({});
  const [episodePipelineMap, setEpisodePipelineMap] = useState<Record<number, EpisodeAudioPipelineResult>>({});
  const [splitDraftMap, setSplitDraftMap] = useState<Record<number, number[]>>({});
  const [sfxDraftMap, setSfxDraftMap] = useState<Record<number, EpisodeSfxDraft>>({});
  const [splitWaveformZoomMap, setSplitWaveformZoomMap] = useState<Record<number, number>>({});
  const [splitAppliedEpisodeSet, setSplitAppliedEpisodeSet] = useState<Set<number>>(new Set());
  const [voices, setVoices] = useState<ElevenLabsVoiceModel[]>([]);
  const [s2sModels, setS2sModels] = useState<ElevenLabsModel[]>([]);
  const [segmentVoiceMap, setSegmentVoiceMap] = useState<Record<string, string>>({});
  const [segmentModelMap, setSegmentModelMap] = useState<Record<string, string>>({});
  const [projectVoices, setProjectVoices] = useState<CharacterVoice[]>([]);
  const [mergedVideoUrlMap, setMergedVideoUrlMap] = useState<Record<number, string>>({});
  const [persistReady, setPersistReady] = useState(false);
  const rangeAudioPreviewRef = useRef<HTMLAudioElement | null>(null);
  const rangeAudioStopTimerRef = useRef<number | null>(null);
  const persistStorageKey = useMemo(
    () => (projectId ? `video-step5-state:${projectId}` : ""),
    [projectId]
  );

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
      if (scriptData.episodes && scriptData.episodes.length > 0) {
        setEpisodes(
          scriptData.episodes.map((episode) => ({
            ...episode,
            dialogueCellAudioMap:
              episode.dialogueCellAudioMap && typeof episode.dialogueCellAudioMap === "object"
                ? episode.dialogueCellAudioMap
                : {},
          }))
        );
      } else {
        const fallbackStoryboard = scriptData.storyboard || scriptData.content || "";
        setEpisodes(
          fallbackStoryboard
            ? [{ title: "第1集", content: "", thinking: "", userInput: "", storyboard: fallbackStoryboard }]
            : []
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    if (!projectId) return;
    const token = getToken();
    if (!token) return;
    void Promise.all([
      getProjectVoices(token, projectId),
      getElevenLabsVoices(token, { page: 1, size: 100, language: "zh" }),
      getElevenLabsModels(token, { canDoVoiceConversion: true }),
    ])
      .then(([projectVoicesData, voicesData, modelsData]) => {
        setProjectVoices(projectVoicesData || []);
        const allVoices = voicesData.items || [];
        setVoices(allVoices);
        setS2sModels(modelsData.items || []);
      })
      .catch(() => {
        setProjectVoices([]);
        setVoices([]);
        setS2sModels([]);
      });
  }, [projectId]);

  useEffect(() => {
    if (!persistStorageKey) return;
    try {
      const legacyStorageKey = projectId ? `video-step-state-${projectId}` : "";
      const raw = window.localStorage.getItem(persistStorageKey) || (legacyStorageKey ? window.localStorage.getItem(legacyStorageKey) : null);
      if (!raw) {
        setPersistReady(true);
        return;
      }
      const parsed = JSON.parse(raw) as Partial<VideoStepPersistState>;
      const restoredPipelineMap =
        parsed.episodePipelineMap && typeof parsed.episodePipelineMap === "object"
          ? (parsed.episodePipelineMap as Record<number, EpisodeAudioPipelineResult>)
          : {};
      const restoredSplitDraftMap =
        parsed.splitDraftMap && typeof parsed.splitDraftMap === "object"
          ? (parsed.splitDraftMap as Record<number, number[]>)
          : {};
      const restoredSfxDraftMap =
        parsed.sfxDraftMap && typeof parsed.sfxDraftMap === "object"
          ? (parsed.sfxDraftMap as Record<number, EpisodeSfxDraft>)
          : {};
      const restoredVoiceMap =
        parsed.segmentVoiceMap && typeof parsed.segmentVoiceMap === "object"
          ? (parsed.segmentVoiceMap as Record<string, string>)
          : {};
      const restoredModelMap =
        parsed.segmentModelMap && typeof parsed.segmentModelMap === "object"
          ? (parsed.segmentModelMap as Record<string, string>)
          : {};
      const restoredMergedVideoUrlMap =
        parsed.mergedVideoUrlMap && typeof parsed.mergedVideoUrlMap === "object"
          ? (parsed.mergedVideoUrlMap as Record<number, string>)
          : {};
      const restoredFxDraftMap =
        parsed.fxDraftMap && typeof parsed.fxDraftMap === "object"
          ? (parsed.fxDraftMap as Record<number, EpisodeFxDraft>)
          : {};
      const restoredApplied =
        Array.isArray(parsed.splitAppliedEpisodeIndexes) && parsed.splitAppliedEpisodeIndexes.length > 0
          ? parsed.splitAppliedEpisodeIndexes.filter((item) => Number.isInteger(item))
          : [];
      const restoredExpanded =
        Array.isArray(parsed.expandedScriptEpisodeIndexes) && parsed.expandedScriptEpisodeIndexes.length > 0
          ? parsed.expandedScriptEpisodeIndexes.filter((item) => Number.isInteger(item))
          : [];
      setEpisodePipelineMap(restoredPipelineMap);
      setSplitDraftMap(restoredSplitDraftMap);
      setSfxDraftMap(restoredSfxDraftMap);
      setSplitAppliedEpisodeSet(new Set(restoredApplied));
      setSegmentVoiceMap(restoredVoiceMap);
      setSegmentModelMap(restoredModelMap);
      setMergedVideoUrlMap(restoredMergedVideoUrlMap);
      setExpandedScriptEpisodeSet(new Set(restoredExpanded));
      setFxDraftMap(restoredFxDraftMap);
    } catch {
      window.localStorage.removeItem(persistStorageKey);
    } finally {
      setPersistReady(true);
    }
  }, [persistStorageKey, projectId]);

  useEffect(() => {
    if (!persistStorageKey || !persistReady) return;
    const payload: VideoStepPersistState = {
      episodePipelineMap,
      splitDraftMap,
      sfxDraftMap,
      splitAppliedEpisodeIndexes: Array.from(splitAppliedEpisodeSet),
      segmentVoiceMap,
      segmentModelMap,
      expandedScriptEpisodeIndexes: Array.from(expandedScriptEpisodeSet),
      mergedVideoUrlMap,
      fxDraftMap,
    };
    window.localStorage.setItem(persistStorageKey, JSON.stringify(payload));
  }, [
    persistStorageKey,
    episodePipelineMap,
    splitDraftMap,
    sfxDraftMap,
    splitAppliedEpisodeSet,
    segmentVoiceMap,
    segmentModelMap,
    expandedScriptEpisodeSet,
    mergedVideoUrlMap,
    fxDraftMap,
    persistReady,
  ]);

  const step3S2SVoices = useMemo(() => {
    const byVoiceId = new Map<string, { voice: ElevenLabsVoiceModel | null; roles: string[] }>();
    const voiceModelMap = new Map(voices.map((item) => [item._id, item]));
    projectVoices.forEach((item) => {
      const voiceId = String(item.voice_id || "").trim();
      if (!voiceId) return;
      const normalizedRole = normalizeRoleKey(item.character_name || "");
      const existing = byVoiceId.get(voiceId);
      if (existing) {
        if (normalizedRole && !existing.roles.includes(normalizedRole)) {
          existing.roles.push(normalizedRole);
        }
        return;
      }
      byVoiceId.set(voiceId, {
        voice: voiceModelMap.get(voiceId) || null,
        roles: normalizedRole ? [normalizedRole] : [],
      });
    });
    return Array.from(byVoiceId.entries()).map(([voiceId, data]) => {
      const roleLabel = data.roles.length > 0 ? data.roles.join(" / ") : "未命名角色";
      const rawTitle = String(data.voice?.title || "").trim();
      const title = rawTitle ? `${roleLabel} · ${rawTitle}` : `${roleLabel} · ${voiceId}`;
      return {
        _id: voiceId,
        title,
        description: data.voice?.description,
        default_text: data.voice?.default_text,
        cover_image: data.voice?.cover_image,
        preview_audio: data.voice?.preview_audio,
        tags: data.voice?.tags,
        languages: data.voice?.languages,
        labels: data.voice?.labels,
        category: data.voice?.category,
        samples: data.voice?.samples,
      } as ElevenLabsVoiceModel;
    });
  }, [projectVoices, voices]);

  const getDefaultVoiceForSegment = useCallback(
    (speakerLabel: string) => {
      const speakerKey = normalizeRoleKey(speakerLabel).toLowerCase();
      if (!speakerKey) return "";
      const direct = projectVoices.find(
        (item) => normalizeRoleKey(item.character_name || "").toLowerCase() === speakerKey
      );
      return direct?.voice_id || "";
    },
    [projectVoices]
  );

  const isPendingTask = useCallback((segment?: Segment) => {
    const taskStatus = String(segment?.task_status || "").toUpperCase();
    return taskStatus === "KLING_SUBMITTED" || taskStatus === "KLING_PROCESSING";
  }, []);

  useEffect(() => {
    const hasPendingTask = segments.some((segment) => isPendingTask(segment));
    if (!hasPendingTask) return;
    const timer = window.setInterval(() => {
      void loadData();
    }, 5000);
    return () => {
      window.clearInterval(timer);
    };
  }, [segments, isPendingTask, loadData]);

  const segmentByOrder = useMemo(() => {
    const map = new Map<number, Segment>();
    segments.forEach((segment) => map.set(segment.order_index, segment));
    return map;
  }, [segments]);

  const episodeRows = useMemo<EpisodeRow[]>(() => {
    let rowCursor = 0;
    return episodes.map((episode, episodeIndex) => {
      const rowCount = countStoryboardRows(episode.storyboard || "");
      const startOrder = rowCursor + 1;
      const endOrder = rowCursor + rowCount;
      const episodeSegments: Segment[] = [];
      for (let order = startOrder; order <= endOrder; order += 1) {
        const segment = segmentByOrder.get(order);
        if (segment) {
          episodeSegments.push(segment);
        }
      }
      const clips = episodeSegments
        .map((segment, index) => ({
          url: getSelectedOrLatestSegmentVideoUrl(segment),
          label: `分镜${toChineseNumber(index + 1)}`,
        }))
        .filter((item) => Boolean(item.url));
      rowCursor += rowCount;
      return {
        episodeIndex,
        title: episode.title || `第${episodeIndex + 1}集`,
        scriptContent: episode.content || "",
        rowCount,
        startOrder,
        endOrder,
        segments: episodeSegments,
        clips,
      };
    });
  }, [episodes, segmentByOrder]);

  useEffect(() => {
    const mergedUrls = Object.values(mergedVideoUrlMap).filter(Boolean);
    const urls = Array.from(new Set([...episodeRows.flatMap((row) => row.clips.map((clip) => clip.url)), ...mergedUrls]));
    const pendingUrls = urls.filter((url) => clipDurationMap[url] === undefined);
    if (pendingUrls.length === 0) return;
    let cancelled = false;
    const loadDuration = (url: string) =>
      new Promise<number>((resolve) => {
        const video = document.createElement("video");
        video.preload = "metadata";
        video.src = url;
        video.onloadedmetadata = () => resolve(Number.isFinite(video.duration) ? video.duration : 0);
        video.onerror = () => resolve(0);
      });
    void Promise.all(pendingUrls.map((url) => loadDuration(url))).then((durations) => {
      if (cancelled) return;
      const nextMap: Record<string, number> = {};
      pendingUrls.forEach((url, index) => {
        nextMap[url] = durations[index] || 0;
      });
      setClipDurationMap((prev) => ({ ...prev, ...nextMap }));
    });
    return () => {
      cancelled = true;
    };
  }, [episodeRows, clipDurationMap, mergedVideoUrlMap]);

  const episodeDurationMap = useMemo(() => {
    const map: Record<number, number> = {};
    episodeRows.forEach((row) => {
      const mergedVideoUrl = mergedVideoUrlMap[row.episodeIndex];
      const sourceClips = mergedVideoUrl ? [{ url: mergedVideoUrl }] : [];
      map[row.episodeIndex] = sourceClips.reduce((sum, clip) => sum + (clipDurationMap[clip.url] || 0), 0);
    });
    return map;
  }, [episodeRows, clipDurationMap, mergedVideoUrlMap]);

  const totalDuration = useMemo(
    () => episodeRows.reduce((sum, row) => sum + (episodeDurationMap[row.episodeIndex] || 0), 0),
    [episodeRows, episodeDurationMap]
  );

  const totalVideoCount = useMemo(
    () => episodeRows.reduce((sum, row) => sum + (mergedVideoUrlMap[row.episodeIndex] ? 1 : 0), 0),
    [episodeRows, mergedVideoUrlMap]
  );

  const showInfoMessage = useCallback((text: string) => {
    setDownloadMessageType("info");
    setDownloadMessage(text);
  }, []);

  const showSuccessMessage = useCallback((text: string) => {
    setDownloadMessageType("success");
    setDownloadMessage(text);
    setActionToast({ type: "success", text });
  }, []);

  const showErrorMessage = useCallback((text: string) => {
    setDownloadMessageType("error");
    setDownloadMessage(text);
    setActionToast({ type: "error", text });
  }, []);

  const getEpisodeSourceClipUrls = useCallback(
    (row: EpisodeRow) => {
      const mergedVideoUrl = mergedVideoUrlMap[row.episodeIndex];
      if (mergedVideoUrl) return [mergedVideoUrl];
      return [];
    },
    [mergedVideoUrlMap]
  );

  const handleExtractAudioPipeline = useCallback(
    async (row: EpisodeRow) => {
      if (!projectId) return;
      const clipUrls = getEpisodeSourceClipUrls(row);
      if (clipUrls.length === 0) {
        showErrorMessage(`${row.title} 暂无可处理视频`);
        return;
      }
      const token = getToken();
      if (!token) {
        window.location.href = "/login";
        return;
      }
      setExtractingEpisodeIndex(row.episodeIndex);
      showInfoMessage(`正在提取 ${row.title} 配音...`);
      try {
        const data = await extractEpisodeAudioPipeline(token, projectId, {
          episodeTitle: row.title,
          clipUrls,
          mergeKey: "",
        });
        setEpisodePipelineMap((prev) => ({ ...prev, [row.episodeIndex]: data }));
        setSplitDraftMap((prev) => ({ ...prev, [row.episodeIndex]: data.split_points || [] }));
        setSplitAppliedEpisodeSet((prev) => {
          const next = new Set(prev);
          next.delete(row.episodeIndex);
          return next;
        });
        showSuccessMessage(`${row.title} 配音提取完成`);
      } catch (err) {
        showErrorMessage(err instanceof Error ? err.message : "提取配音失败");
      } finally {
        setExtractingEpisodeIndex(null);
      }
    },
    [projectId, getEpisodeSourceClipUrls, showErrorMessage, showInfoMessage, showSuccessMessage]
  );

  const handleApplySplitPoints = useCallback(
    async (row: EpisodeRow) => {
      if (!projectId) return;
      const current = episodePipelineMap[row.episodeIndex];
      if (!current) return;
      const splitPoints = splitDraftMap[row.episodeIndex] || [];
      const token = getToken();
      if (!token) {
        window.location.href = "/login";
        return;
      }
      setUpdatingSplitEpisodeIndex(row.episodeIndex);
      showInfoMessage(`正在应用 ${row.title} 分割区间...`);
      try {
        const normalized = normalizeRangePoints(splitPoints, current.duration_sec || 0);
        const data = await updateEpisodeAudioSplits(token, projectId, {
          jobId: current.job_id,
          splitPoints: normalized,
        });
        setEpisodePipelineMap((prev) => ({ ...prev, [row.episodeIndex]: data }));
        setSplitDraftMap((prev) => ({ ...prev, [row.episodeIndex]: data.split_points || [] }));
        setSplitAppliedEpisodeSet((prev) => new Set(prev).add(row.episodeIndex));
        showSuccessMessage(`${row.title} 区间音频已生成`);
      } catch (err) {
        showErrorMessage(err instanceof Error ? err.message : "应用分割点失败");
      } finally {
        setUpdatingSplitEpisodeIndex(null);
      }
    },
    [projectId, episodePipelineMap, splitDraftMap, showErrorMessage, showInfoMessage, showSuccessMessage]
  );

  const stopRangeAudioPreview = useCallback((targetAudio?: HTMLAudioElement) => {
    if (rangeAudioStopTimerRef.current !== null) {
      window.clearTimeout(rangeAudioStopTimerRef.current);
      rangeAudioStopTimerRef.current = null;
    }
    const current = rangeAudioPreviewRef.current;
    const nextTarget = targetAudio || current;
    if (nextTarget) {
      nextTarget.pause();
      nextTarget.currentTime = 0;
      nextTarget.onended = null;
      nextTarget.ontimeupdate = null;
      nextTarget.onerror = null;
      nextTarget.onloadedmetadata = null;
    }
    if (!targetAudio || current === targetAudio) {
      rangeAudioPreviewRef.current = null;
      setPlayingRangeEpisodeIndex(null);
    }
  }, []);

  const handlePreviewSelectedRange = useCallback(
    async (row: EpisodeRow) => {
      const current = episodePipelineMap[row.episodeIndex];
      if (!current?.original_isolated_audio_url) {
        showErrorMessage("请先提取原始音轨人声");
        return;
      }
      if (playingRangeEpisodeIndex === row.episodeIndex) {
        stopRangeAudioPreview();
        return;
      }
      stopRangeAudioPreview();
      const [startSec, endSec] = normalizeRangePoints(
        splitDraftMap[row.episodeIndex] || current.split_points || [],
        current.duration_sec || 0
      );
      if (endSec - startSec <= 0.05) {
        showErrorMessage("选中区间过短，请调整后重试");
        return;
      }
      const resolvedUrl = resolveBackendMediaUrl(current.original_isolated_audio_url);
      if (!resolvedUrl) {
        showErrorMessage("音频地址无效");
        return;
      }
      const audio = new Audio(resolvedUrl);
      audio.preload = "auto";
      rangeAudioPreviewRef.current = audio;
      setPlayingRangeEpisodeIndex(row.episodeIndex);
      audio.onended = () => stopRangeAudioPreview(audio);
      audio.ontimeupdate = () => {
        if (audio.currentTime >= endSec) {
          stopRangeAudioPreview(audio);
        }
      };
      audio.onerror = () => {
        stopRangeAudioPreview(audio);
        showErrorMessage("播放选中区域失败");
      };
      audio.onloadedmetadata = () => {
        const safeStart = Math.max(0, Math.min(startSec, Number.isFinite(audio.duration) ? audio.duration : startSec));
        const safeEnd = Math.max(safeStart + 0.05, endSec);
        audio.currentTime = safeStart;
        void audio.play().catch(() => {
          stopRangeAudioPreview(audio);
          showErrorMessage("播放选中区域失败");
        });
        const maxPlayMs = Math.max(100, Math.round((safeEnd - safeStart) * 1000) + 80);
        rangeAudioStopTimerRef.current = window.setTimeout(() => stopRangeAudioPreview(audio), maxPlayMs);
      };
      audio.load();
    },
    [episodePipelineMap, playingRangeEpisodeIndex, splitDraftMap, stopRangeAudioPreview, showErrorMessage]
  );

  useEffect(
    () => () => {
      stopRangeAudioPreview();
    },
    [stopRangeAudioPreview]
  );

  useEffect(() => {
    if (!actionToast) return;
    const timer = window.setTimeout(() => {
      setActionToast(null);
    }, 5000);
    return () => {
      window.clearTimeout(timer);
    };
  }, [actionToast]);

  const handleDeleteSegmentAudio = useCallback(
    async (row: EpisodeRow, segmentId: string) => {
      if (!projectId) return;
      const current = episodePipelineMap[row.episodeIndex];
      if (!current) {
        showErrorMessage("请先提取音轨并应用分割点");
        return;
      }
      const target = current.segments.find((item) => item.id === segmentId);
      if (!target) {
        showErrorMessage("未找到对应分段");
        return;
      }
      const confirmed = window.confirm(`确认删除分段 ${segmentId} 吗？删除后不可恢复。`);
      if (!confirmed) return;
      const token = getToken();
      if (!token) {
        window.location.href = "/login";
        return;
      }
      const voiceKey = `${row.episodeIndex}:${segmentId}`;
      setDeletingSegmentKey(voiceKey);
      showInfoMessage(`正在删除 ${row.title} ${segmentId} 分段音频...`);
      try {
        const data = await deleteEpisodeAudioSegment(token, projectId, {
          jobId: current.job_id,
          segmentId,
        });
        setEpisodePipelineMap((prev) => ({ ...prev, [row.episodeIndex]: data }));
        setSegmentVoiceMap((prev) => {
          if (!(voiceKey in prev)) return prev;
          const next = { ...prev };
          delete next[voiceKey];
          return next;
        });
        setSegmentModelMap((prev) => {
          if (!(voiceKey in prev)) return prev;
          const next = { ...prev };
          delete next[voiceKey];
          return next;
        });
        setS2sSegmentKey((prev) => (prev === voiceKey ? null : prev));
        showSuccessMessage(`${row.title} ${segmentId} 已删除`);
      } catch (err) {
        showErrorMessage(err instanceof Error ? err.message : "删除分段音频失败");
      } finally {
        setDeletingSegmentKey(null);
      }
    },
    [projectId, episodePipelineMap, showErrorMessage, showInfoMessage, showSuccessMessage]
  );

  const handleSegmentS2S = useCallback(
    async (row: EpisodeRow, segmentId: string) => {
      if (!projectId) return;
      const current = episodePipelineMap[row.episodeIndex];
      if (!current) {
        showErrorMessage("请先提取音轨并应用分割点");
        return;
      }
      const targetSegment = current.segments.find((segment) => segment.id === segmentId);
      if (!targetSegment?.source_audio_url) {
        showErrorMessage("请先提取原始音轨人声并应用分割点");
        return;
      }
      const voiceKey = `${row.episodeIndex}:${segmentId}`;
      const defaultVoice = getDefaultVoiceForSegment(targetSegment.speaker_label);
      const selectedVoiceRaw = segmentVoiceMap[voiceKey] || "";
      const selectedVoice = step3S2SVoices.some((voice) => voice._id === selectedVoiceRaw)
        ? selectedVoiceRaw
        : defaultVoice || step3S2SVoices[0]?._id || "";
      if (!selectedVoice) {
        showErrorMessage("请先在 Step3 为角色配置音色后重试");
        return;
      }
      if (selectedVoice !== selectedVoiceRaw) {
        setSegmentVoiceMap((prev) => ({ ...prev, [voiceKey]: selectedVoice }));
      }
      const selectedModel = segmentModelMap[voiceKey] || s2sModels[0]?.model_id || "";
      if (!selectedModel) {
        showErrorMessage("暂无可用 S2S 模型");
        return;
      }
      const token = getToken();
      if (!token) {
        window.location.href = "/login";
        return;
      }
      setS2sSegmentKey(voiceKey);
      showInfoMessage(`正在生成 ${row.title} ${segmentId} 新音色...`);
      try {
        const data = await generateEpisodeSegmentS2S(token, projectId, {
          jobId: current.job_id,
          segmentId,
          voiceId: selectedVoice,
          modelId: selectedModel,
        });
        setEpisodePipelineMap((prev) => ({ ...prev, [row.episodeIndex]: data }));
        showSuccessMessage(`${row.title} ${segmentId} 音色生成完成`);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : "分段音色生成失败";
        showErrorMessage(`S2S 失败：${errorMessage}`);
      } finally {
        setS2sSegmentKey(null);
      }
    },
    [projectId, episodePipelineMap, segmentVoiceMap, segmentModelMap, step3S2SVoices, s2sModels, getDefaultVoiceForSegment, showErrorMessage, showInfoMessage, showSuccessMessage]
  );

  const handleExtractOriginalVocal = useCallback(
    async (row: EpisodeRow) => {
      if (!projectId) return;
      const current = episodePipelineMap[row.episodeIndex];
      if (!current) {
        showErrorMessage("请先提取原始音轨");
        return;
      }
      if (!current.source_audio_url) {
        showErrorMessage("请先提取原始音轨");
        return;
      }
      const token = getToken();
      if (!token) {
        window.location.href = "/login";
        return;
      }
      setExtractingOriginalVocalEpisodeIndex(row.episodeIndex);
      showInfoMessage(`正在提取 ${row.title} 原始音轨人声...`);
      try {
        const data = await extractEpisodeOriginalVocal(token, projectId, {
          jobId: current.job_id,
        });
        setEpisodePipelineMap((prev) => ({ ...prev, [row.episodeIndex]: data }));
        setSplitAppliedEpisodeSet((prev) => {
          const next = new Set(prev);
          next.delete(row.episodeIndex);
          return next;
        });
        showSuccessMessage(`${row.title} 原始音轨人声提取完成`);
      } catch (err) {
        showErrorMessage(err instanceof Error ? err.message : "原始音轨人声提取失败");
      } finally {
        setExtractingOriginalVocalEpisodeIndex(null);
      }
    },
    [projectId, episodePipelineMap, showErrorMessage, showInfoMessage, showSuccessMessage]
  );

  // ─── 音轨转文字 ───────────────────────────────────────────
  const handleTranscribeSegment = useCallback(
    async (row: EpisodeRow, segmentId: string) => {
      if (!projectId) return;
      const current = episodePipelineMap[row.episodeIndex];
      if (!current) return;
      const token = getToken();
      if (!token) {
        window.location.href = "/login";
        return;
      }
      const voiceKey = `${row.episodeIndex}:${segmentId}`;
      setTranscribingSegmentEpisodeIndex(row.episodeIndex);
      setTranscribingSegmentKey(voiceKey);
      showInfoMessage(`正在转写第 ${row.episodeIndex + 1} 集第 ${current.segments.findIndex(s => s.id === segmentId) + 1} 段音频...`);
      try {
        const data = await transcribeEpisodeSegment(token, projectId, {
          jobId: current.job_id,
          segmentId,
        });
        setEpisodePipelineMap((prev) => ({ ...prev, [row.episodeIndex]: data }));
        showSuccessMessage(`${row.title} 第 ${current.segments.findIndex(s => s.id === segmentId) + 1} 段转写完成`);
      } catch (err) {
        showErrorMessage(err instanceof Error ? err.message : "转写失败");
      } finally {
        setTranscribingSegmentEpisodeIndex(null);
        setTranscribingSegmentKey(null);
      }
    },
    [projectId, episodePipelineMap, showErrorMessage, showInfoMessage, showSuccessMessage]
  );

  const handleTranscribeEpisode = useCallback(
    async (row: EpisodeRow) => {
      if (!projectId) return;
      const current = episodePipelineMap[row.episodeIndex];
      if (!current) return;
      const token = getToken();
      if (!token) {
        window.location.href = "/login";
        return;
      }
      setTranscribingEpisodeIndex(row.episodeIndex);
      showInfoMessage(`正在转写 ${row.title} 整集人声音轨...`);
      try {
        const data = await transcribeEpisodeAudio(token, projectId, {
          jobId: current.job_id,
        });
        setEpisodePipelineMap((prev) => ({ ...prev, [row.episodeIndex]: data }));
        showSuccessMessage(`${row.title} 整集音频转写完成`);
      } catch (err) {
        showErrorMessage(err instanceof Error ? err.message : "转写失败");
      } finally {
        setTranscribingEpisodeIndex(null);
      }
    },
    [projectId, episodePipelineMap, showErrorMessage, showInfoMessage, showSuccessMessage]
  );

  const handleMergeDubbedAudio = useCallback(
    async (row: EpisodeRow) => {
      if (!projectId) return;
      const current = episodePipelineMap[row.episodeIndex];
      if (!current) {
        showErrorMessage("请先提取音轨并应用分割点");
        return;
      }
      if (!splitAppliedEpisodeSet.has(row.episodeIndex)) {
        showErrorMessage("请先应用分割点");
        return;
      }
      const hasDubbed = current.segments.some((segment) => Boolean(segment.dubbed_audio_url));
      if (!hasDubbed) {
        showErrorMessage("请先完成至少一个分段 S2S");
        return;
      }
      const token = getToken();
      if (!token) {
        window.location.href = "/login";
        return;
      }
      setMergingDubbedEpisodeIndex(row.episodeIndex);
      showInfoMessage(`正在合并 ${row.title} 配音...`);
      try {
        const data = await mergeEpisodeDubbedAudio(token, projectId, {
          jobId: current.job_id,
        });
        setEpisodePipelineMap((prev) => ({ ...prev, [row.episodeIndex]: data }));
        showSuccessMessage(`${row.title} 合并配音完成`);
      } catch (err) {
        showErrorMessage(err instanceof Error ? err.message : "一键合并配音失败");
      } finally {
        setMergingDubbedEpisodeIndex(null);
      }
    },
    [projectId, episodePipelineMap, splitAppliedEpisodeSet, showErrorMessage, showInfoMessage, showSuccessMessage]
  );

  const handleMuxDubbedVideo = useCallback(
    async (row: EpisodeRow) => {
      if (!projectId) return;
      const current = episodePipelineMap[row.episodeIndex];
      if (!current) {
        showErrorMessage("请先提取音轨并应用分割点");
        return;
      }
      if (!current.merged_dubbed_audio_url) {
        showErrorMessage("请先完成一键合并配音");
        return;
      }
      const token = getToken();
      if (!token) {
        window.location.href = "/login";
        return;
      }
      setMuxingDubbedVideoEpisodeIndex(row.episodeIndex);
      showInfoMessage(`正在合成 ${row.title} 音视频...`);
      try {
        const data = await muxEpisodeDubbedVideo(token, projectId, {
          jobId: current.job_id,
        });
        setEpisodePipelineMap((prev) => ({ ...prev, [row.episodeIndex]: data }));
        showSuccessMessage(`${row.title} 音视频合成完成`);
      } catch (err) {
        showErrorMessage(err instanceof Error ? err.message : "音视频合成失败");
      } finally {
        setMuxingDubbedVideoEpisodeIndex(null);
      }
    },
    [projectId, episodePipelineMap, showErrorMessage, showInfoMessage, showSuccessMessage]
  );

  const getSfxDraftByEpisode = useCallback(
    (episodeIndex: number, durationSec: number): EpisodeSfxDraft => {
      const safeDuration = Math.max(0, Number(durationSec || 0));
      const existing = sfxDraftMap[episodeIndex];
      if (existing) {
        const hasLegacyRange = Number.isFinite(Number(existing.startSec)) || Number.isFinite(Number(existing.endSec));
        const currentPoints = normalizeSfxPoints(existing.splitPoints || [], safeDuration);
        const splitPoints = hasLegacyRange && !existing.segmentsReady && currentPoints.length <= 2 ? [] : currentPoints;
        const selectedSfxVersionMap =
          existing.selectedSfxVersionMap && typeof existing.selectedSfxVersionMap === "object"
            ? Object.fromEntries(
                Object.entries(existing.selectedSfxVersionMap).map(([segmentIndex, version]) => [
                  Math.max(0, Number(segmentIndex)),
                  Math.max(1, Number(version || 1)),
                ])
              )
            : {};
        return {
          ...existing,
          splitPoints,
          selectedSegmentIndex: Number.isFinite(existing.selectedSegmentIndex) ? Math.max(0, Number(existing.selectedSegmentIndex)) : 0,
          selectedSfxVersionMap,
          segmentsReady: Boolean(existing.segmentsReady),
          startSec: undefined,
          endSec: undefined,
        };
      }
      return {
        splitPoints: [],
        selectedSegmentIndex: 0,
        selectedSfxVersionMap: {},
        segmentsReady: false,
        backgroundSoundPrompt: "",
      };
    },
    [sfxDraftMap]
  );

  const getFxDraftByEpisode = useCallback(
    (episodeIndex: number): EpisodeFxDraft => {
      const existing = fxDraftMap[episodeIndex];
      if (existing) {
        return {
          selectedTag: String(existing.selectedTag || "").trim(),
          searchKeyword: String(existing.searchKeyword || "").trim(),
          selectedSoundId: Math.max(0, Number(existing.selectedSoundId || 0)),
          placedSounds: Array.isArray(existing.placedSounds)
            ? existing.placedSounds
                .map((item) => ({
                  placementId: String(item.placementId || "").trim() || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
                  soundId: Math.max(0, Number(item.soundId || 0)),
                  name: String(item.name || "").trim() || "未命名音效",
                  previewUrl: String(item.previewUrl || "").trim(),
                  durationSec: Math.max(0.1, Number(item.durationSec || 0)),
                  startSec: Math.max(0, Number(item.startSec || 0)),
                }))
                .filter((item) => Boolean(item.previewUrl))
            : [],
        };
      }
      return {
        selectedTag: "",
        searchKeyword: "",
        selectedSoundId: 0,
        placedSounds: [],
      };
    },
    [fxDraftMap]
  );

  const handleLoadFreeSoundTags = useCallback(
    async (row: EpisodeRow, options?: { silent?: boolean }) => {
      if (!projectId) return;
      const token = getToken();
      if (!token) {
        window.location.href = "/login";
        return;
      }
      const draft = getFxDraftByEpisode(row.episodeIndex);
      setLoadingFxTagsEpisodeIndex(row.episodeIndex);
      try {
        const data = await getFreeSoundTags(token, projectId, {
          query: draft.searchKeyword,
          pageSize: 24,
        });
        setFxTagMap((prev) => ({ ...prev, [row.episodeIndex]: Array.isArray(data.items) ? data.items : [] }));
      } catch (err) {
        setFxTagMap((prev) => ({ ...prev, [row.episodeIndex]: [] }));
        if (!options?.silent) {
          showErrorMessage(err instanceof Error ? err.message : "加载 Freesound 标签失败");
        }
      } finally {
        setLoadingFxTagsEpisodeIndex(null);
      }
    },
    [projectId, getFxDraftByEpisode, showErrorMessage]
  );

  const handleSearchFreeSound = useCallback(
    async (row: EpisodeRow, options?: { silent?: boolean }) => {
      if (!projectId) return;
      const token = getToken();
      if (!token) {
        window.location.href = "/login";
        return;
      }
      const draft = getFxDraftByEpisode(row.episodeIndex);
      setSearchingFxEpisodeIndex(row.episodeIndex);
      try {
        const data = await searchFreeSoundSounds(token, projectId, {
          query: draft.searchKeyword || "",
          tag: draft.selectedTag || "",
          page: 1,
          pageSize: 20,
        });
        const items = Array.isArray(data.items) ? data.items : [];
        setFxSearchResultMap((prev) => ({ ...prev, [row.episodeIndex]: items }));
        if (data.warning && !options?.silent) {
          showErrorMessage(data.warning);
        }
      } catch (err) {
        setFxSearchResultMap((prev) => ({ ...prev, [row.episodeIndex]: [] }));
        if (!options?.silent) {
          showErrorMessage(err instanceof Error ? err.message : "搜索 Freesound 音效失败");
        }
      } finally {
        setSearchingFxEpisodeIndex(null);
      }
    },
    [projectId, getFxDraftByEpisode, showErrorMessage]
  );

  useEffect(() => {
    episodeRows.forEach((row) => {
      const activeTab = episodeEditorTabMap[row.episodeIndex] || "ambient";
      if (activeTab !== "fx") return;
      const hasTagsRecord = Object.prototype.hasOwnProperty.call(fxTagMap, row.episodeIndex);
      const hasResultsRecord = Object.prototype.hasOwnProperty.call(fxSearchResultMap, row.episodeIndex);
      if (!hasTagsRecord) {
        void handleLoadFreeSoundTags(row, { silent: true });
      }
      if (!hasResultsRecord) {
        void handleSearchFreeSound(row, { silent: true });
      }
    });
  }, [
    episodeRows,
    episodeEditorTabMap,
    fxTagMap,
    fxSearchResultMap,
    handleLoadFreeSoundTags,
    handleSearchFreeSound,
  ]);

  const ensureSfxPipeline = useCallback(
    async (row: EpisodeRow, token: string, sourceVideoUrl: string) => {
      const current = episodePipelineMap[row.episodeIndex];
      if (current) return current;
      const data = await extractEpisodeAudioPipeline(token, projectId, {
        episodeTitle: row.title,
        clipUrls: [sourceVideoUrl],
        mergeKey: "",
      });
      setEpisodePipelineMap((prev) => ({ ...prev, [row.episodeIndex]: data }));
      setSplitDraftMap((prev) => ({ ...prev, [row.episodeIndex]: data.split_points || [] }));
      return data;
    },
    [projectId, episodePipelineMap]
  );

  const handleGenerateSfx = useCallback(
    async (row: EpisodeRow) => {
      if (!projectId) return;
      const currentSourceUrl = getEpisodeSourceClipUrls(row)[0] || "";
      if (!currentSourceUrl) {
        showErrorMessage("请先确保该集上方有可用视频");
        return;
      }
      const token = getToken();
      if (!token) {
        window.location.href = "/login";
        return;
      }
      const current = await ensureSfxPipeline(row, token, currentSourceUrl);
      const durationSec = Math.max(0, Number((clipDurationMap[currentSourceUrl] || 0) || current.duration_sec || 0));
      if (durationSec <= 0) {
        showErrorMessage("当前视频时长无效");
        return;
      }
      const draft = getSfxDraftByEpisode(row.episodeIndex, durationSec);
      const draftSegments = buildSfxSegments(draft.splitPoints || [], durationSec);
      const safeSelectedSegmentIndex =
        draftSegments.length > 0 ? Math.min(Math.max(0, Number(draft.selectedSegmentIndex || 0)), draftSegments.length - 1) : 0;
      const selectedSegment = draftSegments[safeSelectedSegmentIndex] || null;
      if (!selectedSegment) {
        showErrorMessage("请先在进度条上设置至少一个截取点并选择分段");
        return;
      }
      const startSec = selectedSegment.startSec;
      const endSec = selectedSegment.endSec;
      const clipDuration = selectedSegment.durationSec;
      if (clipDuration < SFX_SEGMENT_MIN_SEC || clipDuration > SFX_SEGMENT_MAX_SEC) {
        showErrorMessage(`截取时长需在 ${SFX_SEGMENT_MIN_SEC} 到 ${SFX_SEGMENT_MAX_SEC} 秒之间`);
        return;
      }
      if (!draft.backgroundSoundPrompt.trim()) {
        showErrorMessage("请填写背景音提示词");
        return;
      }
      setGeneratingSfxEpisodeIndex(row.episodeIndex);
      showInfoMessage(`正在生成 ${row.title} 音效...`);
      try {
        const requestPayload = {
          jobId: current.job_id,
          sourceVideoUrl: currentSourceUrl,
          segmentIndex: safeSelectedSegmentIndex,
          startSec,
          endSec,
          backgroundSoundPrompt: draft.backgroundSoundPrompt.trim(),
        };
        const normalizePrompt = (value: unknown) => String(value || "").trim();
        const isSegmentReady = (data: EpisodeAudioPipelineResult) => {
          return (Array.isArray(data.sfx_segment_results) ? data.sfx_segment_results : []).some((item) => {
            const itemSegmentIndex = Number(item?.segment_index || 0);
            if (itemSegmentIndex !== safeSelectedSegmentIndex || !item?.audio_url) return false;
            const sameBackgroundPrompt =
              normalizePrompt(item?.background_sound_prompt) === normalizePrompt(requestPayload.backgroundSoundPrompt);
            return sameBackgroundPrompt;
          });
        };
        const data = await generateEpisodeSfxAudio(token, projectId, requestPayload);
        setEpisodePipelineMap((prev) => ({ ...prev, [row.episodeIndex]: data }));
        const latestGeneratedVersion = (Array.isArray(data.sfx_segment_results) ? data.sfx_segment_results : [])
          .filter(
            (item) =>
              Number(item?.segment_index || 0) === safeSelectedSegmentIndex &&
              Boolean(item?.audio_url)
          )
          .sort((a, b) => Number(a.version || 1) - Number(b.version || 1))
          .at(-1);
        if (latestGeneratedVersion) {
          setSfxDraftMap((prev) => {
            const currentDraft = prev[row.episodeIndex] || draft;
            return {
              ...prev,
              [row.episodeIndex]: {
                ...currentDraft,
                selectedSfxVersionMap: {
                  ...(currentDraft.selectedSfxVersionMap || {}),
                  [safeSelectedSegmentIndex]: Math.max(1, Number(latestGeneratedVersion.version || 1)),
                },
                segmentsReady: true,
              },
            };
          });
        }
        if (isSegmentReady(data)) {
          showSuccessMessage(`${row.title} 音效生成完成`);
          return;
        }
        showErrorMessage(`${row.title} 音效生成结果未找到，请重试`);
      } catch (err) {
        showErrorMessage(err instanceof Error ? err.message : "生成音效失败");
      } finally {
        setGeneratingSfxEpisodeIndex(null);
      }
    },
    [projectId, ensureSfxPipeline, clipDurationMap, getEpisodeSourceClipUrls, getSfxDraftByEpisode, showErrorMessage, showInfoMessage, showSuccessMessage]
  );

  const handleDeleteSfxVersion = useCallback(
    async (row: EpisodeRow, segment: EpisodeSfxSegmentResult) => {
      if (!projectId) return;
      const current = episodePipelineMap[row.episodeIndex];
      if (!current) {
        showErrorMessage("请先提取音轨并生成音效");
        return;
      }
      const segmentIndex = Math.max(0, Number(segment.segment_index || 0));
      const version = Math.max(1, Number(segment.version || 1));
      const deleteKey = `${row.episodeIndex}:${segmentIndex}:${version}`;
      const confirmed = window.confirm(`确认删除第${segmentIndex + 1}段音效版本${version}吗？删除后不可恢复。`);
      if (!confirmed) return;
      const token = getToken();
      if (!token) {
        window.location.href = "/login";
        return;
      }
      setDeletingSfxVersionKey(deleteKey);
      showInfoMessage(`正在删除 ${row.title} 第${segmentIndex + 1}段版本${version}...`);
      try {
        const data = await deleteEpisodeSfxVersion(token, projectId, {
          jobId: current.job_id,
          segmentIndex,
          version,
        });
        setEpisodePipelineMap((prev) => ({ ...prev, [row.episodeIndex]: data }));
        setSfxDraftMap((prev) => {
          const currentDraft = prev[row.episodeIndex] || getSfxDraftByEpisode(row.episodeIndex, 0);
          const remainVersions = (Array.isArray(data.sfx_segment_results) ? data.sfx_segment_results : [])
            .filter((item) => Number(item?.segment_index || 0) === segmentIndex && Boolean(item?.audio_url))
            .sort((a, b) => Number(a.version || 1) - Number(b.version || 1));
          const latestRemain = remainVersions.at(-1);
          const nextSelectedSfxVersionMap = { ...(currentDraft.selectedSfxVersionMap || {}) };
          if (latestRemain) {
            nextSelectedSfxVersionMap[segmentIndex] = Math.max(1, Number(latestRemain.version || 1));
          } else {
            delete nextSelectedSfxVersionMap[segmentIndex];
          }
          return {
            ...prev,
            [row.episodeIndex]: {
              ...currentDraft,
              selectedSfxVersionMap: nextSelectedSfxVersionMap,
              segmentsReady: true,
            },
          };
        });
        showSuccessMessage(`${row.title} 第${segmentIndex + 1}段版本${version} 已删除`);
      } catch (err) {
        showErrorMessage(err instanceof Error ? err.message : "删除音效版本失败");
      } finally {
        setDeletingSfxVersionKey(null);
      }
    },
    [projectId, episodePipelineMap, getSfxDraftByEpisode, showErrorMessage, showInfoMessage, showSuccessMessage]
  );

  const handleApplySfxCutPoints = useCallback(
    (row: EpisodeRow) => {
      const mergedVideoUrl = mergedVideoUrlMap[row.episodeIndex] || "";
      const current = episodePipelineMap[row.episodeIndex];
      const durationSec = Math.max(0, Number((mergedVideoUrl ? clipDurationMap[mergedVideoUrl] : 0) || current?.duration_sec || 0));
      if (durationSec <= 0) {
        showErrorMessage("当前视频时长无效");
        return;
      }
      const draft = getSfxDraftByEpisode(row.episodeIndex, durationSec);
      const splitPoints = normalizeSfxPoints(draft.splitPoints || [], durationSec);
      if (splitPoints.length <= 0) {
        showErrorMessage("请先设置截取点");
        return;
      }
      if (!isSfxSegmentDurationsValid(splitPoints, durationSec)) {
        showErrorMessage(`每段时长需在 ${SFX_SEGMENT_MIN_SEC}-${SFX_SEGMENT_MAX_SEC} 秒之间`);
        return;
      }
      setApplyingSfxSegmentsEpisodeIndex(row.episodeIndex);
      try {
        const nextSegments = buildSfxSegments(splitPoints, durationSec);
        setSfxDraftMap((prev) => {
          const currentDraft = prev[row.episodeIndex] || draft;
          const safeSelectedSegmentIndex =
            nextSegments.length > 0
              ? Math.min(Math.max(0, Number(currentDraft.selectedSegmentIndex || 0)), nextSegments.length - 1)
              : 0;
          return {
            ...prev,
            [row.episodeIndex]: {
              ...currentDraft,
              splitPoints,
              selectedSegmentIndex: safeSelectedSegmentIndex,
              segmentsReady: true,
            },
          };
        });
        showSuccessMessage(`${row.title} 截取点已应用（本地标记，共 ${nextSegments.length} 段）`);
      } finally {
        setApplyingSfxSegmentsEpisodeIndex(null);
      }
    },
    [clipDurationMap, episodePipelineMap, mergedVideoUrlMap, getSfxDraftByEpisode, showErrorMessage, showSuccessMessage]
  );

  const handleUploadBgm = useCallback(
    async (row: EpisodeRow) => {
      if (!projectId) return;
      const currentSourceUrl = getEpisodeSourceClipUrls(row)[0] || "";
      if (!currentSourceUrl) {
        showErrorMessage("请先确保该集上方有可用视频");
        return;
      }
      const token = getToken();
      if (!token) {
        window.location.href = "/login";
        return;
      }
      const current = await ensureSfxPipeline(row, token, currentSourceUrl);
      const durationSec = Math.max(0, Number((clipDurationMap[currentSourceUrl] || 0) || current.duration_sec || 0));
      if (durationSec <= 0) {
        showErrorMessage("当前视频时长无效");
        return;
      }
      const draft = getSfxDraftByEpisode(row.episodeIndex, durationSec);
      const draftSegments = buildSfxSegments(draft.splitPoints || [], durationSec);
      const safeSelectedSegmentIndex =
        draftSegments.length > 0 ? Math.min(Math.max(0, Number(draft.selectedSegmentIndex || 0)), draftSegments.length - 1) : 0;
      const selectedSegment = draftSegments[safeSelectedSegmentIndex] || null;
      if (!selectedSegment) {
        showErrorMessage("请先在进度条上设置至少一个截取点并选择分段");
        return;
      }
      const selectedFile = bgmUploadFileMap[row.episodeIndex];
      if (!selectedFile) {
        showErrorMessage("请先选择要上传的音频文件");
        return;
      }
      setUploadingBgmEpisodeIndex(row.episodeIndex);
      showInfoMessage(`正在上传 ${row.title} BGM 并应用到第${safeSelectedSegmentIndex + 1}段...`);
      try {
        const data = await uploadEpisodeBgmAudio(token, projectId, {
          jobId: current.job_id,
          sourceVideoUrl: currentSourceUrl,
          segmentIndex: safeSelectedSegmentIndex,
          startSec: selectedSegment.startSec,
          endSec: selectedSegment.endSec,
          file: selectedFile,
        });
        setEpisodePipelineMap((prev) => ({ ...prev, [row.episodeIndex]: data }));
        setBgmUploadFileMap((prev) => ({ ...prev, [row.episodeIndex]: null }));
        showSuccessMessage(`${row.title} BGM 已应用到第${safeSelectedSegmentIndex + 1}段`);
      } catch (err) {
        showErrorMessage(err instanceof Error ? err.message : "上传 BGM 失败");
      } finally {
        setUploadingBgmEpisodeIndex(null);
      }
    },
    [
      projectId,
      clipDurationMap,
      bgmUploadFileMap,
      ensureSfxPipeline,
      getEpisodeSourceClipUrls,
      getSfxDraftByEpisode,
      showErrorMessage,
      showInfoMessage,
      showSuccessMessage,
    ]
  );

  if (loading || !persistReady) {
    return <div className="text-sm text-slate-500">加载中...</div>;
  }

  const toggleScriptExpand = (episodeIndex: number) => {
    setExpandedScriptEpisodeSet((prev) => {
      const next = new Set(prev);
      if (next.has(episodeIndex)) {
        next.delete(episodeIndex);
      } else {
        next.add(episodeIndex);
      }
      return next;
    });
  };

  const toggleSfxCollapse = (episodeIndex: number) => {
    setCollapsedSfxEpisodeSet((prev) => {
      const next = new Set(prev);
      if (next.has(episodeIndex)) {
        next.delete(episodeIndex);
      } else {
        next.add(episodeIndex);
      }
      return next;
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Step 5: 视频编辑</h1>
        <div className="flex items-center gap-4">
          <button
            onClick={() => router.push(`/projects/${projectId}/script/storyboard`)}
            className="rounded-lg border border-slate-200 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50"
          >
            上一步：分镜
          </button>
          <button
            onClick={() => router.push(`/projects/${projectId}/final`)}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm text-white"
          >
            下一步：成片
          </button>
        </div>
      </div>

      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-600">
          {error}
        </div>
      ) : null}
      {downloadMessage ? (
        <div
          className={`rounded-lg border p-4 text-sm ${
            downloadMessageType === "error"
              ? "border-red-200 bg-red-50 text-red-700"
              : downloadMessageType === "success"
                ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                : "border-blue-200 bg-blue-50 text-blue-700"
          }`}
        >
          {downloadMessage}
        </div>
      ) : null}
      {actionToast ? (
        <div
          className={`fixed right-6 top-20 z-50 max-w-md rounded-lg border px-4 py-3 text-sm shadow-lg ${
            actionToast.type === "error"
              ? "border-red-200 bg-red-50 text-red-700"
              : "border-emerald-200 bg-emerald-50 text-emerald-700"
          }`}
        >
          {actionToast.text}
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="text-xs text-slate-500">总集数</div>
          <div className="mt-1 text-2xl font-semibold text-slate-900">{episodeRows.length}</div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="text-xs text-slate-500">已选分镜视频数</div>
          <div className="mt-1 text-2xl font-semibold text-slate-900">{totalVideoCount}</div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="text-xs text-slate-500">总时长</div>
          <div className="mt-1 text-2xl font-semibold text-slate-900">{formatSeconds(totalDuration)}</div>
        </div>
      </div>

      {episodeRows.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-slate-500">
          暂无分集数据，请先在 Step4 生成并保存分镜。
        </div>
      ) : (
        <div className="space-y-6">
          {episodeRows.map((row) => {
            const mergedVideoUrl = mergedVideoUrlMap[row.episodeIndex];
            const readyCount = mergedVideoUrl ? 1 : 0;
            const pipeline = episodePipelineMap[row.episodeIndex];
            const sfxCollapsed = collapsedSfxEpisodeSet.has(row.episodeIndex);
            const activeEditorTab = episodeEditorTabMap[row.episodeIndex] || "ambient";
            const isSplitApplied = splitAppliedEpisodeSet.has(row.episodeIndex);
            const splitDraft = normalizeRangePoints(splitDraftMap[row.episodeIndex] || pipeline?.split_points || [], pipeline?.duration_sec || 0);
            const waveformZoom = Math.max(1, Math.min(6, splitWaveformZoomMap[row.episodeIndex] || 1));
            const sfxDurationSec = Math.max(0, Number((mergedVideoUrl ? clipDurationMap[mergedVideoUrl] : 0) || pipeline?.duration_sec || 0));
            const sfxDraft = getSfxDraftByEpisode(row.episodeIndex, sfxDurationSec);
            const sfxSafePoints = normalizeSfxPoints(sfxDraft.splitPoints || [], sfxDurationSec);
            const sfxSegments = buildSfxSegments(sfxDraft.splitPoints || [], sfxDurationSec);
            const safeSelectedSegmentIndex =
              sfxSegments.length > 0 ? Math.min(Math.max(0, Number(sfxDraft.selectedSegmentIndex || 0)), sfxSegments.length - 1) : 0;
            const selectedSfxSegment = sfxSegments[safeSelectedSegmentIndex] || null;
            const sfxClipDuration = selectedSfxSegment?.durationSec || 0;
            const sfxSegmentResults = (() => {
              const base = (Array.isArray(pipeline?.sfx_segment_results) ? pipeline.sfx_segment_results : [])
                .filter((item) => Boolean(item?.audio_url))
                .slice();
              return base;
            })()
              .sort((a, b) => {
                const segmentDelta = Number(a.segment_index || 0) - Number(b.segment_index || 0);
                if (segmentDelta !== 0) return segmentDelta;
                const versionDelta = Number(a.version || 1) - Number(b.version || 1);
                if (versionDelta !== 0) return versionDelta;
                return String(a.updated_at || "").localeCompare(String(b.updated_at || ""));
              });
            const selectedSegmentSfxResults = sfxSegmentResults.filter(
              (item) => Number(item.segment_index || 0) === safeSelectedSegmentIndex
            );
            const selectedVersion = Math.max(
              1,
              Number(sfxDraft.selectedSfxVersionMap?.[safeSelectedSegmentIndex] || 0)
            );
            const selectedSfxResult =
              selectedSegmentSfxResults.find((item) => Math.max(1, Number(item.version || 1)) === selectedVersion) ||
              (selectedSegmentSfxResults.length > 0 ? selectedSegmentSfxResults[selectedSegmentSfxResults.length - 1] : null);
            const bgmSegmentResults = (Array.isArray(pipeline?.bgm_segment_results) ? pipeline.bgm_segment_results : [])
              .filter((item) => Boolean(item?.audio_url))
              .slice()
              .sort((a, b) => {
                const segmentDelta = Number(a.segment_index || 0) - Number(b.segment_index || 0);
                if (segmentDelta !== 0) return segmentDelta;
                const versionDelta = Number(a.version || 1) - Number(b.version || 1);
                if (versionDelta !== 0) return versionDelta;
                return String(a.updated_at || "").localeCompare(String(b.updated_at || ""));
              });
            const selectedSegmentBgmResults = bgmSegmentResults.filter(
              (item) => Number(item.segment_index || 0) === safeSelectedSegmentIndex
            );
            const selectedBgmFile = bgmUploadFileMap[row.episodeIndex] || null;
            const fxDraft = getFxDraftByEpisode(row.episodeIndex);
            const fxTags = fxTagMap[row.episodeIndex] || [];
            const fxSearchResults = fxSearchResultMap[row.episodeIndex] || [];
            const fxPlacedSounds = (Array.isArray(fxDraft.placedSounds) ? fxDraft.placedSounds : [])
              .slice()
              .sort((a, b) => Number(a.startSec || 0) - Number(b.startSec || 0));
            return (
              <section key={row.episodeIndex} className="rounded-xl border border-slate-200 bg-white p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="flex items-center gap-2">
                      <h2 className="text-lg font-semibold text-slate-900">{row.title}</h2>
                      <div className="text-xs text-slate-500">{`分镜序号 ${row.startOrder}-${Math.max(row.startOrder, row.endOrder)}`}</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleExtractAudioPipeline(row)}
                      disabled={extractingEpisodeIndex === row.episodeIndex || readyCount === 0}
                      className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs text-emerald-700 hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {extractingEpisodeIndex === row.episodeIndex ? "提取中..." : "一键提取配音"}
                    </button>
                  </div>
                </div>
                <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-4">
                  <div className="flex items-center justify-between">
                    <div className="text-xs font-medium text-slate-600">该集剧本（来源 Step1）</div>
                    <button
                      type="button"
                      onClick={() => toggleScriptExpand(row.episodeIndex)}
                      className="text-xs text-slate-600 hover:text-slate-900"
                    >
                      {expandedScriptEpisodeSet.has(row.episodeIndex) ? "收起" : "展开"}
                    </button>
                  </div>
                  {expandedScriptEpisodeSet.has(row.episodeIndex) ? (
                    <pre className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-slate-800">
                      {row.scriptContent || "暂无Step1剧本内容"}
                    </pre>
                  ) : null}
                </div>
                {pipeline ? (
                  <div className="mt-4 space-y-3">
                    <div className="rounded border border-amber-100 bg-amber-50/70 p-3">
                      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <div className="text-sm font-semibold text-amber-800">音效编辑</div>
                          {activeEditorTab === "ambient" ? (
                            <button
                              type="button"
                              onClick={() => toggleSfxCollapse(row.episodeIndex)}
                              className="rounded border border-amber-200 bg-white px-2 py-1 text-xs text-amber-700 hover:bg-amber-100"
                            >
                              {sfxCollapsed ? "展开" : "收起"}
                            </button>
                          ) : null}
                        </div>
                        <div className="flex flex-wrap items-center gap-1">
                          {[
                            { key: "ambient", label: "环境音效" },
                            { key: "fx", label: "特效" },
                            { key: "dialogue", label: "台词" },
                            { key: "bgm", label: "bgm" },
                          ].map((tab) => (
                            <button
                              key={tab.key}
                              type="button"
                              onClick={() =>
                                setEpisodeEditorTabMap((prev) => ({
                                  ...prev,
                                  [row.episodeIndex]: tab.key as EpisodeEditorTab,
                                }))
                              }
                              className={`rounded border px-2 py-1 text-xs ${
                                activeEditorTab === tab.key
                                  ? "border-amber-300 bg-amber-100 text-amber-800"
                                  : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                              }`}
                            >
                              {tab.label}
                            </button>
                          ))}
                        </div>
                      </div>
                      {mergedVideoUrl ? (
                        <VideoPointSelector
                          src={resolveBackendMediaUrl(mergedVideoUrl)}
                          durationSec={sfxDurationSec}
                          points={sfxDraft.splitPoints || []}
                          selectedSegmentIndex={safeSelectedSegmentIndex}
                          applyingCutPoints={applyingSfxSegmentsEpisodeIndex === row.episodeIndex}
                          applyCutPointsDisabled={sfxSafePoints.length <= 0 || !mergedVideoUrl}
                          onApplyCutPoints={() => void handleApplySfxCutPoints(row)}
                          onSelectSegment={(index: number) =>
                            setSfxDraftMap((prev) => {
                              const currentDraft = prev[row.episodeIndex] || sfxDraft;
                              return {
                                ...prev,
                                [row.episodeIndex]: {
                                  ...currentDraft,
                                  selectedSegmentIndex: index,
                                  segmentsReady: true,
                                },
                              };
                            })
                          }
                          onChange={(next: number[]) =>
                            setSfxDraftMap((prev) => {
                              const currentDraft = prev[row.episodeIndex] || sfxDraft;
                              return {
                                ...prev,
                                [row.episodeIndex]: {
                                  ...currentDraft,
                                  splitPoints: next,
                                  segmentsReady: true,
                                  selectedSegmentIndex: Math.min(
                                    Math.max(0, Number(currentDraft.selectedSegmentIndex || 0)),
                                    Math.max(0, buildSfxSegments(next, sfxDurationSec).length - 1)
                                  ),
                                },
                              };
                            })
                          }
                          onInvalidChange={(message: string) => showErrorMessage(message)}
                          sfxSegmentResults={sfxSegmentResults}
                          selectedSfxResult={selectedSfxResult}
                          selectedSfxVersionMap={sfxDraft.selectedSfxVersionMap || {}}
                          deletingSfxVersionKey={
                            deletingSfxVersionKey?.startsWith(`${row.episodeIndex}:`)
                              ? deletingSfxVersionKey.slice(`${row.episodeIndex}:`.length)
                              : null
                          }
                          onDeleteSfxVersion={(segment) => void handleDeleteSfxVersion(row, segment)}
                          onSelectSfxVersion={(segmentIndex, version) =>
                            setSfxDraftMap((prev) => {
                              const currentDraft = prev[row.episodeIndex] || sfxDraft;
                              return {
                                ...prev,
                                [row.episodeIndex]: {
                                  ...currentDraft,
                                  selectedSfxVersionMap: {
                                    ...(currentDraft.selectedSfxVersionMap || {}),
                                    [segmentIndex]: Math.max(1, Number(version || 1)),
                                  },
                                  segmentsReady: true,
                                },
                              };
                            })
                          }
                          showEditorPanel={activeEditorTab === "ambient"}
                        />
                      ) : (
                        <div className="rounded border border-dashed border-amber-200 bg-white p-3 text-xs text-slate-500">
                          当前暂无可预览视频，请先完成该集视频合并。
                        </div>
                      )}
                      {activeEditorTab === "ambient" && !sfxCollapsed ? (
                        <>
                          {selectedSfxSegment ? (
                            <div className="mt-2 text-[11px] text-slate-500">{`当前分段时长：${sfxClipDuration.toFixed(2)} 秒（需 ${SFX_SEGMENT_MIN_SEC}-${SFX_SEGMENT_MAX_SEC} 秒）`}</div>
                          ) : (
                            <div className="mt-2 text-[11px] text-slate-500">请先在进度条上设置至少一个截取点以生成分段</div>
                          )}
                          <label className="mt-2 block text-xs text-slate-600">
                            背景音提示词
                            <textarea
                              value={sfxDraft.backgroundSoundPrompt}
                              onChange={(event) =>
                                setSfxDraftMap((prev) => {
                                  const currentDraft = prev[row.episodeIndex] || sfxDraft;
                                  return {
                                    ...prev,
                                    [row.episodeIndex]: {
                                      ...currentDraft,
                                      backgroundSoundPrompt: event.target.value,
                                    },
                                  };
                                })
                              }
                              maxLength={200}
                              rows={2}
                              className="mt-1 w-full rounded border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700"
                            />
                          </label>
                          <div className="mt-3 flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => handleGenerateSfx(row)}
                                disabled={
                                  generatingSfxEpisodeIndex === row.episodeIndex ||
                                  !mergedVideoUrl ||
                                  !selectedSfxSegment
                                }
                                className="rounded border border-amber-300 bg-amber-100 px-3 py-1 text-xs text-amber-800 hover:bg-amber-200 disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                {generatingSfxEpisodeIndex === row.episodeIndex ? "生成中..." : "生成音效"}
                              </button>
                            </div>
                            {pipeline.sfx_status ? <div className="text-[11px] text-slate-500">{`任务状态：${pipeline.sfx_status}`}</div> : null}
                          </div>
                          <div className="mt-2 text-[11px] text-slate-500">
                            {selectedSegmentSfxResults.length > 0
                              ? `当前段已生成 ${selectedSegmentSfxResults.length} 个版本，点击“播放第${safeSelectedSegmentIndex + 1}段”将与视频同步播放已选版本（当前：版本${Math.max(1, Number(selectedSfxResult?.version || selectedVersion || 1))}）。`
                              : "当前段暂无音效版本，生成后会在截取进度条下方显示音轨条。"}
                          </div>
                        </>
                      ) : null}
                      {activeEditorTab === "fx" ? (
                        <div className="mt-2 space-y-3">
                          <div className="rounded border border-slate-200 bg-white p-3">
                            <div className="mb-2 text-xs font-medium text-slate-700">音轨条（可拖动音效到任意时间点）</div>
                            {sfxDurationSec > 0 ? (
                              <div
                                onDragOver={(event) => event.preventDefault()}
                                onDrop={(event) => {
                                  event.preventDefault();
                                  const raw = event.dataTransfer.getData("application/freesound-item");
                                  if (!raw) return;
                                  let sound: FreeSoundSound | null = null;
                                  try {
                                    sound = JSON.parse(raw) as FreeSoundSound;
                                  } catch {
                                    sound = null;
                                  }
                                  if (!sound || !sound.preview_url) return;
                                  const rect = event.currentTarget.getBoundingClientRect();
                                  const positionRatio = rect.width > 0 ? Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) : 0;
                                  const safeDuration = Math.max(0.1, Number(sound.duration || 0));
                                  const rawStart = positionRatio * sfxDurationSec;
                                  const startSec = Math.max(0, Math.min(Math.max(0, sfxDurationSec - safeDuration), rawStart));
                                  setFxDraftMap((prev) => {
                                    const currentDraft = prev[row.episodeIndex] || fxDraft;
                                    const nextPlaced = [
                                      ...(Array.isArray(currentDraft.placedSounds) ? currentDraft.placedSounds : []),
                                      {
                                        placementId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
                                        soundId: Math.max(0, Number(sound?.id || 0)),
                                        name: String(sound?.name || "未命名音效"),
                                        previewUrl: String(sound?.preview_url || ""),
                                        durationSec: safeDuration,
                                        startSec,
                                      },
                                    ];
                                    return {
                                      ...prev,
                                      [row.episodeIndex]: {
                                        ...currentDraft,
                                        placedSounds: nextPlaced,
                                        selectedSoundId: Math.max(0, Number(sound?.id || 0)),
                                      },
                                    };
                                  });
                                }}
                                className="relative h-20 rounded border border-slate-200 bg-slate-50"
                              >
                                <div className="absolute inset-y-0 left-0 w-px bg-slate-200" />
                                <div className="absolute inset-y-0 right-0 w-px bg-slate-200" />
                                <div className="absolute left-0 top-1 text-[10px] text-slate-400">0s</div>
                                <div className="absolute right-0 top-1 text-[10px] text-slate-400">{`${sfxDurationSec.toFixed(2)}s`}</div>
                                {fxPlacedSounds.map((item) => {
                                  const leftPercent = sfxDurationSec > 0 ? (Math.max(0, Number(item.startSec || 0)) / sfxDurationSec) * 100 : 0;
                                  const widthPercent = sfxDurationSec > 0 ? (Math.max(0.1, Number(item.durationSec || 0.1)) / sfxDurationSec) * 100 : 0;
                                  return (
                                    <div
                                      key={item.placementId}
                                      className="absolute top-7 h-8 rounded border border-amber-300 bg-amber-100 px-1 text-[10px] text-amber-800"
                                      style={{
                                        left: `${Math.max(0, Math.min(98, leftPercent))}%`,
                                        width: `${Math.max(4, Math.min(100, widthPercent))}%`,
                                      }}
                                    >
                                      <div className="flex items-center justify-between gap-1">
                                        <span className="truncate">{item.name}</span>
                                        <button
                                          type="button"
                                          onClick={() =>
                                            setFxDraftMap((prev) => {
                                              const currentDraft = prev[row.episodeIndex] || fxDraft;
                                              return {
                                                ...prev,
                                                [row.episodeIndex]: {
                                                  ...currentDraft,
                                                  placedSounds: (currentDraft.placedSounds || []).filter(
                                                    (soundItem) => soundItem.placementId !== item.placementId
                                                  ),
                                                },
                                              };
                                            })
                                          }
                                          className="rounded border border-amber-300 bg-white px-1 text-[10px] text-amber-700"
                                        >
                                          删
                                        </button>
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            ) : (
                              <div className="rounded border border-dashed border-slate-200 px-3 py-4 text-[11px] text-slate-400">
                                当前视频时长不可用，暂无法拖拽音效
                              </div>
                            )}
                          </div>
                          <div className="rounded border border-slate-200 bg-white p-3">
                            <div className="flex flex-wrap items-center gap-2">
                              <input
                                value={fxDraft.searchKeyword}
                                onChange={(event) =>
                                  setFxDraftMap((prev) => {
                                    const currentDraft = prev[row.episodeIndex] || fxDraft;
                                    return {
                                      ...prev,
                                      [row.episodeIndex]: {
                                        ...currentDraft,
                                        searchKeyword: event.target.value,
                                      },
                                    };
                                  })
                                }
                                placeholder="关键词搜索音效（如 sword whoosh）"
                                className="w-64 rounded border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700"
                              />
                              <button
                                type="button"
                                onClick={() => void handleSearchFreeSound(row)}
                                disabled={searchingFxEpisodeIndex === row.episodeIndex}
                                className="rounded border border-slate-200 bg-white px-3 py-1 text-xs text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                {searchingFxEpisodeIndex === row.episodeIndex ? "搜索中..." : "搜索音效"}
                              </button>
                              <button
                                type="button"
                                onClick={() => void handleLoadFreeSoundTags(row)}
                                disabled={loadingFxTagsEpisodeIndex === row.episodeIndex}
                                className="rounded border border-slate-200 bg-white px-3 py-1 text-xs text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                {loadingFxTagsEpisodeIndex === row.episodeIndex ? "加载中..." : "刷新标签"}
                              </button>
                            </div>
                            <div className="mt-2 flex flex-wrap gap-2">
                              <button
                                type="button"
                                onClick={() =>
                                  setFxDraftMap((prev) => {
                                    const currentDraft = prev[row.episodeIndex] || fxDraft;
                                    return {
                                      ...prev,
                                      [row.episodeIndex]: {
                                        ...currentDraft,
                                        selectedTag: "",
                                      },
                                    };
                                  })
                                }
                                className={`rounded border px-2 py-1 text-[11px] ${
                                  !fxDraft.selectedTag
                                    ? "border-amber-300 bg-amber-100 text-amber-800"
                                    : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                                }`}
                              >
                                全部
                              </button>
                              {fxTags.map((tag) => (
                                <button
                                  key={tag.name}
                                  type="button"
                                  onClick={() =>
                                    setFxDraftMap((prev) => {
                                      const currentDraft = prev[row.episodeIndex] || fxDraft;
                                      return {
                                        ...prev,
                                        [row.episodeIndex]: {
                                          ...currentDraft,
                                          selectedTag: tag.name,
                                        },
                                      };
                                    })
                                  }
                                  className={`rounded border px-2 py-1 text-[11px] ${
                                    fxDraft.selectedTag === tag.name
                                      ? "border-amber-300 bg-amber-100 text-amber-800"
                                      : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                                  }`}
                                >
                                  {tag.name}
                                </button>
                              ))}
                            </div>
                          </div>
                          <div className="rounded border border-slate-200 bg-white p-3">
                            <div className="text-xs font-medium text-slate-700">Freesound 音效列表（支持试听与拖拽）</div>
                            {fxSearchResults.length > 0 ? (
                              <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2">
                                {fxSearchResults.map((sound) => (
                                  <div
                                    key={sound.id}
                                    draggable
                                    onDragStart={(event) => {
                                      event.dataTransfer.setData("application/freesound-item", JSON.stringify(sound));
                                      event.dataTransfer.effectAllowed = "copy";
                                    }}
                                    className="rounded border border-slate-200 bg-slate-50 p-2"
                                  >
                                    <div className="mb-1 flex items-center justify-between gap-2">
                                      <div className="truncate text-xs font-medium text-slate-700">{sound.name}</div>
                                      <div className="text-[11px] text-slate-500">{`${Number(sound.duration || 0).toFixed(2)}s`}</div>
                                    </div>
                                    <InlineAudioPlayer src={sound.preview_url} />
                                    <div className="mt-1 truncate text-[11px] text-slate-500">
                                      {Array.isArray(sound.tags) && sound.tags.length > 0 ? sound.tags.join(" · ") : "无标签"}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <div className="mt-2 rounded border border-dashed border-slate-200 px-3 py-4 text-[11px] text-slate-400">
                                暂无音效结果，可先选择标签或输入关键词后搜索
                              </div>
                            )}
                          </div>
                        </div>
                      ) : null}
                      {activeEditorTab === "bgm" ? (
                        <div className="mt-2 space-y-3">
                          {selectedSfxSegment ? (
                            <div className="text-[11px] text-slate-500">{`当前选中第${safeSelectedSegmentIndex + 1}段：${selectedSfxSegment.startSec.toFixed(2)}s - ${selectedSfxSegment.endSec.toFixed(2)}s（${selectedSfxSegment.durationSec.toFixed(2)}s）`}</div>
                          ) : (
                            <div className="text-[11px] text-slate-500">请先在上方进度条设置截取点并选择分段</div>
                          )}
                          <div className="rounded border border-amber-200 bg-white p-3">
                            <div className="text-xs font-medium text-slate-700">上传音频并应用到当前分段</div>
                            <div className="mt-2 flex flex-wrap items-center gap-2">
                              <input
                                type="file"
                                accept="audio/*"
                                onChange={(event) =>
                                  setBgmUploadFileMap((prev) => ({
                                    ...prev,
                                    [row.episodeIndex]: event.target.files?.[0] || null,
                                  }))
                                }
                                className="max-w-xs text-xs text-slate-600 file:mr-2 file:rounded file:border file:border-slate-200 file:bg-white file:px-2 file:py-1 file:text-xs file:text-slate-700"
                              />
                              <button
                                type="button"
                                onClick={() => void handleUploadBgm(row)}
                                disabled={uploadingBgmEpisodeIndex === row.episodeIndex || !selectedSfxSegment || !selectedBgmFile}
                                className="rounded border border-amber-300 bg-amber-100 px-3 py-1 text-xs text-amber-800 hover:bg-amber-200 disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                {uploadingBgmEpisodeIndex === row.episodeIndex ? "上传中..." : `应用到第${safeSelectedSegmentIndex + 1}段`}
                              </button>
                            </div>
                            {selectedBgmFile ? (
                              <div className="mt-2 text-[11px] text-slate-500">{`待上传：${selectedBgmFile.name}`}</div>
                            ) : (
                              <div className="mt-2 text-[11px] text-slate-400">尚未选择音频文件</div>
                            )}
                          </div>
                          <div className="rounded border border-slate-200 bg-white p-3">
                            <div className="text-xs font-medium text-slate-700">{`第${safeSelectedSegmentIndex + 1}段音轨`}</div>
                            {selectedSegmentBgmResults.length > 0 ? (
                              <div className="mt-2 space-y-2">
                                {selectedSegmentBgmResults.map((item, index) => (
                                  <div
                                    key={`${item.segment_index}-${item.version || 1}-${item.updated_at || index}`}
                                    className="rounded border border-slate-100 bg-slate-50 p-2"
                                  >
                                    <div className="mb-1 text-[11px] text-slate-600">{`版本${Math.max(1, Number(item.version || 1))} · ${String(item.original_filename || "已上传音频")}`}</div>
                                    {item.audio_url ? <InlineAudioPlayer src={resolveBackendMediaUrl(item.audio_url)} /> : null}
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <div className="mt-2 rounded border border-dashed border-slate-200 px-2 py-2 text-[11px] text-slate-400">
                                当前分段尚未应用上传音频
                              </div>
                            )}
                          </div>
                          <div className="rounded border border-slate-200 bg-white p-3">
                            <div className="text-xs font-medium text-slate-700">分段音轨概览</div>
                            {sfxSegments.length > 0 ? (
                              <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2">
                                {sfxSegments.map((segment, segmentIndex) => {
                                  const segmentVersions = bgmSegmentResults.filter(
                                    (item) => Number(item.segment_index || 0) === segmentIndex
                                  );
                                  return (
                                    <button
                                      key={`bgm-summary-${segmentIndex}`}
                                      type="button"
                                      onClick={() =>
                                        setSfxDraftMap((prev) => {
                                          const currentDraft = prev[row.episodeIndex] || sfxDraft;
                                          return {
                                            ...prev,
                                            [row.episodeIndex]: {
                                              ...currentDraft,
                                              selectedSegmentIndex: segmentIndex,
                                              segmentsReady: true,
                                            },
                                          };
                                        })
                                      }
                                      className={`rounded border px-2 py-2 text-left text-[11px] ${
                                        segmentIndex === safeSelectedSegmentIndex
                                          ? "border-amber-300 bg-amber-50 text-amber-800"
                                          : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                                      }`}
                                    >
                                      {`第${segmentIndex + 1}段 · ${segment.startSec.toFixed(2)}s-${segment.endSec.toFixed(2)}s · 音轨${segmentVersions.length}条`}
                                    </button>
                                  );
                                })}
                              </div>
                            ) : (
                              <div className="mt-2 text-[11px] text-slate-400">暂无分段</div>
                            )}
                          </div>
                        </div>
                      ) : null}
                      {activeEditorTab === "dialogue" ? (
                      <>
                        <div className="mt-2">
                        <div className="flex items-center justify-between">
                          <div className="text-xs font-medium text-slate-700">原始音轨</div>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => handleTranscribeEpisode(row)}
                              disabled={!pipeline.original_isolated_audio_url || transcribingEpisodeIndex === row.episodeIndex}
                              className="rounded border border-indigo-200 bg-indigo-50 px-2 py-1 text-xs text-indigo-700 hover:bg-indigo-100 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              {transcribingEpisodeIndex === row.episodeIndex ? "转写中..." : "提取文字"}
                            </button>
                            <button
                              type="button"
                              onClick={() => handleExtractOriginalVocal(row)}
                              disabled={!pipeline.source_audio_url || extractingOriginalVocalEpisodeIndex === row.episodeIndex}
                              className="rounded border border-sky-200 bg-sky-50 px-2 py-1 text-xs text-sky-700 hover:bg-sky-100 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              {extractingOriginalVocalEpisodeIndex === row.episodeIndex ? "提取中..." : "提取人声"}
                            </button>
                          </div>
                        </div>
                      <div className="mb-3 grid grid-cols-1 gap-3">
                        <div>
                          {pipeline.source_audio_url ? <InlineAudioPlayer key={pipeline.source_audio_url} src={resolveBackendMediaUrl(pipeline.source_audio_url)} /> : <div className="text-[11px] text-slate-400">暂无可播放音频</div>}
                        </div>
                        <div>
                          <div className="mb-1 text-[11px] text-slate-500">人声音轨</div>
                          {pipeline.original_isolated_audio_url ? (
                            <InlineAudioPlayer key={pipeline.original_isolated_audio_url} src={resolveBackendMediaUrl(pipeline.original_isolated_audio_url)} />
                          ) : (
                            <div className="rounded border border-dashed border-slate-200 px-2 py-2 text-[11px] text-slate-400">尚未提取人声</div>
                          )}
                          {pipeline.episode_transcription ? (
                            <div className="mt-2 rounded border border-indigo-100 bg-indigo-50 p-2">
                              <div className="mb-1 text-[11px] font-medium text-indigo-700">整集转写文字</div>
                              <div className="text-[11px] leading-relaxed text-slate-600 whitespace-pre-wrap">{pipeline.episode_transcription}</div>
                            </div>
                          ) : null}
                          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                            <div className="flex flex-wrap items-center gap-2">
                              <button
                                type="button"
                                onClick={() => handlePreviewSelectedRange(row)}
                                disabled={!pipeline.original_isolated_audio_url}
                                className="rounded border border-sky-200 bg-sky-50 px-2 py-1 text-xs text-sky-700 hover:bg-sky-100 disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                {playingRangeEpisodeIndex === row.episodeIndex ? "停止播放" : "播放选中区域"}
                              </button>
                              <button
                                type="button"
                                onClick={() => handleApplySplitPoints(row)}
                                disabled={!pipeline.original_isolated_audio_url || updatingSplitEpisodeIndex === row.episodeIndex}
                                className="rounded border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                {updatingSplitEpisodeIndex === row.episodeIndex ? "保存中..." : "应用分割点"}
                              </button>
                            </div>
                            <div className="ml-auto flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() =>
                                  setSplitWaveformZoomMap((prev) => ({
                                    ...prev,
                                    [row.episodeIndex]: Math.max(1, Number((waveformZoom / 1.25).toFixed(3))),
                                  }))
                                }
                                disabled={waveformZoom <= 1.001}
                                className="rounded border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                缩小
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  setSplitWaveformZoomMap((prev) => ({
                                    ...prev,
                                    [row.episodeIndex]: Math.min(6, Number((waveformZoom * 1.25).toFixed(3))),
                                  }))
                                }
                                disabled={waveformZoom >= 5.999}
                                className="rounded border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                放大
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>
                      <SplitWaveform
                        waveform={pipeline.waveform || []}
                        durationSec={pipeline.duration_sec || 0}
                        splitPoints={splitDraft}
                        waveformZoom={waveformZoom}
                        onChange={(next) =>
                          setSplitDraftMap((prev) => ({
                            ...prev,
                            [row.episodeIndex]: next,
                          }))
                        }
                      />
                        </div>
                    {isSplitApplied ? (
                      <div className="mt-3 space-y-3">
                        <div className="text-xs text-slate-500">{`分段数 ${pipeline.segments.length}`}</div>
                        {pipeline.segments.map((segment) => {
                          const voiceKey = `${row.episodeIndex}:${segment.id}`;
                          const defaultVoice = getDefaultVoiceForSegment(segment.speaker_label);
                          const selectedVoiceRaw = segmentVoiceMap[voiceKey] || "";
                          const selectedVoice = step3S2SVoices.some((voice) => voice._id === selectedVoiceRaw)
                            ? selectedVoiceRaw
                            : defaultVoice || step3S2SVoices[0]?._id || "";
                          const selectedModel = segmentModelMap[voiceKey] || s2sModels[0]?.model_id || "";
                          return (
                            <div key={segment.id} className="rounded border border-slate-200 bg-white p-3 text-xs text-slate-600">
                              <div className="flex items-center justify-between">
                                <div className="font-medium text-slate-700">{`${segment.speaker_label} · ${formatSeconds(segment.start_sec)} - ${formatSeconds(segment.end_sec)}`}</div>
                                <button
                                  type="button"
                                  onClick={() => handleDeleteSegmentAudio(row, segment.id)}
                                  disabled={deletingSegmentKey === voiceKey || s2sSegmentKey === voiceKey}
                                  className="rounded border border-rose-200 bg-rose-50 px-2 py-1 text-[11px] text-rose-700 hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                  {deletingSegmentKey === voiceKey ? "删除中..." : "删除"}
                                </button>
                              </div>
                              <div className="mt-2 flex items-center gap-2">
                                <select
                                  value={selectedVoice}
                                  onChange={(event) =>
                                    setSegmentVoiceMap((prev) => ({
                                      ...prev,
                                      [voiceKey]: event.target.value,
                                    }))
                                  }
                                  className="h-8 flex-1 rounded border border-slate-200 bg-white px-2 text-xs text-slate-700"
                                >
                                  {(step3S2SVoices.length > 0
                                    ? step3S2SVoices
                                    : [{ _id: "", title: "请先在 Step3 配置角色音色" } as ElevenLabsVoiceModel]
                                  ).map((voice) => (
                                    <option key={voice._id || "empty"} value={voice._id}>
                                      {voice.title || voice._id}
                                    </option>
                                  ))}
                                </select>
                                <select
                                  value={selectedModel}
                                  onChange={(event) =>
                                    setSegmentModelMap((prev) => ({
                                      ...prev,
                                      [voiceKey]: event.target.value,
                                    }))
                                  }
                                  className="h-8 flex-1 rounded border border-slate-200 bg-white px-2 text-xs text-slate-700"
                                >
                                  {(s2sModels.length > 0
                                    ? s2sModels
                                    : [{ model_id: "", name: "暂无S2S模型" } as ElevenLabsModel]
                                  ).map((model) => (
                                    <option key={model.model_id || "empty"} value={model.model_id}>
                                      {model.name || model.model_id}
                                    </option>
                                  ))}
                                </select>
                                <button
                                  type="button"
                                  onClick={() => handleSegmentS2S(row, segment.id)}
                                  disabled={!segment.source_audio_url || !selectedVoice || !selectedModel || s2sSegmentKey === voiceKey || deletingSegmentKey === voiceKey}
                                  className="rounded border border-violet-200 bg-violet-50 px-2 py-1 text-xs text-violet-700 hover:bg-violet-100 disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                  {s2sSegmentKey === voiceKey ? "生成中..." : "S2S"}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleTranscribeSegment(row, segment.id)}
                                  disabled={
                                    (!segment.source_audio_url && !segment.dubbed_audio_url) ||
                                    (transcribingSegmentEpisodeIndex === row.episodeIndex && transcribingSegmentKey === voiceKey)
                                  }
                                  className="rounded border border-indigo-200 bg-indigo-50 px-2 py-1 text-xs text-indigo-700 hover:bg-indigo-100 disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                  {transcribingSegmentEpisodeIndex === row.episodeIndex && transcribingSegmentKey === voiceKey
                                    ? "转写中..."
                                    : "提取文字"}
                                </button>
                              </div>
                              <div className="mt-2 space-y-2">
                                {segment.source_audio_url ? <InlineAudioPlayer key={segment.source_audio_url} src={resolveBackendMediaUrl(segment.source_audio_url)} /> : null}
                                <div>
                                  <div className="mb-1 text-[11px] text-slate-500">S2S 结果</div>
                                  {segment.dubbed_audio_url ? (
                                    <InlineAudioPlayer key={segment.dubbed_audio_url} src={resolveBackendMediaUrl(segment.dubbed_audio_url)} />
                                  ) : (
                                    <div className="rounded border border-dashed border-slate-200 px-2 py-2 text-[11px] text-slate-400">暂无 S2S 音频</div>
                                  )}
                                </div>
                                {segment.transcription ? (
                                  <div className="rounded border border-indigo-100 bg-indigo-50 p-2">
                                    <div className="mb-1 text-[11px] font-medium text-indigo-700">转写文字</div>
                                    <div className="text-[11px] leading-relaxed text-slate-600 whitespace-pre-wrap">{segment.transcription}</div>
                                  </div>
                                ) : null}
                              </div>
                            </div>
                          );
                        })}
                        <div className="flex justify-end">
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => handleMergeDubbedAudio(row)}
                              disabled={
                                mergingDubbedEpisodeIndex === row.episodeIndex ||
                                muxingDubbedVideoEpisodeIndex === row.episodeIndex ||
                                pipeline.segments.length === 0 ||
                                pipeline.segments.every((segment) => !segment.dubbed_audio_url)
                              }
                              className="rounded border border-indigo-200 bg-indigo-50 px-2 py-1 text-xs text-indigo-700 hover:bg-indigo-100 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              {mergingDubbedEpisodeIndex === row.episodeIndex ? "合并中..." : "一键合并配音"}
                            </button>
                            <button
                              type="button"
                              onClick={() => handleMuxDubbedVideo(row)}
                              disabled={
                                muxingDubbedVideoEpisodeIndex === row.episodeIndex ||
                                mergingDubbedEpisodeIndex === row.episodeIndex ||
                                !pipeline.merged_dubbed_audio_url
                              }
                              className="rounded border border-violet-200 bg-violet-50 px-2 py-1 text-xs text-violet-700 hover:bg-violet-100 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              {muxingDubbedVideoEpisodeIndex === row.episodeIndex ? "合成中..." : "音视频合成"}
                            </button>
                          </div>
                        </div>
                        {pipeline.merged_dubbed_audio_url ? (
                          <div className="rounded border border-indigo-100 bg-indigo-50/40 px-2 py-2">
                            <div className="mb-1 text-[11px] text-indigo-700">合并配音结果</div>
                            <InlineAudioPlayer key={pipeline.merged_dubbed_audio_url} src={resolveBackendMediaUrl(pipeline.merged_dubbed_audio_url)} />
                          </div>
                        ) : null}
                      </div>
                    ) : (
                      <div className="mt-3 rounded border border-dashed border-slate-300 bg-white p-3 text-xs text-slate-500">
                        请先调整并点击“应用分割点”，再显示角色音色选择与分段 S2S。
                      </div>
                    )}
                      </>
                    ) : null}
                    </div>
                  </div>
                ) : null}
                {pipeline?.merged_dubbed_video_url ? (
                  <div className="mt-4 rounded-lg border border-violet-100 bg-violet-50/30 p-4">
                    <div className="mb-2 text-xs font-medium text-violet-700">音视频合成结果</div>
                    <video
                      key={pipeline.merged_dubbed_video_url}
                      src={resolveBackendMediaUrl(pipeline.merged_dubbed_video_url)}
                      controls
                      preload="metadata"
                      className="w-full rounded-md border border-violet-100 bg-black"
                    />
                  </div>
                ) : null}
              </section>
            );
          })}
        </div>
      )}
      <div className="rounded-xl border border-slate-200 bg-white p-4 text-xs text-slate-500">
        按每集顺序展示所选分镜视频，并支持在当前分集内播放与拖动进度预览。
      </div>
    </div>
  );
}
