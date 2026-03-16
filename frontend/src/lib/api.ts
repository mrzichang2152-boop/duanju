type ApiErrorDetailItem = {
  loc?: Array<string | number>;
  msg?: string;
  type?: string;
};

export type ApiError = {
  detail?: string | ApiErrorDetailItem[];
};

const formatApiErrorDetail = (detail: ApiError["detail"]) => {
  if (!detail) {
    return null;
  }
  if (typeof detail === "string") {
    return detail;
  }
  if (Array.isArray(detail)) {
    const messages = detail
      .map((item) => item.msg)
      .filter((message): message is string => Boolean(message));
    if (messages.length > 0) {
      return messages.join("；");
    }
  }
  return null;
};

const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8002/api";
const normalizeToken = (token?: string | null) => (token ?? "").trim();
const REQUEST_TIMEOUT_MS = 15000;
const ASSET_GENERATE_TIMEOUT_MS = 180000;

const request = async <T>(
  path: string,
  options: RequestInit = {},
  token?: string | null,
  timeoutMs: number = REQUEST_TIMEOUT_MS
): Promise<T> => {
  const headers = new Headers(options.headers);
  headers.set("Content-Type", "application/json");
  const normalizedToken = normalizeToken(token);
  if (normalizedToken) {
    headers.set("Authorization", `Bearer ${normalizedToken}`);
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  if (options.signal) {
    if (options.signal.aborted) {
      controller.abort();
    } else {
      options.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
  }
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers,
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error("请求超时，请稍后重试");
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
  if (response.status === 401) {
    const bodyText = await response.text();
    let detail: ApiError["detail"];
    if (bodyText) {
      try {
        const parsed = JSON.parse(bodyText) as ApiError;
        detail = parsed.detail;
      } catch {
        detail = bodyText;
      }
    }
    const authMessage = formatApiErrorDetail(detail) ?? "登录状态校验失败，请重试";
    const lower = authMessage.toLowerCase();
    const shouldForceLogout =
      normalizedToken.length > 0 &&
      (authMessage.includes("无效 Token") ||
        authMessage.includes("token 过期") ||
        lower.includes("signature has expired") ||
        lower.includes("token expired"));
    if (shouldForceLogout && typeof window !== "undefined") {
      const { clearToken } = await import("@/lib/auth");
      clearToken();
      window.location.href = "/login";
    }
    throw new Error(authMessage);
  }
  if (!response.ok) {
    const bodyText = await response.text();
    let detail: ApiError["detail"];
    if (bodyText) {
      try {
        const parsed = JSON.parse(bodyText) as ApiError;
        detail = parsed.detail;
      } catch {
        detail = bodyText;
      }
    }
    throw new Error(formatApiErrorDetail(detail) ?? "请求失败");
  }
  if (response.status === 204) {
    return null as T;
  }
  return (await response.json()) as T;
};

export type AuthResponse = {
  access_token: string;
  token_type: string;
};

export type RegisterPayload = {
  email: string;
  password: string;
};

export type LoginPayload = {
  email: string;
  password: string;
};

export type Project = {
  id: string;
  name: string;
  status: string;
};

export const register = (payload: RegisterPayload) =>
  request<AuthResponse>("/auth/register", {
    method: "POST",
    body: JSON.stringify(payload),
  });

export const login = (payload: LoginPayload) =>
  request<AuthResponse>("/auth/login", {
    method: "POST",
    body: JSON.stringify(payload),
  });

export type CharacterProfile = {
  name: string;
  bio: string;
};

export type ScriptParseResponse = {
  theme: string;
  characters: CharacterProfile[];
  episodes: string[];
};

export const parseScriptFile = async (token: string, file: File): Promise<ScriptParseResponse> => {
  const normalizedToken = normalizeToken(token);
  const formData = new FormData();
  formData.append("file", file);

  const response = await fetch(`${baseUrl}/projects/parse`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${normalizedToken}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`File parsing failed: ${errorText}`);
  }

  return response.json();
};

export const getProjects = (token: string) =>
  request<Project[]>("/projects", {}, token);

export const createProject = (token: string, name: string) =>
  request<Project>(
    "/projects",
    {
      method: "POST",
      body: JSON.stringify({ name }),
    },
    token
  );

export const getProject = (token: string, id: string) =>
  request<Project>(`/projects/${id}`, {}, token);

export type ScriptPayload = {
  content: string;
};

export interface Episode {
  title: string;
  content: string;
  thinking: string;
  userInput: string;
  storyboard?: string;
  isThinkingCollapsed?: boolean;
}

export type ScriptResponse = {
  id?: string;
  project_id: string;
  content: string;
  thinking?: string;
  storyboard?: string;
  outline?: string;
  episodes?: Episode[];
  version?: number;
  is_active?: boolean;
  created_at?: string;
};

export const getScript = (token: string, id: string) =>
  request<ScriptResponse>(`/projects/${id}/script`, {}, token);

export const saveScript = (token: string, id: string, content?: string, thinking?: string, storyboard?: string, outline?: string, episodes?: Episode[]) =>
  request<ScriptResponse>(
    `/projects/${id}/script`,
    {
      method: "POST",
      body: JSON.stringify({ content, thinking, storyboard, outline, episodes }),
    },
    token
  );

export type ScriptValidation = {
  valid: boolean;
  missing: string[];
  warnings: string[];
};

export const validateScript = (
  token: string,
  id: string,
  content: string,
  model?: string
) =>
  request<ScriptValidation>(
    `/projects/${id}/script/validate`,
    {
      method: "POST",
      body: JSON.stringify({ content, model }),
    },
    token
  );

export type ScriptGeneratePayload = {
  mode: "format" | "complete" | "revise" | "extract_resources" | "generate_storyboard" | "step1_modify" | "step2_modify" | "suggestion_paid" | "suggestion_traffic" | "continuation" | "continuation_paid" | "continuation_traffic" | "step0_generate" | "step0_continue" | "step0_modify" | "extract_outline" | "split_script";
  content: string;
  model?: string;
  instruction?: string;
};

export type ScriptGenerateResponse = {
  content: string;
  thinking?: string;
};

type ScriptStreamDelta = {
  content?: string;
  reasoning_content?: string;
};

type ScriptStreamChunk = {
  choices?: Array<{
    delta?: ScriptStreamDelta;
  }>;
  error?: string;
};

export const generateScript = (token: string, id: string, payload: ScriptGeneratePayload): Promise<ScriptGenerateResponse> => {
  return new Promise((resolve, reject) => {
    let content = "";
    let thinking = "";
    generateScriptStream(token, id, payload, (chunk: ScriptStreamChunk) => {
      if (chunk.choices?.[0]?.delta?.content) {
        content += chunk.choices[0].delta.content;
      }
      if (chunk.choices?.[0]?.delta?.reasoning_content) {
        thinking += chunk.choices[0].delta.reasoning_content;
      }
    })
      .then(() => resolve({ content, thinking }))
      .catch(reject);
  });
};

export const generateScriptStream = async (
  token: string,
  id: string,
  payload: ScriptGeneratePayload,
  onChunk: (chunk: any) => void,
  signal?: AbortSignal
) => {
  const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8002/api";
  const response = await fetch(`${baseUrl}/projects/${id}/script/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
    signal,
  });

  if (response.status === 401) {
    if (typeof window !== "undefined") {
      const { clearToken } = await import("@/lib/auth");
      clearToken();
      window.location.href = "/login";
    }
    throw new Error("无效 Token，请重新登录");
  }

  if (!response.ok) {
    const errorText = await response.text();
    let errorDetail = "Generation failed";
    try {
      const errorJson = JSON.parse(errorText);
      errorDetail = formatApiErrorDetail(errorJson.detail) || errorText;
    } catch {
      errorDetail = errorText;
    }
    throw new Error(errorDetail);
  }

  if (!response.body) {
    throw new Error("No response body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.trim().startsWith("data: ")) {
          const data = line.trim().slice(6);
          if (data === "[DONE]") return;
          let parsed: ScriptStreamChunk | null = null;
          try {
            parsed = JSON.parse(data) as ScriptStreamChunk;
            const streamError = typeof parsed.error === "string" ? parsed.error : "";
            if (streamError) {
              const normalized = streamError.replace(/^Error:\s*/i, "").trim();
              throw new Error(normalized || "生成失败");
            }
            onChunk(parsed);
          } catch (e) {
            if (e instanceof Error && parsed && typeof parsed.error === "string") {
              throw e;
            }
            console.error("Error parsing SSE data", e);
          }
        }
      }
    }
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "AbortError") {
      console.log('Stream aborted');
      return; // Silece abort error
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
};

export const extractAssets = (token: string, id: string) =>
  request<{ status: string }>(
    `/projects/${id}/assets/extract`,
    {
      method: "POST",
    },
    token
  );

export type AssetVersion = {
  id: string;
  image_url: string;
  prompt?: string | null;
  is_selected: boolean;
};

export type Asset = {
  id: string;
  type: string;
  name: string;
  description: string | null;
  prompt?: string | null;
  model?: string | null;
  size?: string | null;
  style?: string | null;
  versions: AssetVersion[];
};

export const getAssets = (token: string, id: string) =>
  request<Asset[]>(`/projects/${id}/assets?t=${Date.now()}`, { cache: "no-store" }, token);

export const updateAssetConfig = (
  token: string,
  projectId: string,
  assetId: string,
  payload: {
    prompt?: string;
    model?: string;
    size?: string;
    style?: string;
  }
) =>
  request<Asset>(
    `/projects/${projectId}/assets/${assetId}`,
    {
      method: "PUT",
      body: JSON.stringify(payload),
    },
    token
  );

export const generateAsset = (
  token: string,
  projectId: string,
  assetId: string,
  payload: { prompt?: string; model?: string; ref_image_url?: string; style?: string; options?: Record<string, any> }
) =>
  request<{ status: string }>(
    `/projects/${projectId}/assets/${assetId}/generate`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
    token,
    ASSET_GENERATE_TIMEOUT_MS
  );

export const selectAssetVersion = (token: string, projectId: string, assetId: string, versionId: string) =>
  request<{ status: string }>(
    `/projects/${projectId}/assets/${assetId}/select`,
    {
      method: "PUT",
      body: JSON.stringify({ version_id: versionId }),
    },
    token
  );

// Voice & Fish Audio API

export type FishAudioModel = {
  _id: string;
  title: string;
  description?: string;
  default_text?: string;
  cover_image?: string;
  preview_audio?: string;
  tags?: string[];
  languages?: string[];
  samples?: Array<{ audio?: string; text?: string; title?: string }>;
};

export const getFishAudioModels = (
  token: string,
  params?: { page?: number; size?: number; language?: string; query?: string }
) =>
  request<{ items: FishAudioModel[]; total: number }>(
    `/fish-audio/models?page=${params?.page ?? 1}&size=${params?.size ?? 100}${
      params?.language ? `&language=${encodeURIComponent(params.language)}` : ""
    }${params?.query ? `&query=${encodeURIComponent(params.query)}` : ""}`,
    {},
    token,
    45000
  );

export const generateFishAudioPreview = async (
  token: string,
  payload: { text: string; reference_id: string; format?: "mp3" | "wav" }
) => {
  const normalizedToken = normalizeToken(token);
  const formData = new FormData();
  formData.append("text", payload.text);
  formData.append("reference_id", payload.reference_id);
  formData.append("format", payload.format ?? "mp3");
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 45000);
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/fish-audio/tts`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${normalizedToken}`,
      },
      body: formData,
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error("音色试听生成超时，请稍后重试");
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const bodyText = await response.text();
    let detail: ApiError["detail"];
    if (bodyText) {
      try {
        const parsed = JSON.parse(bodyText) as ApiError;
        detail = parsed.detail;
      } catch {
        detail = bodyText;
      }
    }
    throw new Error(formatApiErrorDetail(detail) ?? "音色试听生成失败");
  }

  return response.blob();
};

export const cloneVoice = async (token: string, file: File, title: string) => {
  const normalizedToken = normalizeToken(token);
  const formData = new FormData();
  formData.append("title", title);
  formData.append("file", file);

  const response = await fetch(`${baseUrl}/fish-audio/clone`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${normalizedToken}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const bodyText = await response.text();
    let detail: ApiError["detail"];
    if (bodyText) {
      try {
        const parsed = JSON.parse(bodyText) as ApiError;
        detail = parsed.detail;
      } catch {
        detail = bodyText;
      }
    }
    throw new Error(formatApiErrorDetail(detail) ?? "Voice cloning failed");
  }

  return response.json() as Promise<{ _id?: string; model_id?: string; title?: string; cover_image?: string }>;
};

export type CharacterVoice = {
  id: string;
  project_id: string;
  character_name: string;
  voice_id: string;
  voice_type: string;
  preview_url?: string;
  config?: any;
};

export const getProjectVoices = (token: string, projectId: string) =>
  request<CharacterVoice[]>(`/projects/${projectId}/voices`, {}, token);

export const updateCharacterVoice = (
  token: string,
  projectId: string,
  characterName: string,
  payload: { voice_id: string; voice_type: string; preview_url?: string; config?: any }
) =>
  request<CharacterVoice>(
    `/projects/${projectId}/voices/${characterName}`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
    token
  );

export const generateTTS = (
  token: string,
  projectId: string,
  payload: { text: string; character_name: string; speed?: number; volume?: number; pitch?: number }
) =>
  request<{ audio_url: string }>(
    `/projects/${projectId}/tts`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
    token
  );

export const deleteAssetVersion = (
  token: string,
  projectId: string,
  assetId: string,
  versionId: string
) =>
  request<{ status: string }>(
    `/projects/${projectId}/assets/${assetId}/versions/${versionId}`,
    {
      method: "DELETE",
    },
    token
  );

export const generateSegments = (token: string, id: string) =>
  request<{ status: string }>(
    `/projects/${id}/segments/generate`,
    {
      method: "POST",
    },
    token
  );

export type SegmentVersion = {
  id: string;
  video_url: string;
  prompt?: string | null;
  status: string;
  is_selected: boolean;
};

export type Segment = {
  id: string;
  order_index: number;
  text_content: string;
  status: string;
  versions: SegmentVersion[];
};

export const getSegments = (token: string, id: string) =>
  request<Segment[]>(`/projects/${id}/segments`, {}, token);

export const generateSegment = (
  token: string,
  projectId: string,
  payload: { segment_id?: string; prompt?: string; model?: string; options?: any }
) =>
  request<{ status: string }>(
    `/projects/${projectId}/segments/generate`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
    token
  );

export const selectSegmentVersion = (
  token: string,
  projectId: string,
  segmentId: string,
  versionId: string
) =>
  request<{ status: string }>(
    `/projects/${projectId}/segments/${segmentId}/select`,
    {
      method: "PUT",
      body: JSON.stringify({ version_id: versionId }),
    },
    token
  );

export const mergeFinal = (token: string, id: string) =>
  request<{ status: string }>(
    `/projects/${id}/merge`,
    {
      method: "POST",
    },
    token
  );

export type SettingsResponse = {
  endpoint: string;
  default_model_text: string;
  default_model_image: string;
  default_model_video: string;
  allow_sync: boolean;
  has_key: boolean;
};

export type SettingsUpdate = {
  endpoint?: string;
  api_key?: string;
  default_model_text?: string;
  default_model_image?: string;
  default_model_video?: string;
  allow_sync?: boolean;
};

export const getSettings = (token: string) =>
  request<SettingsResponse>("/settings", {}, token);

export const updateSettings = (token: string, payload: SettingsUpdate) =>
  request<SettingsResponse>(
    "/settings",
    {
      method: "PUT",
      body: JSON.stringify(payload),
    },
    token
  );

export const getModels = (token: string) =>
  request<unknown>("/linkapi/models", {}, token);

export type Template = {
  id: string;
  kind: string;
  name: string;
  content: string;
  tags: string[];
};

export const getTemplates = (token: string, projectId: string, kind: string) =>
  request<Template[]>(`/projects/${projectId}/templates?kind=${encodeURIComponent(kind)}`, {}, token);

export const createTemplate = (
  token: string,
  projectId: string,
  payload: { kind: string; name: string; content: string; tags: string[] }
) =>
  request<Template>(
    `/projects/${projectId}/templates`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
    token
  );

export const deleteTemplate = (token: string, projectId: string, templateId: string) =>
  request<{ status: string }>(
    `/projects/${projectId}/templates/${templateId}`,
    {
      method: "DELETE",
    },
    token
  );

export const updateTemplate = (
  token: string,
  projectId: string,
  templateId: string,
  payload: { name: string; content: string; tags: string[] }
) =>
  request<Template>(
    `/projects/${projectId}/templates/${templateId}`,
    {
      method: "PUT",
      body: JSON.stringify(payload),
    },
    token
  );
