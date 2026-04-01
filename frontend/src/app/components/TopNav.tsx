"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { clearEmail, clearToken, getEmail, getToken } from "@/lib/auth";

const buildInitial = (value: string | null) => {
  if (!value) {
    return "U";
  }
  const prefix = value.split("@")[0] ?? "";
  const normalized = prefix.replace(/[^a-zA-Z0-9]/g, "");
  return normalized.charAt(0).toUpperCase() || "U";
};

export default function TopNav() {
  const [email, setEmail] = useState<string | null>(null);
  const [isAuthed, setIsAuthed] = useState(false);

  useEffect(() => {
    const sync = () => {
      setEmail(getEmail());
      setIsAuthed(Boolean(getToken()));
    };
    sync();
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);

  const initial = useMemo(() => buildInitial(email), [email]);

  const logout = () => {
    clearToken();
    clearEmail();
    setIsAuthed(false);
    setEmail(null);
    window.location.href = "/login";
  };

  return (
    <nav className="flex items-center gap-4 text-sm text-slate-600">
      <Link href="/projects" className="hover:text-slate-900">
        项目
      </Link>
      {isAuthed ? (
        <div className="group relative">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-900 text-xs font-semibold text-white">
            {initial}
          </div>
          <div className="pointer-events-none absolute right-0 top-8 pt-2 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
            <div className="min-w-[120px] rounded-lg border border-slate-200 bg-white py-2 text-sm text-slate-700 shadow-sm">
              <a href="/settings" className="block px-3 py-1 hover:bg-slate-50">
                设置
              </a>
              <button
                type="button"
                onClick={logout}
                className="block w-full px-3 py-1 text-left hover:bg-slate-50"
              >
                退出登录
              </button>
            </div>
          </div>
        </div>
      ) : (
        <a href="/login" className="hover:text-slate-900">
          登录
        </a>
      )}
    </nav>
  );
}
