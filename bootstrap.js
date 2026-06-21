/* global Zotero, Services, ChromeUtils, PaperOutline */
// ───────────────────────────────────────────────────────────────
//  Paper Outline GPT —— Zotero 7 bootstrap 入口
//  生命周期：install / startup / shutdown / uninstall
//  + 窗口钩子：onMainWindowLoad / onMainWindowUnload
// ───────────────────────────────────────────────────────────────

function install() {}
function uninstall() {}

async function startup({ id, version, rootURI }) {
  // 等 Zotero 完全就绪（否则 ZoteroPane / Items 可能还没准备好）
  await Zotero.initializationPromise;

  // 加载核心逻辑模块（注入到本 bootstrap 作用域，暴露全局 PaperOutline）
  Services.scriptloader.loadSubScript(rootURI + "paperOutline.js");
  PaperOutline.init({ id, version, rootURI });
  // 载入目录缓存（独立 JSON 文件；首次会从旧 prefs 缓存迁移）
  await PaperOutline._loadCache();

  // 注册「设置」面板（编辑 → 设置 → Paper Outline GPT）
  // 注意：src 必须用 rootURI 拼成绝对路径（相对路径在 Zotero 7+ 会抛异常）
  try {
    Zotero.PreferencePanes.register({
      pluginID: id,
      src: rootURI + "preferences.xhtml",
      label: "Paper Outline",
    });
  } catch (e) {
    PaperOutline.log("PreferencePanes.register 失败（不影响主功能）: " + e);
  }

  // 注册右键菜单（Zotero 8/9 走 MenuManager，自动覆盖所有窗口）
  PaperOutline.registerMenu();
  // 注入阅读器左侧「大纲」栏（DOM 注入 reader iframe）
  PaperOutline.registerReaderOutline();
  // 去除文字空格：阅读器工具栏「粉色小猫」图标 → 点一下清理剪贴板
  PaperOutline.registerDespace();
  // 入库自动处理：监听条目新增 → 自动生成总结/目录（默认开，可在设置里关）
  PaperOutline.registerAutoObserver();
  PaperOutline.log("started v" + version);
}

function onMainWindowLoad({ window }) {
  // 仅 Zotero 7 退化路径需要逐窗口注入；MenuManager 会自动处理新窗口
  if (typeof PaperOutline !== "undefined" && PaperOutline._usedMenuManager === false) {
    PaperOutline.addToWindow(window);
  }
}

function onMainWindowUnload({ window }) {
  if (typeof PaperOutline !== "undefined" && PaperOutline._usedMenuManager === false) {
    PaperOutline.removeFromWindow(window);
  }
}

function shutdown() {
  if (typeof PaperOutline !== "undefined") {
    PaperOutline.unregisterMenu();
    PaperOutline.unregisterAutoObserver();
    try { PaperOutline.unregisterDespace(); } catch (e) {}
    // eslint-disable-next-line no-global-assign
    PaperOutline = undefined;
  }
}
