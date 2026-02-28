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
        value.includes("diffusion")
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
