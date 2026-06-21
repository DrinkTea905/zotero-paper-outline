<p align="center">
  <img src="icons/icon.png" width="96" alt="Paper Outline">
</p>

<h1 align="center">Paper Outline</h1>

<p align="center">用 AI 为论文生成<strong>整篇总结（存为笔记）+ 带页码的层级目录</strong>，文献入库可<strong>自动</strong>生成，目录显示在 Zotero 阅读器大纲栏、点击跳页。</p>

<p align="center">
  <a href="https://github.com/DrinkTea905/zotero-paper-outline/releases/latest"><img src="https://img.shields.io/github/v/release/DrinkTea905/zotero-paper-outline?logo=github&label=release" alt="latest release"></a>
  <img src="https://img.shields.io/badge/Zotero-7%20|%208%20|%209-cc2936?logo=zotero&logoColor=white" alt="Zotero 7|8|9">
  <a href="https://github.com/DrinkTea905/zotero-paper-outline/releases"><img src="https://img.shields.io/github/downloads/DrinkTea905/zotero-paper-outline/total?logo=github&label=downloads" alt="downloads"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/DrinkTea905/zotero-paper-outline" alt="license"></a>
  <img src="https://img.shields.io/github/stars/DrinkTea905/zotero-paper-outline?style=social" alt="stars">
</p>

---

一个**专注、轻量**的 Zotero 插件：用 AI 给论文生成**整篇总结**（存为子笔记）和**层级目录 + 逐节摘要**（显示在阅读器左侧大纲栏，点击跳页）。新文献入库可**自动**生成，也可右键手动。无聊天界面、无多余功能。兼容 **Zotero 7 / 8 / 9**。

## ✨ 功能

- **🆕 去除文字空格（小崔定制）**：阅读器工具栏页码「X / Y」右边有个**粉色小猫**图标；中文 PDF 里选中文字、`Ctrl+C` 复制后点它，自动去掉字与字之间的多余空格（中英之间也不留空格、PDF 换行并回成整段，英文单词间正常空格保留），再粘贴即干净。纯规则处理、不调 AI、不联网。开关在「设置 → 高级选项」。
- **🆕 整篇总结 → 子笔记**：通读全文，AI 生成结构化中文总结（分级标题 + 要点 + 加粗，1000 字内），存为该文献的子笔记；总结提示词可在设置里自定义。
- **🆕 入库自动处理（默认开）**：新文献（带 PDF）存入 Zotero 后，自动生成「整篇总结 + 层级目录」。批量导入自动排队限流、已生成的跳过、无 API Key 时静默；可在设置里关闭，改为右键手动。
- **阅读器左侧大纲栏**：打开 PDF，左侧出现 AI 生成的层级目录；点条目跳到对应页，翻页时当前章节自动高亮。
- **书签优先，按需调 AI**：PDF 自带书签（embedded outline）时直接读取（免费、精确）；无书签才调 AI 从全文推断目录与摘要。
- **多服务商，OpenAI 兼容**：DeepSeek（默认，便宜、中文好）/ OpenAI / Kimi(Moonshot) / 智谱 / 通义千问 / SiliconFlow / 本地 Ollama / 自定义，设置里下拉切换。
- **可调层级深度**：识别到全部层级，或只到 1 / 2 / 3 级。
- **目录折叠、生成动画、友好报错、一键重新生成**。
- **目录可选存为子笔记**：右键文献也能生成目录并存成 Zotero 子笔记（默认关；目录本身缓存在数据目录，常驻大纲栏）。

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
3. 可选：在「②入库自动处理」开关自动生成；调整目录层级深度、目录 / 总结提示词；其余（并发、每块字数、自定义 API URL）在「④高级选项」里。

## 🚀 使用

- **入库自动（默认开）**：直接把带 PDF 的文献加进 Zotero，稍候右下角提示「已生成：总结 + 目录」——总结写进子笔记，目录进大纲栏。
- **阅读器内**：打开任意有 PDF 的文献 → 看左侧大纲栏 → 点「📑 生成目录」→ 等生成完，点条目跳页。
- **中间栏右键**：选中一篇或多篇文献 → 右键 →「📝 AI 整篇总结」（存笔记）或「📑 AI 生成目录」。

> 需要 PDF 有可提取的文字层；扫描件请先 OCR。少数字体无 Unicode 映射的 PDF（如部分 CNKI 导出）pdf.js 读不出文字，会退化用 Zotero 全文提取并**估算页码**（≈±1 页）。

## 🛠 工作原理

- 优先 `PDFViewerApplication.pdfDocument.getOutline()` 读 PDF 自带书签；无则取全文喂 AI。
- pdf.js 读不出文字时退化用 Zotero 内置全文 `attachmentText`，并按标题字符偏移估算页码。
- AI 被要求只返回 JSON（`{"outline":[{"level","title","summary","page"}]}`），插件解析后按层级渲染并支持点击跳转。
- 目录缓存在 Zotero 数据目录的 `paper-outline-cache.json`（按正条目 key），重开秒显。
- **整篇总结**：取全文 → 调 AI（纯文本 Markdown 结构）→ 轻量 Markdown→HTML 存为子笔记（带去重标记，已有则不重复生成）。
- **入库自动**：监听 Zotero 条目新增事件，新增 PDF 附件即把其父文献排入队列逐篇生成，已有总结 / 目录则跳过。

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
