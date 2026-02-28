"use client";

import { useState } from "react";
import { register } from "@/lib/api";
import { setEmail, setToken } from "@/lib/auth";

export default function RegisterPage() {
  const [email, setEmailValue] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    setError(null);
    setLoading(true);
    try {
      const result = await register({ email, password });
      setToken(result.access_token);
      setEmail(email);
      window.location.href = "/projects";
    } catch (err) {
      setError(err instanceof Error ? err.message : "注册失败");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <h1 className="text-xl font-semibold">注册</h1>
      <div className="mt-6 space-y-4">
        <div>
          <label className="text-sm text-slate-600">账号（邮箱）</label>
          <input
            value={email}
            onChange={(event) => setEmailValue(event.target.value)}
            className="mt-2 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
            type="email"
            placeholder="name@example.com"
          />
        </div>
        <div>
          <label className="text-sm text-slate-600">密码</label>
          <input
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="mt-2 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
            type="password"
            placeholder="请输入密码"
          />
        </div>
        {error ? <div className="text-sm text-red-500">{error}</div> : null}
        <button
          onClick={submit}
          disabled={loading}
          className="w-full rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          {loading ? "注册中..." : "注册"}
        </button>
        <a href="/login" className="block text-center text-sm text-slate-600">
          已有账号？去登录
        </a>
      </div>
    </div>
  );
}
