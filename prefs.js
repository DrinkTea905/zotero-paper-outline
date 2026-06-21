// 默认偏好（Zotero 启动时加载到 default 分支）
pref("extensions.paperoutline.provider", "deepseek");

// —— AI 接口（所有服务商统一 OpenAI 兼容；选服务商即用其默认 URL/模型）——
// apiUrl / model 留空 = 用所选服务商默认；自定义服务商需填 apiUrl。
pref("extensions.paperoutline.apiUrl", "");
pref("extensions.paperoutline.apiKey", "");
pref("extensions.paperoutline.model", "deepseek-chat");

// —— 通用 ——
pref("extensions.paperoutline.concurrency", 5);
pref("extensions.paperoutline.maxCharsPerChunk", 40000);
// 识别目录层级深度：0=全部（默认识别到所有层级），1/2/3/4=只到该级
pref("extensions.paperoutline.maxLevel", 0);
// 生成后另存为子笔记：默认关（目录始终缓存在阅读器面板，无需靠笔记保存）
pref("extensions.paperoutline.saveAsNote", false);

// —— 入库自动处理（默认开；关掉则改为右键手动）——
// 文献存入后自动生成「整篇总结」并存为子笔记
pref("extensions.paperoutline.autoSummary", true);
// 文献存入后自动生成「层级目录」（缓存在阅读器大纲栏）
pref("extensions.paperoutline.autoOutline", true);

// —— 去除文字空格：中文 PDF 复制后字间空格清理；纯规则，不用 AI ——
// 在阅读器顶部工具栏显示「粉色小猫」图标，点一下清理剪贴板（开关在 设置→高级选项）
pref("extensions.paperoutline.despaceButton", true);

// 整篇总结提示词（显示在设置框，可改；清空回落代码内置 SUMMARY_PROMPT）
pref("extensions.paperoutline.summaryPrompt", "请总结这篇学术论文的核心内容（你的输出必须是简体中文）。直接输出总结正文，不要任何开场白或客套话（例如「好的」「以下是……的总结」等），也不要复述论文标题。要求：\n1. 全文控制在 1000 字以内；\n2. 先点明论文的核心研究问题、研究对象与全文核心观点；\n3. 按论文行文逻辑分模块梳理，覆盖研究背景、制度沿革、核心论证、史料依据、结论与现实启示；\n4. 保留关键数据、典型案例、核心制度规则与重要学术观点；\n5. 使用分级标题+要点的结构化排版，逻辑清晰，重点信息加粗标注；\n6. 抓主干、不遗漏核心结论；宁可凝练也不要超过 1000 字。");

// 默认提示词（显示在设置框里方便修改；清空则回落到代码内置同款 DEFAULT_PROMPT）
pref("extensions.paperoutline.prompt", "你是论文结构分析助手。请阅读给定的论文正文，输出层级化目录（table of contents）。为每个章节给出不超过 60 字的中文核心总结，提炼主要观点，可采用「总结了…，指出了…，讨论了…，强调了…」这类句式。只输出 JSON，格式严格为：{\"outline\":[{\"level\":1,\"title\":\"章节标题\",\"summary\":\"核心总结\"}]}。level 表示层级（1 为一级标题，2 为二级，以此类推）。title 必须带序号前缀：优先保留原文的章节序号（如 一、二、、（一）（二）、1. 2.、(1)(2) 等）；若原文标题没有显式序号，按层级自动补全——一级用「一、二、三、…」，二级用「（一）（二）（三）…」，三级用「1. 2. 3. …」，四级用「(1)(2)(3)…」，同级按出现顺序连续编号。若原文章节标题是英文，title 请翻译成中文（序号保留）。不要输出 JSON 以外的任何文字。");
