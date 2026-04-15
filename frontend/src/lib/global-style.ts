export const DEFAULT_GLOBAL_STYLE = "通用写实风格";

export const STEP3_STYLE_OPTIONS = [
  "真人电影写实", "3D 写实渲染", "3D 超写实渲染", "3D 虚幻引擎风", "3D 游戏 CG",
  "3D 半写实", "3D 皮克斯风", "3D 迪士尼风", "3D 萌系 Q 版", "3D 粘土风",
  "3D 三渲二", "3D Low Poly", "2D 动画", "2D 日式动漫", "2D 国漫风",
  "2D 美式卡通", "2D Q 版卡通", "2D 水彩油画", "2D 水墨国风", "2D 赛博风格",
] as const;

export const DIRECTOR_STYLE_OPTIONS = [
  "阿尔弗雷德・希区柯克",
  "斯坦利・库布里克",
  "黑泽明",
  "费德里科・费里尼",
  "英格玛・伯格曼",
  "李安",
  "王家卫",
  "张艺谋",
  "陈凯歌",
  "侯孝贤",
] as const;

const GLOBAL_STYLE_PROMPT_MAP: Record<string, string> = {
  "通用写实风格": "Ultra-realistic cinematic style, 8K resolution, shot on Arri Alexa 65, 85mm prime lens, f/1.8 aperture. Skin details: High-fidelity human skin texture with visible pores, fine vellus hair, natural skin oils, and subsurface scattering. Lighting: Professional cinematic lighting, soft Rembrandt lighting, natural catchlights in eyes, realistic light bounce and global illumination. Physicality: Natural micro-expressions, realistic eye saccades and blinking, authentic fabric physics and hair movement. Environment: Photorealistic environment with depth of field, atmospheric haze, no digital artifacts, raw film grain, color graded in a natural filmic palette.",
  "真人电影写实": "画面要求：影视级写实主义，RAW照片质感，高动态范围，超4K级细节呈现；强调真实皮肤纹理、光影层次与电影镜头质感。",
  "3D 写实渲染": "画面要求：3D高精度写实渲染，PBR材质与真实光照并重，强调角色与场景的物理真实感与结构清晰度。",
  "3D 超写实渲染": "画面要求：超写实细节增强，微观材质与肌理表现突出，光影与反射遵循真实物理规律。",
  "3D 虚幻引擎风": "画面要求：UE次世代渲染质感，强调Lumen/全局光照与高几何密度场景，电影级体积感与动态范围。",
  "3D 游戏 CG": "画面要求：AAA游戏CG视觉语言，史诗级光影与高对比度材质细节，强化冲击力与镜头表现。",
  "3D 半写实": "画面要求：兼具真实体积与风格化造型，细节保真同时保持美术统一与视觉亲和力。",
  "3D 皮克斯风": "画面要求：皮克斯电影级风格，圆润体块、温暖光照与细腻表情，强调叙事感与角色可读性。",
  "3D 迪士尼风": "画面要求：迪士尼动画质感，梦幻光效与精致角色面部特征，画面明亮并具有童话叙事气质。",
  "3D 萌系 Q 版": "画面要求：Q版比例与萌系风格，色彩明快、轮廓干净，强调角色可爱度与情绪表达。",
  "3D 粘土风": "画面要求：手工粘土材质触感，保留手作纹理与柔和光照，画面具有温暖实体模型感。",
  "3D 三渲二": "画面要求：3D结构结合2D渲染线条与平涂，强调清晰轮廓、分明块面与动画分镜节奏。",
  "3D Low Poly": "画面要求：低多边形几何美术，简洁块面与清晰空间关系，突出风格化构图与色块秩序。",
  "2D 动画": "画面要求：传统2D动画语汇，线稿清晰、上色分层明确，强调运动节奏与镜头可读性。",
  "2D 日式动漫": "画面要求：日式动漫赛璐璐质感，线条利落、角色表情鲜明，注重镜头节奏与空气感。",
  "2D 国漫风": "画面要求：国漫美术体系，东方审美与现代动画融合，强调角色气质与场景层次。",
  "2D 美式卡通": "画面要求：美式卡通夸张造型与高饱和配色，节奏轻快、动势强，强调视觉记忆点。",
  "2D Q 版卡通": "画面要求：Q版卡通比例，简洁可爱、表情强化，构图清晰并突出角色主体。",
  "2D 水彩油画": "画面要求：水彩与油画笔触融合，色层丰富、边缘柔和，强调艺术化光影与情绪氛围。",
  "2D 水墨国风": "画面要求：水墨晕染与留白构图，东方意境优先，强调墨色层次与诗性画面。",
  "2D 赛博风格": "画面要求：二维线条结合赛博科技元素，霓虹高对比与数字化细节并重，氛围未来感强。",
  "阿尔弗雷德・希区柯克": "视觉语言：悬疑构图、心理压迫、信息遮挡与反转暗示，强调紧张感与不安情绪。",
  "斯坦利・库布里克": "视觉语言：强对称构图、冷静机位推进、空间秩序与疏离感，画面精确克制。",
  "黑泽明": "视觉语言：动态调度与自然元素张力并重，强调群像走位、运动节奏与戏剧冲突。",
  "费德里科・费里尼": "视觉语言：梦境叙事与戏剧化场面，人物夸张、画面奇观化，突出幻想与现实交错。",
  "英格玛・伯格曼": "视觉语言：凝视与静默空间，关注人物内心与哲思情绪，强调面部特写与心理张力。",
  "李安": "视觉语言：细腻情感推进、克制叙事、温润光影，强调人物关系与情绪层层递进。",
  "王家卫": "视觉语言：都市情绪、霓虹色彩、时间碎片感与慢速凝视，强调主观抒情与孤独氛围。",
  "张艺谋": "视觉语言：高饱和色彩符号与仪式化场面，强调构图秩序、群体调度与视觉冲击。",
  "陈凯歌": "视觉语言：史诗气质与戏剧张力，强调人物命运感、宏观场面与情绪层级。",
  "侯孝贤": "视觉语言：长镜头与生活流观察，空间留白与节奏克制，强调真实时间与细微情绪。",
};

export const getGlobalStylePrompt = (styleName: string): string => {
  const style = String(styleName || "").trim();
  if (!style) {
    return "全局视觉风格：通用写实风格。请保持整集分镜在美术气质、光影语气、镜头审美上的统一。";
  }
  const preset = GLOBAL_STYLE_PROMPT_MAP[style];
  if (preset) {
    return `全局视觉风格：${style}。风格提示：${preset}。请保持整集分镜在美术气质、光影语气、镜头审美上的统一。`;
  }
  return `全局视觉风格：${style}。请保持整集分镜在美术气质、光影语气、镜头审美上的统一。`;
};
