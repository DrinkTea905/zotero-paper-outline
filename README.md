# Paper Outline —— Zotero 论文目录 / 大纲插件

> 一个**专注单一功能**的 Zotero 插件：用 AI 为论文自动生成**层级化目录 + 逐节中文摘要**，直接显示在阅读器左侧大纲栏，点击条目跳转到对应页码。无聊天界面、无多余功能。
>
> 兼容 **Zotero 7 / 8 / 9**（菜单走 Zotero 8+ 的 `MenuManager`，并保留 7 的 DOM 退化路径）。

## 功能

- **阅读器左侧大纲栏**：打开 PDF，左侧大纲栏出现 AI 生成的层级目录；点条目跳到对应页，翻页时当前章节自动高亮。
- **书签优先，按需调 AI**：PDF 自带书签（embedded outline）时直接读取（免费、精确）；无书签才调 AI 从全文推断目录与摘要。
- **多服务商，OpenAI 兼容**：DeepSeek（默认，便宜、中文好）/ OpenAI / Kimi(Moonshot) / 智谱 / 通义千问 / SiliconFlow / 本地 Ollama / 自定义。在设置里下拉切换。
- **可调层级深度**：识别到全部层级，或只到 1 / 2 / 3 级。
- **目录折叠、生成动画、友好报错、一键重新生成**。
- **可选存为子笔记**：右键文献也能生成目录并存成 Zotero 子笔记（默认关；目录本身缓存在数据目录，常驻大纲栏）。

## 安装

1. 到本仓库 [Releases](../../releases) 下载最新的 `paper-outline-gpt.xpi`（或自行打包，见下）。
2. Zotero → **工具 → 插件** → 右上角齿轮 → **Install Add-on From File…** → 选 `.xpi`。
3. 按提示重启 Zotero。

### 自行打包

```powershell
# 方式一：Python（推荐）
python build_xpi.py
# 方式二：PowerShell
powershell -ExecutionPolicy Bypass -File .\打包.ps1
```
生成 `paper-outline-gpt.xpi`。

## 配置（编辑 → 设置 → Paper Outline）

1. **服务商**下拉选一个（默认 DeepSeek）。
2. 填 **API Key**（本地 Ollama 免 Key）。
   - DeepSeek：到 <https://platform.deepseek.com> 申请，模型 `deepseek-chat`。
   - 其它服务商选中后会自动用其默认 URL / 模型；要换模型或自定义中转，填「⚙ 高级」里的 API URL / 模型即可。
   - 本地 Ollama：先 `ollama pull qwen3:8b`，URL 默认 `http://localhost:11434/v1/chat/completions`，全离线零费用。
3. 可选：调整层级深度、并发、每块字数、提示词。

## 使用

- **阅读器内**：打开任意有 PDF 的文献，看左侧大纲栏 → 点「📑 生成目录」→ 等生成完，点条目跳页。
- **中间栏右键**：选中一篇或多篇文献 → 右键生成目录（如开启「另存为笔记」会写成子笔记）。

> 需要 PDF 有可提取的文字层；扫描件请先 OCR。少数字体无 Unicode 映射的 PDF（如部分 CNKI 导出）pdf.js 读不出文字，会退化用 Zotero 全文提取并**估算页码**（≈±1 页）。

## 文件结构

```
paper-outline-plugin/
├─ manifest.json       插件清单
├─ bootstrap.js        生命周期 + 窗口/阅读器钩子 + 注册设置面板
├─ paperOutline.js     核心：取全文/书签 → 调 AI → 渲染大纲栏 → 跳页 → 缓存
├─ prefs.js            默认偏好
├─ preferences.xhtml   设置面板
├─ icons/icon.png      图标
├─ build_xpi.py        Python 打包成 .xpi
└─ 打包.ps1            PowerShell 打包成 .xpi
```

## 工作原理

- 优先 `PDFViewerApplication.pdfDocument.getOutline()` 读 PDF 自带书签；无则逐页取文字喂 AI。
- pdf.js 读不出文字时退化用 Zotero 内置全文 `attachmentText`，并按标题字符偏移估算页码。
- AI 被要求只返回 JSON（`{"outline":[{"level","title","summary","page"}]}`），插件解析后按层级渲染并支持点击跳转。
- 目录缓存在 Zotero 数据目录的 `paper-outline-cache.json`（按正条目 key），重开秒显。

## 许可

[MIT](LICENSE) © 独钓寒江雪。AI 协作开发（Claude）。

> 图标为占位/示意，若涉及第三方素材请自行替换为可商用/自有版权的图片。
