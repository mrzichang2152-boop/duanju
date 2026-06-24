"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

import { getAdminUsageSummary, type AdminUsageSummaryResponse } from "@/lib/api";
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

export default function AdminUsagePage() {
  const [data, setData] = useState<AdminUsageSummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = getToken();
    if (!token) {
      redirectToLogin();
      return;
    }
    getAdminUsageSummary(token)
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : "加载账号用量统计失败"))
      .finally(() => setLoading(false));
  }, []);

  const summaryCards = useMemo(() => {
    if (!data) return [];
    return [
      { label: "账号数", value: formatInteger(data.totals.account_count) },
      { label: "项目数", value: formatInteger(data.totals.project_count) },
      { label: "文字字符", value: formatInteger(data.totals.text_characters) },
      { label: "图片张数", value: formatInteger(data.totals.image_count) },
      { label: "视频条数", value: formatInteger(data.totals.video_count) },
      { label: "视频秒数", value: formatSeconds(data.totals.video_seconds) },
    ];
  }, [data]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">管理员用量后台</h1>
          <p className="mt-2 text-sm text-slate-600">查看各账号累计生成的文字、图片和视频秒数。</p>
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
          <section className="grid gap-4 md:grid-cols-3 xl:grid-cols-6">
            {summaryCards.map((item) => (
              <div key={item.label} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                <div className="text-sm text-slate-500">{item.label}</div>
                <div className="mt-2 text-2xl font-semibold text-slate-900">{item.value}</div>
              </div>
            ))}
          </section>

          <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-base font-semibold">统计信息</div>
                <div className="mt-1 text-sm text-slate-500">
                  生成时间：{formatDateTime(data.generated_at)}，当前管理员：{data.admin_email}
                </div>
              </div>
              <div className="rounded-lg bg-slate-100 px-3 py-2 text-xs text-slate-600">
                估算视频数：{formatInteger(data.totals.estimated_video_count)}
              </div>
            </div>
            <div className="mt-4 space-y-2 text-sm text-slate-600">
              {data.notes.map((note) => (
                <div key={note}>{note}</div>
              ))}
            </div>
          </section>

          <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div className="border-b border-slate-200 px-6 py-4 text-base font-semibold">账号明细</div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 text-left text-slate-500">
                  <tr>
                    <th className="px-4 py-3 font-medium">账号</th>
                    <th className="px-4 py-3 font-medium">注册时间</th>
                    <th className="px-4 py-3 font-medium">项目数</th>
                    <th className="px-4 py-3 font-medium">文字字符</th>
                    <th className="px-4 py-3 font-medium">图片张数</th>
                    <th className="px-4 py-3 font-medium">视频条数</th>
                    <th className="px-4 py-3 font-medium">视频秒数</th>
                    <th className="px-4 py-3 font-medium">估算视频数</th>
                  </tr>
                </thead>
                <tbody>
                  {data.accounts.map((item) => (
                    <tr key={item.user_id} className="border-t border-slate-100">
                      <td className="px-4 py-3 text-slate-900">{item.email}</td>
                      <td className="px-4 py-3 text-slate-600">{formatDateTime(item.created_at)}</td>
                      <td className="px-4 py-3 text-slate-600">{formatInteger(item.project_count)}</td>
                      <td className="px-4 py-3 text-slate-600">{formatInteger(item.text_characters)}</td>
                      <td className="px-4 py-3 text-slate-600">{formatInteger(item.image_count)}</td>
                      <td className="px-4 py-3 text-slate-600">{formatInteger(item.video_count)}</td>
                      <td className="px-4 py-3 text-slate-600">{formatSeconds(item.video_seconds)}</td>
                      <td className="px-4 py-3 text-slate-600">{formatInteger(item.estimated_video_count)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}
