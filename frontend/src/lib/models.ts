export const extractModels = (raw: unknown): string[] => {
  if (!raw) {
    return [];
  }
  if (Array.isArray(raw)) {
    return raw
      .map((item) => {
        if (!item || typeof item !== "object") {
          return null;
        }
        const record = item as Record<string, unknown>;
        return (
          (record.id as string | undefined) ??
          (record.name as string | undefined) ??
          (record.model as string | undefined)
        );
      })
      .filter((value): value is string => Boolean(value));
  }
  if (typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    const data = record.data ?? record.models ?? record.results;
    return extractModels(data);
  }
  return [];
};

/** 从 /linkapi/models 响应中提取 GRSAI 绘画模型（kind=draw 或 id 以 nano-banana 开头） */
export const extractDrawModels = (raw: unknown): string[] => {
  const ordered: string[] = [];
  const seen = new Set<string>();
  const push = (id: string) => {
    const t = id.trim();
    if (!t) return;
    const k = t.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    ordered.push(t);
  };
  const walk = (arr: unknown) => {
    if (!Array.isArray(arr)) return;
    for (const item of arr) {
      if (!item || typeof item !== "object") continue;
      const r = item as Record<string, unknown>;
      const id = typeof r.id === "string" ? r.id : "";
      if (!id.trim()) continue;
      const kind = String(r.kind || "").toLowerCase();
      if (kind === "draw" || id.toLowerCase().startsWith("nano-banana")) {
        push(id.trim());
      }
    }
  };
  if (Array.isArray(raw)) {
    walk(raw);
    return ordered;
  }
  if (typeof raw === "object" && raw) {
    const record = raw as Record<string, unknown>;
    walk(record.data ?? record.models ?? record.results);
  }
  return ordered;
};

export const filterModels = (models: string[], kind: "text" | "image" | "video") => {
  const filtered = models.filter((model) => {
    const value = model.toLowerCase();
    if (kind === "image") {
      return (
        value.includes("image") ||
        value.includes("img") ||
        value.includes("vision") ||
        value.includes("pix") ||
        value.includes("sd") ||
        value.includes("diffusion") ||
        value.includes("dream") ||
        value.includes("flux") ||
        value.includes("midjourney") ||
        value.includes("dall-e") ||
        value.includes("nano-banana") ||
        value.includes("nanobanana")
      );
    }
    if (kind === "video") {
      return (
        value.includes("video") ||
        value.includes("sora") ||
        value.includes("vid") ||
        value.includes("cinema") ||
        value.includes("movie")
      );
    }
    return true;
  });
  return filtered.length ? filtered : models;
};
