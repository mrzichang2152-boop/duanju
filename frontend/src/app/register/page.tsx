"use client";

export default function RegisterPage() {
  return (
    <div className="mx-auto w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <h1 className="text-xl font-semibold">注册入口已关闭</h1>
      <div className="mt-4 text-sm text-slate-600">请联系管理员分配测试账号。</div>
      <a href="/login" className="mt-6 block text-sm text-slate-700 underline">
        返回登录
      </a>
    </div>
  );
}
