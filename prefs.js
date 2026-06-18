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

// 默认提示词（显示在设置框里方便修改；清空则回落到代码内置同款 DEFAULT_PROMPT）
pref("extensions.paperoutline.prompt", "你是论文结构分析助手。请阅读给定的论文正文，输出层级化目录（table of contents）。为每个章节给出不超过 60 字的中文核心总结，提炼主要观点，可采用「总结了…，指出了…，讨论了…，强调了…」这类句式。只输出 JSON，格式严格为：{\"outline\":[{\"level\":1,\"title\":\"章节标题\",\"summary\":\"核心总结\"}]}。level 表示层级（1 为一级标题，2 为二级，以此类推）。若原文章节标题是英文，title 请翻译成中文。不要输出 JSON 以外的任何文字。");
