"use client";

import { useState } from "react";
import { createProject } from "@/lib/api";
import { getToken } from "@/lib/auth";

export default function NewProjectPage() {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    const token = getToken();
    if (!token) {
      window.location.href = "/login";
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const project = await createProject(token, name);
      window.location.href = `/projects/${project.id}/script`;
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建失败");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <h1 className="text-xl font-semibold">新建项目</h1>
      <div className="mt-6 space-y-4">
        <div>
          <label className="text-sm text-slate-600">项目名称</label>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="mt-2 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
            placeholder="例如：校园悬疑短剧"
          />
        </div>
        {error ? <div className="text-sm text-red-500">{error}</div> : null}
        <button
          onClick={submit}
          disabled={loading || !name}
          className="w-full rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          {loading ? "创建中..." : "创建项目"}
        </button>
      </div>
    </div>
  );
}
