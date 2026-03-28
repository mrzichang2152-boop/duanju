"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getProjects, Project } from "@/lib/api";
import { getToken } from "@/lib/auth";

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    const guardId = window.setTimeout(() => {
      if (!active) {
        return;
      }
      setError((prev) => prev ?? "加载超时，请刷新页面后重试");
      setLoading(false);
    }, 20000);

    const loadProjects = async () => {
      try {
        const token = getToken();
        if (!token) {
          setError("登录状态缺失，正在跳转登录");
          window.location.href = "/login";
          return;
        }
        const result = await getProjects(token);
        if (!active) {
          return;
        }
        setProjects(result);
      } catch (err) {
        if (!active) {
          return;
        }
        setError(err instanceof Error ? err.message : "加载失败");
      } finally {
        if (!active) {
          return;
        }
        window.clearTimeout(guardId);
        setLoading(false);
      }
    };

    void loadProjects();
    return () => {
      active = false;
      window.clearTimeout(guardId);
    };
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">项目列表</h1>
        <Link
          href="/projects/new"
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
        >
          新建项目
        </Link>
      </div>
      {loading ? <div>加载中...</div> : null}
      {error ? <div className="text-sm text-red-500">{error}</div> : null}
      {!loading && !error && projects.length === 0 ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-700">
          暂无项目。如果你之前有任务，请确认是否登录了原账号。
        </div>
      ) : null}
      <div className="grid gap-4 md:grid-cols-2">
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
    </div>
  );
}
