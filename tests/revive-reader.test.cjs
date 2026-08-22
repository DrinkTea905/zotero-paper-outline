const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadPaperOutline(zotero) {
  const source = fs.readFileSync(path.join(__dirname, "..", "paperOutline.js"), "utf8");
  const context = vm.createContext({ Zotero: zotero, console });
  vm.runInContext(source, context, { filename: "paperOutline.js" });
  return context.PaperOutline;
}

async function testManagedRecoveryMenus() {
  const registered = [];
  const zotero = {
    MenuManager: {
      registerMenu(config) {
        registered.push(config);
        return config.menuID;
      },
      unregisterMenu() {},
    },
    Reader: { _readers: [] },
    getMainWindows: () => [],
    debug() {},
  };
  const outline = loadPaperOutline(zotero);
  outline.id = "paper-outline@example.com";
  outline.registerMenu();

  assert.deepEqual(
    registered.map((entry) => entry.target),
    ["main/library/item", "main/menubar/tools", "reader/menubar/view"]
  );
  assert.equal(registered[1].menus[0].label, "🔄 重新唤起 Paper Outline");
}

async function testRevivesCurrentReaderOnly() {
  const current = { type: "pdf", _iframeWindow: { document: {}, setTimeout() {} } };
  const background = { type: "pdf", _iframeWindow: { document: {}, setTimeout() {} } };
  const zotero = {
    Reader: {
      _readers: [current, background],
      getByTabID: (tabID) => (tabID === "reader-tab" ? current : null),
    },
    getMainWindow: () => ({ Zotero_Tabs: { selectedID: "reader-tab" } }),
    debug() {},
  };
  const outline = loadPaperOutline(zotero);
  const revived = [];
  outline._reviveOneReader = async (reader) => {
    revived.push(reader);
    return true;
  };
  outline._toast = () => {};

  assert.equal(await outline.reviveReaderFeatures(), 1);
  assert.deepEqual(revived, [current]);
}

async function testRevivesAllReadersFromLibrary() {
  const first = { type: "pdf" };
  const second = { type: "pdf" };
  const zotero = {
    Reader: { _readers: [first, { type: "epub" }, second], getByTabID: () => null },
    getMainWindow: () => ({ Zotero_Tabs: { selectedID: "zotero-pane" } }),
    debug() {},
  };
  const outline = loadPaperOutline(zotero);
  const revived = [];
  outline._reviveOneReader = async (reader) => {
    revived.push(reader);
    return true;
  };
  outline._toast = () => {};

  assert.equal(await outline.reviveReaderFeatures(), 2);
  assert.deepEqual(revived, [first, second]);
}

async function testRevivesDetachedReaderFromItsOwnMenu() {
  const detachedWindow = {};
  const detached = { type: "pdf", _window: detachedWindow };
  const tabReader = { type: "pdf", tabID: "reader-tab", _window: {} };
  const zotero = {
    Reader: { _readers: [tabReader, detached], getByTabID: () => tabReader },
    getMainWindow: () => ({ Zotero_Tabs: { selectedID: "reader-tab" } }),
    debug() {},
  };
  const outline = loadPaperOutline(zotero);
  const targets = outline._getReaderReviveTargets({ target: { ownerGlobal: detachedWindow } });
  assert.equal(targets.length, 1);
  assert.equal(targets[0], detached);
}

Promise.resolve()
  .then(testManagedRecoveryMenus)
  .then(testRevivesCurrentReaderOnly)
  .then(testRevivesAllReadersFromLibrary)
  .then(testRevivesDetachedReaderFromItsOwnMenu)
  .then(() => console.log("revive-reader tests passed"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
