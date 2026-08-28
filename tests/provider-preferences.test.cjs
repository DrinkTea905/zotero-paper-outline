const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

class MockElement {
  constructor(value = "") {
    this.value = value;
    this.checked = false;
    this.disabled = false;
    this.open = false;
    this.dataset = {};
    this.className = "";
    this.textContent = "";
    this.label = "";
    this.listeners = {};
  }

  addEventListener(type, listener) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(listener);
  }

  dispatchEvent(event) {
    for (const listener of this.listeners[event.type] || []) listener(event);
  }

  trigger(type) {
    this.dispatchEvent({ type, target: this });
  }

  focus() {}
}

function loadPreferencesUI() {
  const elements = {
    "paper-outline-provider": new MockElement("deepseek"),
    "paper-outline-api-key": new MockElement(),
    "paper-outline-model": new MockElement(),
    "paper-outline-api-url": new MockElement(),
    "paper-outline-model-hint": new MockElement(),
    "paper-outline-key-hint": new MockElement(),
    "paper-outline-api-details": new MockElement(),
    "paper-outline-deep-thinking": new MockElement(),
    "paper-outline-test-status": new MockElement(),
  };
  const prefs = {
    "extensions.paperoutline.provider": "deepseek",
    "extensions.paperoutline.providerConfigsMigrated": true,
    "extensions.paperoutline.deepThinking": false,
  };
  const configs = {
    deepseek: {
      apiUrl: "https://api.deepseek.com/chat/completions",
      apiKey: "ds-key",
      model: "deepseek-v4-flash",
    },
    mimo: {
      apiUrl: "https://api.xiaomimimo.com/v1/chat/completions",
      apiKey: "mimo-key",
      model: "mimo-v2.5",
    },
  };
  let tested = null;
  const api = {
    getProviderConfig(provider) {
      return { apiUrl: "", apiKey: "", model: "", ...(configs[provider] || {}) };
    },
    saveProviderConfig(provider, config, activate) {
      configs[provider] = {
        apiUrl: String(config.apiUrl || ""),
        apiKey: String(config.apiKey || ""),
        model: String(config.model || ""),
      };
      if (activate) {
        prefs["extensions.paperoutline.provider"] = provider;
        for (const key of ["apiUrl", "apiKey", "model"]) {
          prefs["extensions.paperoutline." + key] = configs[provider][key];
        }
      }
    },
    async testConnection(options) {
      tested = { ...options };
      return { provider: options.provider, label: options.provider, model: options.model, elapsed: 1 };
    },
  };
  const Zotero = {
    PaperOutlineGPT: api,
    Prefs: {
      get(name) { return prefs[name]; },
      set(name, value) { prefs[name] = value; },
    },
    launchURL() {},
  };
  const document = { getElementById: (id) => elements[id] || null };
  const window = { alert() {}, confirm: () => true };
  const source = fs.readFileSync(path.join(__dirname, "..", "preferences.js"), "utf8");
  const context = vm.createContext({ Zotero, document, window, Event: class Event { constructor(type) { this.type = type; } } });
  vm.runInContext(source, context, { filename: "preferences.js" });
  return {
    ui: context.window.PaperOutlinePrefsUI,
    elements,
    configs,
    prefs,
    tested: () => tested,
  };
}

test("切换 provider 时分别保存并恢复 URL、Key 和模型", async () => {
  const { ui, elements, configs, prefs, tested } = loadPreferencesUI();
  ui.init();

  assert.equal(elements["paper-outline-api-key"].value, "ds-key");
  assert.equal(elements["paper-outline-model"].value, "deepseek-v4-flash");
  assert.equal(elements["paper-outline-api-url"].value, "https://api.deepseek.com/chat/completions");

  elements["paper-outline-api-key"].value = "ds-key-updated";
  elements["paper-outline-model"].value = "deepseek-custom";
  elements["paper-outline-api-url"].value = "https://ds-proxy.example/v1/chat/completions";
  elements["paper-outline-api-key"].trigger("input");

  elements["paper-outline-provider"].value = "mimo";
  elements["paper-outline-provider"].trigger("command");
  assert.equal(configs.deepseek.apiKey, "ds-key-updated");
  assert.equal(configs.deepseek.model, "deepseek-custom");
  assert.equal(configs.deepseek.apiUrl, "https://ds-proxy.example/v1/chat/completions");
  assert.equal(elements["paper-outline-api-key"].value, "mimo-key");
  assert.equal(elements["paper-outline-model"].value, "mimo-v2.5");
  assert.equal(elements["paper-outline-api-url"].value, "https://api.xiaomimimo.com/v1/chat/completions");

  elements["paper-outline-api-key"].value = "mimo-key-updated";
  elements["paper-outline-model"].value = "mimo-v2.5-pro";
  elements["paper-outline-api-key"].trigger("input");
  elements["paper-outline-provider"].value = "deepseek";
  elements["paper-outline-provider"].trigger("command");
  assert.equal(elements["paper-outline-api-key"].value, "ds-key-updated");
  assert.equal(elements["paper-outline-model"].value, "deepseek-custom");
  assert.equal(elements["paper-outline-api-url"].value, "https://ds-proxy.example/v1/chat/completions");

  elements["paper-outline-provider"].value = "mimo";
  elements["paper-outline-provider"].trigger("command");
  assert.equal(elements["paper-outline-api-key"].value, "mimo-key-updated");
  assert.equal(elements["paper-outline-model"].value, "mimo-v2.5-pro");
  assert.equal(prefs["extensions.paperoutline.apiKey"], "mimo-key-updated");

  await ui.testConnection();
  assert.equal(tested().provider, "mimo");
  assert.equal(tested().key, "mimo-key-updated");
  assert.equal(tested().model, "mimo-v2.5-pro");
  assert.equal(tested().url, "https://api.xiaomimimo.com/v1/chat/completions");

  elements["paper-outline-api-key"].value = "";
  elements["paper-outline-model"].value = "";
  elements["paper-outline-api-url"].value = "";
  elements["paper-outline-api-key"].trigger("input");
  elements["paper-outline-provider"].value = "deepseek";
  elements["paper-outline-provider"].trigger("command");
  elements["paper-outline-provider"].value = "mimo";
  elements["paper-outline-provider"].trigger("command");
  assert.equal(elements["paper-outline-api-key"].value, "");
  assert.equal(elements["paper-outline-model"].value, "");
  assert.equal(elements["paper-outline-api-url"].value, "");
});

test("深度思考位于模型下方，三个 provider 字段不再直接绑定全局偏好", () => {
  const xhtml = fs.readFileSync(path.join(__dirname, "..", "preferences.xhtml"), "utf8");
  const modelIndex = xhtml.indexOf('id="paper-outline-model"');
  const thinkingIndex = xhtml.indexOf('id="paper-outline-deep-thinking"');
  const detailsIndex = xhtml.indexOf('id="paper-outline-api-details"');
  assert.ok(modelIndex >= 0 && modelIndex < thinkingIndex);
  assert.ok(thinkingIndex < detailsIndex);
  assert.equal((xhtml.match(/id="paper-outline-deep-thinking"/g) || []).length, 1);
  assert.doesNotMatch(xhtml, /preference="extensions\.paperoutline\.(?:apiKey|apiUrl|model)"/);
});
