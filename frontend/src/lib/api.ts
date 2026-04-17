type ApiErrorDetailItem = {
  loc?: Array<string | number>;
  msg?: string;
  type?: string;
};

export type ApiError = {
  detail?: string | ApiErrorDetailItem[] | Record<string, unknown>;
  message?: string;
  error?: string | Record<string, unknown>;
};

const formatApiErrorDetail = (detail: ApiError["detail"]) => {
  if (!detail) {
    return null;
  }
  if (typeof detail === "string") {
    const lowerDetail = detail.toLowerCase();
    if (lowerDetail.includes("429") || lowerDetail.includes("quota exceeded") || lowerDetail.includes("too many requests")) {
      if (lowerDetail.includes("快速通道")) {
        return "快速通道生成服务限流（Gemini 额度已达上限），请尝试关闭“快速通道”后再次生成，或等待一段时间后重试。";
      }
      return "生成服务限流中，请稍后再试。";
    }
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
  if (typeof detail === "object") {
    const detailObject = detail as Record<string, unknown>;
    const directMessage = detailObject.message;
    if (typeof directMessage === "string" && directMessage.trim()) {
      return directMessage.trim();
    }
    const nestedError = detailObject.error;
    if (typeof nestedError === "string" && nestedError.trim()) {
      return nestedError.trim();
    }
    if (nestedError && typeof nestedError === "object") {
      const nestedMessage = (nestedError as Record<string, unknown>).message;
      if (typeof nestedMessage === "string" && nestedMessage.trim()) {
        return nestedMessage.trim();
      }
    }
    try {
      return JSON.stringify(detailObject, ensureASCIIReplacer);
    } catch {
      return String(detailObject);
    }
  }
  return null;
};

const ensureASCIIReplacer = (_key: string, value: unknown) => {
  if (typeof value === "bigint") {
    return value.toString();
  }
  return value;
};

const parseApiErrorMessage = (bodyText: string, statusCode: number, fallback: string) => {
  const trimmed = bodyText.trim();
  if (!trimmed) {
    return `${fallback}（${statusCode}）`;
  }
  try {
    const parsed = JSON.parse(trimmed) as ApiError;
    const detailText = formatApiErrorDetail(parsed.detail);
    if (detailText) {
      return detailText;
    }
    if (typeof parsed.message === "string" && parsed.message.trim()) {
      return parsed.message.trim();
    }
    if (typeof parsed.error === "string" && parsed.error.trim()) {
      return parsed.error.trim();
    }
    if (parsed.error && typeof parsed.error === "object") {
      const nestedMessage = (parsed.error as Record<string, unknown>).message;
      if (typeof nestedMessage === "string" && nestedMessage.trim()) {
        return nestedMessage.trim();
      }
      return JSON.stringify(parsed.error, ensureASCIIReplacer);
    }
    return `${fallback}（${statusCode}）: ${trimmed}`;
  } catch {
    return `${fallback}（${statusCode}）: ${trimmed}`;
  }
};

const resolveApiBaseUrl = () => {
  const raw = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "/api").trim();
  if (!raw) {
    return "/api";
  }
  if (typeof window === "undefined") {
    return raw;
  }
  if (raw === "/api") {
    return "/api";
  }
  if (raw.startsWith("/")) {
    return raw;
  }
  try {
    const parsed = new URL(raw);
    const isLocalHost = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    const isCrossOrigin = parsed.origin !== window.location.origin;
    if (isLocalHost && isCrossOrigin) {
      return "/api";
    }
    return raw;
  } catch {
    return raw;
  }
};

const baseUrl = resolveApiBaseUrl();
const normalizeToken = (token?: string | null) => (token ?? "").trim();
const REQUEST_TIMEOUT_MS = 15000;
const SUBJECT_GENERATE_TIMEOUT_MS = 180000;
const VIDEO_GENERATE_TIMEOUT_MS = 420000;
const SCRIPT_GENERATE_TIMEOUT_MS = 240000;

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
    const authMessage = parseApiErrorMessage(bodyText, response.status, "登录状态校验失败，请重试");
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
    throw new Error(parseApiErrorMessage(bodyText, response.status, "请求失败"));
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
  storyboardTaskId?: string;
  storyboardTaskStatus?: "pending" | "running" | "completed" | "failed";
  storyboardTaskError?: string;
  storyboardTaskThinking?: string;
  dialogueCellAudioMap?: Record<string, Array<{ text: string; audioUrl: string }>>;
  isThinkingCollapsed?: boolean;
}
export type ScriptEpisodePayload = Episode | Record<string, unknown>;

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
  state_url?: string;
  markdown_url?: string;
};

const hydrateScriptResponseFromStateUrl = async (payload: ScriptResponse): Promise<ScriptResponse> => {
  const stateUrl = String(payload?.state_url || "").trim();
  if (!stateUrl) {
    return payload;
  }
  if (typeof window !== "undefined") {
    try {
      const parsed = new URL(stateUrl, window.location.origin);
      if (parsed.origin !== window.location.origin) {
        return payload;
      }
    } catch {
      return payload;
    }
  }
  try {
    const response = await fetch(stateUrl, { cache: "no-store" });
    if (!response.ok) {
      return payload;
    }
    const remote = (await response.json()) as Partial<ScriptResponse>;
    return {
      ...payload,
      ...remote,
      state_url: payload.state_url,
      markdown_url: payload.markdown_url,
    };
  } catch {
    return payload;
  }
};

export const getScript = async (token: string, id: string) =>
  hydrateScriptResponseFromStateUrl(await request<ScriptResponse>(`/projects/${id}/script`, {}, token));

export const saveScript = async (
  token: string,
  id: string,
  content?: string,
  thinking?: string,
  storyboard?: string,
  outline?: string,
  episodes?: ScriptEpisodePayload[]
) =>
  hydrateScriptResponseFromStateUrl(
    await request<ScriptResponse>(
      `/projects/${id}/script`,
      {
        method: "POST",
        body: JSON.stringify({ content, thinking, storyboard, outline, episodes }),
      },
      token
    )
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
  stream?: boolean;
};

export type ScriptGenerateResponse = {
  content: string;
  thinking?: string;
};

export type StoryboardTaskStartPayload = {
  episode_index: number;
  episode_title: string;
  episode_content: string;
  model?: string;
  instruction?: string;
};

export type StoryboardTaskStatusResponse = {
  task_id: string;
  project_id: string;
  episode_index: number;
  episode_title: string;
  status: "pending" | "running" | "completed" | "failed";
  content?: string | null;
  thinking?: string | null;
  error?: string | null;
};

export type AsyncTaskStatusResponse = {
  task_id: string;
  project_id: string;
  task_type: string;
  status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED";
  result?: Record<string, unknown> | null;
  error?: string | null;
};

export type Step2TaskTarget = "character" | "prop" | "scene";

export type Step2TaskStartPayload = {
  op: "extract" | "modify" | "sync";
  target?: Step2TaskTarget;
  original_content?: string;
  resources_content?: string;
  model?: string;
  instruction?: string;
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

export const generateScript = async (
  token: string,
  id: string,
  payload: ScriptGeneratePayload
): Promise<ScriptGenerateResponse> => {
  if (payload.stream === false) {
    const result = await request<ScriptGenerateResponse>(
      `/projects/${id}/script/generate`,
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
      token,
      SCRIPT_GENERATE_TIMEOUT_MS
    );
    const normalized = String(result?.content ?? "").trim();
    if (!normalized) {
      throw new Error("模型未返回可用内容，请检查模型权限或稍后重试");
    }
    return { content: normalized, thinking: String(result?.thinking ?? "") };
  }

  let content = "";
  let thinking = "";
  await generateScriptStream(token, id, payload, (chunk: ScriptStreamChunk) => {
    if (chunk.choices?.[0]?.delta?.content) {
      content += chunk.choices[0].delta.content;
    }
    if (chunk.choices?.[0]?.delta?.reasoning_content) {
      thinking += chunk.choices[0].delta.reasoning_content;
    }
  });
  const normalizedContent = content.trim();
  if (!normalizedContent) {
    throw new Error("模型未返回可用内容，请检查模型权限或稍后重试");
  }
  return { content: normalizedContent, thinking };
};

export const startStoryboardTask = (
  token: string,
  id: string,
  payload: StoryboardTaskStartPayload
) =>
  request<StoryboardTaskStatusResponse>(
    `/projects/${id}/script/storyboard-tasks/start`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
    token
  );

export const getStoryboardTaskStatus = (token: string, id: string, taskId: string) =>
  request<StoryboardTaskStatusResponse>(
    `/projects/${id}/script/storyboard-tasks/${taskId}`,
    {},
    token
  );

export const startStep2Task = (token: string, id: string, payload: Step2TaskStartPayload) =>
  request<AsyncTaskStatusResponse>(
    `/projects/${id}/script/step2-tasks/start`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
    token
  );

export const getStep2TaskStatus = (token: string, id: string, taskId: string) =>
  request<AsyncTaskStatusResponse>(
    `/projects/${id}/script/step2-tasks/${taskId}`,
    {},
    token
  );

export const generateScriptStream = async (
  token: string,
  id: string,
  payload: ScriptGeneratePayload,
  onChunk: (chunk: ScriptStreamChunk) => void,
  signal?: AbortSignal
) => {
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
  base_character_name?: string | null;
  versions: AssetVersion[];
};

export const getAssets = (token: string, id: string) =>
  request<Asset[]>(`/projects/${id}/assets?t=${Date.now()}`, { cache: "no-store" }, token, 60000);

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
  payload: { prompt?: string; model?: string; ref_image_url?: string; style?: string; options?: Record<string, unknown> }
) =>
  request<AsyncTaskStatusResponse>(
    `/projects/${projectId}/assets/${assetId}/generate`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
    token
  );

export const getAssetGenerateTaskStatus = (token: string, projectId: string, taskId: string) =>
  request<AsyncTaskStatusResponse>(
    `/projects/${projectId}/assets/generate-tasks/${taskId}`,
    {},
    token
  );

export const generateAssetSubject = (
  token: string,
  projectId: string,
  assetId: string,
  payload?: { allow_without_voice?: boolean }
) =>
  request<{ status: string; subject_id: string }>(
    `/projects/${projectId}/assets/${assetId}/generate-subject`,
    {
      method: "POST",
      body: payload ? JSON.stringify(payload) : undefined,
    },
    token,
    SUBJECT_GENERATE_TIMEOUT_MS
  );

export const generateImageSubject = (
  token: string,
  projectId: string,
  payload: {
    image_url: string;
    character_name: string;
    material_name?: string;
    material_description?: string;
    allow_without_voice?: boolean;
  }
) =>
  request<{ status: string; subject_id: string }>(
    `/projects/${projectId}/kling-subjects/from-image`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
    token,
    SUBJECT_GENERATE_TIMEOUT_MS
  );

export const uploadAssetImage = async (
  token: string,
  projectId: string,
  assetId: string,
  file: File
) => {
  const normalizedToken = normalizeToken(token);
  const formData = new FormData();
  formData.append("file", file);
  const response = await fetch(`${baseUrl}/projects/${projectId}/assets/${assetId}/upload`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${normalizedToken}`,
    },
    body: formData,
  });
  if (response.status === 401) {
    const bodyText = await response.text();
    const authMessage = parseApiErrorMessage(bodyText, response.status, "登录状态校验失败，请重试");
    throw new Error(authMessage);
  }
  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(parseApiErrorMessage(bodyText, response.status, "上传失败"));
  }
  return response.json() as Promise<{ status: string }>;
};

export const uploadTemporaryMaterialImage = async (
  token: string,
  projectId: string,
  file: File
) => {
  const normalizedToken = normalizeToken(token);
  const formData = new FormData();
  formData.append("file", file);
  const response = await fetch(`${baseUrl}/projects/${projectId}/assets/upload-temp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${normalizedToken}`,
    },
    body: formData,
  });
  if (response.status === 401) {
    const bodyText = await response.text();
    throw new Error(parseApiErrorMessage(bodyText, response.status, "登录状态校验失败，请重试"));
  }
  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(parseApiErrorMessage(bodyText, response.status, "上传素材失败"));
  }
  return response.json() as Promise<{ status: string; image_url: string }>;
};

export const selectAssetVersion = (token: string, projectId: string, assetId: string, versionId: string) =>
  request<{ status: string }>(
    `/projects/${projectId}/assets/${assetId}/select`,
    {
      method: "PUT",
      body: JSON.stringify({ version_id: versionId }),
    },
    token
  );

// Voice & ElevenLabs API

export type ElevenLabsVoiceModel = {
  _id: string;
  title: string;
  description?: string;
  default_text?: string;
  cover_image?: string;
  preview_audio?: string;
  tags?: string[];
  languages?: string[];
  labels?: Record<string, string>;
  category?: string;
  samples?: Array<{ audio?: string; text?: string; title?: string }>;
  is_my_voice?: boolean;
  is_clone?: boolean;
  can_delete?: boolean;
};

export type ElevenLabsVoiceFacets = {
  languages: string[];
  accents: string[];
  genders: string[];
  ages: string[];
  qualities: string[];
};

export type ElevenLabsModel = {
  model_id: string;
  name: string;
  description?: string;
  can_do_text_to_speech: boolean;
  can_do_voice_conversion: boolean;
  languages?: Array<Record<string, unknown>>;
};

export const getElevenLabsVoices = (
  token: string,
  params?: {
    page?: number;
    size?: number;
    language?: string;
    query?: string;
    accent?: string;
    gender?: string;
    age?: string;
    quality?: string;
    includeLibrary?: boolean;
  }
) =>
  request<{ items: ElevenLabsVoiceModel[]; total: number; facets?: ElevenLabsVoiceFacets; has_more?: boolean }>(
    `/eleven-labs/voices?page=${params?.page ?? 1}&size=${params?.size ?? 100}${
      params?.language ? `&language=${encodeURIComponent(params.language)}` : ""
    }${params?.query ? `&query=${encodeURIComponent(params.query)}` : ""}${
      params?.accent ? `&accent=${encodeURIComponent(params.accent)}` : ""
    }${params?.gender ? `&gender=${encodeURIComponent(params.gender)}` : ""}${
      params?.age ? `&age=${encodeURIComponent(params.age)}` : ""
    }${params?.quality ? `&quality=${encodeURIComponent(params.quality)}` : ""}${
      typeof params?.includeLibrary === "boolean" ? `&include_library=${params.includeLibrary ? "true" : "false"}` : ""
    }`,
    {},
    token,
    45000
  );

export const getElevenLabsModels = (
  token: string,
  params?: { canDoVoiceConversion?: boolean }
) =>
  request<{ items: ElevenLabsModel[]; total: number }>(
    `/eleven-labs/models${
      typeof params?.canDoVoiceConversion === "boolean"
        ? `?can_do_voice_conversion=${params.canDoVoiceConversion ? "true" : "false"}`
        : ""
    }`,
    {},
    token,
    45000
  );

export const generateElevenLabsPreview = async (
  token: string,
  payload: { text: string; voice_id: string; output_format?: string; settings?: Record<string, unknown> }
) => {
  const normalizedToken = normalizeToken(token);
  const formData = new FormData();
  formData.append("text", payload.text);
  formData.append("voice_id", payload.voice_id);
  formData.append("output_format", payload.output_format ?? "mp3_44100_128");
  if (payload.settings) {
    formData.append("settings_json", JSON.stringify(payload.settings));
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 45000);
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/eleven-labs/tts`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${normalizedToken}`,
      },
      body: formData,
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error("ElevenLabs 试听生成超时，请稍后重试");
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
    throw new Error(formatApiErrorDetail(detail) ?? "ElevenLabs 试听生成失败");
  }

  return response.blob();
};

export const cloneElevenLabsVoice = async (token: string, file: File, title: string) => {
  const normalizedToken = normalizeToken(token);
  const formData = new FormData();
  formData.append("title", title);
  formData.append("file", file);

  const response = await fetch(`${baseUrl}/eleven-labs/clone`, {
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
    throw new Error(formatApiErrorDetail(detail) ?? "ElevenLabs 音色克隆失败");
  }

  return response.json() as Promise<{ _id?: string; model_id?: string; title?: string; cover_image?: string }>;
};

export const getMyClonedElevenLabsVoices = (token: string) =>
  request<{ items: ElevenLabsVoiceModel[]; total: number; limit: number; remaining: number }>(
    `/eleven-labs/cloned-voices`,
    {},
    token,
    45000
  );

export const deleteElevenLabsVoice = (token: string, voiceId: string) =>
  request<{ status: string; voice_id: string }>(
    `/eleven-labs/voices/${encodeURIComponent(voiceId)}`,
    {
      method: "DELETE",
    },
    token
  );

export const getFishAudioModels = getElevenLabsVoices;
export type FishAudioModel = ElevenLabsVoiceModel;
export const generateFishAudioPreview = (
  token: string,
  payload: { text: string; reference_id: string; format?: "mp3" | "wav" }
) =>
  generateElevenLabsPreview(token, {
    text: payload.text,
    voice_id: payload.reference_id,
    output_format: payload.format === "wav" ? "pcm_44100" : "mp3_44100_128",
  });
export const cloneVoice = cloneElevenLabsVoice;

export type CharacterVoice = {
  id: string;
  project_id: string;
  character_name: string;
  voice_id: string;
  voice_type: string;
  preview_url?: string;
  config?: Record<string, unknown>;
};

export const getProjectVoices = (token: string, projectId: string) =>
  request<CharacterVoice[]>(`/projects/${projectId}/voices`, {}, token);

export const updateCharacterVoice = (
  token: string,
  projectId: string,
  characterName: string,
  payload: { voice_id: string; voice_type: string; preview_url?: string; config?: Record<string, unknown> }
) =>
  request<CharacterVoice>(
    `/projects/${projectId}/voices/${characterName}`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
    token
  );

export const uploadCharacterVoiceSample = async (
  token: string,
  projectId: string,
  characterName: string,
  file: File,
  payload?: { title?: string; duration_sec?: number }
) => {
  const normalizedToken = normalizeToken(token);
  const formData = new FormData();
  formData.append("file", file);
  if (payload?.title) {
    formData.append("title", payload.title);
  }
  if (typeof payload?.duration_sec === "number" && Number.isFinite(payload.duration_sec)) {
    formData.append("duration_sec", String(payload.duration_sec));
  }
  const response = await fetch(`${baseUrl}/projects/${projectId}/voices/${characterName}/upload-sample`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${normalizedToken}`,
    },
    body: formData,
  });
  if (response.status === 401) {
    const bodyText = await response.text();
    throw new Error(parseApiErrorMessage(bodyText, response.status, "登录状态校验失败，请重试"));
  }
  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(parseApiErrorMessage(bodyText, response.status, "上传音频失败"));
  }
  return response.json() as Promise<CharacterVoice>;
};

export const uploadCharacterVoiceSampleOnly = async (
  token: string,
  projectId: string,
  characterName: string,
  file: File,
  payload?: { title?: string; duration_sec?: number }
) => {
  const normalizedToken = normalizeToken(token);
  const formData = new FormData();
  formData.append("file", file);
  if (payload?.title) {
    formData.append("title", payload.title);
  }
  if (typeof payload?.duration_sec === "number" && Number.isFinite(payload.duration_sec)) {
    formData.append("duration_sec", String(payload.duration_sec));
  }
  const response = await fetch(`${baseUrl}/projects/${projectId}/voices/${characterName}/upload-sample-only`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${normalizedToken}`,
    },
    body: formData,
  });
  if (response.status === 401) {
    const bodyText = await response.text();
    throw new Error(parseApiErrorMessage(bodyText, response.status, "登录状态校验失败，请重试"));
  }
  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(parseApiErrorMessage(bodyText, response.status, "上传音频失败"));
  }
  return response.json() as Promise<CharacterVoice>;
};
export const generateTTS = (
  token: string,
  projectId: string,
  payload: {
    text: string;
    character_name: string;
    speed?: number;
    volume?: number;
    pitch?: number;
    tts_config?: Record<string, unknown>;
  }
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
    token,
    VIDEO_GENERATE_TIMEOUT_MS
  );

export type SegmentVersion = {
  id: string;
  video_url: string;
  prompt?: string | null;
  status: string;
  task_id?: string | null;
  task_status_msg?: string | null;
  is_selected: boolean;
};

export type Segment = {
  id: string;
  order_index: number;
  text_content: string;
  status: string;
  task_status?: string | null;
  task_id?: string | null;
  versions: SegmentVersion[];
};

export const getSegments = (token: string, id: string) =>
  request<Segment[]>(`/projects/${id}/segments`, {}, token);

export const generateSegment = (
  token: string,
  projectId: string,
  payload: { segment_id?: string; prompt?: string; model?: string; options?: Record<string, unknown> }
) =>
  request<{ status: string }>(
    `/projects/${projectId}/segments/generate`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
    token,
    VIDEO_GENERATE_TIMEOUT_MS
  );

export const generateSegmentFrameImage = (
  token: string,
  projectId: string,
  payload: { prompt: string; references?: string[]; frame_type?: string; aspect_ratio?: string; model?: string; quick_channel?: boolean }
) =>
  request<AsyncTaskStatusResponse>(
    `/projects/${projectId}/segments/frame-images/generate`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
    token,
    REQUEST_TIMEOUT_MS
  );

export const getSegmentFrameImageTaskStatus = (token: string, projectId: string, taskId: string) =>
  request<AsyncTaskStatusResponse>(
    `/projects/${projectId}/segments/frame-images/tasks/${taskId}?t=${Date.now()}`,
    { cache: "no-store" },
    token
  );

export const deleteSegmentFrameImage = (token: string, projectId: string, imageUrl: string) =>
  request<{ status: string }>(
    `/projects/${projectId}/segments/frame-images/delete`,
    {
      method: "POST",
      body: JSON.stringify({ image_url: imageUrl }),
    },
    token,
    REQUEST_TIMEOUT_MS
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

export const deleteSegmentVersion = (
  token: string,
  projectId: string,
  segmentId: string,
  versionId: string
) =>
  request<{ status: string }>(
    `/projects/${projectId}/segments/${segmentId}/versions/${versionId}`,
    {
      method: "DELETE",
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

export const downloadMergedEpisode = async (
  token: string,
  projectId: string,
  payload: { episodeTitle?: string; clipUrls: string[] }
) => {
  const normalizedToken = normalizeToken(token);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), VIDEO_GENERATE_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/projects/${projectId}/episodes/merge-download`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${normalizedToken}`,
      },
      body: JSON.stringify({
        episode_title: payload.episodeTitle || "",
        clip_urls: payload.clipUrls,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error("分集合并超时，请稍后重试");
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(parseApiErrorMessage(bodyText, response.status, "分集合并下载失败"));
  }
  const blob = await response.blob();
  const disposition = response.headers.get("content-disposition") || "";
  const filenameMatch = disposition.match(/filename\*?=(?:UTF-8''|")?([^\";]+)/i);
  const rawFilename = filenameMatch?.[1] || `${(payload.episodeTitle || "episode").trim() || "episode"}.mp4`;
  const filename = decodeURIComponent(rawFilename.replace(/"/g, "").trim());
  return { blob, filename };
};

export type EpisodeMergeStoreResult = {
  merge_key: string;
  merged_video_url: string;
  already_exists: boolean;
  episode_title: string;
};

export const mergeEpisodeOnServer = (
  token: string,
  projectId: string,
  payload: { episodeTitle?: string; clipUrls: string[] },
  timeoutMs: number = VIDEO_GENERATE_TIMEOUT_MS
) =>
  request<EpisodeMergeStoreResult>(
    `/projects/${projectId}/episodes/merge-store`,
    {
      method: "POST",
      body: JSON.stringify({
        episode_title: payload.episodeTitle || "",
        clip_urls: payload.clipUrls,
      }),
    },
    token,
    timeoutMs
  );

export type EpisodeAudioPipelineSegment = {
  id: string;
  index: number;
  start_sec: number;
  end_sec: number;
  speaker_label: string;
  source_audio_url: string;
  isolated_audio_url: string;
  dubbed_audio_url: string;
  transcription?: string;
  transcription_language?: string;
};

export type EpisodeSfxSegmentResult = {
  segment_index: number;
  version?: number;
  start_sec: number;
  end_sec: number;
  duration_sec: number;
  clip_video_url?: string;
  audio_url?: string;
  video_url?: string;
  background_sound_prompt?: string;
  updated_at?: string;
};

export type EpisodeAppliedSfxSegmentResult = {
  segment_index: number;
  start_sec: number;
  end_sec: number;
  duration_sec: number;
  clip_video_url?: string;
  video_url?: string;
  updated_at?: string;
};

export type EpisodeBgmSegmentResult = {
  segment_index: number;
  version?: number;
  start_sec: number;
  end_sec: number;
  duration_sec: number;
  audio_url?: string;
  original_filename?: string;
  content_type?: string;
  updated_at?: string;
};

export type FreeSoundTag = {
  name: string;
  count?: number;
};

export type FreeSoundSound = {
  id: number;
  name: string;
  duration: number;
  preview_url: string;
  tags: string[];
  username?: string;
};

export type EpisodeAudioPipelineResult = {
  job_id: string;
  project_id: string;
  episode_title: string;
  created_at: string;
  merge_key?: string;
  merged_video_url: string;
  source_audio_url: string;
  vocal_audio_url: string;
  original_isolated_audio_url?: string;
  merged_dubbed_audio_url?: string;
  merged_dubbed_video_url?: string;
  sfx_clip_video_url?: string;
  sfx_audio_url?: string;
  sfx_video_url?: string;
  sfx_segment_results?: EpisodeSfxSegmentResult[];
  sfx_applied_segment_results?: EpisodeAppliedSfxSegmentResult[];
  sfx_applied_split_points?: number[];
  sfx_background_sound_prompt?: string;
  sfx_soundtrack_prompt?: string;
  sfx_asmr_mode?: boolean;
  sfx_task_id?: string;
  sfx_segment_index?: number;
  sfx_start_sec?: number;
  sfx_end_sec?: number;
  sfx_task_updated_at?: string;
  sfx_status?: string;
  bgm_audio_url?: string;
  bgm_segment_results?: EpisodeBgmSegmentResult[];
  bgm_segment_index?: number;
  bgm_start_sec?: number;
  bgm_end_sec?: number;
  bgm_status?: string;
  bgm_task_updated_at?: string;
  duration_sec: number;
  waveform: number[];
  split_points: number[];
  segments: EpisodeAudioPipelineSegment[];
  episode_transcription?: string;
  episode_transcription_language?: string;
};

export const extractEpisodeAudioPipeline = (
  token: string,
  projectId: string,
  payload: { episodeTitle?: string; clipUrls: string[]; mergeKey?: string }
) =>
  request<EpisodeAudioPipelineResult>(
    `/projects/${projectId}/episodes/audio-pipeline/extract`,
    {
      method: "POST",
      body: JSON.stringify({
        episode_title: payload.episodeTitle || "",
        clip_urls: payload.clipUrls,
        merge_key: payload.mergeKey || "",
      }),
    },
    token,
    VIDEO_GENERATE_TIMEOUT_MS
  );

export const updateEpisodeAudioSplits = (
  token: string,
  projectId: string,
  payload: { jobId: string; splitPoints: number[] }
) =>
  request<EpisodeAudioPipelineResult>(
    `/projects/${projectId}/episodes/audio-pipeline/update-splits`,
    {
      method: "POST",
      body: JSON.stringify({
        job_id: payload.jobId,
        split_points: payload.splitPoints,
      }),
    },
    token
  );

export const generateEpisodeAudioSegments = (
  token: string,
  projectId: string,
  payload: { jobId: string }
) =>
  request<EpisodeAudioPipelineResult>(
    `/projects/${projectId}/episodes/audio-pipeline/generate-segments`,
    {
      method: "POST",
      body: JSON.stringify({
        job_id: payload.jobId,
      }),
    },
    token,
    VIDEO_GENERATE_TIMEOUT_MS
  );

export const generateEpisodeSegmentS2S = (
  token: string,
  projectId: string,
  payload: {
    jobId: string;
    segmentId: string;
    voiceId: string;
    modelId?: string;
    settings?: Record<string, unknown>;
  }
) =>
  request<EpisodeAudioPipelineResult>(
    `/projects/${projectId}/episodes/audio-pipeline/s2s`,
    {
      method: "POST",
      body: JSON.stringify({
        job_id: payload.jobId,
        segment_id: payload.segmentId,
        voice_id: payload.voiceId,
        model_id: payload.modelId,
        settings: payload.settings ?? {},
      }),
    },
    token,
    VIDEO_GENERATE_TIMEOUT_MS
  );

export const deleteEpisodeAudioSegment = (
  token: string,
  projectId: string,
  payload: {
    jobId: string;
    segmentId: string;
  }
) =>
  request<EpisodeAudioPipelineResult>(
    `/projects/${projectId}/episodes/audio-pipeline/delete-segment`,
    {
      method: "POST",
      body: JSON.stringify({
        job_id: payload.jobId,
        segment_id: payload.segmentId,
      }),
    },
    token,
    VIDEO_GENERATE_TIMEOUT_MS
  );

export const extractEpisodeOriginalVocal = (
  token: string,
  projectId: string,
  payload: {
    jobId: string;
  }
) =>
  request<EpisodeAudioPipelineResult>(
    `/projects/${projectId}/episodes/audio-pipeline/extract-original-vocal`,
    {
      method: "POST",
      body: JSON.stringify({
        job_id: payload.jobId,
      }),
    },
    token,
    VIDEO_GENERATE_TIMEOUT_MS
  );

export const mergeEpisodeDubbedAudio = (
  token: string,
  projectId: string,
  payload: {
    jobId: string;
  }
) =>
  request<EpisodeAudioPipelineResult>(
    `/projects/${projectId}/episodes/audio-pipeline/merge-dubbed`,
    {
      method: "POST",
      body: JSON.stringify({
        job_id: payload.jobId,
      }),
    },
    token,
    VIDEO_GENERATE_TIMEOUT_MS
  );

export const muxEpisodeDubbedVideo = (
  token: string,
  projectId: string,
  payload: {
    jobId: string;
  }
) =>
  request<EpisodeAudioPipelineResult>(
    `/projects/${projectId}/episodes/audio-pipeline/mux-dubbed-video`,
    {
      method: "POST",
      body: JSON.stringify({
        job_id: payload.jobId,
      }),
    },
    token,
    VIDEO_GENERATE_TIMEOUT_MS
  );

export const clipEpisodeSfxVideo = (
  token: string,
  projectId: string,
  payload: {
    jobId: string;
    sourceVideoUrl?: string;
    startSec: number;
    endSec: number;
  }
) =>
  request<EpisodeAudioPipelineResult>(
    `/projects/${projectId}/episodes/audio-pipeline/clip-sfx-video`,
    {
      method: "POST",
      body: JSON.stringify({
        job_id: payload.jobId,
        source_video_url: payload.sourceVideoUrl || "",
        start_sec: payload.startSec,
        end_sec: payload.endSec,
      }),
    },
    token,
    VIDEO_GENERATE_TIMEOUT_MS
  );

export const applyEpisodeSfxSegments = (
  token: string,
  projectId: string,
  payload: {
    jobId: string;
    sourceVideoUrl?: string;
    split_points: number[];
  }
) =>
  request<EpisodeAudioPipelineResult>(
    `/projects/${projectId}/episodes/audio-pipeline/apply-sfx-segments`,
    {
      method: "POST",
      body: JSON.stringify({
        job_id: payload.jobId,
        source_video_url: payload.sourceVideoUrl || "",
        split_points: payload.split_points,
      }),
    },
    token,
    VIDEO_GENERATE_TIMEOUT_MS
  );

export const generateEpisodeSfxAudio = (
  token: string,
  projectId: string,
  payload: {
    jobId: string;
    sourceVideoUrl?: string;
    segmentIndex?: number;
    startSec: number;
    endSec: number;
    backgroundSoundPrompt: string;
  }
) =>
  request<EpisodeAudioPipelineResult>(
    `/projects/${projectId}/episodes/audio-pipeline/generate-sfx`,
    {
      method: "POST",
      body: JSON.stringify({
        job_id: payload.jobId,
        source_video_url: payload.sourceVideoUrl || "",
        segment_index: payload.segmentIndex ?? 0,
        start_sec: payload.startSec,
        end_sec: payload.endSec,
        background_sound_prompt: payload.backgroundSoundPrompt,
      }),
    },
    token,
    VIDEO_GENERATE_TIMEOUT_MS
  );

export const deleteEpisodeSfxVersion = (
  token: string,
  projectId: string,
  payload: {
    jobId: string;
    segmentIndex: number;
    version: number;
  }
) =>
  request<EpisodeAudioPipelineResult>(
    `/projects/${projectId}/episodes/audio-pipeline/delete-sfx-version`,
    {
      method: "POST",
      body: JSON.stringify({
        job_id: payload.jobId,
        segment_index: payload.segmentIndex,
        version: payload.version,
      }),
    },
    token,
    VIDEO_GENERATE_TIMEOUT_MS
  );

export const uploadEpisodeBgmAudio = async (
  token: string,
  projectId: string,
  payload: {
    jobId: string;
    sourceVideoUrl?: string;
    segmentIndex?: number;
    startSec: number;
    endSec: number;
    file: File;
  }
) => {
  const normalizedToken = normalizeToken(token);
  const formData = new FormData();
  formData.append("job_id", payload.jobId);
  formData.append("source_video_url", payload.sourceVideoUrl || "");
  formData.append("segment_index", String(Math.max(0, Number(payload.segmentIndex ?? 0))));
  formData.append("start_sec", String(payload.startSec));
  formData.append("end_sec", String(payload.endSec));
  formData.append("file", payload.file);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), VIDEO_GENERATE_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/projects/${projectId}/episodes/audio-pipeline/upload-bgm`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${normalizedToken}`,
      },
      body: formData,
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error("上传 BGM 超时，请稍后重试");
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
  if (response.status === 401) {
    const bodyText = await response.text();
    const authMessage = parseApiErrorMessage(bodyText, response.status, "登录状态校验失败，请重试");
    throw new Error(authMessage);
  }
  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(parseApiErrorMessage(bodyText, response.status, "上传 BGM 失败"));
  }
  return response.json() as Promise<EpisodeAudioPipelineResult>;
};

export const getFreeSoundTags = (
  token: string,
  projectId: string,
  payload?: { query?: string; pageSize?: number }
) =>
  request<{ items: FreeSoundTag[] }>(
    `/projects/${projectId}/episodes/audio-pipeline/freesound-tags?query=${encodeURIComponent(payload?.query || "")}&page_size=${Math.max(
      1,
      Math.min(100, Number(payload?.pageSize || 24))
    )}`,
    {},
    token,
    45000
  ).catch(() => ({ items: [] }));

export const searchFreeSoundSounds = (
  token: string,
  projectId: string,
  payload: { query?: string; tag?: string; page?: number; pageSize?: number }
) =>
  request<{ items: FreeSoundSound[]; count: number; page: number; page_size: number; warning?: string }>(
    `/projects/${projectId}/episodes/audio-pipeline/freesound-search`,
    {
      method: "POST",
      body: JSON.stringify({
        query: payload.query || "",
        tag: payload.tag || "",
        page: Math.max(1, Number(payload.page || 1)),
        page_size: Math.max(1, Math.min(40, Number(payload.pageSize || 20))),
      }),
    },
    token,
    45000
  ).catch(() => ({
    items: [],
    count: 0,
    page: Math.max(1, Number(payload.page || 1)),
    page_size: Math.max(1, Math.min(40, Number(payload.pageSize || 20))),
    warning: "Freesound 搜索暂时不可用",
  }));

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

export type TranscribeSegmentResult = {
  job_id: string;
  segment_id: string;
  text: string;
  language: string;
  segments: EpisodeAudioPipelineSegment[];
};

export const transcribeEpisodeSegment = (
  token: string,
  projectId: string,
  payload: { jobId: string; segmentId: string }
) =>
  request<EpisodeAudioPipelineResult>(
    `/projects/${projectId}/episodes/audio-pipeline/transcribe-segment`,
    {
      method: "POST",
      body: JSON.stringify({
        job_id: payload.jobId,
        segment_id: payload.segmentId,
      }),
    },
    token,
    VIDEO_GENERATE_TIMEOUT_MS
  );

export type TranscribeEpisodeResult = {
  job_id: string;
  text: string;
  language: string;
};

export const transcribeEpisodeAudio = (
  token: string,
  projectId: string,
  payload: { jobId: string }
) =>
  request<EpisodeAudioPipelineResult>(
    `/projects/${projectId}/episodes/audio-pipeline/transcribe-episode`,
    {
      method: "POST",
      body: JSON.stringify({
        job_id: payload.jobId,
      }),
    },
    token,
    VIDEO_GENERATE_TIMEOUT_MS
  );
