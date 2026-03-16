"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getProjects, Project } from "@/lib/api";
import { getToken } from "@/lib/auth";

export default function Home() {
  const [token, setToken] = useState<string | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = getToken();
    setToken(t);
    if (!t) {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!token) {
      return;
    }
    setLoading(true);
    getProjects(token)
      .then(setProjects)
      .catch((err) => setError(err instanceof Error ? err.message : "加载失败"))
      .finally(() => setLoading(false));
  }, [token]);

  return (
    <div className="flex flex-col gap-8">
      <section className="rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
        <h1 className="text-2xl font-semibold">从文本到短剧成片的一站式流程</h1>
        <p className="mt-3 text-sm text-slate-600">
          支持剧本校验、素材生成、分段视频与一键合并，满足全流程可追溯与可回滚需求。
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link
            href="/projects"
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
          >
            进入项目
          </Link>
          <Link
            href="/projects/new"
            className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:border-slate-300"
          >
            新建项目
          </Link>
        </div>
      </section>
      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <div className="text-base font-semibold">项目列表</div>
          <Link
            href="/projects"
            className="text-sm text-slate-600 hover:text-slate-900"
          >
            查看全部
          </Link>
        </div>
        {loading ? <div className="mt-4 text-sm text-slate-500">加载中...</div> : null}
        {error ? <div className="mt-4 text-sm text-red-500">{error}</div> : null}
        {!loading && !error && projects.length === 0 ? (
          <div className="mt-4 text-sm text-slate-500">暂无项目，请先新建。</div>
        ) : null}
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {projects.map((project) => (
            <Link
              key={project.id}
              href={`/projects/${project.id}/script/input`}
              prefetch={false}
              className="rounded-xl border border-slate-200 bg-white p-4 text-sm hover:border-slate-300 block"
            >
              <div className="font-semibold">{project.name}</div>
              <div className="mt-2 text-slate-600">当前状态：{project.status}</div>
            </Link>
          ))}
        </div>
      </section>
      <section className="grid gap-4 md:grid-cols-4">
        {[
          { title: "Step 1 剧本", desc: "导入、校验、补齐、版本化管理" },
          { title: "Step 2 素材", desc: "角色/道具/场景提取与三视图生成" },
          { title: "Step 3 分段", desc: "连续选段生成，支持多版本预览" },
          { title: "Step 4 成片", desc: "一键合并与历史版本回溯" },
        ].map((item) => (
          <div
            key={item.title}
            className="rounded-xl border border-slate-200 bg-white p-4 text-sm"
          >
            <div className="font-semibold">{item.title}</div>
            <div className="mt-2 text-slate-600">{item.desc}</div>
          </div>
        ))}
      </section>
    </div>
  );
}
