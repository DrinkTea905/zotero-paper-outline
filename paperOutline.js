/* global Zotero */
// ───────────────────────────────────────────────────────────────
//  Paper Outline —— 核心逻辑
//  流程：选中条目 → 取最佳PDF附件 → 取全文 → (长文分块)并发调AI
//        → 得到层级目录+逐节摘要 → 拼成HTML → 存为子笔记
// ───────────────────────────────────────────────────────────────

var PaperOutline = {
  id: null,
  rootURI: null,
  _addedWindows: new Set(),
  MINERU_API_BASE: "https://mineru.net/api/v4",
  MINERU_TOKEN_URL: "https://mineru.net/apiManage/token",
  MINERU_TOKEN_DAYS: 90,
  MINERU_WARNING_DAYS: 14,
  _mineruTextCache: null,
  _mineruReminderTimer: null,

  init({ id, version, rootURI }) {
    this.id = id;
    this.version = version;
    this.rootURI = rootURI;
    // 暴露到 Zotero 主对象，方便在「运行 JavaScript」里诊断/手动触发
    try { Zotero.PaperOutlineGPT = this; } catch (e) {}
    try { this._migratePrefs(); } catch (e) {}
    try { this._scheduleMineruExpiryReminder(); } catch (e) {}
  },

  // 旧版偏好迁移：openai.* → 统一的 apiKey/apiUrl/model（仅在新键为空时复制，保住用户已填配置）
  _migratePrefs() {
    const P = "extensions.paperoutline.";
    const get = (k) => Zotero.Prefs.get(P + k, true);
    const set = (k, v) => Zotero.Prefs.set(P + k, v, true);
    if (!get("apiKey") && get("openai.apiKey")) set("apiKey", get("openai.apiKey"));
    if (!get("model") && get("openai.model")) set("model", get("openai.model"));
    const oldUrl = get("openai.apiUrl");
    // 仅迁移用户自定义过的 URL（旧默认 deepseek 地址不迁，留空走预设，便于切换服务商）
    if (!get("apiUrl") && oldUrl && oldUrl !== "https://api.deepseek.com/chat/completions") {
      set("apiUrl", oldUrl);
    }

    // DeepSeek 于 2026-07-24 停止支持旧模型名 deepseek-chat。
    // 仅迁移官方 DeepSeek 端点；自定义中转可能仍把该名称作为别名，必须保留用户配置。
    const provider = get("provider") || "deepseek";
    const model = String(get("model") || "").trim();
    const apiUrl = String(get("apiUrl") || "").trim().replace(/\/+$/, "");
    const officialDeepSeek =
      !apiUrl ||
      apiUrl === "https://api.deepseek.com/chat/completions" ||
      apiUrl === "https://api.deepseek.com/v1/chat/completions";
    if (provider === "deepseek" && model === "deepseek-chat" && officialDeepSeek) {
      set("model", "");
    }

    // 旧版本没有保存 Token 录入时间；升级后从首次读取时开始估算 90 天有效期。
    if (get("mineruToken") && !parseInt(get("mineruTokenSavedAt") || "0", 10)) {
      set("mineruTokenSavedAt", String(Date.now()));
      set("mineruTokenExpired", false);
      set("mineruExpiryReminderAt", "0");
    }
  },

  log(msg) {
    Zotero.debug("[PaperOutline] " + msg);
  },

  // ── 偏好读取（带默认值）────────────────────────────────
  pref(key, fallback) {
    const v = Zotero.Prefs.get("extensions.paperoutline." + key, true);
    return v === undefined || v === null || v === "" ? fallback : v;
  },

  DEFAULT_PROMPT:
    "你是论文结构分析助手。请阅读给定的论文正文，输出层级化目录（table of contents）。" +
    "为每个章节给出不超过 60 字的中文核心总结，提炼主要观点，" +
    "可采用「总结了…，指出了…，讨论了…，强调了…」这类句式。" +
    "只输出 JSON，格式严格为：" +
    '{"outline":[{"level":1,"title":"章节标题","summary":"核心总结"}]}。' +
    "level 表示层级（1 为一级标题，2 为二级，以此类推）。" +
    "title 必须带序号前缀：优先保留原文的章节序号（如 一、二、、（一）（二）、1. 2.、(1)(2) 等）；" +
    "若原文标题没有显式序号，按层级自动补全——一级用「一、二、三、…」，二级用「（一）（二）（三）…」，" +
    "三级用「1. 2. 3. …」，四级用「(1)(2)(3)…」，同级按出现顺序连续编号。" +
    "若原文章节标题是英文，title 请翻译成中文（序号保留）。不要输出 JSON 以外的任何文字。",

  // 整篇总结提示词（默认；设置里可改，清空回落到此）。AI 用 Markdown 输出，写入笔记时转 HTML。
  SUMMARY_PROMPT:
    "请总结这篇学术论文的核心内容（你的输出必须是简体中文）。直接输出总结正文，" +
    "不要任何开场白或客套话（例如「好的」「以下是……的总结」等），也不要复述论文标题。要求：\n" +
    "1. 全文控制在 1000 字以内；\n" +
    "2. 先点明论文的核心研究问题、研究对象与全文核心观点；\n" +
    "3. 按论文行文逻辑分模块梳理，覆盖研究背景、制度沿革、核心论证、史料依据、结论与现实启示；\n" +
    "4. 保留关键数据、典型案例、核心制度规则与重要学术观点；\n" +
    "5. 使用分级标题+要点的结构化排版，逻辑清晰，重点信息加粗标注；\n" +
    "6. 抓主干、不遗漏核心结论；宁可凝练也不要超过 1000 字。",

  // 总结喂给 AI 的全文字符上限（详细全文总结，需尽量覆盖全文；超长才首尾截断）
  SUMMARY_MAX_CHARS: 60000,

  // 子笔记里的整篇总结标记（用于去重判断：同一文献已有总结笔记则自动模式跳过）
  SUMMARY_MARKER: "由 Paper Outline 生成 · 整篇总结",

  // 页码增强：当把带「===== 第 N 页 =====」标记的全文喂给 AI 时附加，让它标出每节起始页
  PAGE_INSTRUCTION:
    "【页码要求】正文中我用「===== 第 N 页 =====」标出了每页起始。" +
    "请在每个目录条目里额外输出一个整数字段 page，值＝该章节标题所在页码" +
    "（不要使用论文首页或前置“目录/目次”页里列出的页码；同一标题在目录页和正文均出现时，必须取正文标题真正开始的页面）" +
    "（取标题上方最近的「第 N 页」标记）。即每个条目形如 " +
    '{"level":1,"title":"…","summary":"…","page":3}。',

  // ── 菜单注册 ────────────────────────────────────────────
  // Zotero 8/9：用 Zotero.MenuManager.registerMenu（自动管理所有窗口）
  // Zotero 7：退化为逐窗口注入 #zotero-itemmenu
  MENU_LABEL: "📑 AI 生成目录",
  SUMMARY_MENU_LABEL: "📝 AI 整篇总结 → 笔记",
  REVIVE_MENU_LABEL: "🔄 重新唤起 Paper Outline",
  _menuID: "paper-outline-menu",
  _reviveMenuID: "paper-outline-revive-menu",
  _reviveReaderMenuID: "paper-outline-revive-reader-menu",
  _registeredMenuIDs: [],
  _usedMenuManager: false,

  registerMenu() {
    if (Zotero.MenuManager && typeof Zotero.MenuManager.registerMenu === "function") {
      try {
        this._registeredMenuIDs = [];
        const itemMenuID = Zotero.MenuManager.registerMenu({
          menuID: this._menuID,
          pluginID: this.id,
          target: "main/library/item", // 条目右键菜单
          menus: [
            {
              menuType: "menuitem",
              label: this.SUMMARY_MENU_LABEL,
              // Zotero 8/9：label 属性不渲染，需在 onShowing 里给 DOM 元素设 label
              onShowing: (event, context) => {
                try {
                  if (context && context.menuElem) {
                    context.menuElem.setAttribute("label", PaperOutline.SUMMARY_MENU_LABEL);
                  }
                } catch (e) {}
              },
              onCommand: () => this.runSummaryOnSelected(),
            },
            {
              menuType: "menuitem",
              label: this.MENU_LABEL,
              onShowing: (event, context) => {
                try {
                  if (context && context.menuElem) {
                    context.menuElem.setAttribute("label", PaperOutline.MENU_LABEL);
                  }
                } catch (e) {}
              },
              onCommand: () => this.runOnSelected(),
            },
            {
              menuType: "menuitem",
              label: "📋 复制 PDF 文件",
              onShowing: (event, context) => {
                try {
                  if (context && context.menuElem) context.menuElem.setAttribute("label", "📋 复制 PDF 文件");
                  if (context && context.setVisible) context.setVisible(PaperOutline.pref("copyFile", true)); // 总开关
                } catch (e) {}
              },
              onCommand: () => PaperOutline.copySelectedFile(),
            },
          ],
        });
        this._registeredMenuIDs.push(itemMenuID || this._menuID);

        const reviveMenu = (target, menuID) => {
          const registeredID = Zotero.MenuManager.registerMenu({
            menuID,
            pluginID: this.id,
            target,
            menus: [
              {
                menuType: "menuitem",
                label: this.REVIVE_MENU_LABEL,
                onShowing: (event, context) => {
                  try {
                    if (context && context.menuElem) {
                      context.menuElem.setAttribute("label", PaperOutline.REVIVE_MENU_LABEL);
                    }
                  } catch (e) {}
                },
                onCommand: (event) => PaperOutline.reviveReaderFeatures(event),
              },
            ],
          });
          this._registeredMenuIDs.push(registeredID || menuID);
        };
        reviveMenu("main/menubar/tools", this._reviveMenuID);
        reviveMenu("reader/menubar/view", this._reviveReaderMenuID);
        this._usedMenuManager = true;
        this.log("menus registered via MenuManager");
        return;
      } catch (e) {
        try {
          for (const menuID of this._registeredMenuIDs) {
            try { Zotero.MenuManager.unregisterMenu(menuID); } catch (e3) {}
          }
        } catch (e2) {}
        this._registeredMenuIDs = [];
        this.log("MenuManager.registerMenu failed, fallback to DOM: " + e);
      }
    }
    // Zotero 7 退化路径
    this._usedMenuManager = false;
    for (const win of Zotero.getMainWindows()) this.addToWindow(win);
  },

  unregisterMenu() {
    try {
      if (this._usedMenuManager && Zotero.MenuManager && Zotero.MenuManager.unregisterMenu) {
        const menuIDs = this._registeredMenuIDs.length
          ? this._registeredMenuIDs
          : [this._menuID, this._reviveMenuID, this._reviveReaderMenuID];
        for (const menuID of menuIDs) {
          try { Zotero.MenuManager.unregisterMenu(menuID); } catch (e2) {}
        }
      }
      this._registeredMenuIDs = [];
      this.removeFromAllWindows();
    } catch (e) {
      this.log("unregisterMenu error: " + e);
    }
  },

  // —— 以下仅 Zotero 7 退化路径使用 ——
  addToWindow(window) {
    try {
      const doc = window.document;
      const itemMenu = doc.getElementById("zotero-itemmenu");
      if (itemMenu && !doc.getElementById("paper-outline-menuitem")) {
        const ms = doc.createXULElement("menuitem");
        ms.id = "paper-outline-summary-menuitem";
        ms.setAttribute("label", this.SUMMARY_MENU_LABEL);
        ms.addEventListener("command", () => this.runSummaryOnSelected());
        itemMenu.appendChild(ms);
        const mi = doc.createXULElement("menuitem");
        mi.id = "paper-outline-menuitem";
        mi.setAttribute("label", this.MENU_LABEL);
        mi.addEventListener("command", () => this.runOnSelected());
        itemMenu.appendChild(mi);
      }

      const toolsMenu = doc.getElementById("menu_ToolsPopup");
      if (toolsMenu && !doc.getElementById("paper-outline-revive-menuitem")) {
        const revive = doc.createXULElement("menuitem");
        revive.id = "paper-outline-revive-menuitem";
        revive.setAttribute("label", this.REVIVE_MENU_LABEL);
        revive.addEventListener("command", (event) => this.reviveReaderFeatures(event));
        toolsMenu.appendChild(revive);
      }

      if (
        doc.getElementById("paper-outline-menuitem") ||
        doc.getElementById("paper-outline-revive-menuitem")
      ) {
        this._addedWindows.add(window);
      }
    } catch (e) {
      this.log("addToWindow error: " + e);
    }
  },

  removeFromWindow(window) {
    try {
      window.document.getElementById("paper-outline-menuitem")?.remove();
      window.document.getElementById("paper-outline-summary-menuitem")?.remove();
      window.document.getElementById("paper-outline-revive-menuitem")?.remove();
      this._addedWindows.delete(window);
    } catch (e) {
      this.log("removeFromWindow error: " + e);
    }
  },

  removeFromAllWindows() {
    for (const win of [...this._addedWindows]) this.removeFromWindow(win);
  },

  HTML_NS: "http://www.w3.org/1999/xhtml",

  // ── 阅读器左侧「大纲」栏注入（DOM 注入 reader iframe，参考 jasminum）──
  registerReaderOutline() {
    try {
      if (Zotero.Reader && typeof Zotero.Reader.registerEventListener === "function") {
        Zotero.Reader.registerEventListener(
          "renderToolbar",
          (event) => {
            PaperOutline._injectReaderOutline(event.reader);
          },
          this.id
        );
        // 处理已经打开的阅读器
        try {
          (Zotero.Reader._readers || []).forEach((r) => PaperOutline._injectReaderOutline(r));
        } catch (e) {}
        this.log("reader outline listener registered");
      }
    } catch (e) {
      this.log("registerReaderOutline error: " + e);
    }
  },

  _getReaderReviveTargets(event) {
    let readers = [];
    try {
      readers = Array.from((Zotero.Reader && Zotero.Reader._readers) || []).filter(
        (reader) => reader && reader.type === "pdf"
      );
    } catch (e) {}

    // 独立阅读器中调用时只恢复该窗口；阅读器标签页中调用时只恢复当前 PDF。
    try {
      const win = Zotero.getMainWindow && Zotero.getMainWindow();
      const commandWindow =
        (event && event.target && event.target.ownerGlobal) || (event && event.view) || null;
      if (commandWindow && commandWindow !== win) {
        const detached = readers.find(
          (reader) => !reader.tabID && reader._window === commandWindow
        );
        if (detached) return [detached];
      }
      const tabID = win && win.Zotero_Tabs && win.Zotero_Tabs.selectedID;
      const current =
        tabID && Zotero.Reader && typeof Zotero.Reader.getByTabID === "function"
          ? Zotero.Reader.getByTabID(tabID)
          : null;
      if (current && current.type === "pdf") return [current];
    } catch (e) {}
    return readers;
  },

  async _reviveOneReader(reader, activateOutline) {
    if (!reader || reader.type !== "pdf") return false;
    await this._injectReaderOutline(reader);

    const rw = reader._iframeWindow;
    const doc = rw && rw.document;
    if (!doc) return false;

    try { this._injectDespaceButton({ doc, reader }); } catch (e) {}
    try { this._injectReaderInfoPanel({ doc, reader }); } catch (e) {}
    try { this._injectAnnotCleanButton({ doc, reader }); } catch (e) {}

    if (activateOutline) {
      try {
        const outlineTab = doc.getElementById("viewOutline");
        if (outlineTab && typeof outlineTab.click === "function") outlineTab.click();
      } catch (e) {}
    }

    // Zotero 的 React 视图可能在点击标签后再次替换 DOM，分阶段补挂且保持幂等。
    const retry = async () => {
      try {
        await PaperOutline._injectReaderOutline(reader);
        const currentDoc = reader._iframeWindow && reader._iframeWindow.document;
        if (currentDoc) {
          PaperOutline._injectDespaceButton({ doc: currentDoc, reader });
          PaperOutline._injectReaderInfoPanel({ doc: currentDoc, reader });
          PaperOutline._injectAnnotCleanButton({ doc: currentDoc, reader });
        }
      } catch (e) {
        PaperOutline.log("revive retry: " + e);
      }
    };
    try {
      rw.setTimeout(retry, 80);
      rw.setTimeout(retry, 260);
      rw.setTimeout(retry, 700);
    } catch (e) {}
    return true;
  },

  async reviveReaderFeatures(event) {
    const readers = this._getReaderReviveTargets(event);
    if (!readers.length) {
      this._toast("Paper Outline · 未找到 PDF", "请先打开一篇 PDF，再使用重新唤起功能");
      return 0;
    }

    let revived = 0;
    for (const reader of readers) {
      try {
        if (await this._reviveOneReader(reader, true)) revived++;
      } catch (e) {
        this.log("reviveReaderFeatures: " + e);
      }
    }
    if (revived) {
      this._toast(
        "Paper Outline · 已重新唤起",
        revived === 1 ? "已刷新当前 PDF 的目录栏和工具按钮" : "已刷新 " + revived + " 个 PDF 阅读器"
      );
    } else {
      this._toast("Paper Outline · 唤起失败", "请关闭当前 PDF 标签页后重试");
    }
    return revived;
  },

  // 解析当前 reader 的 pdf.js PDFViewerApplication（多路径兜底：不同 Zotero 版本属性名有别）
  // zotero-gpt 用的是 reader._internalReader._lastView._iframeWindow.PDFViewerApplication
  _getReaderApp(reader) {
    if (!reader) return null;
    const ir = reader._internalReader;
    const views = [
      ir && ir._lastView,
      ir && ir._primaryView,
      reader._lastView,
      reader._primaryView,
    ];
    for (const v of views) {
      try {
        const w = v && v._iframeWindow;
        if (!w) continue;
        // ⚠️ 特权代码经 Xray 读 pdf.js 对象时，getTextContent 的文字属性会被隐藏成空。
        // 用 wrappedJSObject 拿到内容域原生对象，文字才读得出来。
        const win = w.wrappedJSObject || w;
        if (win.PDFViewerApplication) return win.PDFViewerApplication;
      } catch (e) {}
    }
    return null;
  },

  async _injectReaderOutline(reader) {
    try {
      if (!reader || reader.type !== "pdf") return;
      try { await reader._initPromise; } catch (e) {}

      // 🔑 关键修复：注入宿主用【外层 reader.html】(reader._iframeWindow)——那才是肉眼
      // 可见的侧栏；内层 pdf.js 侧栏被 Zotero 用 CSS 隐藏了，往那注入“成功了也看不见”。
      const rw = reader._iframeWindow; // 外层 reader.html window（注入宿主）
      if (!rw || !rw.document) return;
      const doc = rw.document;

      // 预热 pdf.js 视图（取书签/页码/跳页都靠它；用时一律走 _getReaderApp(reader) 多路径解析）
      try {
        const v = (reader._internalReader && reader._internalReader._lastView) || reader._lastView;
        if (v && v.initializedPromise) await v.initializedPromise;
        const app0 = this._getReaderApp(reader);
        if (app0 && app0.initializedPromise) await app0.initializedPromise;
      } catch (e) {}

      const att = reader._item;
      const item = att && att.parentItem ? att.parentItem : att;

      // 等外层侧栏内容容器就绪（最多 ~2.5s）
      let tries = 0;
      while (!doc.getElementById("sidebarContent") && tries < 25) {
        await new Promise((r) => rw.setTimeout(r, 100));
        tries++;
      }

      // 注入：仅当面板缺失时重建。Zotero 收起侧栏时可能销毁 sidebarContent，
      // 重新展开后会创建一个全新的容器，因此每次都重新查询当前宿主，不能保存旧节点引用。
      const ensureInjected = () => {
        try {
          const host = doc.getElementById("sidebarContent");
          if (!host) {
            PaperOutline.log("reader sidebar host 未找到");
            return false;
          }
          if (!host.querySelector("#paper-outline-reader")) {
            PaperOutline._renderReaderOutline(doc, host, item, reader);
          } else {
            PaperOutline._updateReaderPanelVisibility(doc);
          }
          return true;
        } catch (e3) {
          PaperOutline.log("ensureInjected: " + e3);
          return false;
        }
      };
      this._readerEnsure = ensureInjected; // 暴露给诊断
      ensureInjected();
      // 旧版本可能已把前置“目录/目次”页缓存成所有章节的跳转页。
      // 打开阅读器时做一次无 AI、无费用的本地页码修复，避免用户必须重新生成。
      try {
        if (item && this._getCache(item.key) && !reader._poCachedPageRepairStarted) {
          reader._poCachedPageRepairStarted = true;
          this._repairCachedOutlinePages(item, reader, doc).catch((e) =>
            PaperOutline.log("repairCachedOutlinePages: " + e)
          );
        }
      } catch (e2) {}

      const scheduleEnsure = (delay) => {
        try {
          rw.setTimeout(() => ensureInjected(), delay || 0);
        } catch (e) {}
      };

      // 用文档级事件委托监听侧栏开关和三个标签。按钮本身也会被 Zotero 重建，
      // 事件委托无需在每个新按钮上重复绑定。
      try {
        if (reader._poSidebarClickDoc && reader._poSidebarClickHandler) {
          try {
            reader._poSidebarClickDoc.removeEventListener(
              "click",
              reader._poSidebarClickHandler,
              true
            );
          } catch (e) {}
        }
        const sidebarClickHandler = (event) => {
          let target = event && event.target;
          while (target && target !== doc) {
            const id = target.id || (target.getAttribute && target.getAttribute("id"));
            if (["viewThumbnail", "viewOutline", "viewAnnotations", "sidebarToggle"].includes(id)) {
              // React 的收起/展开与标签切换可能分两轮提交，分阶段补挂并更新显隐。
              scheduleEnsure(40);
              scheduleEnsure(160);
              scheduleEnsure(360);
              break;
            }
            target = target.parentNode;
          }
        };
        doc.addEventListener("click", sidebarClickHandler, true);
        reader._poSidebarClickDoc = doc;
        reader._poSidebarClickHandler = sidebarClickHandler;
      } catch (e2) {}

      // React 若重建整个侧栏宿主，旧 host 上的观察器也会一起失效。
      // 改为观察稳定的 reader 文档，并且只在“当前 host 存在但面板缺失”时补回。
      try {
        if (reader._paperOutlineObserver) {
          try { reader._paperOutlineObserver.disconnect(); } catch (e) {}
        }
        const root = doc.body || doc.documentElement;
        if (root && rw.MutationObserver) {
          let pending = false;
          const mo = new rw.MutationObserver(() => {
            const currentHost = doc.getElementById("sidebarContent");
            if (!currentHost || currentHost.querySelector("#paper-outline-reader") || pending) return;
            pending = true;
            rw.setTimeout(() => {
              pending = false;
              ensureInjected();
            }, 30);
          });
          mo.observe(root, { childList: true, subtree: true });
          reader._paperOutlineObserver = mo;
          reader._paperOutlineObserverDoc = doc;
        }
      } catch (e2) {}

      // PDF 加载完再补一道保险（走 pdf.js eventBus）
      try {
        const app1 = this._getReaderApp(reader);
        const eb = app1 && app1.eventBus;
        if (eb && reader._poEnsureEventBus !== eb) {
          reader._poEnsureEventBus = eb;
          eb.on("documentloaded", () => rw.setTimeout(ensureInjected, 80));
        }
      } catch (e2) {}

      // 翻页时高亮目录里对应章节（页码跟随，像真正的大纲导航）
      try {
        const app2 = this._getReaderApp(reader);
        const eb2 = app2 && app2.eventBus;
        if (eb2 && reader._poPageEventBus !== eb2) {
          reader._poPageEventBus = eb2;
          eb2.on("pagechanging", (e) => {
            const pn =
              (e && (e.pageNumber || e.pageLabel)) ||
              (app2.pdfViewer && app2.pdfViewer.currentPageNumber) ||
              1;
            rw.setTimeout(() => PaperOutline._highlightReaderOutline(doc, parseInt(pn, 10) || 1), 30);
          });
        }
      } catch (e2) {}

      // 若该篇已有缓存目录，自动切到「大纲」标签直接显示（每个 reader 只切一次，
      // 走 reader 自身的标签点击最可靠，不打断用户后续手动切换）。
      try {
        if (item && this._getCache(item.key) && !reader._paperOutlineSwitched) {
          reader._paperOutlineSwitched = true;
          rw.setTimeout(() => {
            try {
              const vb = doc.getElementById("viewOutline");
              if (vb) vb.click();
            } catch (e4) {}
          }, 400);
        }
      } catch (e2) {}
    } catch (e) {
      this.log("_injectReaderOutline error: " + e);
    }
  },

  _renderReaderOutline(doc, host, item, reader) {
    const HTML = this.HTML_NS;
    const mk = (tag, css, text, cls) => {
      const e = doc.createElementNS(HTML, tag);
      if (css) e.setAttribute("style", css);
      if (cls) e.setAttribute("class", cls);
      if (text != null) e.textContent = text;
      return e;
    };
    this._injectReaderStyle(doc);
    let box = host.querySelector("#paper-outline-reader");
    if (!box) {
      box = mk("div", "");
      box.id = "paper-outline-reader";
      host.appendChild(box);
    }
    box.setAttribute(
      "style",
      "position:relative;z-index:10;width:100%;flex-direction:column;overflow-y:auto;" +
        "padding:8px 10px;box-sizing:border-box;background:var(--material-sidepane,Field);"
    );
    box.textContent = "";

    const maxLevel = parseInt(this.pref("maxLevel", 0), 10) || 0;
    let outline = item ? this._getCache(item.key) : null;
    if (outline && maxLevel > 0) {
      outline = outline.filter((s) => (parseInt(s.level, 10) || 1) <= maxLevel);
    }

    // 空状态：生成目录 + 就地测试连接
    if (!outline || !outline.length) {
      const actions = mk("div", null, null, "po-empty-actions");
      const btn = mk("button", null, "📑 生成目录", "po-btn");
      btn.addEventListener("click", () => PaperOutline._doGenerate(doc, host, item, reader, false));
      const testBtn = mk("button", null, "🔌 测试连接", "po-btn po-test-btn");
      const status = mk(
        "div",
        null,
        this._needKey() && !this.pref("apiKey", "")
          ? "尚未填写 API Key，可先测试连接查看具体提示。"
          : "生成前可先测试当前 AI 连接。",
        "po-connection-status po-status-idle"
      );
      status.setAttribute("role", "status");
      status.setAttribute("aria-live", "polite");
      testBtn.addEventListener("click", () => PaperOutline._testReaderConnection(testBtn, status));
      actions.appendChild(btn);
      actions.appendChild(testBtn);
      box.appendChild(actions);
      box.appendChild(status);
      this._updateReaderPanelVisibility(doc);
      return;
    }

    // 工具条：两个胶囊按钮 —— 展开/收起（切换）、重新生成
    const bar = mk("div", null, null, "po-toolbar");
    const tToggle = mk("span", null, "⇕ 展开/收起", "po-tbtn");
    tToggle.addEventListener("click", () => PaperOutline._toggleAllReader(box));
    const tRe = mk("span", null, "↻ 重新生成", "po-tbtn");
    tRe.addEventListener("click", () => PaperOutline._doGenerate(doc, host, item, reader, true));
    bar.appendChild(tToggle);
    bar.appendChild(tRe);
    box.appendChild(bar);

    // 目录树（可折叠）
    const lvOf = (s) => Math.max(1, Math.min(6, parseInt(s.level, 10) || 1));
    for (let i = 0; i < outline.length; i++) {
      const s = outline[i];
      const lv = lvOf(s);
      const pg = parseInt(s.page, 10);
      const row = mk("div", `margin-left:${(lv - 1) * 12}px`, null, "po-item po-lv" + lv);
      row.setAttribute("data-idx", String(i));
      row.setAttribute("data-level", String(lv));
      if (pg > 0) row.setAttribute("data-page", String(pg));
      const hasChild = i + 1 < outline.length && lvOf(outline[i + 1]) > lv;
      const tg = mk("span", null, hasChild ? "▾" : "", "po-toggle" + (hasChild ? "" : " po-leaf"));
      if (hasChild) {
        tg.addEventListener("click", (ev) => {
          ev.stopPropagation();
          PaperOutline._toggleCollapse(box, i);
        });
      }
      row.appendChild(tg);
      row.appendChild(mk("span", null, s.title || "", "po-text"));
      if (s.summary || pg) {
        row.setAttribute("title", (s.summary || "") + (pg ? (s.summary ? "\n" : "") + "→ 第 " + pg + " 页" : ""));
      }
      row.addEventListener("click", () => {
        PaperOutline._setActiveRow(doc, row); // 点谁高亮谁（修同页多小标题时高亮跑到下一个）
        PaperOutline._readerJump(reader, s);
      });
      box.appendChild(row);
    }

    this._updateReaderPanelVisibility(doc);
    // 渲染后按当前页高亮一次
    try {
      const app = this._getReaderApp(reader);
      const cur = (app && (app.page || (app.pdfViewer && app.pdfViewer.currentPageNumber))) || 1;
      this._highlightReaderOutline(doc, cur);
    } catch (e) {}
  },

  // 生成（带转圈动画 + 友好报错）：空态按钮与「重新生成」共用
  async _doGenerate(doc, host, item, reader, force) {
    const box = host.querySelector("#paper-outline-reader");
    if (!box) return;
    const txt = this._showReaderLoading(doc, box, force ? "正在重新生成…" : "正在读取与分析…");
    try {
      await this._generateReaderOutline(item, reader, (t) => { if (txt) txt.textContent = t; }, force);
      this._renderReaderOutline(doc, host, item, reader);
    } catch (e) {
      this._showReaderError(doc, host, box, item, reader, e);
    }
  },

  async _testReaderConnection(button, status) {
    if (!button || !status || button.disabled) return;
    button.disabled = true;
    button.textContent = "正在测试…";
    status.className = "po-connection-status po-status-testing";
    status.textContent = "正在连接服务商并验证模型，请稍候…";
    try {
      const result = await this.testConnection();
      status.className = "po-connection-status po-status-success";
      status.textContent =
        "连接成功 · " + result.label + " · " + result.model + " · " + result.elapsed + " ms";
    } catch (e) {
      const message = String((e && e.message) || e || "未知错误")
        .replace(/^Error:\s*/i, "")
        .trim();
      status.className = "po-connection-status po-status-error";
      status.textContent = "连接失败：" + message;
    } finally {
      button.disabled = false;
      button.textContent = "🔌 测试连接";
    }
  },

  _showReaderLoading(doc, box, text) {
    const HTML = this.HTML_NS;
    box.textContent = "";
    const wrap = doc.createElementNS(HTML, "div");
    wrap.setAttribute("class", "po-spin-wrap");
    const sp = doc.createElementNS(HTML, "div");
    sp.setAttribute("class", "po-spin");
    const tx = doc.createElementNS(HTML, "div");
    tx.setAttribute("class", "po-spin-txt");
    tx.textContent = text || "生成中…";
    wrap.appendChild(sp);
    wrap.appendChild(tx);
    box.appendChild(wrap);
    this._updateReaderPanelVisibility(doc);
    return tx;
  },

  _showReaderError(doc, host, box, item, reader, e) {
    const HTML = this.HTML_NS;
    box.textContent = "";
    const msg = doc.createElementNS(HTML, "div");
    msg.setAttribute("style", "color:#c0392b;font-size:12px;margin:6px 2px;line-height:1.6;");
    msg.textContent = "⚠ " + (e && e.message ? e.message : String(e));
    box.appendChild(msg);
    const retry = doc.createElementNS(HTML, "button");
    retry.setAttribute("class", "po-btn");
    retry.textContent = "重试";
    retry.addEventListener("click", () => PaperOutline._doGenerate(doc, host, item, reader, false));
    box.appendChild(retry);
    this._updateReaderPanelVisibility(doc);
  },

  // 折叠/展开某父节点下的子项
  _toggleCollapse(box, idx) {
    const rows = Array.from(box.querySelectorAll(".po-item"));
    const base = rows[idx];
    if (!base) return;
    const baseLv = parseInt(base.getAttribute("data-level"), 10) || 1;
    const next = base.getAttribute("data-collapsed") !== "1";
    base.setAttribute("data-collapsed", next ? "1" : "0");
    const bt = base.querySelector(".po-toggle");
    if (bt) bt.textContent = next ? "▸" : "▾";
    for (let j = idx + 1; j < rows.length; j++) {
      const lv = parseInt(rows[j].getAttribute("data-level"), 10) || 1;
      if (lv <= baseLv) break;
      rows[j].style.display = next ? "none" : "";
      if (!next) {
        rows[j].setAttribute("data-collapsed", "0");
        const t = rows[j].querySelector(".po-toggle");
        if (t && !t.classList.contains("po-leaf")) t.textContent = "▾";
      }
    }
  },

  _expandAllReader(box) {
    Array.from(box.querySelectorAll(".po-item")).forEach((r) => {
      r.style.display = "";
      r.setAttribute("data-collapsed", "0");
      const t = r.querySelector(".po-toggle");
      if (t && !t.classList.contains("po-leaf")) t.textContent = "▾";
    });
  },

  _collapseAllReader(box) {
    Array.from(box.querySelectorAll(".po-item")).forEach((r) => {
      const lv = parseInt(r.getAttribute("data-level"), 10) || 1;
      if (lv > 1) r.style.display = "none";
      const t = r.querySelector(".po-toggle");
      if (t && !t.classList.contains("po-leaf")) {
        r.setAttribute("data-collapsed", "1");
        t.textContent = "▸";
      }
    });
  },

  // 一键切换：当前展开则全收起，反之全展开
  _toggleAllReader(box) {
    const collapsed = box.getAttribute("data-allcollapsed") === "1";
    if (collapsed) {
      this._expandAllReader(box);
      box.setAttribute("data-allcollapsed", "0");
    } else {
      this._collapseAllReader(box);
      box.setAttribute("data-allcollapsed", "1");
    }
  },

  // 直接高亮指定行（点击时用：点谁亮谁）
  _setActiveRow(doc, row) {
    try {
      const box = doc.getElementById("paper-outline-reader");
      if (!box || !row) return;
      Array.from(box.querySelectorAll(".po-item")).forEach((r) => r.classList.remove("po-active"));
      row.classList.add("po-active");
    } catch (e) {}
  },

  // 按当前页高亮对应章节并滚动到可见
  _highlightReaderOutline(doc, pageNum) {
    try {
      const box = doc.getElementById("paper-outline-reader");
      if (!box) return;
      const rows = Array.from(box.querySelectorAll(".po-item"));
      // 若已高亮的章节就在当前页，保持不动 —— 同一页有多个小标题时，避免翻页事件把高亮顶到该页最后一个
      const active = box.querySelector(".po-item.po-active");
      if (active) {
        const ap = parseInt(active.getAttribute("data-page"), 10);
        if (ap > 0 && ap === pageNum) {
          if (active.style.display !== "none") { try { active.scrollIntoView({ block: "nearest" }); } catch (e) {} }
          return;
        }
      }
      let best = null;
      for (const r of rows) {
        const p = parseInt(r.getAttribute("data-page"), 10);
        if (p > 0 && p <= pageNum) best = r;
      }
      rows.forEach((r) => r.classList.remove("po-active"));
      if (best) {
        best.classList.add("po-active");
        if (best.style.display !== "none") {
          try { best.scrollIntoView({ block: "nearest" }); } catch (e) {}
        }
      }
    } catch (e) {}
  },

  // 注入面板样式（每个 reader 文档一次）：层级字体 + 悬停 + 当前高亮 + 折叠箭头 + 转圈，跟随主题色
  _injectReaderStyle(doc) {
    try {
      if (doc.getElementById("paper-outline-style")) return;
      const st = doc.createElementNS(this.HTML_NS, "style");
      st.id = "paper-outline-style";
      st.textContent = [
        '#paper-outline-reader{font-family:-apple-system,"Segoe UI","Microsoft YaHei",system-ui,sans-serif;font-size:13px;line-height:1.65;color:var(--fill-primary,#1a1a1a);}',
        '#paper-outline-reader .po-empty-actions{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px;width:100%;}',
        '#paper-outline-reader .po-empty-actions .po-btn{width:100%;margin-top:4px;}',
        '#paper-outline-reader .po-connection-status{margin-top:9px;padding:8px 9px;border:1px solid transparent;border-radius:6px;font-size:11.5px;line-height:1.5;overflow-wrap:anywhere;}',
        '#paper-outline-reader .po-status-idle{background:var(--fill-quinary,rgba(0,0,0,.045));color:var(--fill-secondary,#777);}',
        '#paper-outline-reader .po-status-testing{background:rgba(154,103,0,.10);color:#9a6700;}',
        '#paper-outline-reader .po-status-success{background:rgba(32,131,60,.11);color:#20833c;}',
        '#paper-outline-reader .po-status-error{background:rgba(198,61,61,.10);color:#b72f2f;}',
        '#paper-outline-reader .po-toolbar{display:flex;flex-wrap:wrap;gap:8px;margin:2px 2px 12px;}',
        '#paper-outline-reader .po-tbtn{display:inline-flex;align-items:center;gap:4px;font-size:12px;padding:4px 14px;border-radius:14px;border:1px solid var(--fill-quarternary,#d4d4d4);background:var(--fill-quinary,rgba(0,0,0,.035));color:var(--fill-secondary,#555);cursor:pointer;user-select:none;transition:background .12s,color .12s,border-color .12s;}',
        '#paper-outline-reader .po-tbtn:hover{background:var(--accent-blue,#2e7dd1);border-color:var(--accent-blue,#2e7dd1);color:#fff;}',
        '#paper-outline-reader .po-tbtn:active{transform:translateY(1px);}',
        '#paper-outline-reader .po-item{display:flex;align-items:baseline;gap:4px;padding:3px 6px;border-radius:6px;cursor:pointer;}',
        '#paper-outline-reader .po-item:hover{background:var(--fill-quinary,rgba(43,125,209,.12));}',
        '#paper-outline-reader .po-toggle{flex:none;width:14px;text-align:center;font-size:10px;color:var(--fill-secondary,#999);cursor:pointer;}',
        '#paper-outline-reader .po-toggle.po-leaf{cursor:default;color:transparent;}',
        '#paper-outline-reader .po-text{flex:1 1 auto;overflow-wrap:anywhere;word-break:break-word;}',
        '#paper-outline-reader .po-active{background:var(--color-accent,#2e7dd1);}',
        '#paper-outline-reader .po-active .po-text{color:#fff;}',
        '#paper-outline-reader .po-lv1{font-weight:600;font-size:13.5px;margin-top:6px;}',
        '#paper-outline-reader .po-lv2{font-weight:500;}',
        '#paper-outline-reader .po-lv3,#paper-outline-reader .po-lv4,#paper-outline-reader .po-lv5,#paper-outline-reader .po-lv6{font-weight:400;color:var(--fill-secondary,#666);font-size:12.5px;}',
        '#paper-outline-reader .po-btn{margin-top:4px;padding:5px 12px;cursor:pointer;border-radius:6px;border:1px solid var(--fill-quarternary,#c9c9c9);background:transparent;color:inherit;font-size:12.5px;}',
        '#paper-outline-reader .po-btn:hover{background:var(--fill-quinary,rgba(43,125,209,.12));}',
        '#paper-outline-reader .po-spin-wrap{display:flex;flex-direction:column;align-items:center;gap:10px;padding:26px 0;color:var(--fill-secondary,#777);font-size:12px;}',
        '#paper-outline-reader .po-spin{width:24px;height:24px;border:3px solid var(--fill-quinary,#ddd);border-top-color:var(--accent-blue,#2e7dd1);border-radius:50%;animation:po-rot .8s linear infinite;}',
        '@media (prefers-color-scheme:dark){#paper-outline-reader .po-status-testing{color:#f0c15a;}#paper-outline-reader .po-status-success{color:#70d68a;}#paper-outline-reader .po-status-error{color:#ff9292;}}',
        '@keyframes po-rot{to{transform:rotate(360deg);}}',
      ].join("\n");
      (doc.head || doc.documentElement).appendChild(st);
    } catch (e) {}
  },

  // 仅当「大纲」标签激活时显示本面板（reader.html 的激活类是 .active；多兼容几种写法以防版本差异）
  _updateReaderPanelVisibility(doc) {
    try {
      const box = doc.getElementById("paper-outline-reader");
      if (!box) return;
      const vb = doc.getElementById("viewOutline");
      const active = !!(
        vb &&
        (vb.classList.contains("active") ||
          vb.classList.contains("selected") ||
          vb.classList.contains("toggled") ||
          vb.getAttribute("aria-selected") === "true")
      );
      const want = active ? "flex" : "none";
      if (box.style.display !== want) box.style.display = want;
      // 大纲标签激活时隐藏原生 outlineView（我们用自己的面板替代），避免它盖住/抢点击
      const ov = doc.getElementById("outlineView");
      if (ov) ov.style.display = active ? "none" : "";
    } catch (e) {}
  },

  // 点击目录项跳转：①Zotero reader 官方 navigate（最稳）②书签 dest 精确定位 ③pdf.js 翻页 ④文本查找
  async _readerJump(reader, s) {
    try {
      const pg = parseInt(s.page, 10);
      const app = this._getReaderApp(reader); // 已是 wrappedJSObject 原生对象
      this.log("jump page=" + pg + " app=" + !!app + " title=" + (s.title || "").slice(0, 20));

      if (app) {
        // ① PDF 自带书签的精确目标（含页内 y 坐标）
        if (s.dest && app.pdfLinkService && app.pdfLinkService.goToDestination) {
          try { app.pdfLinkService.goToDestination(s.dest); return; } catch (e) {}
        }
        // ② 原生 pdf.js 翻页（currentPageNumber 为 1 基；app 已脱 Xray，可写）
        if (pg && pg > 0) {
          try { app.pdfViewer.currentPageNumber = pg; this.log("jumped via currentPageNumber"); return; } catch (e) { this.log("currentPageNumber: " + e); }
          try { app.page = pg; this.log("jumped via app.page"); return; } catch (e) {}
          try { app.pdfViewer.scrollPageIntoView({ pageNumber: pg }); this.log("jumped via scrollPageIntoView"); return; } catch (e) {}
        }
      }
      // ③ Zotero reader 官方导航兜底（0 基 pageIndex）
      if (pg && pg > 0 && reader && typeof reader.navigate === "function") {
        try { await reader.navigate({ pageIndex: pg - 1 }); this.log("jumped via reader.navigate"); return; } catch (e) { this.log("reader.navigate: " + e); }
      }
      // ④ 末路：按标题文本查找（仅文字层可读时有效）
      if (app && app.eventBus && s.title) {
        app.eventBus.dispatch("find", {
          source: null, type: "", query: String(s.title).slice(0, 40),
          caseSensitive: false, entireWord: false, highlightAll: true, findPrevious: false,
        });
      }
    } catch (e) {
      this.log("_readerJump: " + e);
    }
  },

  // ── 入口：处理当前选中条目 ──────────────────────────────
  async runOnSelected() {
    const pane = Zotero.getActiveZoteroPane();
    const win = Zotero.getMainWindow();
    const items = (pane ? pane.getSelectedItems() : []).filter((i) =>
      i.isRegularItem()
    );
    if (!items.length) {
      if (win) win.alert("请先选中至少一篇文献条目。");
      return;
    }

    // 检查 API Key（本地 Ollama / 自定义 不强制）
    if (this._needKey() && !this.pref("apiKey", "")) {
      if (win) win.alert("尚未填写 API Key。请到 设置 → Paper Outline 里填写。");
      return;
    }

    const pw = new Zotero.ProgressWindow({ closeOnClick: false });
    pw.changeHeadline("Paper Outline");
    pw.show();

    let ok = 0;
    for (const item of items) {
      const line = new pw.ItemProgress(
        item.getImageSrc?.() || "",
        (item.getField("title") || "(无标题)").slice(0, 40) + " …"
      );
      try {
        await this.summarize(item, line);
        line.setProgress(100);
        ok++;
      } catch (e) {
        this.log("summarize error: " + e);
        line.setError();
        line.setText("失败：" + String(e).slice(0, 80));
      }
    }
    pw.addDescription(`完成 ${ok}/${items.length}`);
    pw.startCloseTimer(4000);
  },

  // ── 单篇处理（菜单入口：生成 + 存笔记）────────────────────
  async summarize(item, line) {
    line?.setText("取 PDF 全文…");
    const outline = await this.generateOutline(item, (t) => line?.setText(t));
    const title = item.getField("title") || "未命名文献";
    if (this.pref("saveAsNote", false)) {
      line?.setText("写入笔记…");
      const html = this._renderNote(title, outline);
      const note = new Zotero.Item("note");
      note.libraryID = item.libraryID;
      note.parentID = item.id; // 挂成该条目的子笔记
      note.setNote(html);
      await note.saveTx();
    }
    return outline;
  },

  // ── 核心：取全文 → 分块并发调 AI → 合并目录（菜单/面板共用）──
  async generateOutline(item, onText, opts) {
    opts = opts || {};
    // opts.pagedText：带「===== 第 N 页 =====」标记的全文（阅读器面板传入，用于让 AI 标页码）
    // opts.att：指定 PDF 附件（阅读器面板传入当前打开的那个，避免多 PDF 时取错）
    let fullText = opts.pagedText || opts.fullText || "";
    if (!fullText) {
      const att = opts.att || (await this._resolveAttachment(item));
      if (!att || !att.isPDFAttachment()) {
        throw new Error("没有可用的 PDF 附件");
      }
      const bundle = await this._getTextBundleForItem(att, {
        allowOCR: opts.allowOCR,
        context: opts.context || "manual",
        onText,
      });
      if (bundle.pages && bundle.pages.length) {
        opts.pagedText = bundle.pages
          .map((text, index) => "\n\n===== 第 " + (index + 1) + " 页 =====\n" + text)
          .join("");
        fullText = opts.pagedText;
      } else {
        fullText = bundle.text || "";
      }
    }
    if (!fullText.trim()) {
      throw new Error("没有识别出可用的论文文字。");
    }

    // 系统提示：带页码标记时追加“标出每节起始页”的要求；并按设置控制识别层级深度
    let sys = this.pref("prompt", this.DEFAULT_PROMPT);
    if (opts.pagedText) sys += "\n\n" + this.PAGE_INSTRUCTION;
    const maxLevel = parseInt(this.pref("maxLevel", 0), 10) || 0;
    sys +=
      maxLevel > 0
        ? "\n\n只需识别到第 " + maxLevel + " 级标题（level 不超过 " + maxLevel + "）。"
        : "\n\n请尽量识别完整的层级结构，包含 (一)(二)(三)、1. 2.、(1)(2) 等各级小标题。";

    const maxChars = parseInt(this.pref("maxCharsPerChunk", 40000), 10) || 40000;
    const chunks = this._splitText(fullText, maxChars);
    const concurrency = parseInt(this.pref("concurrency", 5), 10) || 5;

    if (onText) onText(`AI 分析中（${chunks.length} 块 / 并发 ${concurrency}）…`);

    const partResults = await this._pool(chunks, concurrency, async (chunk, idx) => {
      const userMsg =
        chunks.length > 1
          ? `这是论文的第 ${idx + 1}/${chunks.length} 部分，请只就这部分输出目录条目：\n\n${chunk}`
          : `论文全文：\n\n${chunk}`;
      const raw = await this.callAI(sys, userMsg);
      return this._parseOutline(raw);
    });

    const outline = [];
    for (const part of partResults) {
      if (Array.isArray(part)) outline.push(...part);
    }
    if (!outline.length) throw new Error("AI 未返回有效目录");

    this._setCache(item.key, outline); // 缓存供阅读器面板读取
    return outline;
  },

  // 该文献下的所有 PDF 附件
  _pdfAttachments(item) {
    try {
      const ids = item.getAttachments ? item.getAttachments() : [];
      const out = [];
      for (const id of ids) {
        const a = Zotero.Items.get(id);
        if (a && a.isPDFAttachment && a.isPDFAttachment()) out.push(a);
      }
      return out;
    } catch (e) {
      return [];
    }
  },

  // 解析要用哪个 PDF：1 个直接用；多个让用户选；都没有则回退 getBestAttachment
  async _resolveAttachment(item) {
    const pdfs = this._pdfAttachments(item);
    if (pdfs.length === 1) return pdfs[0];
    if (pdfs.length > 1) {
      const picked = this._pickAttachment(pdfs);
      if (!picked) throw new Error("已取消选择 PDF。");
      return picked;
    }
    return await item.getBestAttachment();
  },

  _pickAttachment(pdfs) {
    try {
      const win = Zotero.getMainWindow();
      const labels = pdfs.map(
        (a, i) => i + 1 + ". " + (a.attachmentFilename || a.getField("title") || "PDF " + a.id)
      );
      const sel = {};
      const ok = Services.prompt.select(
        win,
        "选择 PDF",
        "该文献有多个 PDF 附件，选择要生成目录的一个：",
        labels,
        sel
      );
      return ok ? pdfs[sel.value] : null;
    } catch (e) {
      this.log("pickAttachment: " + e);
      return pdfs[0];
    }
  },

  // ── 阅读器面板专用：先读 PDF 自带书签，无则用 Zotero PDFWorker 抽全文走 AI ──────
  async _generateReaderOutline(item, reader, onText, forceAI) {
    if (!item) throw new Error("无法定位文献条目");
    if (!forceAI) {
      try {
        const emb = await this._getEmbeddedOutline(reader);
        if (emb && emb.length) {
          if (onText) onText("已读取 PDF 自带书签");
          this._setCache(item.key, emb);
          return emb;
        }
      } catch (e) {
        this.log("embedded outline: " + e);
      }
    }
    // 用 Zotero PDFWorker 抽每页文本（CID-aware，知网/扫描双层也能读）；带页码标记喂 AI，
    // 之后再用每页文本把标题精确定位到页（见 _fillPages）。worker 失败则回退 attachmentText。
    const att = (reader && reader._item) || (await this._resolveAttachment(item));
    let pages = null;
    try { pages = await this._getWorkerPages(att); } catch (e) { this.log("workerPages: " + e); }
    if (pages && !this._hasReadablePdfText(pages.join("\n"))) pages = null;
    const pagedText =
      pages && pages.length ? pages.map((t, i) => `\n\n===== 第 ${i + 1} 页 =====\n` + t).join("") : null;
    this.log("generateReaderOutline workerPages=" + (pages ? pages.length : "无"));
    const outline = await this.generateOutline(item, onText, { pagedText, att });
    if (outline && outline.length) {
      try {
        await this._fillPages(item, reader, outline, pages);
        this._setCache(item.key, outline);
      } catch (e) {
        this.log("fillPages: " + e);
      }
    }
    return outline;
  },

  // 用 Zotero PDFWorker 抽全文并按换页符 \f 切成每页文本（pdf.js 读不出的知网 PDF 也能读）
  async _getWorkerPages(att) {
    try {
      if (!att || !att.id || !Zotero.PDFWorker || !att.isPDFAttachment || !att.isPDFAttachment()) return null;
      const r = await Zotero.PDFWorker.getFullText(att.id, 500); // 上限 500 页，足够论文用
      const t = (r && r.text) || "";
      if (!t.trim()) return null;
      return t.split("\f"); // 每段 = 一页
    } catch (e) {
      this.log("getWorkerPages: " + e);
      return null;
    }
  },

  // 识别论文前部的印刷“目录/目次”页。此类页面会密集重复后文标题，
  // 如果按“第一次出现”定位，几乎所有章节都会被错误映射到首页。
  _detectPrintedContentsPages(pages, outline) {
    const norm = (s) => String(s || "").replace(/\s+/g, "");
    const probes = [];
    const seen = new Set();
    for (const s of outline || []) {
      const key = norm(s && s.title);
      if (key.length < 2) continue;
      const probe = key.slice(0, Math.min(18, key.length));
      if (!seen.has(probe)) {
        seen.add(probe);
        probes.push(probe);
      }
    }
    const detected = new Set();
    if (!pages || !pages.length || probes.length < 2) return detected;

    // 只检查文档前部，最多 12 页；正文中的章节回顾不会被误判成前置目录。
    const frontLimit = Math.min(
      pages.length,
      Math.min(12, Math.max(6, Math.ceil(pages.length * 0.2)))
    );
    const denseThreshold = Math.max(4, Math.min(8, Math.ceil(probes.length * 0.35)));
    let previousWasContents = false;
    for (let i = 0; i < frontLimit; i++) {
      const raw = String(pages[i] || "");
      const page = norm(raw);
      let matches = 0;
      for (const probe of probes) {
        if (page.includes(probe)) matches++;
      }
      const hasContentsHeading =
        /(?:^|[\r\n])\s*(?:目\s*录|目\s*次|contents)\s*(?:[\r\n]|$)/im.test(raw);
      const isContents =
        (hasContentsHeading && matches >= 2) ||
        matches >= denseThreshold ||
        (previousWasContents && matches >= 3);
      if (isContents) detected.add(i);
      previousWasContents = isContents;
    }
    return detected;
  },

  async _repairCachedOutlinePages(item, reader, doc) {
    const cached = item && this._getCache(item.key);
    if (!cached || cached.length < 2) return false;
    const att = (reader && reader._item) || (await this._resolveAttachment(item));
    const pages = await this._getWorkerPages(att);
    if (!pages || pages.length < 2) return false;
    const contentsPages = this._detectPrintedContentsPages(pages, cached);
    if (!contentsPages.size) return false;

    const badCount = cached.filter((s) => {
      const page = parseInt(s && s.page, 10);
      return page > 0 && contentsPages.has(page - 1);
    }).length;
    if (badCount < Math.max(2, Math.ceil(cached.length * 0.3))) return false;

    const repaired = cached.map((s) => Object.assign({}, s));
    await this._fillPages(item, reader, repaired, pages);
    const changed = repaired.some(
      (s, i) => parseInt(s.page, 10) !== parseInt(cached[i] && cached[i].page, 10)
    );
    if (!changed) return false;
    this._setCache(item.key, repaired);
    const host = doc && doc.getElementById("sidebarContent");
    if (host) this._renderReaderOutline(doc, host, item, reader);
    this.log("已自动修复旧缓存中的目录页跳转：" + item.key);
    return true;
  },

  // 给每个条目补页码：① 有 worker 每页文本 → 逐页精确定位标题（精确到页）；
  // ② 拿不到则按字符偏移比例估算；③ 单调非递减 + 继承，保证每一级（含子标题）都有页码。
  async _fillPages(item, reader, outline, pages) {
    const norm = (s) => String(s || "").replace(/\s+/g, "");
    if (!pages) {
      try {
        const att = (reader && reader._item) || (await this._resolveAttachment(item));
        pages = await this._getWorkerPages(att);
      } catch (e) {}
    }
    let numPages = pages && pages.length ? pages.length : 0;
    let contentsPages = new Set();
    let bodyStart = 0;

    if (pages && pages.length) {
      // —— 精确：跳过前置印刷目录页，再按目录顺序游标前进，避免短词和重复标题错位。——
      const np = pages.map(norm);
      contentsPages = this._detectPrintedContentsPages(pages, outline);
      if (contentsPages.size) bodyStart = Math.max(...Array.from(contentsPages)) + 1;
      let cursor = bodyStart,
        hit = 0;
      for (const s of outline) {
        const key = norm(s.title);
        if (key.length < 2) continue;
        const probe = key.slice(0, Math.min(18, key.length));
        let found = -1;
        for (let i = cursor; i < np.length; i++) {
          if (!contentsPages.has(i) && np[i].includes(probe)) { found = i; break; }
        }
        if (found < 0) {
          for (let i = bodyStart; i < np.length; i++) {
            if (!contentsPages.has(i) && np[i].includes(probe)) { found = i; break; }
          }
        }
        if (found >= 0) {
          s.page = found + 1; // 精确命中：覆盖 AI 的猜测
          cursor = found;
          hit++;
        }
      }
      this.log(
        "fillPages 精确命中=" + hit + "/" + outline.length +
        " 页数=" + numPages +
        " 排除目录页=" + Array.from(contentsPages).map((i) => i + 1).join(",")
      );
    } else {
      // —— 退化：worker 取不到（极少数）→ 按 attachmentText 字符偏移比例估算缺失的 ——
      let body = "";
      try {
        const att = (reader && reader._item) || (await item.getBestAttachment());
        body = norm((att && (await att.attachmentText)) || "");
      } catch (e) {}
      const app = this._getReaderApp(reader);
      numPages = (app && app.pdfDocument && app.pdfDocument.numPages) || 0;
      if (numPages && body.length >= 50) {
        let from = 0;
        for (const s of outline) {
          if (parseInt(s.page, 10) > 0) continue;
          const key = norm(s.title);
          let idx = -1;
          for (const k of [key, key.slice(0, 12), key.slice(0, 6)]) {
            if (k.length < 2) continue;
            idx = body.indexOf(k, from);
            if (idx < 0) idx = body.indexOf(k);
            if (idx >= 0) break;
          }
          if (idx >= 0) {
            from = idx + 1;
            s.page = Math.max(1, Math.min(numPages, Math.floor((idx / body.length) * numPages) + 1));
          }
        }
        this.log("fillPages 估算 页数=" + numPages);
      }
    }

    // 单调非递减 + 继承（目录顺序=文档顺序）→ 确保每条都有页码
    let last = bodyStart + 1;
    for (const s of outline) {
      let p = parseInt(s.page, 10);
      if (p > 0 && contentsPages.has(p - 1)) p = 0;
      if (!p || p < 1) p = last;
      if (p < last) p = last;
      if (numPages) p = Math.min(p, numPages);
      s.page = p;
      last = p;
    }
  },

  // 读取 PDF 内嵌目录（书签）。返回 [{level,title,summary:'',page,dest}] 或 null。
  async _getEmbeddedOutline(reader) {
    const app = this._getReaderApp(reader);
    if (!app || !app.pdfDocument) return null;
    const doc = app.pdfDocument;
    let raw = null;
    try {
      raw = await doc.getOutline();
    } catch (e) {
      return null;
    }
    if (!raw || !raw.length) return null;

    // dest（命名或显式数组）→ 1 基页码
    const destToPage = async (dest) => {
      try {
        let d = dest;
        if (typeof d === "string") d = await doc.getDestination(d);
        if (!Array.isArray(d) || !d[0]) return null;
        const ref = d[0];
        let idx = null;
        if (typeof ref === "number") idx = ref;
        else if (ref && typeof ref === "object") idx = await doc.getPageIndex(ref);
        return idx == null ? null : (idx | 0) + 1;
      } catch (e) {
        return null;
      }
    };

    const out = [];
    const walk = async (nodes, level) => {
      for (const n of nodes) {
        const title = (n.title || "").trim();
        if (title) {
          const page = await destToPage(n.dest);
          out.push({ level, title, summary: "", page: page, dest: n.dest || null });
        }
        if (n.items && n.items.length) await walk(n.items, level + 1);
      }
    };
    await walk(raw, 1);
    return out;
  },

  // ── 目录缓存（按 item.key 存进 Zotero 数据目录下的独立 JSON 文件，不再塞进偏好）──────
  // 内存里维护一份 _cache，读写都走它（同步接口不变）；写时异步落盘。
  _cache: {},
  _cacheLoaded: false,

  _cachePath() {
    try {
      return PathUtils.join(Zotero.DataDirectory.dir, "paper-outline-cache.json");
    } catch (e) {
      return null;
    }
  },

  // 启动时调用一次：从 JSON 文件载入；文件不存在则尝试从旧 prefs 缓存迁移过来。
  async _loadCache() {
    try {
      const p = this._cachePath();
      if (p && (await IOUtils.exists(p))) {
        this._cache = JSON.parse(await IOUtils.readUTF8(p)) || {};
      } else {
        const old = Zotero.Prefs.get("extensions.paperoutline.cache", true);
        if (old) {
          this._cache = JSON.parse(old) || {};
          await this._saveCacheFile();
          try { Zotero.Prefs.clear("extensions.paperoutline.cache", true); } catch (e) {}
          this.log("缓存已从 prefs 迁移到 " + p);
        }
      }
    } catch (e) {
      this.log("loadCache: " + e);
    }
    this._cacheLoaded = true;
  },

  async _saveCacheFile() {
    try {
      const p = this._cachePath();
      if (p) await IOUtils.writeUTF8(p, JSON.stringify(this._cache));
    } catch (e) {
      this.log("saveCacheFile: " + e);
    }
  },

  _getCache(key) {
    return (this._cache && this._cache[key]) || null;
  },

  _setCache(key, outline) {
    if (!this._cache) this._cache = {};
    this._cache[key] = outline;
    this._saveCacheFile(); // 异步落盘，不阻塞
  },

  _clearCache(key) {
    if (this._cache && key in this._cache) {
      delete this._cache[key];
      this._saveCacheFile();
    }
  },

  // 设置面板「清空所有目录缓存」按钮调用
  clearAllCacheUI() {
    try {
      const win = Zotero.getMainWindow();
      const n = Object.keys(this._cache || {}).length;
      if (!n) {
        win.alert("当前没有已缓存的目录。");
        return;
      }
      if (win.confirm("已缓存 " + n + " 篇论文的目录，确认全部清空？")) {
        this._cache = {};
        this._saveCacheFile();
        win.alert("已清空 " + n + " 篇目录缓存。");
      }
    } catch (e) {
      this.log("clearAllCacheUI: " + e);
    }
  },

  // ── 拼装笔记 HTML（按 level 缩进）───────────────────────
  _renderNote(title, outline) {
    const esc = (s) =>
      String(s || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    const rows = outline
      .map((s) => {
        const lv = Math.max(1, Math.min(6, parseInt(s.level, 10) || 1));
        const indent = (lv - 1) * 22;
        return (
          `<p style="margin:2px 0 2px ${indent}px">` +
          `<b>${esc(s.title)}</b>` +
          (s.summary ? `<br/><span>${esc(s.summary)}</span>` : "") +
          `</p>`
        );
      })
      .join("\n");
    return (
      `<h1>📑 ${esc(title)} — AI 目录摘要</h1>` +
      `<p><i>由 Paper Outline 生成</i></p>\n${rows}`
    );
  },

  // ── AI 服务商预设（全部走 OpenAI 兼容 /chat/completions；Ollama 用其 /v1 兼容端点）──
  // 选定服务商即用其默认 URL/模型；用户在设置里填的 apiUrl/model 非空则覆盖（自定义服务商必填）。
  PROVIDERS: {
    deepseek:    { label: "DeepSeek（默认）",          url: "https://api.deepseek.com/chat/completions",                          model: "deepseek-v4-flash",       json: true },
    openai:      { label: "OpenAI",                     url: "https://api.openai.com/v1/chat/completions",                         model: "gpt-4o-mini",             json: true },
    moonshot:    { label: "月之暗面 Kimi",              url: "https://api.moonshot.cn/v1/chat/completions",                        model: "moonshot-v1-8k",          json: true },
    zhipu:       { label: "智谱 GLM",                   url: "https://open.bigmodel.cn/api/paas/v4/chat/completions",              model: "glm-4-flash",             json: true },
    qwen:        { label: "通义千问 Qwen",              url: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", model: "qwen-plus",               json: true },
    siliconflow: { label: "硅基流动 SiliconFlow",       url: "https://api.siliconflow.cn/v1/chat/completions",                     model: "deepseek-ai/DeepSeek-V3", json: true },
    ollama:      { label: "本地 Ollama",                url: "http://localhost:11434/v1/chat/completions",                         model: "qwen2.5",                 json: false },
    custom:      { label: "自定义（手填 URL / 模型）",   url: "",                                                                   model: "",                        json: false },
  },

  MODEL_PREFERENCES: {
    deepseek:    [/flash/i, /chat/i, /deepseek/i, /pro/i],
    openai:      [/^gpt-4o-mini$/i, /^gpt-4\.1-mini$/i, /^gpt-4o$/i, /^gpt-4\.1$/i, /^gpt-/i],
    moonshot:    [/moonshot.*8k/i, /moonshot/i, /kimi/i],
    zhipu:       [/glm-4-flash/i, /glm-4/i, /glm/i],
    qwen:        [/qwen-plus/i, /qwen.*turbo/i, /qwen/i],
    siliconflow: [/deepseek.*v3/i, /deepseek/i, /qwen/i],
    ollama:      [/qwen/i, /llama/i, /mistral/i],
    custom:      [],
  },

  _resolveAI(overrides) {
    overrides = overrides || {};
    const has = (key) => Object.prototype.hasOwnProperty.call(overrides, key);
    const p = has("provider") ? overrides.provider : this.pref("provider", "deepseek");
    const preset = this.PROVIDERS[p] || this.PROVIDERS.deepseek;
    const customUrl = has("url") ? overrides.url : this.pref("apiUrl", "");
    const customModel = has("model") ? overrides.model : this.pref("model", "");
    const customKey = has("key") ? overrides.key : this.pref("apiKey", "");
    const url = (customUrl || "").trim() || preset.url;
    const model = (customModel || "").trim() || preset.model;
    const key = (customKey || "").trim();
    return {
      provider: p,
      label: preset.label,
      url,
      model,
      key,
      json: preset.json,
      modelIsCustom: !!(customModel || "").trim(),
    };
  },

  _modelsURL(chatURL) {
    const clean = String(chatURL || "").trim().split(/[?#]/)[0].replace(/\/+$/, "");
    if (!clean) return "";
    if (/\/chat\/completions$/i.test(clean)) {
      return clean.replace(/\/chat\/completions$/i, "/models");
    }
    return "";
  },

  _chooseAvailableModel(provider, ids, fallback) {
    const models = (ids || [])
      .map((id) => String(id || "").trim())
      .filter(Boolean);
    if (!models.length) return fallback || "";
    if (fallback && models.includes(fallback)) return fallback;

    const usable = models.filter((id) =>
      !/(embedding|rerank|whisper|speech|tts|moderation|image|dall-e)/i.test(id)
    );
    const candidates = usable.length ? usable : models;
    const preferences = this.MODEL_PREFERENCES[provider] || [];
    for (const pattern of preferences) {
      const match = candidates.find((id) => pattern.test(id));
      if (match) return match;
    }
    return candidates[0];
  },

  async _discoverModel(config, force) {
    if (!config || config.modelIsCustom) return config && config.model;
    const modelsURL = this._modelsURL(config.url);
    if (!modelsURL) return config.model;

    this._modelDiscoveryCache = this._modelDiscoveryCache || new Map();
    const cacheKey = config.provider + "|" + modelsURL;
    if (!force && this._modelDiscoveryCache.has(cacheKey)) {
      return this._modelDiscoveryCache.get(cacheKey);
    }

    try {
      const headers = {};
      if (config.key) headers.Authorization = "Bearer " + config.key;
      const xhr = await Zotero.HTTP.request("GET", modelsURL, {
        headers,
        responseType: "text",
        timeout: 20000,
      });
      const result = JSON.parse(xhr.responseText);
      const ids = Array.isArray(result.data)
        ? result.data.map((item) => item && item.id).filter(Boolean)
        : [];
      const selected = this._chooseAvailableModel(config.provider, ids, config.model);
      if (selected) {
        this._modelDiscoveryCache.set(cacheKey, selected);
        return selected;
      }
    } catch (e) {
      this.log("model discovery failed, using fallback: " + e);
    }
    return config.model;
  },

  async _prepareAI(overrides, forceDiscovery) {
    const config = this._resolveAI(overrides);
    if (!config.modelIsCustom) {
      config.model = await this._discoverModel(config, !!forceDiscovery);
    }
    return config;
  },

  _isModelError(error) {
    const status = (error && error.status) || 0;
    const text = String(
      (error && error.body) || (error && error.message) || error || ""
    ).toLowerCase();
    return (
      (status === 400 || status === 404 || text.includes("model")) &&
      (text.includes("model") || text.includes("supported api"))
    );
  },

  // 是否需要 API Key（本地 Ollama / 自定义 不强制）
  _needKey(provider) {
    const p = provider || this.pref("provider", "deepseek");
    return p !== "ollama" && p !== "custom";
  },

  getMineruTokenStatus(overrides) {
    overrides = overrides || {};
    const token = String(
      overrides.token !== undefined ? overrides.token : this.pref("mineruToken", "")
    ).trim();
    if (!token) {
      return {
        configured: false,
        state: "missing",
        daysLeft: 0,
        expiresAt: 0,
        dateText: "",
      };
    }

    let savedAt = parseInt(this.pref("mineruTokenSavedAt", "0"), 10) || 0;
    if (!savedAt) {
      savedAt = Date.now();
      try {
        Zotero.Prefs.set(
          "extensions.paperoutline.mineruTokenSavedAt",
          String(savedAt),
          true
        );
      } catch (e) {}
    }
    const expiresAt = savedAt + this.MINERU_TOKEN_DAYS * 24 * 60 * 60 * 1000;
    const daysLeft = Math.max(
      0,
      Math.ceil((expiresAt - Date.now()) / (24 * 60 * 60 * 1000))
    );
    const apiMarkedExpired =
      this.pref("mineruTokenExpired", false) === true ||
      String(this.pref("mineruTokenExpired", false)) === "true";
    const state =
      apiMarkedExpired || Date.now() >= expiresAt
        ? "expired"
        : daysLeft <= this.MINERU_WARNING_DAYS
          ? "warning"
          : "valid";
    return {
      configured: true,
      state,
      daysLeft,
      savedAt,
      expiresAt,
      dateText: this._formatDate(expiresAt),
    };
  },

  _formatDate(timestamp) {
    const date = new Date(timestamp);
    const pad = (value) => String(value).padStart(2, "0");
    return (
      date.getFullYear() +
      "-" +
      pad(date.getMonth() + 1) +
      "-" +
      pad(date.getDate())
    );
  },

  _scheduleMineruExpiryReminder() {
    const showReminder = () => {
      try {
        const status = this.getMineruTokenStatus();
        if (!status.configured || status.state === "valid") return;
        const last = parseInt(this.pref("mineruExpiryReminderAt", "0"), 10) || 0;
        const interval =
          status.state === "expired" ? 3 * 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
        if (last && Date.now() - last < interval) return;

        if (status.state === "expired") {
          this._toast(
            "MinerU Token 需要更新",
            "Token 可能已到期。重新创建并替换后，扫描 PDF 才能继续识别。"
          );
        } else {
          this._toast(
            "MinerU Token 即将到期",
            "按保存时间估算还剩 " +
              status.daysLeft +
              " 天，请在到期后重新创建 Token。"
          );
        }
        Zotero.Prefs.set(
          "extensions.paperoutline.mineruExpiryReminderAt",
          String(Date.now()),
          true
        );
      } catch (e) {
        this.log("mineru expiry reminder: " + e);
      }
    };

    try {
      this.cancelMineruExpiryReminder();
      const win = Zotero.getMainWindow && Zotero.getMainWindow();
      const timerHost = win && win.setTimeout ? win : globalThis;
      const schedule = (delay) => {
        const id = timerHost.setTimeout(() => {
          showReminder();
          schedule(24 * 60 * 60 * 1000);
        }, delay);
        this._mineruReminderTimer = { timerHost, id };
      };
      schedule(3500);
    } catch (e) {}
  },

  cancelMineruExpiryReminder() {
    try {
      const timer = this._mineruReminderTimer;
      if (timer && timer.timerHost && timer.timerHost.clearTimeout) {
        timer.timerHost.clearTimeout(timer.id);
      }
    } catch (e) {}
    this._mineruReminderTimer = null;
  },

  openMineruTokenPage() {
    Zotero.launchURL(this.MINERU_TOKEN_URL);
  },

  async openSettings() {
    try {
      if (
        Zotero.Utilities &&
        Zotero.Utilities.Internal &&
        typeof Zotero.Utilities.Internal.openPreferences === "function"
      ) {
        await Zotero.Utilities.Internal.openPreferences(this.id);
        return true;
      }
    } catch (e) {
      this.log("open preferences: " + e);
    }
    try {
      const win = Zotero.getMainWindow();
      if (win && typeof win.openPreferences === "function") {
        win.openPreferences(this.id);
        return true;
      }
    } catch (e) {}
    try {
      if (
        Zotero.Utilities &&
        Zotero.Utilities.Internal &&
        typeof Zotero.Utilities.Internal.openPreferences === "function"
      ) {
        await Zotero.Utilities.Internal.openPreferences();
        return true;
      }
    } catch (e) {}
    return false;
  },

  _mineruAuthHeaders(token) {
    return { Authorization: "Bearer " + String(token || "").trim() };
  },

  _parseMineruResponse(text) {
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch (e) {
      return {};
    }
  },

  _mineruErrorMessage(code, message, status) {
    const key = String(code === undefined || code === null ? "" : code);
    if (key === "A0202" || status === 401 || status === 403) {
      return "MinerU Token 无效，请检查是否完整复制。";
    }
    if (key === "A0211") {
      return "MinerU Token 已到期，请重新创建并替换。";
    }
    if (key === "-60005") return "这份 PDF 超过 MinerU 当前允许的文件大小。";
    if (key === "-60006") return "这份 PDF 页数超过 MinerU 当前允许的范围。";
    if (key === "-60009") return "MinerU 当前任务较多，请稍后再试。";
    if (key === "-60018") return "今天的 MinerU 识别额度已用完，请明天再试。";
    if (key === "-60012") return "没有找到这次识别任务，请重新发起。";
    if (key === "-60013") return "识别结果已过期，请重新发起。";
    if (status === 429) return "MinerU 请求较多，请稍后再试。";
    if (status >= 500) return "MinerU 服务暂时不可用，请稍后再试。";
    const brief = String(message || "").replace(/\s+/g, " ").trim().slice(0, 120);
    return brief ? "MinerU 识别失败：" + brief : "MinerU 识别失败，请稍后再试。";
  },

  _markMineruExpired(expired) {
    try {
      Zotero.Prefs.set("extensions.paperoutline.mineruTokenExpired", !!expired, true);
    } catch (e) {}
  },

  async _mineruJSONRequest(method, url, options) {
    options = options || {};
    let xhr;
    try {
      xhr = await Zotero.HTTP.request(method, url, {
        headers: options.headers || {},
        body: options.body,
        responseType: "text",
        timeout: options.timeout || 60000,
      });
    } catch (error) {
      const raw =
        (error && error.xmlhttp && error.xmlhttp.responseText) ||
        (error && error.message) ||
        "";
      const parsed = this._parseMineruResponse(raw);
      const status =
        (error && error.xmlhttp && error.xmlhttp.status) || (error && error.status) || 0;
      const code =
        parsed.code !== undefined && parsed.code !== null ? parsed.code : parsed.msgCode;
      if (String(code) === "A0211") this._markMineruExpired(true);
      if (
        options.acceptNonAuthError &&
        status !== 401 &&
        status !== 403 &&
        String(code) !== "A0202" &&
        String(code) !== "A0211"
      ) {
        return parsed;
      }
      throw new Error(this._mineruErrorMessage(code, parsed.msg || raw, status));
    }

    const parsed = this._parseMineruResponse(xhr.responseText);
    const code =
      parsed.code !== undefined && parsed.code !== null ? parsed.code : parsed.msgCode;
    if (String(code) === "A0211") this._markMineruExpired(true);
    if (String(code) === "A0202" || String(code) === "A0211") {
      throw new Error(this._mineruErrorMessage(code, parsed.msg, xhr.status || 0));
    }
    if (
      !options.acceptNonAuthError &&
      code !== undefined &&
      code !== null &&
      String(code) !== "0" &&
      String(code).toLowerCase() !== "success"
    ) {
      throw new Error(this._mineruErrorMessage(code, parsed.msg, xhr.status || 0));
    }
    return parsed;
  },

  async testMineruConnection(overrides) {
    overrides = overrides || {};
    const token = String(
      overrides.token !== undefined ? overrides.token : this.pref("mineruToken", "")
    ).trim();
    if (!token) throw new Error("请先填写 MinerU Token。");

    await this._mineruJSONRequest(
      "GET",
      this.MINERU_API_BASE + "/extract-results/batch/paper-outline-connection-check",
      {
        headers: this._mineruAuthHeaders(token),
        timeout: 30000,
        acceptNonAuthError: true,
      }
    );
    this._markMineruExpired(false);
    const status = this.getMineruTokenStatus({ token });
    return { dateText: status.dateText, daysLeft: status.daysLeft };
  },

  // 设置页「测试连接」：走与正式生成相同的 chat/completions 请求链，仅发送极短消息。
  async testConnection(overrides) {
    const config = await this._prepareAI(overrides, true);
    if (!config.url) throw new Error("请先填写 API URL。");
    if (!config.model) throw new Error("没有发现可用模型，请填写模型名称后重试。");
    if (this._needKey(config.provider) && !config.key) {
      throw new Error("请先填写 API Key。");
    }

    const headers = {};
    if (config.key) headers.Authorization = "Bearer " + config.key;
    const startedAt = Date.now();
    const payload = {
      model: config.model,
      stream: false,
      messages: [{ role: "user", content: "Reply only with OK." }],
      temperature: 0,
      max_tokens: 32,
    };
    // DeepSeek V4 默认开启思考模式；短测试若不关闭，输出额度可能全被 reasoning_content 占用。
    if (config.provider === "deepseek") {
      payload.thinking = { type: "disabled" };
    }
    const result = await this._post(
      config.url,
      headers,
      payload,
      { timeout: 30000 }
    );
    const choice = result.choices && result.choices[0];
    const message = (choice && choice.message) || result.message;
    if (!message || typeof message !== "object") {
      throw new Error("接口已连接，但返回格式不是标准的对话结果。请检查接口地址是否兼容 chat/completions。");
    }
    return {
      provider: config.provider,
      label: config.label,
      model: config.model,
      elapsed: Date.now() - startedAt,
    };
  },

  // ── AI 调用：所有服务商统一走 OpenAI 兼容 /chat/completions ───────────────
  // opts.json：是否要求 JSON 输出（目录=true；整篇总结=false，要纯文本）。不传则按服务商预设。
  async callAI(systemPrompt, userPrompt, opts) {
    opts = opts || {};
    let config = await this._prepareAI();
    let { url, model, key, json } = config;
    if (!url) throw new Error("未配置 API URL（自定义服务商需在设置里填写）");
    const headers = {};
    if (key) headers.Authorization = "Bearer " + key;
    const payload = {
      model,
      stream: false,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.2,
    };
    const useJson = opts.json !== undefined ? opts.json : json;
    if (useJson) payload.response_format = { type: "json_object" }; // 多数服务商支持；不支持的预设里关掉
    let j;
    try {
      j = await this._post(url, headers, payload);
    } catch (error) {
      if (config.modelIsCustom || !this._isModelError(error)) throw error;
      const refreshed = await this._prepareAI(null, true);
      if (!refreshed.model || refreshed.model === model) throw error;
      config = refreshed;
      model = refreshed.model;
      payload.model = model;
      j = await this._post(url, headers, payload);
    }
    return (
      (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) ||
      (j.message && j.message.content) ||
      ""
    );
  },

  // 统一的 HTTP POST（用 Zotero.HTTP.request，特权环境、不受网页 CORS 限制）
  async _post(url, headers, payload, options) {
    options = options || {};
    let xhr;
    try {
      xhr = await Zotero.HTTP.request("POST", url, {
        headers: Object.assign({ "Content-Type": "application/json" }, headers || {}),
        body: JSON.stringify(payload),
        responseType: "text",
        timeout: options.timeout || 180000,
      });
    } catch (e) {
      const error = new Error(this._friendlyError(e));
      error.status = (e && e.xmlhttp && e.xmlhttp.status) || (e && e.status) || 0;
      error.body = ((e && e.xmlhttp && e.xmlhttp.responseText) || (e && e.message) || "").toString();
      throw error;
    }
    try {
      return JSON.parse(xhr.responseText);
    } catch (e) {
      throw new Error("接口已响应，但返回的不是有效 JSON。请检查 API URL 是否为 chat/completions 地址。");
    }
  },

  // 把底层报错翻译成人话
  _friendlyError(e) {
    const status = (e && e.xmlhttp && e.xmlhttp.status) || (e && e.status) || 0;
    const body = ((e && e.xmlhttp && e.xmlhttp.responseText) || (e && e.message) || "").toString();
    const low = body.toLowerCase();
    if (low.includes("supported api model names") ||
        low.includes("model not found") ||
        low.includes("no such model"))
      return "服务商已调整可用模型。请把“模型”栏留空后重新测试，插件会自动查询当前可用模型。";
    if (status === 401 || low.includes("invalid api key") || low.includes("incorrect api key") ||
        low.includes("authentication") || low.includes("unauthorized"))
      return "API Key 无效，请检查是否填写正确（设置 → AI 接口 → API Key）。";
    if (status === 402 || low.includes("insufficient") || low.includes("balance") ||
        low.includes("欠费") || low.includes("quota") || low.includes("exceeded"))
      return "账户余额 / 额度不足，请到所选服务商充值后再试。";
    if (status === 429 || low.includes("rate limit") || low.includes("too many"))
      return "请求过于频繁（被限流）。可把「高级 → 并发数」调小，或稍后再试。";
    if (status === 404 || low.includes("no such model") || low.includes("model not") || low.includes("not found"))
      return "接口地址或模型名不对（404）：检查服务商 / 模型名 /（高级里的）API URL。";
    if (status === 0 || low.includes("networkerror") || low.includes("timeout") ||
        low.includes("timed out") || low.includes("offline") || low.includes("connection"))
      return "网络连接失败：请检查网络 / 代理，或 API 地址是否可访问。";
    if (status >= 500) return "服务商服务器出错（HTTP " + status + "），请稍后再试。";
    const snip = body.replace(/\s+/g, " ").slice(0, 160);
    return "调用失败" + (status ? "（HTTP " + status + "）" : "") + (snip ? "：" + snip : "");
  },

  // ── 工具函数 ────────────────────────────────────────────
  // 把 AI 返回的 JSON 文本解析成 outline 数组（容错）
  _parseOutline(raw) {
    if (!raw) return [];
    let txt = String(raw).trim();
    // 去掉可能的 ```json ``` 包裹
    txt = txt.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    try {
      const obj = JSON.parse(txt);
      if (Array.isArray(obj)) return obj;
      if (Array.isArray(obj.outline)) return obj.outline;
    } catch (e) {
      // 兜底：从文本里抠出第一个 { ... } 或 [ ... ]
      const m = txt.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
      if (m) {
        try {
          const obj = JSON.parse(m[0]);
          return Array.isArray(obj) ? obj : obj.outline || [];
        } catch (_) {}
      }
    }
    this.log("parseOutline 失败，原文：" + txt.slice(0, 300));
    return [];
  },

  // 按字符数把长文切块，尽量在换行处断开
  _splitText(text, maxChars) {
    if (text.length <= maxChars) return [text];
    const chunks = [];
    let i = 0;
    while (i < text.length) {
      let end = Math.min(i + maxChars, text.length);
      if (end < text.length) {
        const nl = text.lastIndexOf("\n", end);
        if (nl > i + maxChars * 0.5) end = nl;
      }
      chunks.push(text.slice(i, end));
      i = end;
    }
    return chunks;
  },

  // 并发池：limit 路并发执行 fn(item, index)
  async _pool(items, limit, fn) {
    const results = new Array(items.length);
    let cursor = 0;
    const worker = async () => {
      while (cursor < items.length) {
        const idx = cursor++;
        try {
          results[idx] = await fn(items[idx], idx);
        } catch (e) {
          this.log("pool task error: " + e);
          results[idx] = [];
        }
      }
    };
    const n = Math.max(1, Math.min(limit, items.length));
    await Promise.all(Array.from({ length: n }, worker));
    return results;
  },

  // 延时（Zotero 的 bluebird Promise.delay；退化到 setTimeout）
  _sleep(ms) {
    try {
      return Zotero.Promise.delay(ms);
    } catch (e) {
      return new Promise((r) => {
        try {
          Zotero.getMainWindow().setTimeout(r, ms);
        } catch (e2) {
          setTimeout(r, ms);
        }
      });
    }
  },

  // ════════════════════════════════════════════════════════════════
  //  整篇总结（新功能）：通读全文 → 一段概括性中文总结 → 存为子笔记
  // ════════════════════════════════════════════════════════════════

  // 取该条目最合适的 PDF（不弹选择框，供自动/总结用；多 PDF 取第一个）
  async _bestPdf(item) {
    const pdfs = this._pdfAttachments(item);
    if (pdfs.length) return pdfs[0];
    try {
      const a = await item.getBestAttachment();
      if (a && a.isPDFAttachment && a.isPDFAttachment()) return a;
    } catch (e) {}
    return null;
  },

  _hasReadablePdfText(text) {
    const compact = String(text || "").replace(/\s+/g, "");
    const meaningful = compact.replace(
      /[^\p{L}\p{N}\u3400-\u9fff]/gu,
      ""
    );
    return meaningful.length >= 80;
  },

  _confirmMineru(title, message) {
    try {
      return Services.prompt.confirm(Zotero.getMainWindow(), title, message);
    } catch (e) {
      try {
        return Zotero.getMainWindow().confirm(message);
      } catch (e2) {
        return false;
      }
    }
  },

  async _ensureMineruReady() {
    const token = String(this.pref("mineruToken", "") || "").trim();
    if (!token) {
      const open = this._confirmMineru(
        "扫描 PDF 需要文字识别",
        "这份 PDF 没有可读取的文字，Paper Outline 需要先用 MinerU 识别页面内容，才能继续生成总结和目录。\n\n尚未设置 MinerU Token。是否现在打开设置？"
      );
      if (open) await this.openSettings();
      throw new Error("扫描 PDF 需要先设置 MinerU Token。");
    }

    const status = this.getMineruTokenStatus({ token });
    if (status.state === "expired") {
      const open = this._confirmMineru(
        "MinerU Token 需要更新",
        "MinerU Token 有效期为 90 天，当前 Token 可能已到期。请重新创建后回到设置中替换。\n\n是否现在前往 MinerU？"
      );
      if (open) this.openMineruTokenPage();
      throw new Error("MinerU Token 可能已到期，请重新创建并替换。");
    }

    const autoUpload =
      this.pref("mineruAutoUpload", false) === true ||
      String(this.pref("mineruAutoUpload", false)) === "true";
    if (!autoUpload) {
      const confirmed = this._confirmMineru(
        "上传扫描 PDF 进行识别",
        "这份 PDF 没有可读取的文字。继续后，当前 PDF 会发送至 MinerU 完成文字识别，识别结果将用于生成总结和目录。\n\n是否上传并继续？"
      );
      if (!confirmed) throw new Error("已取消上传扫描 PDF。");
    }
    return token;
  },

  async _attachmentFilePath(att) {
    let path = "";
    try {
      path = att.getFilePath();
    } catch (e) {}
    if (!path) {
      try {
        path = await att.getFilePathAsync();
      } catch (e) {}
    }
    if (!path || !(await IOUtils.exists(path))) {
      throw new Error("找不到这份 PDF 的本地文件。");
    }
    return path;
  },

  _mineruUploadError(status, responseText) {
    const body = String(responseText || "");
    const codeMatch = body.match(/<Code>\s*([^<]+)\s*<\/Code>/i);
    const code = codeMatch ? codeMatch[1].trim() : "";
    if (status === 413 || code === "EntityTooLarge") {
      return "这份 PDF 超过 MinerU 当前允许的文件大小。";
    }
    if (code === "RequestTimeTooSkewed") {
      return "电脑时间与网络时间相差较大，请校准系统时间后重试。";
    }
    if (
      status === 403 ||
      code === "SignatureDoesNotMatch" ||
      code === "AccessDenied" ||
      code === "InvalidAccessKeyId"
    ) {
      return (
        "MinerU 未接受这次上传" +
        (status ? "（HTTP " + status + (code ? " / " + code : "") + "）" : "") +
        "，请重新发起；如果仍然失败，请检查网络或代理。"
      );
    }
    if (status === 400) {
      return (
        "MinerU 认为上传请求不完整" +
        (code ? "（" + code + "）" : "") +
        "，请重新发起。"
      );
    }
    if (status === 0) return "PDF 上传失败，请检查网络或代理后重试。";
    return (
      "PDF 上传失败" +
      (status ? "（HTTP " + status + (code ? " / " + code : "") + "）" : "") +
      "，请稍后重试。"
    );
  },

  async _uploadMineruFile(uploadUrl, path) {
    const bytes = await IOUtils.read(path);
    // MinerU 的临时上传地址明确要求不要设置 Content-Type。
    // Zotero.HTTP.request() 会在有请求体时自动补上该请求头，因此这里直接使用原生 XHR。
    return await new Promise((resolve, reject) => {
      let xhr;
      try {
        xhr = new XMLHttpRequest({ mozAnon: true });
        xhr.mozBackgroundRequest = true;
        xhr.open("PUT", uploadUrl, true);
        xhr.responseType = "text";
        xhr.timeout = 10 * 60 * 1000;
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve();
            return;
          }
          const error = new Error(
            this._mineruUploadError(xhr.status, xhr.responseText)
          );
          error.status = xhr.status;
          reject(error);
        };
        xhr.onerror = () => {
          const error = new Error(
            this._mineruUploadError(xhr.status || 0, xhr.responseText)
          );
          error.status = xhr.status || 0;
          reject(error);
        };
        xhr.ontimeout = () => reject(new Error("PDF 上传超时，请检查网络后重试。"));
        xhr.onabort = () => reject(new Error("PDF 上传已取消。"));
        xhr.send(bytes);
      } catch (error) {
        reject(
          new Error(
            this._mineruUploadError(
              (xhr && xhr.status) || 0,
              (xhr && xhr.responseText) || (error && error.message)
            )
          )
        );
      }
    });
  },

  async _waitForMineruResult(batchID, token, onText) {
    const deadline = Date.now() + 20 * 60 * 1000;
    while (Date.now() < deadline) {
      const result = await this._mineruJSONRequest(
        "GET",
        this.MINERU_API_BASE + "/extract-results/batch/" + encodeURIComponent(batchID),
        {
          headers: this._mineruAuthHeaders(token),
          timeout: 60000,
        }
      );
      const tasks =
        (result.data && (result.data.extract_result || result.data.extract_results)) || [];
      const task = tasks[0];
      if (!task) {
        await this._sleep(3000);
        continue;
      }

      const state = String(task.state || task.status || "").toLowerCase();
      if (state === "done" || state === "success") {
        const zipUrl = task.full_zip_url || task.fullZipUrl;
        if (!zipUrl) throw new Error("MinerU 已完成识别，但没有返回可用结果。");
        return zipUrl;
      }
      if (state === "failed" || state === "error") {
        throw new Error(
          this._mineruErrorMessage(task.err_code, task.err_msg || task.error, 0)
        );
      }

      if (onText) {
        const progress = task.extract_progress || task.progress || {};
        const current =
          progress.extracted_pages || progress.current_page || progress.current || 0;
        const total = progress.total_pages || progress.total || 0;
        onText(
          current && total
            ? "MinerU 正在识别扫描页（" + current + "/" + total + "）…"
            : "MinerU 正在识别扫描页…"
        );
      }
      await this._sleep(3000);
    }
    throw new Error("MinerU 识别等待时间较长，请稍后重试。");
  },

  _localFile(path) {
    const file = Components.classes["@mozilla.org/file/local;1"].createInstance(
      Components.interfaces.nsIFile
    );
    file.initWithPath(path);
    return file;
  },

  _mineruBlockText(block) {
    if (block === null || block === undefined) return "";
    if (typeof block === "string" || typeof block === "number") return String(block);
    if (Array.isArray(block)) {
      return block
        .map((value) => this._mineruBlockText(value))
        .filter(Boolean)
        .join("\n");
    }

    for (const key of ["text", "content", "latex", "html"]) {
      if (typeof block[key] === "string" && block[key].trim()) return block[key].trim();
    }
    for (const key of [
      "blocks",
      "children",
      "para_blocks",
      "body",
      "caption",
      "img_caption",
      "table_caption",
    ]) {
      if (block[key]) {
        const text = this._mineruBlockText(block[key]);
        if (text.trim()) return text.trim();
      }
    }
    return "";
  },

  _mineruPagesFromContentList(content, fallbackText) {
    const pageMap = new Map();
    const visit = (value, inheritedPage) => {
      if (value === null || value === undefined) return;
      if (Array.isArray(value)) {
        for (const child of value) visit(child, inheritedPage);
        return;
      }
      if (typeof value !== "object") return;

      let page = value.page_idx;
      if (page === undefined || page === null) page = value.page_index;
      if (page === undefined || page === null) page = inheritedPage;
      if (page !== undefined && page !== null) {
        const text = this._mineruBlockText(value);
        if (text.trim()) {
          const index = Math.max(0, parseInt(page, 10) || 0);
          const list = pageMap.get(index) || [];
          list.push(text.trim());
          pageMap.set(index, list);
          return;
        }
      }

      for (const key of ["pages", "blocks", "children", "para_blocks", "body"]) {
        if (value[key]) visit(value[key], page);
      }
    };
    visit(content, undefined);

    if (!pageMap.size) return fallbackText ? [String(fallbackText)] : [];
    const maxPage = Math.max(...pageMap.keys());
    const pages = [];
    for (let index = 0; index <= maxPage; index++) {
      const values = pageMap.get(index) || [];
      pages.push([...new Set(values)].join("\n\n"));
    }
    return pages;
  },

  async _readMineruZip(arrayBuffer) {
    const nonce = Date.now() + "-" + Math.random().toString(16).slice(2);
    const zipPath = PathUtils.join(PathUtils.tempDir, "paper-outline-mineru-" + nonce + ".zip");
    const extracted = [];
    let reader = null;
    try {
      const bytes =
        arrayBuffer instanceof Uint8Array ? arrayBuffer : new Uint8Array(arrayBuffer);
      await IOUtils.write(zipPath, bytes);
      reader = Components.classes["@mozilla.org/libjar/zip-reader;1"].createInstance(
        Components.interfaces.nsIZipReader
      );
      reader.open(this._localFile(zipPath));

      const entries = [];
      const enumeration = reader.findEntries("*");
      while (enumeration.hasMore()) entries.push(enumeration.getNext());
      const markdownEntry =
        entries.find((name) => /(^|\/)full\.md$/i.test(name)) ||
        entries.find((name) => /\.md$/i.test(name));
      const contentEntry =
        entries.find(
          (name) => /_content_list\.json$/i.test(name) && !/_content_list_v2\.json$/i.test(name)
        ) ||
        entries.find((name) => /_content_list_v2\.json$/i.test(name)) ||
        entries.find((name) => /content.*\.json$/i.test(name));

      if (!markdownEntry) throw new Error("MinerU 结果中没有找到识别后的正文。");
      const extractEntry = async (entry, suffix) => {
        const target = PathUtils.join(
          PathUtils.tempDir,
          "paper-outline-mineru-" + nonce + suffix
        );
        reader.extract(entry, this._localFile(target));
        extracted.push(target);
        return await IOUtils.readUTF8(target);
      };

      const markdown = await extractEntry(markdownEntry, ".md");
      let content = null;
      if (contentEntry) {
        try {
          content = JSON.parse(await extractEntry(contentEntry, ".json"));
        } catch (e) {
          this.log("parse MinerU content list: " + e);
        }
      }
      const pages = this._mineruPagesFromContentList(content, markdown);
      return { text: markdown, pages };
    } finally {
      try {
        if (reader) reader.close();
      } catch (e) {}
      for (const path of extracted) {
        try {
          await IOUtils.remove(path);
        } catch (e) {}
      }
      try {
        await IOUtils.remove(zipPath);
      } catch (e) {}
    }
  },

  _mineruDownloadBody(xhr) {
    try {
      if (xhr && xhr.response) {
        return new TextDecoder("utf-8").decode(new Uint8Array(xhr.response));
      }
    } catch (e) {}
    return "";
  },

  _mineruDownloadError(status, responseText) {
    const body = String(responseText || "");
    const codeMatch = body.match(/<Code>\s*([^<]+)\s*<\/Code>/i);
    const code = codeMatch ? codeMatch[1].trim() : "";
    const suffix =
      status || code
        ? "（" +
          (status ? "HTTP " + status : "") +
          (status && code ? " / " : "") +
          (code || "") +
          "）"
        : "";
    if (status === 401 || status === 403) {
      return "MinerU 识别结果链接已失效或被拒绝" + suffix + "，请重新生成。";
    }
    if (status === 404 || code === "NoSuchKey") {
      return "MinerU 识别结果已过期或不存在" + suffix + "，请重新生成。";
    }
    if (status === 429) {
      return "MinerU 结果下载请求较多" + suffix + "，请稍后重试。";
    }
    if (status >= 500) {
      return "MinerU 结果服务器暂时不可用" + suffix + "，请稍后重试。";
    }
    if (status === 0) {
      return "无法连接 MinerU 结果服务器，请检查网络或代理后重试。";
    }
    return "识别结果下载失败" + suffix + "，请稍后重试。";
  },

  _downloadMineruBytes(zipUrl) {
    // 结果位于 MinerU CDN。使用匿名原生 XHR，避免携带 Zotero 的 Cookie 或附加请求头。
    return new Promise((resolve, reject) => {
      let xhr;
      const fail = (status, message, retryable) => {
        const error = new Error(
          message || this._mineruDownloadError(status, this._mineruDownloadBody(xhr))
        );
        error.status = status || 0;
        error.retryable = !!retryable;
        reject(error);
      };
      try {
        xhr = new XMLHttpRequest({ mozAnon: true });
        xhr.mozBackgroundRequest = true;
        xhr.open("GET", zipUrl, true);
        xhr.responseType = "arraybuffer";
        xhr.timeout = 10 * 60 * 1000;
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300 && xhr.response) {
            resolve(xhr.response);
            return;
          }
          const retryable =
            xhr.status === 0 ||
            xhr.status === 408 ||
            xhr.status === 429 ||
            xhr.status >= 500;
          fail(xhr.status, "", retryable);
        };
        xhr.onerror = () => fail(xhr.status || 0, "", true);
        xhr.ontimeout = () =>
          fail(0, "MinerU 识别结果下载超时，请检查网络后重试。", true);
        xhr.onabort = () => fail(0, "MinerU 识别结果下载已取消。", false);
        xhr.send();
      } catch (error) {
        fail(
          (xhr && xhr.status) || 0,
          this._mineruDownloadError(
            (xhr && xhr.status) || 0,
            (error && error.message) || ""
          ),
          true
        );
      }
    });
  },

  async _downloadMineruResult(zipUrl, onText) {
    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const data = await this._downloadMineruBytes(zipUrl);
        if (!data || !data.byteLength) {
          throw new Error("MinerU 返回了空的识别结果，请重新生成。");
        }
        return await this._readMineruZip(data);
      } catch (error) {
        lastError = error;
        if (!error.retryable || attempt >= 3) break;
        if (onText) {
          onText("MinerU 结果暂时无法取回，正在重试（" + attempt + "/2）…");
        }
        await this._sleep(attempt * 2000);
      }
    }
    throw lastError || new Error("识别结果下载失败，请稍后重试。");
  },

  async _recognizeWithMineru(att, opts) {
    opts = opts || {};
    if (!this._mineruTextCache) this._mineruTextCache = new Map();
    const cacheKey = String(att && (att.id || att.key || att.attachmentFilename));
    if (this._mineruTextCache.has(cacheKey)) {
      return this._mineruTextCache.get(cacheKey);
    }

    const token = await this._ensureMineruReady();
    const path = await this._attachmentFilePath(att);
    const filename =
      att.attachmentFilename ||
      (typeof PathUtils.filename === "function" ? PathUtils.filename(path) : "paper.pdf");
    if (opts.onText) opts.onText("正在准备扫描 PDF…");
    const created = await this._mineruJSONRequest(
      "POST",
      this.MINERU_API_BASE + "/file-urls/batch",
      {
        headers: Object.assign(
          { "Content-Type": "application/json" },
          this._mineruAuthHeaders(token)
        ),
        body: JSON.stringify({
          files: [
            {
              name: filename,
              data_id: cacheKey,
              is_ocr: true,
            },
          ],
          model_version: "vlm",
          enable_formula: true,
          enable_table: true,
          language: "ch",
        }),
        timeout: 60000,
      }
    );
    const data = created.data || {};
    const batchID = data.batch_id || data.batchId;
    const uploadUrls = data.file_urls || data.fileUrls || [];
    const uploadUrl =
      (uploadUrls[0] && (uploadUrls[0].url || uploadUrls[0].file_url)) || uploadUrls[0];
    if (!batchID || !uploadUrl) {
      throw new Error("MinerU 没有返回上传地址，请稍后重试。");
    }

    if (opts.onText) opts.onText("正在上传扫描 PDF 至 MinerU…");
    await this._uploadMineruFile(uploadUrl, path);
    const zipUrl = await this._waitForMineruResult(batchID, token, opts.onText);
    if (opts.onText) opts.onText("正在读取识别结果…");
    const result = await this._downloadMineruResult(zipUrl, opts.onText);
    if (!result.text || !result.text.trim()) {
      throw new Error("MinerU 已完成识别，但没有识别出可用文字。");
    }
    this._mineruTextCache.set(cacheKey, result);
    return result;
  },

  async _getTextBundleForItem(att, opts) {
    opts = opts || {};
    if (!att) return { text: "", pages: null, source: "empty" };
    try {
      const pages = await this._getWorkerPages(att);
      if (pages && pages.length) {
        const t = pages.join("\n");
        if (this._hasReadablePdfText(t)) {
          return { text: t, pages, source: "local" };
        }
      }
    } catch (e) {}
    try {
      const t = (await att.attachmentText) || "";
      if (this._hasReadablePdfText(t)) {
        return { text: t, pages: null, source: "local" };
      }
    } catch (e) {}
    if (opts.allowOCR === false) return { text: "", pages: null, source: "empty" };
    const recognized = await this._recognizeWithMineru(att, opts);
    return {
      text: recognized.text,
      pages: recognized.pages,
      source: "mineru",
    };
  },

  // 取附件全文：优先读取 PDF 自带文字；扫描件按设置交给 MinerU 识别。
  async _getFullTextForItem(att, opts) {
    const bundle = await this._getTextBundleForItem(att, opts);
    return bundle.text || "";
  },

  // 总结只需代表性内容：超长则取首段(70%)+尾段(30%)，覆盖引言与结论
  _textForSummary(fullText, maxChars) {
    const t = String(fullText || "");
    if (t.length <= maxChars) return t;
    const head = Math.floor(maxChars * 0.7);
    const tail = maxChars - head;
    return t.slice(0, head) + "\n\n……（中略）……\n\n" + t.slice(t.length - tail);
  },

  // 生成整篇总结文本（opts.fullText 已有则复用，避免重复抽取；opts.att 指定 PDF）
  async generateSummary(item, onText, opts) {
    opts = opts || {};
    let full = opts.fullText;
    if (!full) {
      const att = opts.att || (await this._bestPdf(item));
      if (!att || !att.isPDFAttachment()) throw new Error("没有可用的 PDF 附件");
      if (onText) onText("取 PDF 全文…");
      full = await this._getFullTextForItem(att, {
        context: opts.context || "manual",
        onText,
      });
    }
    if (!full || !full.trim()) throw new Error("没有识别出可用的论文文字。");
    const text = this._textForSummary(full, this.SUMMARY_MAX_CHARS);
    const sys = this.pref("summaryPrompt", this.SUMMARY_PROMPT);
    if (onText) onText("AI 总结中…");
    const out = await this.callAI(sys, "论文标题：" + (item.getField("title") || "") + "\n\n论文全文：\n\n" + text, { json: false });
    const summary = String(out || "").trim();
    if (!summary) throw new Error("AI 未返回总结内容");
    return summary;
  },

  // 拼装总结笔记 HTML（含 SUMMARY_MARKER 供去重识别）。总结正文走轻量 Markdown→HTML。
  _renderSummaryNote(title, summary) {
    const esc = (s) =>
      String(s || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    return (
      `<h1>📝 ${esc(title)} — AI 总结</h1>` +
      `<p style="color:#888"><i>${esc(this.SUMMARY_MARKER)}</i></p>` +
      this._mdToNoteHtml(summary)
    );
  },

  // 轻量 Markdown→HTML（供总结笔记用）：支持 #/##/### 标题、- * 无序列表、1. 有序列表、**加粗**。
  // 先转义 HTML 实体，再在转义后的文本上套标记，安全且足够覆盖 AI 的常见 Markdown 输出。
  _mdToNoteHtml(md) {
    const esc = (s) =>
      String(s || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    const inline = (s) =>
      esc(s)
        .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
        .replace(/__([^_\n]+)__/g, "<strong>$1</strong>");
    const lines = String(md || "").replace(/\r\n?/g, "\n").split("\n");
    const out = [];
    let list = null; // "ul" | "ol"
    const closeList = () => {
      if (list) {
        out.push("</" + list + ">");
        list = null;
      }
    };
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) {
        closeList();
        continue;
      }
      let m;
      if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
        closeList();
        // # → h2，## → h3，### 及更深 → h4（笔记标题已占 h1）。
        // 显式字号 + 下限 14px：避免深层标题用默认 h4/h5/h6 渲染得比正文还小、视觉骤降。
        const lvl = Math.min(4, m[1].length + 1);
        const size = { 2: "17px", 3: "15px", 4: "14px" }[lvl];
        const weight = lvl >= 4 ? "600" : "700";
        out.push(
          "<h" + lvl + ' style="font-size:' + size + ";font-weight:" + weight + ';margin:12px 0 4px;">' +
            inline(m[2]) +
            "</h" + lvl + ">"
        );
        continue;
      }
      if ((m = line.match(/^(?:[-*]|•|·)\s+(.*)$/))) {
        if (list !== "ul") {
          closeList();
          out.push("<ul>");
          list = "ul";
        }
        out.push("<li>" + inline(m[1]) + "</li>");
        continue;
      }
      if ((m = line.match(/^\d+[.、)]\s+(.*)$/))) {
        if (list !== "ol") {
          closeList();
          out.push("<ol>");
          list = "ol";
        }
        out.push("<li>" + inline(m[1]) + "</li>");
        continue;
      }
      closeList();
      out.push("<p>" + inline(line) + "</p>");
    }
    closeList();
    return out.join("") || "<p>" + esc(md) + "</p>";
  },

  // 查该条目下是否已有本插件生成的总结笔记（按 SUMMARY_MARKER）
  _findSummaryNote(item) {
    try {
      const ids = item.getNotes ? item.getNotes() : [];
      for (const id of ids) {
        const n = Zotero.Items.get(id);
        const html = n && n.getNote ? n.getNote() : "";
        if (html && html.indexOf(this.SUMMARY_MARKER) >= 0) return n;
      }
    } catch (e) {
      this.log("_findSummaryNote: " + e);
    }
    return null;
  },

  // 写入/更新总结子笔记。opts.force=true：已存在则覆盖（手动重做）；否则已存在就跳过（自动）
  async _saveSummaryNote(item, summary, opts) {
    opts = opts || {};
    const existing = this._findSummaryNote(item);
    if (existing && !opts.force) return existing;
    const html = this._renderSummaryNote(item.getField("title") || "未命名文献", summary);
    if (existing) {
      existing.setNote(html);
      await existing.saveTx();
      return existing;
    }
    const note = new Zotero.Item("note");
    note.libraryID = item.libraryID;
    note.parentID = item.id;
    note.setNote(html);
    await note.saveTx();
    return note;
  },

  // 菜单入口：对选中条目生成整篇总结并存笔记（手动：已有则覆盖）
  async runSummaryOnSelected() {
    const pane = Zotero.getActiveZoteroPane();
    const win = Zotero.getMainWindow();
    const items = (pane ? pane.getSelectedItems() : []).filter((i) => i.isRegularItem());
    if (!items.length) {
      if (win) win.alert("请先选中至少一篇文献条目。");
      return;
    }
    if (this._needKey() && !this.pref("apiKey", "")) {
      if (win) win.alert("尚未填写 API Key。请到 设置 → Paper Outline 里填写。");
      return;
    }
    const pw = new Zotero.ProgressWindow({ closeOnClick: false });
    pw.changeHeadline("Paper Outline · 整篇总结");
    pw.show();
    let ok = 0;
    for (const item of items) {
      const line = new pw.ItemProgress(
        item.getImageSrc?.() || "",
        (item.getField("title") || "(无标题)").slice(0, 40) + " …"
      );
      try {
        const summary = await this.generateSummary(item, (t) => line.setText(t));
        await this._saveSummaryNote(item, summary, { force: true });
        line.setText("已写入总结笔记");
        line.setProgress(100);
        ok++;
      } catch (e) {
        this.log("summary error: " + e);
        line.setError();
        line.setText("失败：" + String(e).slice(0, 80));
      }
    }
    pw.addDescription(`完成 ${ok}/${items.length}`);
    pw.startCloseTimer(4000);
  },

  // ── 自动模式下生成目录（无 reader）：worker 抽页 → AI → 补页码 → 缓存 ──
  async _buildOutlineAuto(item, att, onText) {
    const bundle = await this._getTextBundleForItem(att, {
      context: "auto",
      onText,
    });
    const pages = bundle.pages;
    const pagedText =
      pages && pages.length
        ? pages.map((t, i) => `\n\n===== 第 ${i + 1} 页 =====\n` + t).join("")
        : null;
    const outline = await this.generateOutline(item, onText, {
      pagedText,
      fullText: bundle.text,
      att,
      context: "auto",
    });
    if (outline && outline.length) {
      try {
        await this._fillPages(item, null, outline, pages);
        this._setCache(item.key, outline);
      } catch (e) {
        this.log("_buildOutlineAuto fillPages: " + e);
      }
    }
    return outline;
  },

  // ════════════════════════════════════════════════════════════════
  //  入库自动处理：监听条目 add 事件 → 队列限流 → 自动总结 / 目录
  // ════════════════════════════════════════════════════════════════
  _notifierID: null,
  _autoQueue: [],
  _autoSet: null,
  _autoRunning: false,

  _autoOutlineOn() {
    return this.pref("autoOutline", true) !== false;
  },
  _autoSummaryOn() {
    return this.pref("autoSummary", true) !== false;
  },

  registerAutoObserver() {
    try {
      if (this._notifierID) return;
      const self = this;
      this._notifierID = Zotero.Notifier.registerObserver(
        {
          notify(event, type, ids, extraData) {
            try {
              self._onNotify(event, type, ids);
            } catch (e) {
              self.log("notify: " + e);
            }
          },
        },
        ["item"],
        "paperoutline-auto"
      );
      this.log("auto observer registered");
    } catch (e) {
      this.log("registerAutoObserver: " + e);
    }
  },

  unregisterAutoObserver() {
    try {
      if (this._notifierID) {
        Zotero.Notifier.unregisterObserver(this._notifierID);
        this._notifierID = null;
      }
    } catch (e) {
      this.log("unregisterAutoObserver: " + e);
    }
  },

  // 仅在 PDF 附件被新增时触发（→ 其父文献条目）。覆盖浏览器抓取 / 拖入 PDF / 按 DOI 添加等。
  _onNotify(event, type, ids) {
    if (event !== "add") return;
    if (!this._autoOutlineOn() && !this._autoSummaryOn()) return; // 两个开关都关 = 不监听
    if (this._needKey() && !this.pref("apiKey", "")) return; // 没配 Key 不打扰
    const parents = new Set();
    for (const id of ids || []) {
      try {
        const it = Zotero.Items.get(id);
        if (!it || (it.isFeedItem && it.isFeedItem())) continue; // 跳过 RSS feed 条目
        if (it.isPDFAttachment && it.isPDFAttachment() && it.parentItemID) {
          const p = Zotero.Items.get(it.parentItemID);
          if (p && p.isRegularItem && p.isRegularItem()) parents.add(p.id);
        }
      } catch (e) {}
    }
    for (const pid of parents) this._enqueueAuto(pid);
  },

  _enqueueAuto(itemID) {
    if (!this._autoSet) this._autoSet = new Set();
    if (this._autoSet.has(itemID)) return;
    this._autoSet.add(itemID);
    this._autoQueue.push(itemID);
    this._drainAuto();
  },

  // 顺序处理队列（一次一篇 + 篇间停顿），避免批量导入时并发狂刷 API
  async _drainAuto() {
    if (this._autoRunning) return;
    this._autoRunning = true;
    try {
      while (this._autoQueue.length) {
        const id = this._autoQueue.shift();
        try {
          await this._autoProcess(id);
        } catch (e) {
          this.log("auto process " + id + ": " + e);
        }
        if (this._autoSet) this._autoSet.delete(id);
        await this._sleep(1200);
      }
    } finally {
      this._autoRunning = false;
    }
  },

  async _autoProcess(itemID) {
    const item = Zotero.Items.get(itemID);
    if (!item || !item.isRegularItem()) return;
    const wantOutline = this._autoOutlineOn();
    const wantSummary = this._autoSummaryOn();
    if (!wantOutline && !wantSummary) return;
    if (this._needKey() && !this.pref("apiKey", "")) return;

    const att = await this._bestPdf(item);
    if (!att) return; // 没 PDF（可能还没下完）→ 等下次（再加 PDF 会再触发）

    // 等正文就绪：刚入库时文件可能还在写入/抽取，重试几次
    let full = "";
    for (let i = 0; i < 4; i++) {
      full = await this._getFullTextForItem(att, { allowOCR: false });
      if (full.trim()) break;
      await this._sleep(3000);
    }
    if (!full.trim()) {
      full = await this._getFullTextForItem(att, { context: "auto" });
    }
    if (!full.trim()) return;

    const did = [];
    if (wantSummary) {
      try {
        if (!this._findSummaryNote(item)) {
          const summary = await this.generateSummary(item, null, { att, fullText: full });
          await this._saveSummaryNote(item, summary, {});
          did.push("总结");
        }
      } catch (e) {
        this.log("auto summary " + item.key + ": " + e);
      }
    }
    if (wantOutline) {
      try {
        if (!this._getCache(item.key)) {
          const o = await this._buildOutlineAuto(item, att, null);
          if (o && o.length) did.push("目录");
        }
      } catch (e) {
        this.log("auto outline " + item.key + ": " + e);
      }
    }
    if (did.length) this._autoToast(item, did);
  },

  _autoToast(item, did) {
    try {
      const pw = new Zotero.ProgressWindow();
      pw.changeHeadline("Paper Outline · 自动");
      const ip = new pw.ItemProgress(
        item.getImageSrc?.() || "",
        (item.getField("title") || "").slice(0, 32)
      );
      ip.setProgress(100);
      pw.show();
      pw.addDescription("已生成：" + did.join(" + "));
      pw.startCloseTimer(3500);
    } catch (e) {}
  },

  // ════════════════════════════════════════════════════════════════
  //  去除文字空格 —— 中文 PDF 复制后字间空格清理，纯规则、不用 AI
  //  阅读器工具栏放一个「粉色小猫」图标：点它 = 读剪贴板 → 清理 → 写回
  //  开关在「设置 → 高级选项 → 去除文字空格」，默认开（帮助里全称含「（小崔定制）」）
  // ════════════════════════════════════════════════════════════════
  DESPACE_BTN_ID: "paper-outline-despace-btn",
  ANNOT_BTN_ID: "paper-outline-despace-annot-bar",
  READER_INFO_ID: "paper-outline-reader-info",
  READER_INFO_TEXT_ID: "paper-outline-reader-info-text",
  READER_INFO_COPY_ID: "paper-outline-reader-info-copy",

  // 读取当前 PDF 对应条目的「题名 - 作者 - 年份」，与 Zotero 标签页提示信息保持一致。
  _getReaderInfoText(reader) {
    try {
      const att = reader && reader._item;
      const item = (att && att.parentItem) || att;
      if (!item) return "";
      const getField = (field, ...args) => {
        try {
          return typeof item.getField === "function" ? item.getField(field, ...args) : "";
        } catch (e) {
          return "";
        }
      };
      const tidy = (value) => String(value || "").replace(/\s+/g, " ").trim();
      let title = tidy(getField("title"));
      if (!title && typeof item.getDisplayTitle === "function") {
        try { title = tidy(item.getDisplayTitle()); } catch (e) {}
      }
      const creator = tidy(getField("firstCreator") || item.firstCreator);
      const date = tidy(getField("date", true, true) || getField("date"));
      const yearMatch = date.match(/(?:^|\D)((?:1[5-9]|20|21)\d{2})(?=\D|$)/);
      const year = yearMatch && yearMatch[1] !== "0000" ? yearMatch[1] : "";
      return [title, creator, year].filter(Boolean).join(" - ");
    } catch (e) {
      this.log("getReaderInfoText: " + e);
      return "";
    }
  },

  copyReaderInfo(reader) {
    try {
      const text = this._getReaderInfoText(reader);
      if (!text) {
        this._toast("文献信息 · 无法复制", "当前 PDF 没有可用的题名、作者或年份");
        return "";
      }
      const UI = Zotero.Utilities && Zotero.Utilities.Internal;
      if (!UI || typeof UI.copyTextToClipboard !== "function") {
        throw new Error("剪贴板接口不可用");
      }
      UI.copyTextToClipboard(text);
      this._toast("文献信息 · 已复制", text);
      return text;
    } catch (e) {
      this.log("copyReaderInfo: " + e);
      this._toast("文献信息 · 复制失败", String(e));
      return "";
    }
  },

  _makeReaderInfoPanel(doc, reader) {
    const panel = doc.createElement("div");
    panel.id = this.READER_INFO_ID;
    panel.style.cssText =
      "height:26px;display:flex;align-items:center;box-sizing:border-box;overflow:hidden;" +
      "flex:0 1 310px;min-width:150px;max-width:min(310px,30vw);margin-left:4px;" +
      "border:1px solid var(--fill-quarternary,#d5d5d5);border-radius:7px;" +
      "background:var(--material-sidepane,rgba(255,255,255,.78));color:var(--fill-primary,#333);";

    const text = doc.createElement("span");
    text.id = this.READER_INFO_TEXT_ID;
    text.style.cssText =
      "min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" +
      "padding:0 8px;font-size:12px;line-height:24px;user-select:text;";

    const copy = doc.createElement("button");
    copy.id = this.READER_INFO_COPY_ID;
    copy.setAttribute("type", "button");
    copy.setAttribute("tabindex", "-1");
    copy.setAttribute("aria-label", "复制当前文献信息");
    copy.style.cssText =
      "height:24px;flex:none;display:inline-flex;align-items:center;gap:4px;padding:0 8px;" +
      "border:0;border-left:1px solid var(--fill-quarternary,#d5d5d5);border-radius:0 6px 6px 0;" +
      "background:transparent;color:var(--accent-blue,#2e7dd1);font-size:11.5px;cursor:pointer;";
    copy.innerHTML =
      '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
      '<rect x="5.2" y="4.8" width="7.3" height="8" rx="1.4" stroke="currentColor" stroke-width="1.35"/>' +
      '<path d="M10.4 4.8V3.6c0-.8-.6-1.4-1.4-1.4H4.1c-.8 0-1.4.6-1.4 1.4v6.1c0 .8.6 1.4 1.4 1.4h1.1" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/>' +
      '</svg><span>复制</span>';
    copy.addEventListener("mouseenter", () => { if (!copy.disabled) copy.style.background = "rgba(46,125,209,.10)"; });
    copy.addEventListener("mouseleave", () => { copy.style.background = "transparent"; });
    copy.addEventListener("click", (event) => {
      try { event.preventDefault(); event.stopPropagation(); } catch (e) {}
      PaperOutline.copyReaderInfo(reader);
    });

    panel.appendChild(text);
    panel.appendChild(copy);
    this._updateReaderInfoPanel(panel, reader);
    return panel;
  },

  _updateReaderInfoPanel(panel, reader) {
    if (!panel) return;
    const text = this._getReaderInfoText(reader);
    const shown = text || "当前 PDF 无可复制的题录信息";
    const label = panel.querySelector && panel.querySelector("#" + this.READER_INFO_TEXT_ID);
    const copy = panel.querySelector && panel.querySelector("#" + this.READER_INFO_COPY_ID);
    if (label) {
      label.textContent = shown;
      label.setAttribute("title", shown);
    }
    panel.setAttribute("title", shown);
    if (copy) {
      copy.disabled = !text;
      copy.style.opacity = text ? "1" : ".45";
      copy.style.cursor = text ? "pointer" : "default";
      copy.setAttribute("title", text ? "复制：" + text : "当前 PDF 无可复制的题录信息");
    }
  },

  _injectReaderInfoPanel(event) {
    const doc = event && event.doc;
    const reader = event && event.reader;
    if (!doc) return;
    let panel = doc.getElementById(this.READER_INFO_ID);
    if (!panel) panel = this._makeReaderInfoPanel(doc, reader);
    else this._updateReaderInfoPanel(panel, reader);

    const center = doc.querySelector(".center.tools") || doc.querySelector(".toolbar .center");
    if (center) {
      const cat = doc.getElementById(this.DESPACE_BTN_ID);
      const before = cat && cat.parentNode === center ? cat.nextSibling : center.firstChild;
      if (panel.parentNode === center && before === panel) return;
      center.insertBefore(panel, before);
      return;
    }

    const cat = doc.getElementById(this.DESPACE_BTN_ID);
    if (cat && cat.parentNode) {
      if (panel.parentNode === cat.parentNode && cat.nextSibling === panel) return;
      cat.parentNode.insertBefore(panel, cat.nextSibling);
      return;
    }
    const anchor = doc.getElementById("numPages") || doc.getElementById("pageNumber");
    if (anchor && anchor.parentNode) {
      anchor.parentNode.insertBefore(panel, anchor.nextSibling);
    } else if (typeof event.append === "function") {
      event.append(panel);
    }
  },

  // 核心：去掉中文之间、以及中文与英文/数字之间的多余空白。中英之间不留空格。
  cleanSpaces(text) {
    if (text == null) return text;
    let s = String(text).replace(/\r\n?/g, "\n");
    s = s.replace(/[   ]/g, " "); // 不间断空格 / 数字空格 → 普通空格
    // 全角空格 / 不间断空格 → 普通空格，统一处理
    s = s.replace(/[ 　]/g, " ");
    // CJK 字符范围（中日韩文字、假名、各类中文标点、全角/半角符号）
    const C =
      "\\u2E80-\\u2EFF\\u3000-\\u303F\\u3040-\\u30FF\\u31C0-\\u31EF\\u31F0-\\u31FF" +
      "\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF\\uFE30-\\uFE4F\\uFF00-\\uFFEF";
    // 1) 中文 ↔ 中文 之间的空格/制表符 → 删除
    s = s.replace(new RegExp("(?<=[" + C + "])[ \\t]+(?=[" + C + "])", "g"), "");
    // 2) 中文 ↔ 英文/数字 之间的空格 → 删除（中英不留空格）
    s = s.replace(new RegExp("(?<=[" + C + "])[ \\t]+(?=[A-Za-z0-9])", "g"), "");
    s = s.replace(new RegExp("(?<=[A-Za-z0-9])[ \\t]+(?=[" + C + "])", "g"), "");
    // 3) 中文行尾因 PDF 换行产生的【单个换行】并回上一行（保留空行＝段落分隔）
    s = s.replace(new RegExp("(?<=[" + C + "])\\n(?!\\n)(?=[" + C + "])", "g"), "");
    // 4) 英文内部 2+ 连续空格压成一个（保住英文单词之间的真空格）
    s = s.replace(/[ \t]{2,}/g, " ");
    // 5) 去掉每行首尾多余空格
    s = s.replace(/[ \t]+$/gm, "").replace(/^[ \t]+/gm, "");
    return s.trim();
  },

  // 顶部小提示（复用 Zotero ProgressWindow）
  _toast(title, desc) {
    try {
      const pw = new Zotero.ProgressWindow();
      pw.changeHeadline(title);
      pw.show();
      if (desc) pw.addDescription(desc);
      pw.startCloseTimer(2500);
    } catch (e) {}
  },
  _despaceToast(headline, desc) { this._toast("去除文字空格 · " + headline, desc); },
  _cfToast(headline, desc) { this._toast("复制 PDF 文件 · " + headline, desc); },

  // 方案A 动作：读剪贴板 → 清理 → 写回
  cleanClipboardSpaces() {
    try {
      const UI = Zotero.Utilities.Internal;
      let txt = UI.getClipboard("text/plain");
      if (txt == null) { try { txt = UI.getClipboard("text/unicode"); } catch (e) {} }
      if (txt == null || txt === "") {
        this._despaceToast("剪贴板为空", "请先复制文字，再点这个图标");
        return;
      }
      const cleaned = this.cleanSpaces(txt);
      if (cleaned === txt) {
        this._despaceToast("无需处理", "没有发现多余空格");
        return;
      }
      UI.copyTextToClipboard(cleaned);
      const removed = txt.length - cleaned.length;
      this._despaceToast("已清理", "去掉了 " + removed + " 处空白，直接粘贴即可");
    } catch (e) {
      this.log("cleanClipboardSpaces: " + e);
      this._despaceToast("出错", String(e));
    }
  },

  // 统一的小猫图标：轮廓更清楚，在浅色/深色工具栏上都保持辨识度。
  _catIconSVG(size) {
    const px = parseInt(size, 10) || 20;
    return (
      '<svg width="' + px + '" height="' + px + '" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
      '<path d="M5.3 9.2 4.7 4.6l4.35 2.48A8.7 8.7 0 0 1 12 6.55c1.06 0 2.05.18 2.95.53L19.3 4.6l-.6 4.6c.92 1.06 1.42 2.4 1.42 3.82 0 4-3.5 6.58-8.12 6.58S3.88 17.02 3.88 13.02c0-1.42.5-2.76 1.42-3.82Z" fill="#FF86C2" stroke="#D9438E" stroke-width="1.35" stroke-linejoin="round"/>' +
      '<path d="m6.15 6.48 1.92 1.1-1.66.94-.26-2.04Zm11.7 0-1.92 1.1 1.66.94.26-2.04Z" fill="#FFD3E8"/>' +
      '<circle cx="8.75" cy="12.45" r=".95" fill="#57354A"/><circle cx="15.25" cy="12.45" r=".95" fill="#57354A"/>' +
      '<path d="m11.05 14.45.95.72.95-.72" stroke="#B52F78" stroke-width="1.15" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<path d="M12 15.2c-.55.82-1.5 1.03-2.27.46M12 15.2c.55.82 1.5 1.03 2.27.46M7.8 14.65l-2.3-.25m2.42 1.22-2.17.47m10.45-1.44 2.3-.25m-2.42 1.22 2.17.47" stroke="#8F5476" stroke-width=".75" stroke-linecap="round"/>' +
      '</svg>'
    );
  },

  // 造一个工具栏按钮：新版粉色小猫图标（醒目）
  _makeDespaceButton(doc) {
    const btn = doc.createElement("button");
    btn.id = this.DESPACE_BTN_ID;
    btn.className = "toolbar-button";
    btn.setAttribute("title", "去除文字空格：点我清理刚复制的文字");
    btn.setAttribute("tabindex", "-1");
    btn.innerHTML = this._catIconSVG(20);
    btn.addEventListener("click", (e) => {
      try { e.preventDefault(); e.stopPropagation(); } catch (er) {}
      PaperOutline.cleanClipboardSpaces();
    });
    return btn;
  },

  // 把按钮放到中间标注工具组(.center.tools)最前面 —— 用户选定的「中间」位置（标注工具左边）。
  // .center 随工具栏一起渲染，比 #numPages 早且稳，首次渲染即可就位、无需等待。
  _injectDespaceButton(event) {
    const doc = event && event.doc;
    if (!doc) return;
    let existing = doc.getElementById(this.DESPACE_BTN_ID);
    if (!this.pref("despaceButton", true)) { if (existing) existing.remove(); return; } // 关掉则移除
    const center = doc.querySelector(".center.tools") || doc.querySelector(".toolbar .center");
    if (center) {
      // 已在中间组最前 → 稳定，别动（React 重渲后本监听会再触发、自动补回）
      if (existing && existing.parentNode === center && center.firstElementChild === existing) return;
      if (existing) { existing.remove(); existing = null; } // 位置不对就先摘掉再放
      center.insertBefore(this._makeDespaceButton(doc), center.firstChild); // 放中间组最前
      return;
    }
    // 中间组还没渲染：先临时放页码后；下次 .center 出现会被上面分支归位
    if (existing) return;
    const anchor = doc.getElementById("numPages") || doc.getElementById("pageNumber");
    if (anchor && anchor.parentNode) {
      anchor.parentNode.insertBefore(this._makeDespaceButton(doc), anchor.nextSibling);
    } else if (typeof event.append === "function") {
      event.append(this._makeDespaceButton(doc));
    }
  },

  // 一键清理：把本 PDF 所有标注里的空格去掉（高亮/下划线的文字 + 任意标注的批注），直接改存标注
  async cleanAllAnnotations(reader) {
    try {
      const att = reader && reader._item;
      if (!att || typeof att.getAnnotations !== "function") {
        this._despaceToast("没找到标注", "请在打开的 PDF 阅读器里使用");
        return;
      }
      let annots = [];
      try { annots = att.getAnnotations() || []; } catch (e) { this.log("getAnnotations: " + e); }
      if (!annots.length) { this._despaceToast("没有标注", "本 PDF 暂无标注"); return; }
      // 预扫：算出哪些需要改（只改真的有多余空格的）
      const targets = [];
      for (const a of annots) {
        let nt = null, nc = null;
        const type = a.annotationType;
        if ((type === "highlight" || type === "underline") && a.annotationText) {
          const c = this.cleanSpaces(a.annotationText);
          if (c !== a.annotationText) nt = c;
        }
        if (a.annotationComment) {
          const c = this.cleanSpaces(a.annotationComment);
          if (c !== a.annotationComment) nc = c;
        }
        if (nt != null || nc != null) targets.push({ a, nt, nc });
      }
      if (!targets.length) { this._despaceToast("无需处理", "标注里没有多余空格"); return; }
      let n = 0;
      for (const t of targets) {
        try {
          if (t.nt != null) t.a.annotationText = t.nt;
          if (t.nc != null) t.a.annotationComment = t.nc;
          await t.a.saveTx();
          n++;
        } catch (e) { this.log("clean annot save: " + e); }
      }
      this._despaceToast("标注已清理", "处理了 " + n + " / " + targets.length + " 条标注");
    } catch (e) {
      this.log("cleanAllAnnotations: " + e);
      this._despaceToast("出错", String(e));
    }
  },

  // 在标注栏（注释列表 #annotations）顶部注入「去除全部标注空格」按钮（粉色小猫）
  _injectAnnotCleanButton(event) {
    if (!this.pref("despaceButton", true)) return;
    const doc = event && event.doc;
    if (!doc) return;
    if (doc.getElementById(this.ANNOT_BTN_ID)) return; // 幂等
    const list = doc.getElementById("annotations"); // 注释列表容器（切到「注释」标签才有）
    if (!list || !list.parentNode) return;
    const bar = doc.createElement("div");
    bar.id = this.ANNOT_BTN_ID;
    bar.style.cssText = "display:flex;justify-content:center;padding:7px 8px;box-sizing:border-box;";
    const btn = doc.createElement("button");
    const PINK = "#ff3d9a"; // 粉色描边 + 粉色小猫
    btn.style.cssText =
      "width:100%;height:32px;padding:0 12px;gap:7px;display:flex;align-items:center;justify-content:center;" +
      "font-size:13px;font-weight:700;letter-spacing:.5px;color:#000;background:#fff;border:1.5px solid " + PINK + ";" +
      "border-radius:8px;cursor:pointer;box-shadow:0 1px 4px rgba(255,61,154,.28);";
    btn.onmouseover = () => { btn.style.background = "#fff0f7"; };
    btn.onmouseout = () => { btn.style.background = "#fff"; };
    btn.setAttribute("title", "把本 PDF 所有标注里的空格一次性去除");
    btn.innerHTML = this._catIconSVG(18) + "<span>去除全部标注空格</span>";
    btn.addEventListener("click", (e) => {
      try { e.preventDefault(); e.stopPropagation(); } catch (er) {}
      PaperOutline.cleanAllAnnotations(event.reader);
    });
    bar.appendChild(btn);
    list.parentNode.insertBefore(bar, list); // 放到注释列表上方
  },

  // 注册：renderToolbar 时把「粉色小猫」按钮注入工具栏；并给已打开的阅读器补一次
  registerDespace() {
    try {
      if (!(Zotero.Reader && typeof Zotero.Reader.registerEventListener === "function")) return;
      Zotero.Reader.registerEventListener(
        "renderToolbar",
        (event) => {
          if (typeof PaperOutline === "undefined") return;
          try { PaperOutline._injectDespaceButton(event); } catch (e) { PaperOutline.log("despace btn: " + e); }
          try { PaperOutline._injectReaderInfoPanel(event); } catch (e) { PaperOutline.log("reader info: " + e); }
        },
        this.id
      );
      // 标注栏：每次标注渲染时确保「去除全部标注空格」按钮在注释列表顶部
      Zotero.Reader.registerEventListener(
        "renderSidebarAnnotationHeader",
        (event) => {
          if (typeof PaperOutline === "undefined") return;
          try { PaperOutline._injectAnnotCleanButton(event); } catch (e) { PaperOutline.log("annot btn: " + e); }
        },
        this.id
      );
      // 已打开的阅读器（重装/启用插件时不一定会重渲）→ 直接对其文档注入一次
      try {
        (Zotero.Reader._readers || []).forEach((r) => {
          try {
            const d = r && r._iframeWindow && r._iframeWindow.document;
            if (d) {
              PaperOutline._injectDespaceButton({ doc: d, reader: r });
              PaperOutline._injectReaderInfoPanel({ doc: d, reader: r });
              PaperOutline._injectAnnotCleanButton({ doc: d, reader: r });
            }
          } catch (e) {}
        });
      } catch (e) {}
      this.log("despace registered (button=" + this.pref("despaceButton", true) + ")");
    } catch (e) {
      this.log("registerDespace: " + e);
    }
  },

  // 关闭插件时清理：移除已注入按钮
  unregisterDespace() {
    try {
      (Zotero.Reader._readers || []).forEach((r) => {
        try {
          const d = r && r._iframeWindow && r._iframeWindow.document;
          if (!d) return;
          const b = d.getElementById(this.DESPACE_BTN_ID);
          if (b) b.remove();
          const bar = d.getElementById(this.ANNOT_BTN_ID);
          if (bar) bar.remove();
          const info = d.getElementById(this.READER_INFO_ID);
          if (info) info.remove();
        } catch (e) {}
      });
    } catch (e) {}
  },

  // ════════════════════════════════════════════════════════════════
  //  复制 PDF 文件到剪贴板（可直接粘贴到资源管理器/邮件/聊天）
  //  入口：文库右键、文库 Ctrl+C(选中文件附件时)、阅读器右键、阅读器 Ctrl+C(无选中文字时)
  // ════════════════════════════════════════════════════════════════
  COPYFILE_MENU_ID: "paper-outline-copyfile-menu",

  // 解析出可复制的文件附件：附件本身 / 常规条目取最佳 PDF 附件
  async _resolveFileAttachment(itemOrAtt) {
    try {
      const it = itemOrAtt;
      if (!it) return null;
      if (it.isFileAttachment && it.isFileAttachment()) return it;
      if (it.isRegularItem && it.isRegularItem()) {
        const best = await it.getBestAttachment();
        if (best && best.isFileAttachment && best.isFileAttachment()) return best;
      }
    } catch (e) {}
    return null;
  },

  // 单文件：把一个文件放上剪贴板（application/x-moz-file → Windows 转 CF_HDROP，可粘贴成文件）
  _putFileOnClipboard(path) {
    const file = Zotero.File.pathToFile(path);
    const Cc = Components.classes, Ci = Components.interfaces;
    const trans = Cc["@mozilla.org/widget/transferable;1"].createInstance(Ci.nsITransferable);
    trans.init(null);
    trans.addDataFlavor("application/x-moz-file");
    trans.setTransferData("application/x-moz-file", file);
    Cc["@mozilla.org/widget/clipboard;1"].getService(Ci.nsIClipboard)
      .setData(trans, null, Ci.nsIClipboard.kGlobalClipboard);
  },

  _buildFileDropBytes(paths) {
    const DROPFILES_SIZE = 20;
    const charCount = paths.reduce((sum, path) => sum + path.length + 1, 1);
    const bytes = new Uint8Array(DROPFILES_SIZE + charCount * 2);
    // DROPFILES.pFiles = 20；fWide = TRUE，其余字段保持 0。
    bytes[0] = DROPFILES_SIZE;
    bytes[16] = 1;
    let offset = DROPFILES_SIZE;
    for (const path of paths) {
      for (let i = 0; i < path.length; i++) {
        const code = path.charCodeAt(i);
        bytes[offset++] = code & 0xff;
        bytes[offset++] = (code >>> 8) & 0xff;
      }
      offset += 2; // 每条路径的 UTF-16 结尾 \0
    }
    // Uint8Array 初始化为 0，末尾会多保留一个 UTF-16 \0，组成双零结尾。
    return bytes;
  },

  // Windows 多文件剪贴板必须写入一个完整的 CF_HDROP 数据块。
  // 直接调用 Win32 剪贴板 API，不依赖 PowerShell、外部程序或本地安全策略。
  async _putFilesOnClipboardWindows(paths) {
    if (!Zotero.isWin) throw new Error("当前系统暂不支持一次复制多份文件");
    const unique = [];
    const seen = new Set();
    for (const path of paths || []) {
      const value = String(path || "").trim();
      const key = value.toLowerCase();
      if (value && !seen.has(key)) {
        seen.add(key);
        unique.push(value);
      }
    }
    if (unique.length < 2) throw new Error("多文件剪贴板至少需要两份文件");
    if (unique.length > 100) throw new Error("一次最多复制 100 份文件");

    let ctypes;
    try {
      ({ ctypes } = ChromeUtils.importESModule("resource://gre/modules/ctypes.sys.mjs"));
    } catch (e) {
      ({ ctypes } = ChromeUtils.import("resource://gre/modules/ctypes.jsm"));
    }

    const kernel32 = ctypes.open("kernel32.dll");
    const user32 = ctypes.open("user32.dll");
    const shell32 = ctypes.open("shell32.dll");
    let hGlobal = null;
    let clipboardOwnsMemory = false;
    let GlobalFree = null;
    try {
      const GlobalAlloc = kernel32.declare(
        "GlobalAlloc", ctypes.winapi_abi,
        ctypes.voidptr_t, ctypes.uint32_t, ctypes.size_t
      );
      const GlobalLock = kernel32.declare(
        "GlobalLock", ctypes.winapi_abi,
        ctypes.voidptr_t, ctypes.voidptr_t
      );
      const GlobalUnlock = kernel32.declare(
        "GlobalUnlock", ctypes.winapi_abi,
        ctypes.int32_t, ctypes.voidptr_t
      );
      GlobalFree = kernel32.declare(
        "GlobalFree", ctypes.winapi_abi,
        ctypes.voidptr_t, ctypes.voidptr_t
      );
      const OpenClipboard = user32.declare(
        "OpenClipboard", ctypes.winapi_abi,
        ctypes.int32_t, ctypes.voidptr_t
      );
      const EmptyClipboard = user32.declare(
        "EmptyClipboard", ctypes.winapi_abi,
        ctypes.int32_t
      );
      const SetClipboardData = user32.declare(
        "SetClipboardData", ctypes.winapi_abi,
        ctypes.voidptr_t, ctypes.uint32_t, ctypes.voidptr_t
      );
      const GetClipboardData = user32.declare(
        "GetClipboardData", ctypes.winapi_abi,
        ctypes.voidptr_t, ctypes.uint32_t
      );
      const CloseClipboard = user32.declare(
        "CloseClipboard", ctypes.winapi_abi,
        ctypes.int32_t
      );
      const DragQueryFileW = shell32.declare(
        "DragQueryFileW", ctypes.winapi_abi,
        ctypes.uint32_t,
        ctypes.voidptr_t,
        ctypes.uint32_t,
        ctypes.char16_t.ptr,
        ctypes.uint32_t
      );

      const dropBytes = this._buildFileDropBytes(unique);
      const totalBytes = dropBytes.length;
      // GHND = GMEM_MOVEABLE | GMEM_ZEROINIT；SetClipboardData 成功后内存所有权交给系统。
      hGlobal = GlobalAlloc(0x0042, totalBytes);
      if (hGlobal.isNull()) throw new Error("无法分配 Windows 剪贴板内存");
      const locked = GlobalLock(hGlobal);
      if (locked.isNull()) throw new Error("无法写入 Windows 剪贴板内存");
      try {
        const BufferType = ctypes.uint8_t.array(totalBytes);
        const buffer = ctypes.cast(locked, BufferType.ptr).contents;
        for (let i = 0; i < totalBytes; i++) buffer[i] = dropBytes[i];
      } finally {
        GlobalUnlock(hGlobal);
      }

      const CF_HDROP = 15;
      let opened = false;
      for (let attempt = 0; attempt < 10; attempt++) {
        if (OpenClipboard(null)) {
          opened = true;
          break;
        }
        await Zotero.Promise.delay(50 + attempt * 40);
      }
      if (!opened) throw new Error("剪贴板正被其他程序占用，请稍后重试");
      try {
        if (!EmptyClipboard()) throw new Error("无法清空 Windows 剪贴板");
        const stored = SetClipboardData(CF_HDROP, hGlobal);
        if (stored.isNull()) throw new Error("Windows 拒绝写入多文件剪贴板");
        clipboardOwnsMemory = true;
        const actual = GetClipboardData(CF_HDROP);
        const count = actual.isNull()
          ? 0
          : Number(DragQueryFileW(actual, 0xffffffff, null, 0));
        if (count !== unique.length) {
          throw new Error("剪贴板校验失败：应写入 " + unique.length + " 份，实际为 " + count + " 份");
        }
      } finally {
        CloseClipboard();
      }
    } finally {
      if (hGlobal && !hGlobal.isNull() && !clipboardOwnsMemory) {
        try { if (GlobalFree) GlobalFree(hGlobal); } catch (e) {}
      }
      try { shell32.close(); } catch (e) {}
      try { user32.close(); } catch (e) {}
      try { kernel32.close(); } catch (e) {}
    }
  },

  _fileBaseName(path) {
    try { return Zotero.File.pathToFile(path).leafName; } catch (e) { return "PDF"; }
  },

  // 把一个条目对应的 PDF 文件复制到剪贴板（单文件）
  async copyAttachmentFile(itemOrAtt) {
    try {
      const att = await this._resolveFileAttachment(itemOrAtt);
      if (!att) { this._cfToast("没有可复制的文件", "该条目没有本地 PDF/文件附件"); return; }
      let path = null;
      try { path = att.getFilePath(); } catch (e) {}
      if (!path) { try { path = await att.getFilePathAsync(); } catch (e) {} }
      if (!path) { this._cfToast("文件未找到", "附件可能未下载或已丢失"); return; }
      try { if (!(await IOUtils.exists(path))) { this._cfToast("文件不存在", String(path)); return; } } catch (e) {}
      this._putFileOnClipboard(path);
      this._cfToast("已复制文件", (att.attachmentFilename || this._fileBaseName(path)) + " · 可粘贴到文件夹/邮件/聊天");
    } catch (e) {
      this.log("copyAttachmentFile: " + e);
      this._cfToast("复制失败", String(e));
    }
  },

  async copyAttachmentFiles(items) {
    try {
      const paths = [];
      let skipped = 0;
      for (const item of items || []) {
        const att = await this._resolveFileAttachment(item);
        if (!att) { skipped++; continue; }
        let path = null;
        try { path = att.getFilePath(); } catch (e) {}
        if (!path) { try { path = await att.getFilePathAsync(); } catch (e) {} }
        if (!path) { skipped++; continue; }
        try {
          if (!(await IOUtils.exists(path))) { skipped++; continue; }
        } catch (e) {}
        paths.push(path);
      }

      const uniquePaths = [];
      const seen = new Set();
      for (const path of paths) {
        const key = Zotero.isWin ? String(path).toLowerCase() : String(path);
        if (!seen.has(key)) {
          seen.add(key);
          uniquePaths.push(path);
        }
      }
      if (!uniquePaths.length) {
        this._cfToast("没有可复制的文件", "所选条目没有已下载到本地的 PDF/文件附件");
        return;
      }
      if (uniquePaths.length === 1) {
        this._putFileOnClipboard(uniquePaths[0]);
        const detail = this._fileBaseName(uniquePaths[0]) +
          (skipped ? " · 另有 " + skipped + " 篇没有本地文件" : "") +
          " · 可粘贴到文件夹/邮件/聊天";
        this._cfToast("已复制 1 份文件", detail);
        return;
      }

      await this._putFilesOnClipboardWindows(uniquePaths);
      const detail = uniquePaths.length + " 份文件已写入剪贴板" +
        (skipped ? " · 跳过 " + skipped + " 篇无本地文件的条目" : "") +
        " · 可一次粘贴";
      this._cfToast("批量复制成功", detail);
    } catch (e) {
      this.log("copyAttachmentFiles: " + e);
      this._cfToast("批量复制失败", String((e && e.message) || e));
    }
  },

  // 文库右键菜单调用：单选和多选共用同一条复制流程
  async copySelectedFile() {
    try {
      const zp = Zotero.getActiveZoteroPane && Zotero.getActiveZoteroPane();
      const items = (zp && zp.getSelectedItems) ? zp.getSelectedItems() : [];
      if (!items || !items.length) { this._cfToast("未选中条目", "请先选中文献或其 PDF 附件"); return; }
      await this.copyAttachmentFiles(items);
    } catch (e) { this.log("copySelectedFile: " + e); }
  },

  // 常规条目是否带至少一个文件附件（同步判断，用于决定 Ctrl+C 是否接管）
  _itemHasFileAttachment(it) {
    try {
      const ids = (it && it.getAttachments) ? it.getAttachments() : [];
      for (const id of ids) {
        const a = Zotero.Items.get(id);
        if (a && a.isFileAttachment && a.isFileAttachment()) return true;
      }
    } catch (e) {}
    return false;
  },

  // 文库 Ctrl+C：选中“文件附件”或“带文件附件的常规条目”时复制其 PDF 文件；
  // 否则不拦，交给 Zotero 默认（Quick Copy 题录，取决于快速复制设置）。
  _onLibraryCopyKey(e, win) {
    try {
      if (typeof PaperOutline === "undefined") return;
      if (!((e.key === "c" || e.key === "C") && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey)) return;
      if (!PaperOutline.pref("copyFile", true)) return; // 总开关关 → 放行 Zotero 默认
      // 🔑 只在「文库」标签激活时接管 Ctrl+C；阅读器(或其它)标签激活时一律放行，
      //    否则会把阅读器里"复制选中文字"误劫持成"复制 PDF 文件"。
      try {
        const tabs = win.Zotero_Tabs;
        if (tabs && tabs.selectedID && tabs.selectedID !== "zotero-pane") return;
      } catch (e2) {}
      const t = e.target;
      const tag = t && t.tagName && String(t.tagName).toLowerCase();
      if (tag === "input" || tag === "textarea" || (t && t.isContentEditable)) return; // 输入框里不拦
      const zp = win.ZoteroPane || (Zotero.getActiveZoteroPane && Zotero.getActiveZoteroPane());
      if (!zp || !zp.getSelectedItems) return;
      const items = zp.getSelectedItems();
      if (!items || !items.length) return;
      const hasFile = items.some((it) =>
        (it.isFileAttachment && it.isFileAttachment()) ||
        (it.isRegularItem && it.isRegularItem() && PaperOutline._itemHasFileAttachment(it))
      );
      if (!hasFile) return; // 没有可复制的文件 → 放行 Zotero 默认
      e.preventDefault(); e.stopPropagation();
      PaperOutline.copyAttachmentFiles(items);
    } catch (err) { PaperOutline.log("_onLibraryCopyKey: " + err); }
  },

  registerCopyFile() {
    try {
      // ① 阅读器「标签」右键菜单（main/tab）—— 在标签栏上右键标签即可复制其 PDF 文件
      //    （文库右键的「复制 PDF 文件」已并入 registerMenu 的条目菜单里）
      if (Zotero.MenuManager && typeof Zotero.MenuManager.registerMenu === "function") {
        try {
          Zotero.MenuManager.registerMenu({
            menuID: this.COPYFILE_MENU_ID,
            pluginID: this.id,
            target: "main/tab",
            menus: [{
              menuType: "menuitem",
              label: "复制 PDF 文件",
              onShowing: (event, context) => {
                try {
                  if (context && context.menuElem) context.menuElem.setAttribute("label", "复制 PDF 文件");
                  const it = context && context.items && context.items[0];
                  const ok = it && it.isFileAttachment && it.isFileAttachment();
                  if (context && context.setVisible) context.setVisible(!!ok && PaperOutline.pref("copyFile", true)); // 仅文件附件标签 + 总开关开
                } catch (e) {}
              },
              onCommand: (event, context) => {
                try { const it = context && context.items && context.items[0]; PaperOutline.copyAttachmentFile(it); } catch (e) {}
              },
            }],
          });
        } catch (e) { this.log("copyfile tab menu: " + e); }
      }
      // （阅读器内右键/Ctrl+C 复制已按需求移除，防与阅读器自身复制冲突；保留「标签右键」与「文库」）
      // ② 文库主窗口 Ctrl+C
      try {
        const win = Zotero.getMainWindow();
        if (win && !win.__poCopyFileKeyHooked) {
          win.__poCopyFileKeyHooked = true;
          const handler = (e) => PaperOutline._onLibraryCopyKey(e, win);
          win.addEventListener("keydown", handler, true);
          this._copyFileKeyWin = { win, handler };
        }
      } catch (e) {}
      this.log("copyfile registered");
    } catch (e) {
      this.log("registerCopyFile: " + e);
    }
  },

  unregisterCopyFile() {
    try {
      if (Zotero.MenuManager && typeof Zotero.MenuManager.unregisterMenu === "function") {
        try { Zotero.MenuManager.unregisterMenu(this.COPYFILE_MENU_ID); } catch (e) {}
      }
    } catch (e) {}
    try {
      if (this._copyFileKeyWin) {
        this._copyFileKeyWin.win.removeEventListener("keydown", this._copyFileKeyWin.handler, true);
        try { this._copyFileKeyWin.win.__poCopyFileKeyHooked = false; } catch (e) {}
        this._copyFileKeyWin = null;
      }
    } catch (e) {}
  },
};
