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
    "若原文章节标题是英文，title 请翻译成中文。不要输出 JSON 以外的任何文字。",

  // 页码增强：当把带「===== 第 N 页 =====」标记的全文喂给 AI 时附加，让它标出每节起始页
  PAGE_INSTRUCTION:
    "【页码要求】正文中我用「===== 第 N 页 =====」标出了每页起始。" +
    "请在每个目录条目里额外输出一个整数字段 page，值＝该章节标题所在页码" +
    "（取标题上方最近的「第 N 页」标记）。即每个条目形如 " +
    '{"level":1,"title":"…","summary":"…","page":3}。',

  // ── 菜单注册 ────────────────────────────────────────────
  // Zotero 8/9：用 Zotero.MenuManager.registerMenu（自动管理所有窗口）
  // Zotero 7：退化为逐窗口注入 #zotero-itemmenu
  MENU_LABEL: "🧾 AI 总结并生成目录",
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
              label: this.MENU_LABEL,
              // Zotero 8/9：label 属性不渲染，需在 onShowing 里给 DOM 元素设 label
              onShowing: (event, context) => {
                try {
                  if (context && context.menuElem) {
                    context.menuElem.setAttribute("label", PaperOutline.MENU_LABEL);
                  }
                } catch (e) {}
              },
              onCommand: () => this.runOnSelected(),
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
      row.addEventListener("click", () => PaperOutline._readerJump(reader, s));
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

  // 按当前页高亮对应章节并滚动到可见
  _highlightReaderOutline(doc, pageNum) {
    try {
      const box = doc.getElementById("paper-outline-reader");
      if (!box) return;
      const rows = Array.from(box.querySelectorAll(".po-item"));
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
  async callAI(systemPrompt, userPrompt) {
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
    if (json) payload.response_format = { type: "json_object" }; // 多数服务商支持；不支持的预设里关掉
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
};
