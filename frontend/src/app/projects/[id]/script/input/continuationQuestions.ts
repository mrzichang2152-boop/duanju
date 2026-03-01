export type Question = {
  id: string;
  label: string;
  type: "text" | "select";
  options?: string[];
  placeholder?: string;
};

export type Category = {
  category: string;
  questions: Question[];
};

export const continuationQuestions: Category[] = [
  {
    category: "一、基础剧情维度",
    questions: [
      { id: "q1", label: "1. 当前写到第几集", type: "text" },
      { id: "q2", label: "2. 已完成集数大纲（简述）", type: "text" },
      { id: "q3", label: "3. 当前剧情所处阶段", type: "select", options: ["冷启动期", "付费拉升期", "中段维稳期", "高潮预热期", "终局阶段"] },
      { id: "q4", label: "4. 当前核心长期矛盾", type: "text" },
      { id: "q5", label: "5. 当前阶段性矛盾", type: "text" },
      { id: "q6", label: "6. 是否已经兑现过一次高潮", type: "select", options: ["是", "否"] },
      { id: "q7", label: "7. 当前主线目标", type: "text" },
      { id: "q8", label: "8. 当前支线数量", type: "text" }
    ]
  },
  {
    category: "二、角色资产维度",
    questions: [
      { id: "q9", label: "9. 主角人设标签（最多5个）", type: "text" },
      { id: "q10", label: "10. 主角核心缺陷", type: "text" },
      { id: "q11", label: "11. 主角隐藏身份（是否已曝光）", type: "select", options: ["是", "否"] },
      { id: "q12", label: "12. 主角当前强弱状态", type: "text" },
      { id: "q13", label: "13. 主角成长承诺", type: "text" },
      { id: "q14", label: "14. 反派数量", type: "text" },
      { id: "q15", label: "15. 反派压迫强度（1–10）", type: "text" },
      { id: "q16", label: "16. 反派是否已被削弱", type: "select", options: ["是", "否"] },
      { id: "q17", label: "17. 是否存在终极反派", type: "select", options: ["是", "否"] },
      { id: "q18", label: "18. 是否允许新增角色", type: "select", options: ["是", "否"] },
      { id: "q19", label: "19. 新角色上限数量", type: "text" },
      { id: "q20", label: "20. 是否允许新增反派", type: "select", options: ["是", "否"] },
      { id: "q21", label: "21. 情感线状态", type: "select", options: ["暧昧", "对立", "已确认", "已破裂"] }
    ]
  },
  {
    category: "三、结构控制维度",
    questions: [
      { id: "q22", label: "22. 预计总集数", type: "text" },
      { id: "q23", label: "23. 是否必须在第X集前达到高潮", type: "select", options: ["是", "否"] },
      { id: "q24", label: "24. 是否有明确结局设定（可选）", type: "select", options: ["大团圆", "悲剧", "反转结局", "开放式", "暗黑式"] },
      { id: "q25", label: "25. 是否必须为第二季留伏笔", type: "select", options: ["是", "否"] },
      { id: "q26", label: "26. 是否允许多线并行", type: "select", options: ["是", "否"] },
      { id: "q27", label: "27. 是否允许时间跳跃", type: "select", options: ["是", "否"] },
      { id: "q28", label: "28. 是否允许身份反转", type: "select", options: ["是", "否"] }
    ]
  },
  {
    category: "四、爽点与情绪维度",
    questions: [
      { id: "q29", label: "29. 当前核心爽点类型", type: "select", options: ["复仇", "身份碾压", "权力压制", "情感虐爽", "事业逆袭", "悬疑揭秘"] },
      { id: "q30", label: "30. 是否允许更换爽点类型", type: "select", options: ["是", "否"] },
      { id: "q31", label: "31. 爽点释放节奏", type: "select", options: ["高频", "中频", "低频递增"] },
      { id: "q32", label: "32. 是否必须制造强反转", type: "select", options: ["是", "否"] },
      { id: "q33", label: "33. 是否允许极端冲突", type: "select", options: ["是", "否"] }
    ]
  },
  {
    category: "五、付费相关维度（付费按钮重点）",
    questions: [
      { id: "q34", label: "34. 是否已发生首次付费", type: "select", options: ["是", "否"] },
      { id: "q35", label: "35. 首次付费动机类型", type: "text" },
      { id: "q36", label: "36. 下一个付费节点计划", type: "text" },
      { id: "q37", label: "37. 是否以复购为核心", type: "select", options: ["是", "否"] },
      { id: "q38", label: "38. 是否需要拉长LTV", type: "select", options: ["是", "否"] },
      { id: "q39", label: "39. 是否允许延迟兑现核心承诺", type: "select", options: ["是", "否"] },
      { id: "q40", label: "40. 是否必须制造“错过就亏”的紧迫感", type: "select", options: ["是", "否"] }
    ]
  },
  {
    category: "六、流量相关维度（爆款按钮重点）",
    questions: [
      { id: "q41", label: "41. 最近3集是否有爆点", type: "select", options: ["是", "否"] },
      { id: "q42", label: "42. 当前冲突强度（1–10）", type: "text" },
      { id: "q43", label: "43. 是否出现掉量", type: "select", options: ["是", "否"] },
      { id: "q44", label: "44. 是否需要强开局重构", type: "select", options: ["是", "否"] },
      { id: "q45", label: "45. 是否以冲峰值为目标", type: "select", options: ["是", "否"] },
      { id: "q46", label: "46. 是否必须制造评论区争议", type: "select", options: ["是", "否"] },
      { id: "q47", label: "47. 是否允许价值观撕裂", type: "select", options: ["是", "否"] },
      { id: "q48", label: "48. 是否允许极端反差桥段", type: "select", options: ["是", "否"] },
      { id: "q49", label: "49. 是否需要可切片桥段设计", type: "select", options: ["是", "否"] }
    ]
  },
  {
    category: "七、平台与风控维度",
    questions: [
      { id: "q50", label: "50. 发布平台", type: "select", options: ["抖音", "快手", "海外"] },
      { id: "q51", label: "51. 是否投流", type: "select", options: ["是", "否"] },
      { id: "q52", label: "52. 是否有审核敏感边界", type: "select", options: ["是", "否"] },
      { id: "q53", label: "53. 是否避免以下内容（暴力/伦理/极端价值观）", type: "select", options: ["是", "否"] },
      { id: "q54", label: "54. 是否允许灰色道德行为", type: "select", options: ["是", "否"] },
      { id: "q55", label: "55. 是否必须保证价值观正向", type: "select", options: ["是", "否"] }
    ]
  },
  {
    category: "八、创作自由度边界",
    questions: [
      { id: "q56", label: "56. 是否允许改动前文设定", type: "select", options: ["是", "否"] },
      { id: "q57", label: "57. 是否允许补充世界观", type: "select", options: ["是", "否"] },
      { id: "q58", label: "58. 是否允许推翻已埋伏笔", type: "select", options: ["是", "否"] },
      { id: "q59", label: "59. 是否允许改变人物性格走向", type: "select", options: ["是", "否"] },
      { id: "q60", label: "60. 是否允许开放式收尾", type: "select", options: ["是", "否"] }
    ]
  },
  {
    category: "九、商业目标维度（很多人忽略）",
    questions: [
      { id: "q61", label: "61. 本剧目标", type: "select", options: ["冲流量", "稳定现金流", "IP孵化", "账号矩阵填充"] },
      { id: "q62", label: "62. 是否需要制造IP记忆点", type: "select", options: ["是", "否"] },
      { id: "q63", label: "63. 是否考虑衍生角色开发", type: "select", options: ["是", "否"] },
      { id: "q64", label: "64. 是否为广告或品牌植入服务", type: "select", options: ["是", "否"] }
    ]
  },
  {
    category: "十、数据反馈维度（可选但非常重要）",
    questions: [
      { id: "q65", label: "65. 掉量集数", type: "text" },
      { id: "q66", label: "66. 爆量集数", type: "text" },
      { id: "q67", label: "67. 完播率情况", type: "text" },
      { id: "q68", label: "68. 评论区主要讨论点", type: "text" },
      { id: "q69", label: "69. 观众骂点", type: "text" },
      { id: "q70", label: "70. 观众爽点反馈", type: "text" }
    ]
  },
  {
    category: "十一、节奏强控参数（进阶系统才需要）",
    questions: [
      { id: "q71", label: "71. 每集目标冲突次数", type: "text" },
      { id: "q72", label: "72. 每集是否必须有反转", type: "select", options: ["是", "否"] },
      { id: "q73", label: "73. 爽点间隔上限（秒）", type: "text" },
      { id: "q74", label: "74. 是否必须制造误导", type: "select", options: ["是", "否"] },
      { id: "q75", label: "75. 是否必须制造信息差", type: "select", options: ["是", "否"] }
    ]
  }
];
