<p align="center">
  <img src="icons/icon.png" width="96" alt="Paper Outline">
</p>

<h1 align="center">Paper Outline</h1>

<p align="center">用 AI 为论文生成<strong>带页码的层级目录 + 逐节摘要</strong>，显示在 Zotero 阅读器大纲栏，点击跳转。</p>

<p align="center">
  <a href="https://github.com/DrinkTea905/zotero-paper-outline/releases/latest"><img src="https://img.shields.io/github/v/release/DrinkTea905/zotero-paper-outline?logo=github&label=release" alt="latest release"></a>
  <img src="https://img.shields.io/badge/Zotero-7%20|%208%20|%209-cc2936?logo=zotero&logoColor=white" alt="Zotero 7|8|9">
  <a href="https://github.com/DrinkTea905/zotero-paper-outline/releases"><img src="https://img.shields.io/github/downloads/DrinkTea905/zotero-paper-outline/total?logo=github&label=downloads" alt="downloads"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/DrinkTea905/zotero-paper-outline" alt="license"></a>
  <img src="https://img.shields.io/github/stars/DrinkTea905/zotero-paper-outline?style=social" alt="stars">
</p>

---

一个**专注单一功能**的 Zotero 插件：选中文献或打开 PDF，用 AI 自动生成**层级化目录 + 逐节中文摘要**，直接显示在阅读器左侧大纲栏，点击条目跳转到对应页码。无聊天界面、无多余功能。兼容 **Zotero 7 / 8 / 9**。

## ✨ 功能

- **阅读器左侧大纲栏**：打开 PDF，左侧出现 AI 生成的层级目录；点条目跳到对应页，翻页时当前章节自动高亮。
- **书签优先，按需调 AI**：PDF 自带书签（embedded outline）时直接读取（免费、精确）；无书签才调 AI 从全文推断目录与摘要。
- **多服务商，OpenAI 兼容**：DeepSeek（默认，便宜、中文好）/ OpenAI / Kimi(Moonshot) / 智谱 / 通义千问 / SiliconFlow / 本地 Ollama / 自定义，设置里下拉切换。
- **可调层级深度**：识别到全部层级，或只到 1 / 2 / 3 级。
- **目录折叠、生成动画、友好报错、一键重新生成**。
- **可选存为子笔记**：右键文献也能生成目录并存成 Zotero 子笔记（默认关；目录本身缓存在数据目录，常驻大纲栏）。

## 📦 安装

**[⬇️ 下载最新版 `paper-outline-gpt.xpi`](https://github.com/DrinkTea905/zotero-paper-outline/releases/latest)**，然后：

1. Zotero → **工具 → 插件** → 右上角齿轮 → **Install Add-on From File…** → 选刚下载的 `.xpi`。
2. 按提示重启 Zotero。

> 已配置**自动更新**：以后发布新版本，Zotero 会自动检测并升级，无需手动重装。

<details>
<summary>自行打包（开发者）</summary>

```powershell
# 方式一：Python（推荐）
python build_xpi.py
# 方式二：PowerShell
powershell -ExecutionPolicy Bypass -File .\打包.ps1
```
生成 `paper-outline-gpt.xpi`。
</details>

## ⚙️ 配置（编辑 → 设置 → Paper Outline）

1. **服务商**下拉选一个（默认 DeepSeek）。
2. 填 **API Key**（本地 Ollama 免 Key）。
   - DeepSeek：到 <https://platform.deepseek.com> 申请，模型 `deepseek-chat`。
   - 其它服务商选中后会自动用其默认 URL / 模型；要换模型或自定义中转，填「⚙ 高级」里的 API URL / 模型即可。
   - 本地 Ollama：先 `ollama pull qwen3:8b`，URL 默认 `http://localhost:11434/v1/chat/completions`，全离线零费用。
3. 可选：调整层级深度、并发、每块字数、提示词。

## 🚀 使用

- **阅读器内**：打开任意有 PDF 的文献 → 看左侧大纲栏 → 点「📑 生成目录」→ 等生成完，点条目跳页。
- **中间栏右键**：选中一篇或多篇文献 → 右键生成目录（如开启「另存为笔记」会写成子笔记）。

> 需要 PDF 有可提取的文字层；扫描件请先 OCR。少数字体无 Unicode 映射的 PDF（如部分 CNKI 导出）pdf.js 读不出文字，会退化用 Zotero 全文提取并**估算页码**（≈±1 页）。

## 🛠 工作原理

- 优先 `PDFViewerApplication.pdfDocument.getOutline()` 读 PDF 自带书签；无则取全文喂 AI。
- pdf.js 读不出文字时退化用 Zotero 内置全文 `attachmentText`，并按标题字符偏移估算页码。
- AI 被要求只返回 JSON（`{"outline":[{"level","title","summary","page"}]}`），插件解析后按层级渲染并支持点击跳转。
- 目录缓存在 Zotero 数据目录的 `paper-outline-cache.json`（按正条目 key），重开秒显。

<details>
<summary>文件结构</summary>

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
</details>

## 💬 反馈与交流

- 发现 bug 或想要新功能 → [提 Issue](https://github.com/DrinkTea905/zotero-paper-outline/issues)
- 想聊用法、分享想法 → [Discussions](https://github.com/DrinkTea905/zotero-paper-outline/discussions)

## 📄 许可

[MIT](LICENSE) © 独钓寒江雪。AI 协作开发（Claude）。
