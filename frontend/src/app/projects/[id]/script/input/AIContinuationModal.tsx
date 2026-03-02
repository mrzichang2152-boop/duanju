import { useState } from "react";
import { continuationQuestions } from "./continuationQuestions";

interface AIContinuationModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (formattedAnswers: string, mode: "continuation_paid" | "continuation_traffic") => void;
}

export default function AIContinuationModal({
  isOpen,
  onClose,
  onSubmit,
}: AIContinuationModalProps) {
  const [answers, setAnswers] = useState<
    Record<string, { selected: string[]; custom: string }>
  >({});

  if (!isOpen) return null;

  const handleOptionToggle = (questionId: string, option: string) => {
    setAnswers((prev) => {
      const current = prev[questionId] || { selected: [], custom: "" };
      const selected = current.selected.includes(option)
        ? current.selected.filter((item) => item !== option)
        : [...current.selected, option];
      return { ...prev, [questionId]: { ...current, selected } };
    });
  };

  const handleCustomChange = (questionId: string, value: string) => {
    setAnswers((prev) => {
      const current = prev[questionId] || { selected: [], custom: "" };
      return { ...prev, [questionId]: { ...current, custom: value } };
    });
  };

  const handleSubmit = (mode: "continuation_paid" | "continuation_traffic") => {
    let formattedText = "【AI续写配置参数】\n";
    let hasContent = false;
    
    // Iterate through all questions and build the formatted text
    continuationQuestions.forEach((category) => {
      let categoryHasContent = false;
      let categoryText = `\n${category.category}\n`;

      category.questions.forEach((q) => {
        const answer = answers[q.id];
        // Skip if no answer for this question
        if (!answer) return;

        const parts = [];
        if (answer.selected && answer.selected.length > 0) parts.push(...answer.selected);
        if (answer.custom && answer.custom.trim()) parts.push(answer.custom.trim());

        if (parts.length > 0) {
          categoryText += `${q.label}：${parts.join("，")}\n`;
          categoryHasContent = true;
          hasContent = true;
        }
      });

      if (categoryHasContent) {
        formattedText += categoryText;
      }
    });

    onSubmit(hasContent ? formattedText : "", mode);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="flex h-[90vh] w-full max-w-4xl flex-col rounded-xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b p-4">
          <h2 className="text-xl font-bold text-slate-800">AI 续写配置</h2>
          <button
            onClick={onClose}
            className="rounded-full p-2 text-slate-500 hover:bg-slate-100"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          <div className="space-y-8">
            {continuationQuestions.map((category) => (
              <div key={category.category} className="space-y-4">
                <h3 className="border-l-4 border-indigo-500 pl-3 text-lg font-bold text-slate-800">
                  {category.category}
                </h3>
                <div className="grid gap-6 md:grid-cols-2">
                  {category.questions.map((q) => (
                    <div
                      key={q.id}
                      className="rounded-lg border border-slate-100 bg-slate-50 p-4"
                    >
                      <label className="mb-2 block text-sm font-medium text-slate-700">
                        {q.label}
                      </label>

                      <div className="space-y-3">
                        {q.type === "select" && q.options && (
                          <div className="flex flex-wrap gap-2">
                            {q.options.map((option) => (
                              <label
                                key={option}
                                className={`flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors ${
                                  answers[q.id]?.selected?.includes(option)
                                    ? "border-indigo-500 bg-indigo-50 text-indigo-700"
                                    : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
                                }`}
                              >
                                <input
                                  type="checkbox"
                                  className="hidden"
                                  checked={
                                    answers[q.id]?.selected?.includes(option) ||
                                    false
                                  }
                                  onChange={() =>
                                    handleOptionToggle(q.id, option)
                                  }
                                />
                                {option}
                              </label>
                            ))}
                          </div>
                        )}

                        <input
                          type="text"
                          placeholder={
                            q.type === "select" ? "手动输入 / 其他..." : "请输入..."
                          }
                          className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                          value={answers[q.id]?.custom || ""}
                          onChange={(e) =>
                            handleCustomChange(q.id, e.target.value)
                          }
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="border-t bg-slate-50 p-4">
          <div className="flex justify-end gap-3">
            <button
              onClick={onClose}
              className="rounded-lg px-4 py-2 text-sm font-medium text-slate-600 hover:text-slate-800"
            >
              取消
            </button>
            <button
              onClick={() => handleSubmit("continuation_paid")}
              className="rounded-lg bg-indigo-600 px-6 py-2 text-sm font-medium text-white hover:bg-indigo-700"
            >
              付费转化续写建议
            </button>
            <button
              onClick={() => handleSubmit("continuation_traffic")}
              className="rounded-lg bg-pink-600 px-6 py-2 text-sm font-medium text-white hover:bg-pink-700"
            >
              流量爆款续写建议
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
