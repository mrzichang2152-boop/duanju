"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { mergeFinal } from "@/lib/api";
import { getToken } from "@/lib/auth";

export default function FinalPage() {
  const params = useParams<{ id: string }>();
  const projectId = params.id;
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const runMerge = async () => {
    if (!projectId) {
      return;
    }
    const token = getToken();
    if (!token) {
      window.location.href = "/login";
      return;
    }
    setLoading(true);
    const result = await mergeFinal(token, projectId);
    setStatus(result.status);
    setLoading(false);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Step 6: 成片</h1>
        <a
          href={projectId ? `/projects/${projectId}/script/video` : "/projects"}
          className="rounded-lg border border-slate-200 px-4 py-2 text-sm"
        >
          返回分段
        </a>
      </div>
      <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm">
        <div className="font-semibold">一键合并</div>
        <p className="mt-2 text-slate-600">合并所有已生成分段并生成成片。</p>
        <button
          onClick={runMerge}
          disabled={loading}
          className="mt-4 rounded-lg bg-slate-900 px-4 py-2 text-sm text-white"
        >
          {loading ? "合并中..." : "开始合并"}
        </button>
        {status ? <div className="mt-3 text-slate-600">状态：{status}</div> : null}
      </div>
      <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm">
        <div className="font-semibold">成片管理</div>
        <div className="mt-2 text-slate-600">成片播放与版本将在后续版本接入。</div>
      </div>
    </div>
  );
}
