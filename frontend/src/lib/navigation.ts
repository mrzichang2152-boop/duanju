"use client";

const defaultAuthedPath = "/projects";

export const normalizeRedirectPath = (value?: string | null) => {
  const raw = String(value || "").trim();
  if (!raw) {
    return defaultAuthedPath;
  }
  if (raw.startsWith("/") && !raw.startsWith("//")) {
    return raw;
  }
  if (typeof window === "undefined") {
    return defaultAuthedPath;
  }
  try {
    const parsed = new URL(raw, window.location.origin);
    if (parsed.origin !== window.location.origin) {
      return defaultAuthedPath;
    }
    const normalized = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    return normalized.startsWith("/") ? normalized : defaultAuthedPath;
  } catch {
    return defaultAuthedPath;
  }
};

export const buildLoginUrl = (redirectPath?: string | null) => {
  const resolvedRedirect =
    redirectPath ??
    (typeof window !== "undefined"
      ? `${window.location.pathname}${window.location.search}${window.location.hash}`
      : defaultAuthedPath);
  const normalized = normalizeRedirectPath(resolvedRedirect);
  if (!normalized || normalized === "/login") {
    return "/login";
  }
  return `/login?redirect=${encodeURIComponent(normalized)}`;
};

export const redirectToLogin = (redirectPath?: string | null) => {
  if (typeof window === "undefined") {
    return;
  }
  window.location.href = buildLoginUrl(redirectPath);
};

export const resolvePostLoginPath = (redirectPath?: string | null) => {
  const normalized = normalizeRedirectPath(redirectPath);
  if (normalized === "/login") {
    return defaultAuthedPath;
  }
  return normalized;
};
