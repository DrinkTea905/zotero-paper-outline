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

  init({ id, version, rootURI }) {
    this.id = id;
    this.version = version;
    this.rootURI = rootURI;
    // 暴露到 Zotero 主对象，方便在「运行 JavaScript」里诊断/手动触发
    try { Zotero.PaperOutlineGPT = this; } catch (e) {}
    try { this._migratePrefs(); } catch (e) {}
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
    "（取标题上方最近的「第 N 页」标记）。即每个条目形如 " +
    '{"level":1,"title":"…","summary":"…","page":3}。',

  // ── 菜单注册 ────────────────────────────────────────────
  // Zotero 8/9：用 Zotero.MenuManager.registerMenu（自动管理所有窗口）
  // Zotero 7：退化为逐窗口注入 #zotero-itemmenu
  MENU_LABEL: "📑 AI 生成目录",
  SUMMARY_MENU_LABEL: "📝 AI 整篇总结 → 笔记",
  _menuID: "paper-outline-menu",
  _usedMenuManager: false,

  registerMenu() {
    if (Zotero.MenuManager && typeof Zotero.MenuManager.registerMenu === "function") {
      try {
        Zotero.MenuManager.registerMenu({
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
        this._usedMenuManager = true;
        this.log("menu registered via MenuManager");
        return;
      } catch (e) {
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
        Zotero.MenuManager.unregisterMenu(this._menuID);
      } else {
        this.removeFromAllWindows();
      }
    } catch (e) {
      this.log("unregisterMenu error: " + e);
    }
  },

  // —— 以下仅 Zotero 7 退化路径使用 ——
  addToWindow(window) {
    try {
      const doc = window.document;
      if (doc.getElementById("paper-outline-menuitem")) return;
      const itemMenu = doc.getElementById("zotero-itemmenu");
      if (!itemMenu) return;
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
      this._addedWindows.add(window);
    } catch (e) {
      this.log("addToWindow error: " + e);
    }
  },

  removeFromWindow(window) {
    try {
      window.document.getElementById("paper-outline-menuitem")?.remove();
      window.document.getElementById("paper-outline-summary-menuitem")?.remove();
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

      // 注入：仅当面板缺失时重建（带守卫，避免 MutationObserver 无限循环）。
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
          // 点侧栏标签（缩略图/大纲/注释）或开关时，切换本面板显隐（仅大纲标签显示）
          ["viewThumbnail", "viewOutline", "viewAnnotations", "sidebarToggle"].forEach((bid) => {
            const b = doc.getElementById(bid);
            if (b && !b._poHooked) {
              b._poHooked = true;
              b.addEventListener("click", () =>
                rw.setTimeout(() => PaperOutline._updateReaderPanelVisibility(doc), 50)
              );
            }
          });
          return true;
        } catch (e3) {
          PaperOutline.log("ensureInjected: " + e3);
          return false;
        }
      };
      this._readerEnsure = ensureInjected; // 暴露给诊断
      ensureInjected();

      // React 若重渲侧栏把面板冲掉，立刻补回（守卫防循环；只观察 #sidebarContent 子节点）
      try {
        const host = doc.getElementById("sidebarContent");
        if (host && rw.MutationObserver && !reader._paperOutlineObserver) {
          const mo = new rw.MutationObserver(() => ensureInjected());
          mo.observe(host, { childList: true });
          reader._paperOutlineObserver = mo;
        }
      } catch (e2) {}

      // PDF 加载完再补一道保险（走 pdf.js eventBus）
      try {
        const app1 = this._getReaderApp(reader);
        const eb = app1 && app1.eventBus;
        if (eb && !reader._poEbHooked) {
          reader._poEbHooked = true;
          eb.on("documentloaded", () => rw.setTimeout(ensureInjected, 80));
        }
      } catch (e2) {}

      // 翻页时高亮目录里对应章节（页码跟随，像真正的大纲导航）
      try {
        const app2 = this._getReaderApp(reader);
        const eb2 = app2 && app2.eventBus;
        if (eb2 && !reader._poPageHooked) {
          reader._poPageHooked = true;
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

    // 空状态：仅一个生成按钮
    if (!outline || !outline.length) {
      const btn = mk("button", null, "📑 生成目录", "po-btn");
      btn.addEventListener("click", () => PaperOutline._doGenerate(doc, host, item, reader, false));
      box.appendChild(btn);
      if (this._needKey() && !this.pref("apiKey", "")) {
        box.appendChild(mk("div", "opacity:0.7;margin-top:8px;font-size:11px;", "（需先在 设置 → Paper Outline 填 API Key）"));
      }
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
    let fullText = opts.pagedText || "";
    if (!fullText) {
      const att = opts.att || (await this._resolveAttachment(item));
      if (!att || !att.isPDFAttachment()) {
        throw new Error("没有可用的 PDF 附件");
      }
      try {
        fullText = (await att.attachmentText) || "";
      } catch (e) {
        this.log("attachmentText error: " + e);
      }
    }
    if (!fullText.trim()) {
      throw new Error("PDF 全文为空（可能是扫描件，需先 OCR）");
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

    if (pages && pages.length) {
      // —— 精确：标题出现在哪一页的文本里，就是第几页（按目录顺序游标前进，避免短词错位）——
      const np = pages.map(norm);
      let cursor = 0,
        hit = 0;
      for (const s of outline) {
        const key = norm(s.title);
        if (key.length < 2) continue;
        const probe = key.slice(0, Math.min(18, key.length));
        let found = -1;
        for (let i = cursor; i < np.length; i++) if (np[i].includes(probe)) { found = i; break; }
        if (found < 0) for (let i = 0; i < np.length; i++) if (np[i].includes(probe)) { found = i; break; }
        if (found >= 0) {
          s.page = found + 1; // 精确命中：覆盖 AI 的猜测
          cursor = found;
          hit++;
        }
      }
      this.log("fillPages 精确命中=" + hit + "/" + outline.length + " 页数=" + numPages);
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
    let last = 1;
    for (const s of outline) {
      let p = parseInt(s.page, 10);
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
    deepseek:    { label: "DeepSeek（默认）",          url: "https://api.deepseek.com/chat/completions",                          model: "deepseek-chat",           json: true },
    openai:      { label: "OpenAI",                     url: "https://api.openai.com/v1/chat/completions",                         model: "gpt-4o-mini",             json: true },
    moonshot:    { label: "月之暗面 Kimi",              url: "https://api.moonshot.cn/v1/chat/completions",                        model: "moonshot-v1-8k",          json: true },
    zhipu:       { label: "智谱 GLM",                   url: "https://open.bigmodel.cn/api/paas/v4/chat/completions",              model: "glm-4-flash",             json: true },
    qwen:        { label: "通义千问 Qwen",              url: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", model: "qwen-plus",               json: true },
    siliconflow: { label: "硅基流动 SiliconFlow",       url: "https://api.siliconflow.cn/v1/chat/completions",                     model: "deepseek-ai/DeepSeek-V3", json: true },
    ollama:      { label: "本地 Ollama",                url: "http://localhost:11434/v1/chat/completions",                         model: "qwen2.5",                 json: false },
    custom:      { label: "自定义（手填 URL / 模型）",   url: "",                                                                   model: "",                        json: false },
  },

  _resolveAI() {
    const p = this.pref("provider", "deepseek");
    const preset = this.PROVIDERS[p] || this.PROVIDERS.deepseek;
    const url = (this.pref("apiUrl", "") || "").trim() || preset.url;
    const model = (this.pref("model", "") || "").trim() || preset.model;
    const key = (this.pref("apiKey", "") || "").trim();
    return { url, model, key, json: preset.json };
  },

  // 是否需要 API Key（本地 Ollama / 自定义 不强制）
  _needKey() {
    const p = this.pref("provider", "deepseek");
    return p !== "ollama" && p !== "custom";
  },

  // ── AI 调用：所有服务商统一走 OpenAI 兼容 /chat/completions ───────────────
  // opts.json：是否要求 JSON 输出（目录=true；整篇总结=false，要纯文本）。不传则按服务商预设。
  async callAI(systemPrompt, userPrompt, opts) {
    opts = opts || {};
    const { url, model, key, json } = this._resolveAI();
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
    const j = await this._post(url, headers, payload);
    return (
      (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) ||
      (j.message && j.message.content) ||
      ""
    );
  },

  // 统一的 HTTP POST（用 Zotero.HTTP.request，特权环境、不受网页 CORS 限制）
  async _post(url, headers, payload) {
    let xhr;
    try {
      xhr = await Zotero.HTTP.request("POST", url, {
        headers: Object.assign({ "Content-Type": "application/json" }, headers || {}),
        body: JSON.stringify(payload),
        responseType: "text",
        timeout: 180000,
      });
    } catch (e) {
      throw new Error(this._friendlyError(e));
    }
    return JSON.parse(xhr.responseText);
  },

  // 把底层报错翻译成人话
  _friendlyError(e) {
    const status = (e && e.xmlhttp && e.xmlhttp.status) || (e && e.status) || 0;
    const body = ((e && e.xmlhttp && e.xmlhttp.responseText) || (e && e.message) || "").toString();
    const low = body.toLowerCase();
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

  // 取附件全文：优先 PDFWorker（CID-aware，知网/扫描双层也能读），退化 attachmentText
  async _getFullTextForItem(att) {
    if (!att) return "";
    try {
      const pages = await this._getWorkerPages(att);
      if (pages && pages.length) {
        const t = pages.join("\n");
        if (t.trim()) return t;
      }
    } catch (e) {}
    try {
      const t = (await att.attachmentText) || "";
      if (t.trim()) return t;
    } catch (e) {}
    return "";
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
      full = await this._getFullTextForItem(att);
    }
    if (!full || !full.trim()) throw new Error("PDF 全文为空（可能是扫描件，需先 OCR）");
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
    let pages = null;
    try {
      pages = await this._getWorkerPages(att);
    } catch (e) {}
    const pagedText =
      pages && pages.length
        ? pages.map((t, i) => `\n\n===== 第 ${i + 1} 页 =====\n` + t).join("")
        : null;
    const outline = await this.generateOutline(item, onText, { pagedText, att });
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
      full = await this._getFullTextForItem(att);
      if (full.trim()) break;
      await this._sleep(3000);
    }
    if (!full.trim()) {
      this.log("auto: 无可用正文，跳过 " + item.key);
      return;
    }

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

  // 造一个工具栏按钮：粉色小猫图标（醒目）
  _makeDespaceButton(doc) {
    const btn = doc.createElement("button");
    btn.id = this.DESPACE_BTN_ID;
    btn.className = "toolbar-button";
    btn.setAttribute("title", "去除文字空格：点我清理刚复制的文字");
    btn.setAttribute("tabindex", "-1");
    // 粉色小猫（耳朵+脸+眼睛+鼻子+胡须）
    btn.innerHTML =
      '<svg width="20" height="20" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
      '<path d="M4 3.8 L9.4 9 L4 10.4 Z" fill="#ff6fb5"/>' +
      '<path d="M20 3.8 L14.6 9 L20 10.4 Z" fill="#ff6fb5"/>' +
      '<path d="M12 5.6 C16.5 5.6 19.2 8.8 19.2 13 C19.2 17.3 16 19.9 12 19.9 C8 19.9 4.8 17.3 4.8 13 C4.8 8.8 7.5 5.6 12 5.6 Z" fill="#ff90d0"/>' +
      '<circle cx="9.4" cy="12.4" r="1.05" fill="#48243d"/>' +
      '<circle cx="14.6" cy="12.4" r="1.05" fill="#48243d"/>' +
      '<path d="M11 15 L13 15 L12 16.2 Z" fill="#e03a8e"/>' +
      '<path d="M5.2 12.9 L8.4 13.1 M5.3 14.3 L8.4 14 M18.8 12.9 L15.6 13.1 M18.7 14.3 L15.6 14" stroke="#f0a6d2" stroke-width="0.6" stroke-linecap="round"/>' +
      "</svg>";
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
    btn.innerHTML =
      '<svg width="18" height="18" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
      '<path d="M4 3.8 L9.4 9 L4 10.4 Z" fill="#ff6fb5"/>' +
      '<path d="M20 3.8 L14.6 9 L20 10.4 Z" fill="#ff6fb5"/>' +
      '<path d="M12 5.6 C16.5 5.6 19.2 8.8 19.2 13 C19.2 17.3 16 19.9 12 19.9 C8 19.9 4.8 17.3 4.8 13 C4.8 8.8 7.5 5.6 12 5.6 Z" fill="#ff90d0"/>' +
      '<circle cx="9.4" cy="12.4" r="1.05" fill="#48243d"/>' +
      '<circle cx="14.6" cy="12.4" r="1.05" fill="#48243d"/>' +
      '<path d="M11 15 L13 15 L12 16.2 Z" fill="#e03a8e"/>' +
      "</svg><span>去除全部标注空格</span>";
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
            if (d) { PaperOutline._injectDespaceButton({ doc: d }); PaperOutline._injectAnnotCleanButton({ doc: d, reader: r }); }
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

  // 文库右键菜单调用：复制当前选中条目（取第一个）的文件
  copySelectedFile() {
    try {
      const zp = Zotero.getActiveZoteroPane && Zotero.getActiveZoteroPane();
      const items = (zp && zp.getSelectedItems) ? zp.getSelectedItems() : [];
      if (!items || !items.length) { this._cfToast("未选中条目", "请先选中文献或其 PDF 附件"); return; }
      this.copyAttachmentFile(items[0]);
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
      const t = e.target;
      const tag = t && t.tagName && String(t.tagName).toLowerCase();
      if (tag === "input" || tag === "textarea" || (t && t.isContentEditable)) return; // 输入框里不拦
      const zp = win.ZoteroPane || (Zotero.getActiveZoteroPane && Zotero.getActiveZoteroPane());
      if (!zp || !zp.getSelectedItems) return;
      const items = zp.getSelectedItems();
      if (!items || items.length !== 1) return; // 仅单选时接管，多选交回 Zotero 默认
      const it = items[0];
      let target = null;
      if (it.isFileAttachment && it.isFileAttachment()) target = it;
      else if (it.isRegularItem && it.isRegularItem() && PaperOutline._itemHasFileAttachment(it)) target = it;
      if (!target) return; // 没有可复制的文件 → 放行 Zotero 默认
      e.preventDefault(); e.stopPropagation();
      PaperOutline.copyAttachmentFile(target);
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
