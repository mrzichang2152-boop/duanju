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

const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8002";

const request = async <T>(
  path: string,
  options: RequestInit = {},
  token?: string | null
): Promise<T> => {
  const headers = new Headers(options.headers);
  headers.set("Content-Type", "application/json");
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers,
  });
  if (response.status === 401) {
    if (typeof window !== "undefined") {
      const { clearToken } = await import("@/lib/auth");
      clearToken();
      window.location.href = "/login";
    }
    throw new Error("无效 Token");
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

export type ScriptResponse = {
  project_id: string;
  content: string;
};

export const getScript = (token: string, id: string) =>
  request<ScriptResponse>(`/projects/${id}/script`, {}, token);

export const saveScript = (token: string, id: string, content: string) =>
  request<ScriptResponse>(
    `/projects/${id}/script`,
    {
      method: "POST",
      body: JSON.stringify({ content }),
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
  mode: "format" | "complete" | "revise" | "extract_resources" | "generate_storyboard" | "step1_modify" | "step2_modify" | "suggestion_paid" | "suggestion_traffic";
  content: string;
  model?: string;
  instruction?: string;
};

export type ScriptGenerateResponse = {
  content: string;
};

export const generateScript = (token: string, id: string, payload: ScriptGeneratePayload) =>
  request<ScriptGenerateResponse>(
    `/projects/${id}/script/generate`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
    token
  );

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
  versions: AssetVersion[];
};

export const getAssets = (token: string, id: string) =>
  request<Asset[]>(`/projects/${id}/assets`, {}, token);

export const generateAsset = (
  token: string,
  projectId: string,
  assetId: string,
  payload: { prompt?: string; model?: string; ref_image_url?: string }
) =>
  request<{ status: string }>(
    `/projects/${projectId}/assets/${assetId}/generate`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
    token
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
  payload: { segment_id?: string; prompt?: string; model?: string }
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
