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

class MockElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.id = "";
    this.children = [];
    this.parentNode = null;
    this.style = { cssText: "" };
    this.attributes = {};
    this.listeners = {};
    this.textContent = "";
    this.innerHTML = "";
    this.disabled = false;
  }

  get firstChild() { return this.children[0] || null; }
  get firstElementChild() { return this.firstChild; }
  get nextSibling() {
    if (!this.parentNode) return null;
    const index = this.parentNode.children.indexOf(this);
    return index >= 0 ? this.parentNode.children[index + 1] || null : null;
  }

  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] || null; }
  addEventListener(type, listener, options) {
    this.listeners[type] = listener;
    this.listenerOptions = this.listenerOptions || {};
    this.listenerOptions[type] = options;
  }
  appendChild(child) { return this.insertBefore(child, null); }
  insertBefore(child, before) {
    if (child.parentNode) {
      const oldIndex = child.parentNode.children.indexOf(child);
      if (oldIndex >= 0) child.parentNode.children.splice(oldIndex, 1);
    }
    child.parentNode = this;
    const index = before ? this.children.indexOf(before) : -1;
    if (index >= 0) this.children.splice(index, 0, child);
    else this.children.push(child);
    return child;
  }
  querySelector(selector) {
    if (!selector.startsWith("#")) return null;
    const id = selector.slice(1);
    const walk = (element) => {
      if (element.id === id) return element;
      for (const child of element.children) {
        const found = walk(child);
        if (found) return found;
      }
      return null;
    };
    return walk(this);
  }
}

class MockDocument {
  constructor(center) {
    this.center = center;
    this.listeners = {};
    this.listenerOptions = {};
    const listeners = {};
    const listenerOptions = {};
    this.defaultView = {
      listeners,
      listenerOptions,
      addEventListener(type, listener, options) {
        listeners[type] = listener;
        listenerOptions[type] = options;
      },
      removeEventListener(type, listener) {
        if (listeners[type] === listener) delete listeners[type];
      },
    };
  }
  createElement(tagName) { return new MockElement(tagName); }
  addEventListener(type, listener, options) {
    this.listeners[type] = listener;
    this.listenerOptions[type] = options;
  }
  removeEventListener(type, listener) {
    if (this.listeners[type] === listener) delete this.listeners[type];
  }
  querySelector(selector) {
    return selector === ".center.tools" || selector === ".toolbar .center" ? this.center : null;
  }
  getElementById(id) { return this.center.querySelector("#" + id); }
}

function makeReader(fields) {
  const parentItem = {
    firstCreator: fields.firstCreator || "",
    getField(field, base, includeBaseMapped) {
      if (field === "date" && base && includeBaseMapped) return fields.formattedDate || "";
      return fields[field] || "";
    },
  };
  return { _item: { parentItem } };
}

function testBuildsZoteroStyleInfoLine() {
  const outline = loadPaperOutline({ debug() {} });
  const reader = makeReader({
    title: " 犯罪统计与犯罪治理的优化 ",
    firstCreator: "卢建平",
    date: "2021-10",
    formattedDate: "2021-10-01",
  });
  assert.equal(outline._getReaderInfoText(reader), "犯罪统计与犯罪治理的优化 - 卢建平 - 2021");
}

function testHandlesPartialMetadata() {
  const outline = loadPaperOutline({ debug() {} });
  assert.equal(outline._getReaderInfoText(makeReader({ title: "只有题名" })), "只有题名");
  assert.equal(outline._getReaderInfoText(null), "");
}

function testCopiesExactDisplayedText() {
  let copied = "";
  let toast = null;
  const zotero = {
    Utilities: { Internal: { copyTextToClipboard: (text) => { copied = text; } } },
    debug() {},
  };
  const outline = loadPaperOutline(zotero);
  outline._toast = (title, description) => { toast = { title, description }; };
  const reader = makeReader({ title: "题名", firstCreator: "作者", date: "2024" });
  assert.equal(outline.copyReaderInfo(reader), "题名 - 作者 - 2024");
  assert.equal(copied, "题名 - 作者 - 2024");
  assert.equal(toast.title, "文献信息 · 已复制");
}

function testPlacesPanelImmediatelyAfterCat() {
  let copied = "";
  let copyCount = 0;
  let copiedAttachment = null;
  const zotero = {
    Utilities: { Internal: { copyTextToClipboard: (text) => { copied = text; copyCount += 1; } } },
    Prefs: { get() { return undefined; } },
    debug() {},
  };
  const outline = loadPaperOutline(zotero);
  outline._toast = () => {};
  outline.copyAttachmentFile = async (attachment) => { copiedAttachment = attachment; };
  const center = new MockElement("div");
  const cat = new MockElement("button");
  cat.id = outline.DESPACE_BTN_ID;
  const builtIn = new MockElement("button");
  builtIn.id = "built-in-tool";
  center.appendChild(cat);
  center.appendChild(builtIn);
  const doc = new MockDocument(center);
  const reader = makeReader({ title: "题名", firstCreator: "作者", date: "2024" });

  outline._injectReaderInfoPanel({ doc, reader });
  assert.equal(center.children.length, 3);
  assert.equal(center.children[0], cat);
  assert.equal(center.children[1].id, outline.READER_INFO_ID);
  assert.equal(center.children[2], builtIn);
  assert.equal(center.children[1].children.length, 2, "reader panel should only show two copy buttons");
  assert.equal(center.children[1].children[0].id, outline.READER_INFO_COPY_ID);
  assert.equal(center.children[1].children[1].id, outline.READER_PDF_COPY_ID);
  assert.match(center.children[1].querySelector("#" + outline.READER_INFO_COPY_ID).innerHTML, /复制信息/);
  assert.match(center.children[1].querySelector("#" + outline.READER_PDF_COPY_ID).innerHTML, /复制 PDF/);
  assert.equal(doc.defaultView.listenerOptions.mousedown, true);
  assert.equal(doc.defaultView.listenerOptions.click, true);

  outline._injectReaderInfoPanel({ doc, reader });
  assert.equal(center.children.length, 3);
  const copyInfo = center.children[1].querySelector("#" + outline.READER_INFO_COPY_ID);
  const copyPdf = center.children[1].querySelector("#" + outline.READER_PDF_COPY_ID);
  const eventCalls = { preventDefault: 0, stopPropagation: 0, stopImmediatePropagation: 0 };
  doc.defaultView.listeners.mousedown({
    target: copyInfo,
    button: 0,
    preventDefault() { eventCalls.preventDefault += 1; },
    stopPropagation() { eventCalls.stopPropagation += 1; },
    stopImmediatePropagation() { eventCalls.stopImmediatePropagation += 1; },
  });
  assert.equal(copied, "题名 - 作者 - 2024");
  assert.equal(copyCount, 1);
  assert.deepEqual(eventCalls, { preventDefault: 1, stopPropagation: 1, stopImmediatePropagation: 1 });

  doc.defaultView.listeners.click({
    target: copyInfo,
    preventDefault() {},
    stopPropagation() {},
    stopImmediatePropagation() {},
  });
  assert.equal(copyCount, 1, "the following click must not copy a second time");

  doc.defaultView.listeners.click({
    target: copyPdf,
    preventDefault() {},
    stopPropagation() {},
    stopImmediatePropagation() {},
  });
  assert.equal(copiedAttachment, reader._item, "click fallback must copy the current PDF attachment");

  copiedAttachment = null;
  doc.defaultView.listeners.mousedown({
    target: copyPdf,
    button: 2,
    preventDefault() {},
    stopPropagation() {},
    stopImmediatePropagation() {},
  });
  assert.equal(copiedAttachment, null, "right click must not trigger PDF copying");
}

function testUsesRedrawnCatIconEverywhere() {
  const outline = loadPaperOutline({ debug() {} });
  const svg = outline._catIconSVG(20);
  assert.match(svg, /width="20"/);
  assert.match(svg, /stroke="#D9438E"/);
  assert.match(svg, /FFD3E8/);
  assert.doesNotMatch(svg, /M4 3\.8 L9\.4 9/);
}

try {
  testBuildsZoteroStyleInfoLine();
  testHandlesPartialMetadata();
  testCopiesExactDisplayedText();
  testPlacesPanelImmediatelyAfterCat();
  testUsesRedrawnCatIconEverywhere();
  console.log("reader-info tests passed");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
