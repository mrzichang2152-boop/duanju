"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

import { getCurrentUserUsageSummary, type CurrentUserUsageResponse } from "@/lib/api";
import { getToken } from "@/lib/auth";
import { redirectToLogin } from "@/lib/navigation";


function formatInteger(value: number) {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(Number(value || 0));
}

function formatSeconds(value: number) {
  return new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(Number(value || 0));
}

function formatDateTime(value?: string | null) {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString("zh-CN");
}

export default function UsagePage() {
  const [data, setData] = useState<CurrentUserUsageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = getToken();
    if (!token) {
      redirectToLogin();
      return;
    }
    getCurrentUserUsageSummary(token)
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : "加载用量统计失败"))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">我的用量</h1>
          <p className="mt-2 text-sm text-slate-600">查看当前账号累计生成的文字、图片和视频秒数。</p>
        </div>
        <Link
          href="/projects"
          className="rounded-lg border border-slate-200 px-4 py-2 text-sm text-slate-700 hover:border-slate-300"
        >
          返回项目
        </Link>
      </div>

      {loading ? <div className="rounded-2xl border border-slate-200 bg-white p-6 text-sm text-slate-500 shadow-sm">加载中...</div> : null}
      {error ? <div className="rounded-2xl border border-red-200 bg-red-50 p-6 text-sm text-red-600 shadow-sm">{error}</div> : null}

      {!loading && !error && data ? (
        <>
          <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-base font-semibold">{data.email}</div>
                <div className="mt-1 text-sm text-slate-500">
                  注册时间：{formatDateTime(data.account.created_at)}，统计时间：{formatDateTime(data.generated_at)}
                </div>
              </div>
              <div className="rounded-lg bg-slate-100 px-3 py-2 text-xs text-slate-600">
                估算视频数：{formatInteger(data.account.estimated_video_count)}
              </div>
            </div>
          </section>

          <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
            {[
              { label: "项目数", value: formatInteger(data.account.project_count) },
              { label: "文字字符", value: formatInteger(data.account.text_characters) },
              { label: "图片张数", value: formatInteger(data.account.image_count) },
              { label: "视频条数", value: formatInteger(data.account.video_count) },
              { label: "视频秒数", value: formatSeconds(data.account.video_seconds) },
            ].map((item) => (
              <div key={item.label} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                <div className="text-sm text-slate-500">{item.label}</div>
                <div className="mt-2 text-2xl font-semibold text-slate-900">{item.value}</div>
              </div>
            ))}
          </section>

          <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="text-base font-semibold">统计说明</div>
            <div className="mt-4 space-y-2 text-sm text-slate-600">
              {data.notes.map((note) => (
                <div key={note}>{note}</div>
              ))}
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}
