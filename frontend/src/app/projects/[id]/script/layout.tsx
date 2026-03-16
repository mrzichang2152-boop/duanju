"use client";

import { usePathname, useParams } from "next/navigation";
import Link from "next/link";

const steps = [
  { id: "input", name: "Step 1: 修改剧本", path: "input" },
  { id: "resources", name: "Step 2: 提取资源", path: "resources" },
  { id: "assets", name: "Step 3: 生成素材", path: "assets" },
  { id: "storyboard", name: "Step 4: 生成分镜", path: "storyboard" },
  { id: "video", name: "Step 5: 生成分段视频", path: "video" },
];

export default function ScriptLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const params = useParams();
  const id = params?.id as string;
  const projectId = id;

  if (!pathname) return null;

  return (
    <div className="flex h-full flex-col">
      <div className="mb-6 border-b border-slate-200 bg-white px-6 py-4">
        <div className="flex items-center gap-8">
          {steps.map((step, index) => {
            const isActive = pathname.includes(`/script/${step.path}`);
            const isCompleted = steps.findIndex(s => pathname.includes(`/script/${s.path}`)) > index;

            return (
              <Link
                key={step.id}
                href={`/projects/${projectId}/script/${step.path}`}
                prefetch={false}
                className={`flex items-center gap-2 text-sm font-medium ${
                  isActive
                    ? "text-indigo-600"
                    : isCompleted
                    ? "text-slate-900"
                    : "text-slate-400"
                }`}
              >
                <div
                  className={`flex h-6 w-6 items-center justify-center rounded-full text-xs ${
                    isActive
                      ? "bg-indigo-600 text-white"
                      : isCompleted
                      ? "bg-slate-900 text-white"
                      : "bg-slate-100 text-slate-400"
                  }`}
                >
                  {index + 1}
                </div>
                {step.name}
              </Link>
            );
          })}
        </div>
      </div>
      <div className="flex-1 overflow-auto px-6 pb-6">{children}</div>
    </div>
  );
}
