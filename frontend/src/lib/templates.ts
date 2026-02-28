export type TemplateContext = Record<string, string | number | null | undefined>;

export const applyTemplate = (template: string, context: TemplateContext) =>
  template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key) => {
    const value = context[key];
    return value === null || value === undefined ? "" : String(value);
  });
