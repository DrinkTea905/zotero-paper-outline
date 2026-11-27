const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadPaperOutline(options = {}) {
  const prefs = Object.assign({}, options.prefs || {});
  const zotero = Object.assign(
    {
      Prefs: {
        get(name) {
          return prefs[name.replace("extensions.paperoutline.", "")];
        },
        set(name, value) {
          prefs[name.replace("extensions.paperoutline.", "")] = value;
        },
        clear(name) {
          delete prefs[name.replace("extensions.paperoutline.", "")];
        },
      },
      HTTP: {
        request:
          options.request ||
          (async () => {
            throw new Error("unexpected HTTP request");
          }),
      },
      DataDirectory: { dir: "/mock-zotero-data" },
      debug() {},
      launchURL() {},
      getMainWindow() {
        return options.mainWindow || null;
      },
      getMainWindows() {
        return options.mainWindow ? [options.mainWindow] : [];
      },
    },
    options.zotero || {}
  );

  const source = fs.readFileSync(path.join(ROOT, "paperOutline.js"), "utf8");
  const context = vm.createContext({
    Zotero: zotero,
    Services: options.Services || {},
    IOUtils: options.IOUtils,
    PathUtils: options.PathUtils || {
      join: (...parts) => parts.join("/"),
      tempDir: "/tmp",
    },
    console,
    Map,
    Set,
    URL,
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(source, context, { filename: "paperOutline.js" });
  return { outline: context.PaperOutline, prefs, zotero, context };
}

class MockUIElement {
  constructor(tag = "div", value = "") {
    this.tagName = tag;
    this.value = value;
    this.checked = false;
    this.disabled = false;
    this.open = false;
    this.hidden = false;
    this.type = tag === "input" ? "password" : "";
    this.dataset = {};
    this.className = "";
    this.textContent = "";
    this.label = "";
    this.placeholder = "";
    this.listeners = {};
    this.children = [];
    this.attributes = {};
    this.focused = false;
  }

  get firstChild() {
    return this.children[0] || null;
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  removeChild(child) {
    const idx = this.children.indexOf(child);
    if (idx >= 0) this.children.splice(idx, 1);
    return child;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  getAttribute(name) {
    return this.attributes[name] || null;
  }

  addEventListener(type, fn) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(fn);
  }

  dispatchEvent(event) {
    for (const fn of this.listeners[event.type] || []) fn(event);
  }

  trigger(type) {
    this.dispatchEvent({ type, target: this });
  }

  focus() {
    this.focused = true;
  }
}

function loadPreferencesWithCore(options = {}) {
  const { outline, prefs } = loadPaperOutline(options);
  const fullPrefs = {};
  for (const [k, v] of Object.entries(prefs)) {
    fullPrefs["extensions.paperoutline." + k] = v;
  }
  const zotero = {
    PaperOutlineGPT: options.apiOverride ? Object.assign(outline, options.apiOverride) : outline,
    Prefs: {
      get(name) {
        return fullPrefs[name];
      },
      set(name, value) {
        fullPrefs[name] = value;
        prefs[name.replace("extensions.paperoutline.", "")] = value;
      },
      clear(name) {
        delete fullPrefs[name];
        delete prefs[name.replace("extensions.paperoutline.", "")];
      },
    },
    launchURL() {},
    debug() {},
  };
  // Re-bind PaperOutline's Zotero.Prefs to the shared store
  outline.pref = function (key, fallback) {
    const v = zotero.Prefs.get("extensions.paperoutline." + key, true);
    return v === undefined || v === null || v === "" ? fallback : v;
  };

  const elements = {
    "paper-outline-provider": new MockUIElement("menulist", fullPrefs["extensions.paperoutline.provider"] || "deepseek"),
    "paper-outline-api-key": new MockUIElement("input", ""),
    "po-api-key-toggle": new MockUIElement("button", ""),
    "paper-outline-key-hint": new MockUIElement("p", ""),
    "paper-outline-model": new MockUIElement("input", ""),
    "po-fetch-models-btn": new MockUIElement("button", ""),
    "po-model-picker": new MockUIElement("select", ""),
    "po-model-fetch-status": new MockUIElement("p", ""),
    "paper-outline-model-hint": new MockUIElement("p", ""),
    "paper-outline-deep-thinking": new MockUIElement("input", ""),
    "paper-outline-deep-thinking-desc": new MockUIElement("p", ""),
    "paper-outline-api-details": new MockUIElement("details", ""),
    "paper-outline-api-url": new MockUIElement("input", ""),
    "paper-outline-test-button": new MockUIElement("button", ""),
    "paper-outline-test-status": new MockUIElement("div", ""),
    "paper-outline-mineru-token": new MockUIElement("input", ""),
    "po-mineru-token-toggle": new MockUIElement("button", ""),
    "paper-outline-mineru-test-button": new MockUIElement("button", ""),
    "paper-outline-mineru-status": new MockUIElement("div", ""),
    "paper-outline-mineru-auto-upload": new MockUIElement("input", ""),
    "paper-outline-auto-summary": new MockUIElement("input", ""),
    "paper-outline-auto-outline": new MockUIElement("input", ""),
    "paper-outline-despace-button": new MockUIElement("input", ""),
    "paper-outline-copy-file": new MockUIElement("input", ""),
    "paper-outline-trim-references": new MockUIElement("input", ""),
    "paper-outline-save-as-note": new MockUIElement("input", ""),
    "paper-outline-outline-prompt": new MockUIElement("textarea", ""),
    "po-summary-preset": new MockUIElement("menulist", "humanities"),
    "paper-outline-summary-prompt": new MockUIElement("textarea", ""),
    "paper-outline-prompt-reset-status": new MockUIElement("p", ""),
    "po-clear-mineru-cache-btn": new MockUIElement("button", ""),
  };
  elements["po-model-picker"].hidden = true;
  elements["po-model-fetch-status"].hidden = true;

  const alerts = [];
  const confirms = [];
  const windowObj = {
    alert(msg) {
      alerts.push(msg);
    },
    confirm(msg) {
      confirms.push(msg);
      return options.confirmResult !== undefined ? options.confirmResult : true;
    },
  };
  const documentObj = {
    activeElement: null,
    getElementById: (id) => elements[id] || null,
    createElementNS: (_ns, tag) => new MockUIElement(tag),
    createElement: (tag) => new MockUIElement(tag),
  };

  const source = fs.readFileSync(path.join(ROOT, "preferences.js"), "utf8");
  const ctx = vm.createContext({
    Zotero: zotero,
    document: documentObj,
    window: windowObj,
    Event: class Event {
      constructor(type) {
        this.type = type;
      }
    },
    Set,
  });
  vm.runInContext(source, ctx, { filename: "preferences.js" });
  return {
    ui: ctx.window.PaperOutlinePrefsUI,
    outline,
    elements,
    fullPrefs,
    alerts,
    confirms,
    documentObj,
  };
}

// ═══════════════════════════════════════════════════════════════
// 1. 4 层防失效动态模型机制
// ═══════════════════════════════════════════════════════════════

test("MiMo /models 自动追新：优先选最新 flash，升级至 v3 自动追新不守旧", () => {
  const { outline } = loadPaperOutline();
  assert.equal(
    outline._chooseAvailableModel(
      "mimo",
      ["mimo-v2.5", "mimo-v2.6-pro", "mimo-v2.6-flash", "mimo-v2.6-pro-ultraspeed"],
      "mimo-v2.6-flash"
    ),
    "mimo-v2.6-flash"
  );
  assert.equal(
    outline._chooseAvailableModel("mimo", ["mimo-v2.6-flash", "mimo-v3-flash"], "mimo-v2.6-flash"),
    "mimo-v3-flash"
  );
});

test("国内各服务商自动追新选型并过滤非对话模型（embedding/rerank/ocr/video/flux/tts）", () => {
  const { outline } = loadPaperOutline();

  assert.equal(
    outline._chooseAvailableModel(
      "deepseek",
      ["deepseek-chat", "deepseek-reasoner", "deepseek-flash", "deepseek-ocr"],
      "deepseek-flash"
    ),
    "deepseek-flash"
  );
  assert.equal(
    outline._chooseAvailableModel(
      "moonshot",
      ["moonshot-v1-8k", "kimi-k2.6", "kimi-k3.1-pro", "kimi-tts-1"],
      "kimi-k2.6"
    ),
    "kimi-k3.1-pro"
  );
  assert.equal(
    outline._chooseAvailableModel(
      "zhipu",
      ["glm-4-flash", "glm-4.7-flash", "glm-5.3-flash", "glm-4v-plus", "cogvideo-3", "embedding-3"],
      "glm-4.7-flash"
    ),
    "glm-5.3-flash"
  );
  assert.equal(
    outline._chooseAvailableModel(
      "qwen",
      ["qwen-turbo", "qwen-plus", "qwen-vl-max", "qwen-tts", "text-embedding-v3"],
      "qwen-plus"
    ),
    "qwen-plus"
  );
  assert.equal(
    outline._chooseAvailableModel(
      "qwen",
      ["qwen-plus", "qwen-flash", "qwen-ocr"],
      "qwen-plus"
    ),
    "qwen-flash"
  );
  assert.equal(
    outline._chooseAvailableModel(
      "siliconflow",
      [
        "BAAI/bge-m3",
        "BAAI/bge-reranker-v2-m3",
        "black-forest-labs/FLUX.1-dev",
        "deepseek-ai/DeepSeek-V3",
        "deepseek-ai/DeepSeek-V3.2",
        "Qwen/Qwen2.5-72B-Instruct",
      ],
      "deepseek-ai/DeepSeek-V3.2"
    ),
    "deepseek-ai/DeepSeek-V3.2"
  );
  assert.equal(
    outline._chooseAvailableModel(
      "ollama",
      ["nomic-embed-text", "bge-rerank", "llama3.1:8b", "qwen2.5:7b", "qwen3:8b"],
      "qwen3"
    ),
    "qwen3:8b"
  );
});

test("listAvailableModels 返回标准结构、按 Key 哈希隔离缓存并写入 _modelMetaCache", async () => {
  let calls = 0;
  const { outline } = loadPaperOutline({
    request: async (_method, _url, opts) => {
      calls += 1;
      const auth = opts.headers.Authorization || "";
      if (auth === "Bearer key-A") {
        return {
          responseText: JSON.stringify({
            data: [
              { id: "mimo-v2.6-flash", context_length: 524288 },
              { id: "mimo-v3-flash", max_model_len: 2097152 },
              { id: "mimo-tts-1", context_length: 8192 },
            ],
          }),
        };
      }
      return {
        responseText: JSON.stringify({
          data: [{ id: "mimo-v2.6-pro", context_length: 1048576 }],
        }),
      };
    },
  });

  const first = await outline.listAvailableModels({ provider: "mimo", key: "key-A" }, false);
  assert.deepEqual(plain(first), {
    models: ["mimo-v2.6-flash", "mimo-v3-flash"],
    recommended: "mimo-v3-flash",
    provider: "mimo",
    url: "https://api.xiaomimimo.com/v1/models",
  });
  assert.equal(calls, 1);

  // 同 Key 走缓存不重复请求
  const cached = await outline.listAvailableModels({ provider: "mimo", key: "key-A" }, false);
  assert.equal(calls, 1);
  assert.deepEqual(plain(cached.models), ["mimo-v2.6-flash", "mimo-v3-flash"]);

  // 不同 Key 独立隔离缓存
  const second = await outline.listAvailableModels({ provider: "mimo", key: "key-B" }, false);
  assert.equal(calls, 2);
  assert.equal(second.recommended, "mimo-v2.6-pro");

  // force=true 强制刷新
  await outline.listAvailableModels({ provider: "mimo", key: "key-A" }, true);
  assert.equal(calls, 3);

  // _modelMetaCache 已提取上下文长度并优先于家族正则
  assert.equal(outline._contextWindowTokens({ model: "mimo-v3-flash", provider: "mimo" }), 2097152);
  assert.equal(outline._contextWindowTokens({ model: "mimo-v2.6-flash", provider: "mimo" }), 524288);
});

test("动态上下文窗口优先级（元数据 → 家族正则 → 服务商默认）与中英加权 Token 估算", () => {
  const { outline } = loadPaperOutline();
  outline._modelMetaCache = new Map([["custom-super-model", { contextTokens: 300000 }]]);

  // 1) 元数据最高优先级
  assert.equal(
    outline._contextWindowTokens({ model: "custom-super-model", modelIsCustom: true, contextTokens: 128000 }),
    300000
  );
  // 2) 家族正则
  assert.equal(outline._contextWindowTokens({ model: "kimi-k3.1-pro", modelIsCustom: true }), 1048576);
  assert.equal(outline._contextWindowTokens({ model: "glm-5.3-flash", modelIsCustom: true }), 200000);
  // 3) 服务商默认（非自定义模型时兜底）
  assert.equal(
    outline._contextWindowTokens({ model: "brand-new-alias", modelIsCustom: false, contextTokens: 256000 }),
    256000
  );
  assert.equal(
    outline._contextWindowTokens({ model: "brand-new-alias", modelIsCustom: true, contextTokens: 256000 }),
    0
  );

  // 中英加权 Token 估算
  assert.equal(outline._estimatePromptTokens(""), 0);
  assert.equal(outline._estimatePromptTokens("论文标题"), Math.ceil(4 * 1.15)); // 5
  assert.equal(outline._estimatePromptTokens("hello world"), Math.ceil(11 * 0.35)); // 4
  assert.equal(outline._estimatePromptTokens("中文abc"), Math.ceil(2 * 1.15 + 3 * 0.35)); // 4
});

test("运行期自愈：thinkingStyle 4 种协议、kimi-k3 省略 temperature、400 降级重试、<think> 剥离", async () => {
  const { outline, prefs } = loadPaperOutline({ prefs: { deepThinking: true } });

  // 1) 四种 thinkingStyle
  const pObj = {};
  outline._applyThinkingPreference(pObj, outline._resolveAI({ provider: "deepseek" }), "summary");
  assert.deepEqual(plain(pObj.thinking), { type: "enabled" });

  const pEnable = {};
  outline._applyThinkingPreference(pEnable, outline._resolveAI({ provider: "qwen" }), "summary");
  assert.equal(pEnable.enable_thinking, true);

  const pReason = {};
  outline._applyThinkingPreference(pReason, outline._resolveAI({ provider: "moonshot" }), "summary");
  assert.equal(pReason.reasoning_effort, "high");

  const pNone = {};
  outline._applyThinkingPreference(pNone, outline._resolveAI({ provider: "siliconflow" }), "summary");
  assert.deepEqual(pNone, {});

  // 关闭时各自输出关闭形态
  prefs.deepThinking = false;
  const pReasonOff = {};
  outline._applyThinkingPreference(pReasonOff, outline._resolveAI({ provider: "moonshot" }), "summary");
  assert.equal(pReasonOff.reasoning_effort, "low");
  const pEnableOff = {};
  outline._applyThinkingPreference(pEnableOff, outline._resolveAI({ provider: "qwen" }), "summary");
  assert.equal(pEnableOff.enable_thinking, false);

  // 2) kimi-k3* 默认省略 temperature
  const pKimi3 = { model: "kimi-k3-pro" };
  outline._applyTemperature(pKimi3, { model: "kimi-k3-pro" }, 0.2);
  assert.equal(Object.hasOwn(pKimi3, "temperature"), false);
  const pNormal = { model: "kimi-k2.6" };
  outline._applyTemperature(pNormal, { model: "kimi-k2.6" }, 0.2);
  assert.equal(pNormal.temperature, 0.2);

  // 3) 400 参数拒绝错误自动剥离冲突字段重试
  const attempts = [];
  outline._post = async (_url, _headers, payload) => {
    attempts.push(JSON.parse(JSON.stringify(payload)));
    if (attempts.length === 1) {
      const err = new Error("bad request");
      err.status = 400;
      err.body = "temperature and thinking parameter is not supported";
      throw err;
    }
    if (attempts.length === 2) {
      const err = new Error("bad request");
      err.status = 400;
      err.body = "response_format json_object not supported; use max_completion_tokens instead of max_tokens";
      throw err;
    }
    return { choices: [{ message: { content: "<think>内部推理\n多行</think>\n最终正文" } }] };
  };

  const res = await outline._postWithParamFallback(
    "https://api.deepseek.com/chat/completions",
    {},
    {
      model: "deepseek-flash",
      temperature: 0.2,
      thinking: { type: "disabled" },
      response_format: { type: "json_object" },
      max_tokens: 128,
      messages: [],
    }
  );
  assert.equal(attempts.length, 3);
  assert.equal(Object.hasOwn(attempts[1], "temperature"), false);
  assert.equal(Object.hasOwn(attempts[1], "thinking"), false);
  assert.equal(Object.hasOwn(attempts[2], "response_format"), false);
  assert.equal(Object.hasOwn(attempts[2], "max_tokens"), false);
  assert.equal(attempts[2].max_completion_tokens, 128);

  // 4) <think>...</think> 剥离
  assert.equal(
    outline._stripThinkingTags(res.choices[0].message.content),
    "最终正文"
  );
  assert.equal(
    outline._stripThinkingTags("  <think>a</think>\n<think>b</think>正文<keep>"),
    "正文<keep>"
  );
});

test("callAI 遇自定义旧模型 404 时沿用原 provider/url/key 刷新热切换兜底", async () => {
  const requests = [];
  const { outline } = loadPaperOutline({
    prefs: {
      provider: "moonshot",
      providerConfigsMigrated: true,
      "providerConfig.moonshot.apiKey": "kimi-secret",
      "providerConfig.moonshot.apiUrl": "https://api.moonshot.cn/v1/chat/completions",
      "providerConfig.moonshot.model": "moonshot-v1-old-custom",
    },
    request: async (method, url, opts) => {
      requests.push({ method, url, opts });
      if (method === "GET") {
        assert.equal(url, "https://api.moonshot.cn/v1/models");
        assert.equal(opts.headers.Authorization, "Bearer kimi-secret");
        return {
          responseText: JSON.stringify({
            data: [{ id: "kimi-k2.6" }, { id: "kimi-k3-pro" }],
          }),
        };
      }
      const body = JSON.parse(opts.body);
      if (body.model === "moonshot-v1-old-custom") {
        const err = new Error("model not found");
        err.xmlhttp = { status: 404, responseText: "model not found: moonshot-v1-old-custom" };
        throw err;
      }
      // 切换到 kimi-k3-pro 后自动删除 temperature
      assert.equal(body.model, "kimi-k3-pro");
      assert.equal(Object.hasOwn(body, "temperature"), false);
      return {
        responseText: JSON.stringify({
          choices: [{ message: { content: "<think>思考中</think>真实结果" } }],
        }),
      };
    },
  });

  const out = await outline.callAI("sys", "user", { json: false });
  assert.equal(out, "真实结果");
  assert.equal(requests.filter((r) => r.method === "GET").length, 1);
  assert.equal(requests.filter((r) => r.method === "POST").length, 2);
});

test("_migratePrefs 无损迁移旧 openai 配置至 custom、清除旧明文 key 并清理已下线默认模型", () => {
  const { outline, prefs } = loadPaperOutline({
    prefs: {
      provider: "openai",
      "openai.apiKey": "sk-legacy-plain",
      "providerConfig.openai.apiKey": "sk-oa-scoped",
      "providerConfig.openai.model": "gpt-4o",
      "providerConfig.openai.apiUrl": "",
      "providerConfig.mimo.model": "mimo-v2.5",
      "providerConfig.mimo.apiUrl": "",
      "providerConfig.moonshot.model": "moonshot-v1-8k",
      "providerConfig.moonshot.apiUrl": "https://api.moonshot.cn/v1/chat/completions",
      "providerConfig.deepseek.model": "deepseek-chat",
      "providerConfig.deepseek.apiUrl": "https://proxy.custom.example/v1/chat/completions",
      providerConfigsMigrated: true,
    },
  });

  outline._migratePrefs();

  assert.equal(prefs.provider, "custom");
  assert.equal(prefs["providerConfig.custom.apiKey"], "sk-oa-scoped");
  assert.equal(prefs["providerConfig.custom.model"], "gpt-4o");
  assert.equal(prefs["providerConfig.custom.apiUrl"], "https://api.openai.com/v1/chat/completions");
  assert.equal(prefs["openai.apiKey"], undefined);
  assert.equal(prefs["providerConfig.openai.apiKey"], undefined);
  // 官方端点的已下线默认模型被清空
  assert.equal(prefs["providerConfig.mimo.model"], "");
  assert.equal(prefs["providerConfig.moonshot.model"], "");
  // 自定义中转地址下的旧别名保留不被误删
  assert.equal(prefs["providerConfig.deepseek.model"], "deepseek-chat");
});

// ═══════════════════════════════════════════════════════════════
// 2. 设置界面联调
// ═══════════════════════════════════════════════════════════════

test("设置界面：单一数据源读取 PROVIDERS、拉取并选择模型、恢复自动、切服务商重置", async () => {
  let fetchCalledWith = null;
  const { ui, elements, outline } = loadPreferencesWithCore({
    prefs: {
      provider: "mimo",
      providerConfigsMigrated: true,
      "providerConfig.mimo.apiKey": "mimo-key",
    },
    apiOverride: {
      async listAvailableModels(opts, force) {
        fetchCalledWith = { opts, force };
        return {
          models: ["mimo-v2.6-flash", "mimo-v3-flash"],
          recommended: "mimo-v3-flash",
          provider: opts.provider,
          url: "https://api.xiaomimimo.com/v1/models",
        };
      },
    },
  });

  // 修改核心 PROVIDERS 验证 UI 从单一数据源读取
  outline.PROVIDERS.mimo.model = "mimo-v9-single-source";
  ui.init();
  assert.match(elements["paper-outline-model-hint"].textContent, /mimo-v9-single-source/);

  // 点击拉取模型
  await ui.fetchModels();
  assert.equal(fetchCalledWith.force, true);
  assert.equal(fetchCalledWith.opts.provider, "mimo");
  const picker = elements["po-model-picker"];
  assert.equal(picker.hidden, false);
  assert.equal(picker.children.length, 3);
  assert.equal(picker.children[0].value, "");
  assert.match(picker.children[0].textContent, /自动选择最新.*mimo-v3-flash/);
  assert.equal(picker.children[2].value, "mimo-v3-flash");
  assert.match(picker.children[2].textContent, /推荐/);

  // 选择指定模型
  picker.value = "mimo-v2.6-flash";
  picker.trigger("change");
  assert.equal(elements["paper-outline-model"].value, "mimo-v2.6-flash");
  assert.match(elements["po-model-fetch-status"].textContent, /已选择模型：mimo-v2\.6-flash/);

  // 选回“自动选择最新”清空输入框
  picker.value = "";
  picker.trigger("change");
  assert.equal(elements["paper-outline-model"].value, "");
  assert.match(elements["po-model-fetch-status"].textContent, /已恢复自动追新模式/);

  // 切换服务商重置下拉框
  elements["paper-outline-provider"].value = "deepseek";
  elements["paper-outline-provider"].trigger("command");
  assert.equal(picker.hidden, true);
  assert.equal(picker.children.length, 0);
  assert.equal(elements["po-model-fetch-status"].hidden, true);
});

test("设置界面：密钥显隐切换、MinerU Token input 实时同步防误报、总结预设切换与恢复、trimReferences 与清缓存联动", async () => {
  let clearMineruCalled = 0;
  const { ui, elements, fullPrefs, alerts, confirms, outline } = loadPreferencesWithCore({
    prefs: {
      provider: "deepseek",
      providerConfigsMigrated: true,
      trimReferences: true,
      summaryPreset: "humanities",
    },
    apiOverride: {
      async clearMineruCacheUI() {
        clearMineruCalled += 1;
      },
    },
  });

  ui.init();

  // 1) API Key 与 MinerU Token 显隐切换
  const keyInput = elements["paper-outline-api-key"];
  const keyToggle = elements["po-api-key-toggle"];
  assert.equal(keyInput.type, "password");
  keyToggle.trigger("click");
  assert.equal(keyInput.type, "text");
  assert.equal(keyToggle.textContent, "隐藏");
  assert.equal(keyToggle.getAttribute("aria-pressed"), "true");
  keyToggle.trigger("click");
  assert.equal(keyInput.type, "password");
  assert.equal(keyToggle.textContent, "显示");
  assert.equal(keyToggle.getAttribute("aria-pressed"), "false");

  const mineruInput = elements["paper-outline-mineru-token"];
  const mineruToggle = elements["po-mineru-token-toggle"];
  mineruToggle.trigger("click");
  assert.equal(mineruInput.type, "text");
  assert.equal(mineruToggle.textContent, "隐藏");

  // 2) MinerU Token 粘贴仅触发 input（未失焦）后立即勾选自动上传，不应误报未填 Token
  mineruInput.value = "mineru-token-live-123";
  mineruInput.trigger("input");
  assert.equal(fullPrefs["extensions.paperoutline.mineruToken"], "mineru-token-live-123");
  const autoUpload = elements["paper-outline-mineru-auto-upload"];
  autoUpload.checked = true;
  autoUpload.trigger("change");
  assert.equal(alerts.length, 0);
  assert.equal(confirms.length, 1);
  assert.equal(fullPrefs["extensions.paperoutline.mineruAutoUpload"], true);

  // 3) 总结预设切换：同步更新 textarea 与 prefs，且内容严格匹配对应预设
  const presetEl = elements["po-summary-preset"];
  const summaryArea = elements["paper-outline-summary-prompt"];
  const outlineArea = elements["paper-outline-outline-prompt"];
  presetEl.value = "stem";
  presetEl.trigger("command");
  assert.equal(summaryArea.value, outline.SUMMARY_PROMPT_PRESETS.stem);
  assert.equal(fullPrefs["extensions.paperoutline.summaryPreset"], "stem");
  assert.equal(fullPrefs["extensions.paperoutline.summaryPrompt"], outline.SUMMARY_PROMPT_PRESETS.stem);

  presetEl.value = "brief";
  presetEl.trigger("change");
  assert.equal(summaryArea.value, outline.SUMMARY_PROMPT_PRESETS.brief);

  // 改脏后点击「恢复默认」应恢复默认目录提示词 + 当前选中预设（brief）的总结提示词
  outlineArea.value = "dirty outline";
  summaryArea.value = "dirty summary";
  ui.restoreDefaultPrompts();
  assert.equal(outlineArea.value, outline.DEFAULT_PROMPT);
  assert.equal(summaryArea.value, outline.SUMMARY_PROMPT_PRESETS.brief);

  // 4) trimReferences 开关联动
  const trimBox = elements["paper-outline-trim-references"];
  assert.equal(trimBox.checked, true);
  trimBox.checked = false;
  trimBox.trigger("change");
  assert.equal(fullPrefs["extensions.paperoutline.trimReferences"], false);

  // 5) clearMineruCache 按钮可见并触发核心清理接口
  assert.equal(elements["po-clear-mineru-cache-btn"].hidden, false);
  await ui.clearMineruCache();
  assert.equal(clearMineruCalled, 1);
});

// ═══════════════════════════════════════════════════════════════
// 3. P0/P1 Bug 修复与生命周期验证
// ═══════════════════════════════════════════════════════════════

test("testMineruConnection：断网/500/非 JSON 必须抛错，仅合法业务错误码视为鉴权通过", async () => {
  // 1) status === 0（断网/超时）必须抛错
  {
    const { outline } = loadPaperOutline({
      request: async () => {
        const err = new Error("NetworkError");
        err.xmlhttp = { status: 0, responseText: "" };
        throw err;
      },
    });
    await assert.rejects(() => outline.testMineruConnection({ token: "t1" }), /无法连接 MinerU/);
  }
  // 2) HTTP 500 必须抛错（无论响应体是否含业务错误码）
  {
    const { outline } = loadPaperOutline({
      request: async () => {
        const err = new Error("500");
        err.xmlhttp = { status: 500, responseText: JSON.stringify({ msg: "Internal Server Error" }) };
        throw err;
      },
    });
    await assert.rejects(() => outline.testMineruConnection({ token: "t1" }), /暂时不可用|500/);
  }
  {
    const { outline } = loadPaperOutline({
      request: async () => {
        const err = new Error("500");
        err.xmlhttp = { status: 500, responseText: JSON.stringify({ code: -60012, msg: "err" }) };
        throw err;
      },
    });
    await assert.rejects(() => outline.testMineruConnection({ token: "t1" }));
  }
  // 3) 非 JSON 响应（如代理拦截 HTML 页面）必须抛错
  {
    const { outline } = loadPaperOutline({
      request: async () => ({ status: 200, responseText: "<html>Proxy Blocked</html>" }),
    });
    await assert.rejects(() => outline.testMineruConnection({ token: "t1" }), /不是有效 JSON/);
  }
  // 4) 合法业务错误码（-60012 任务不存在）说明鉴权通过
  {
    const { outline } = loadPaperOutline({
      request: async () => {
        const err = new Error("not found");
        err.xmlhttp = { status: 404, responseText: JSON.stringify({ code: -60012, msg: "task not found" }) };
        throw err;
      },
    });
    const res = await outline.testMineruConnection({ token: "valid-token" });
    assert.match(res.dateText, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(res.daysLeft > 0);
  }
});

test("_splitText 传入 0 / 负数不会死循环", () => {
  const { outline } = loadPaperOutline();
  const sample = "甲".repeat(5000);
  const chunksZero = outline._splitText(sample, 0);
  const chunksNeg = outline._splitText(sample, -100);
  assert.ok(chunksZero.length >= 1);
  assert.equal(chunksZero.join(""), sample);
  assert.ok(chunksNeg.length >= 1);
  assert.equal(chunksNeg.join(""), sample);
});

test("_post 429/503 指数退避重试成功，_pool 分块最终失败必须抛错绝不返回残缺目录", async () => {
  let postAttempts = 0;
  const sleeps = [];
  const { outline } = loadPaperOutline({
    request: async () => {
      postAttempts += 1;
      if (postAttempts === 1) {
        const err = new Error("rate limit");
        err.xmlhttp = { status: 429, responseText: "Too Many Requests" };
        throw err;
      }
      if (postAttempts === 2) {
        const err = new Error("unavailable");
        err.xmlhttp = { status: 503, responseText: "Service Unavailable" };
        throw err;
      }
      return { responseText: JSON.stringify({ ok: true }) };
    },
  });
  outline._sleep = async (ms) => {
    sleeps.push(ms);
  };

  const data = await outline._post("https://api.deepseek.com/chat/completions", {}, { model: "deepseek-flash" });
  assert.deepEqual(plain(data), { ok: true });
  assert.equal(postAttempts, 3);
  assert.equal(sleeps.length, 2);
  assert.ok(sleeps[1] > sleeps[0], "backoff delay should increase");

  // _pool 分块失败必须抛错
  await assert.rejects(
    () =>
      outline._pool(["c1", "c2", "c3"], 2, async (chunk, idx) => {
        if (idx === 1) throw new Error("chunk 2 timeout");
        return [{ level: 1, title: chunk }];
      }),
    /chunk 2 timeout/
  );
});

test("英文论文 rawTitle 在 _fillPages 中精确匹配英文 PDF 页码并跳过前置目录页", async () => {
  const { outline } = loadPaperOutline();
  const pages = [
    "Table of Contents\n1. Introduction .... 2\n2. Methodology .... 4\n3. Experimental Results .... 6",
    "1. Introduction\nThis paper investigates neural scaling laws in detail.",
    "Continued background discussion.",
    "2. Methodology\nWe introduce a novel multi-stage distillation pipeline.",
    "Ablation details and hyperparameters.",
    "3. Experimental Results\nOur approach outperforms strong baselines across all benchmarks.",
  ];
  const entries = [
    { level: 1, title: "一、引言", rawTitle: "1. Introduction", summary: "介绍背景", page: 1 },
    { level: 1, title: "二、研究方法", rawTitle: "2. Methodology", summary: "方法设计", page: 1 },
    { level: 1, title: "三、实验结果", rawTitle: "3. Experimental Results", summary: "实验对比", page: 1 },
  ];

  await outline._fillPages({ key: "EN1" }, null, entries, pages);
  assert.deepEqual(
    entries.map((e) => e.page),
    [2, 4, 6]
  );
});

test("缓存原子落盘（tmpPath）与损坏 JSON 自动备份 .bak 并重置", async () => {
  const files = new Map();
  const writeOpts = [];
  const copies = [];
  const mockIOUtils = {
    async exists(p) {
      return files.has(p);
    },
    async readUTF8(p) {
      return files.get(p);
    },
    async writeUTF8(p, content, opts) {
      writeOpts.push({ p, opts });
      files.set(p, content);
    },
    async copy(src, dst) {
      copies.push({ src, dst });
      files.set(dst, files.get(src));
    },
  };

  const { outline } = loadPaperOutline({ IOUtils: mockIOUtils });
  const cacheFile = outline._cachePath();

  // 1) 损坏 JSON 自动备份 .bak
  files.set(cacheFile, "{broken-json");
  await outline._loadCache();
  assert.deepEqual(plain(outline._cache), {});
  assert.equal(copies.length, 1);
  assert.equal(copies[0].dst, cacheFile + ".bak");
  assert.equal(files.get(cacheFile + ".bak"), "{broken-json");

  // 2) 写入时使用 tmpPath 原子落盘
  outline._setCache("ITEM1", [{ level: 1, title: "一、绪论", page: 1 }]);
  await outline._cacheSaveChain;
  assert.equal(writeOpts.length, 1);
  assert.equal(writeOpts[0].opts.tmpPath, cacheFile + ".tmp");
  assert.deepEqual(JSON.parse(files.get(cacheFile)).ITEM1[0].title, "一、绪论");
});

test("_stripReferencesForAI 裁掉后半段参考文献但不误裁正文前半段", () => {
  const { outline } = loadPaperOutline();

  const body = "正文内容。".repeat(200);
  const refs = "\nReferences\n[1] Smith 2020.\n[2] Doe 2021.";
  const stripped = outline._stripReferencesForAI(body + refs);
  assert.equal(stripped, body);

  const zhBody = "法史论证与史料分析。".repeat(150);
  const zhRefs = "\n参考文献\n[1] 张三：《中国法制史》。";
  assert.equal(outline._stripReferencesForAI(zhBody + zhRefs), zhBody);

  // 前半段出现 "References" 标题时不误裁
  const earlyRef = "前言。\nReferences\n" + "后续大量正文。".repeat(300);
  assert.equal(outline._stripReferencesForAI(earlyRef), earlyRef);
});

test("_mdToNoteHtml 完整渲染 Markdown 语法并安全转义 HTML 防 XSS", () => {
  const { outline } = loadPaperOutline();
  const md = [
    "# 一级标题 <script>alert(1)</script>",
    "",
    "正文含 **加粗**、*斜体*、行内代码 `<img onerror=x>` 与符号 a & b。",
    "",
    "> 引用段落含 **重点**",
    "",
    "---",
    "",
    "| 指标 | 数值 |",
    "| --- | --- |",
    "| F1 | **92.4%** |",
    "",
    "```python",
    "if a < b and c > d:",
    "    print('ok')",
    "```",
    "",
    "- 顶层项",
    "  - 嵌套子项",
    "1. 有序一",
    "2. 有序二",
  ].join("\n");

  const html = outline._mdToNoteHtml(md);
  assert.doesNotMatch(html, /<script>/i);
  assert.doesNotMatch(html, /<img\s/i);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img onerror=x&gt;/);
  assert.match(html, /a &amp; b/);
  assert.match(html, /<strong>加粗<\/strong>/);
  assert.match(html, /<em>斜体<\/em>/);
  assert.match(html, /<code[^>]*>&lt;img onerror=x&gt;<\/code>/);
  assert.match(html, /<blockquote[^>]*><p[^>]*>引用段落含 <strong>重点<\/strong><\/p><\/blockquote>/);
  assert.match(html, /<hr\/>/);
  assert.match(html, /<table[^>]*><thead><tr><th[^>]*>指标<\/th><th[^>]*>数值<\/th><\/tr><\/thead><tbody><tr><td[^>]*>F1<\/td><td[^>]*><strong>92\.4%<\/strong><\/td><\/tr><\/tbody><\/table>/);
  assert.match(html, /<pre[^>]*><code>if a &lt; b and c &gt; d:\n    print\(&#39;ok&#39;\)<\/code><\/pre>/);
  assert.match(html, /<ul><li>顶层项<\/li><ul><li>嵌套子项<\/li><\/ul><\/ul>/);
  assert.match(html, /<ol><li>有序一<\/li><li>有序二<\/li><\/ol>/);
});

test("_autoProcess 跳过已完成条目，且 context==='auto' 遇扫描件不弹阻塞 confirm", async () => {
  let getTextCalled = 0;
  let confirmCalled = 0;
  const doneItem = {
    id: 1,
    key: "DONE1",
    isRegularItem: () => true,
    getNotes: () => [101],
  };
  const scanItem = {
    id: 2,
    key: "SCAN2",
    isRegularItem: () => true,
    getNotes: () => [],
    getAttachments: () => [202],
  };
  const scanAtt = {
    id: 202,
    key: "ATT202",
    isPDFAttachment: () => true,
    attachmentText: Promise.resolve(""),
  };
  const summaryNote = {
    getNote: () => "<p>由 Paper Outline 生成 · 整篇总结</p>",
  };

  const { outline } = loadPaperOutline({
    prefs: {
      provider: "deepseek",
      providerConfigsMigrated: true,
      "providerConfig.deepseek.apiKey": "ds-key",
      autoSummary: true,
      autoOutline: true,
      mineruToken: "valid-token",
      mineruTokenSavedAt: String(Date.now()),
      mineruAutoUpload: false,
    },
    zotero: {
      Items: {
        get(id) {
          if (id === 1) return doneItem;
          if (id === 2) return scanItem;
          if (id === 101) return summaryNote;
          if (id === 202) return scanAtt;
          return null;
        },
      },
      PDFWorker: {
        getFullText: async () => {
          getTextCalled += 1;
          return { text: "" };
        },
      },
    },
  });
  outline._sleep = async () => {};
  outline._confirmMineru = () => {
    confirmCalled += 1;
    return false;
  };
  outline._cache = { DONE1: [{ level: 1, title: "已存在" }] };

  // 1) 已完成条目直接跳过，不触发 PDF 解析
  await outline._autoProcess(1);
  assert.equal(getTextCalled, 0);

  // 2) 扫描 PDF 在 auto 模式且未开启 mineruAutoUpload 时静默跳过，绝不弹阻塞 confirm
  await outline._autoProcess(2);
  assert.equal(confirmCalled, 0);
});

test("_hasReadablePdfText 识别多页仅封面有文字的扫描 PDF", () => {
  const { outline } = loadPaperOutline();
  assert.equal(outline._hasReadablePdfText("短文本", 1), false);
  // 10 页 PDF 仅首页有 120 字封面（均页 12 字 < 35）→ 判为扫描件
  assert.equal(outline._hasReadablePdfText("封面标题作者单位".repeat(15), 10), false);
  // 正常 5 页论文（均页 200 字）→ 判为可读文字层
  assert.equal(outline._hasReadablePdfText("正常论文正文内容".repeat(125), 5), true);
});

test("bootstrap.js + paperOutline.js shutdown 完整清理与 openSettings 使用 paneID", async () => {
  const calls = {
    prefUnregistered: [],
    readerUnregistered: [],
    removedIds: [],
    observerDisconnected: 0,
    eventBusOff: [],
    openedPrefPane: [],
    clickRemoved: 0,
  };

  const outlineView = { style: { display: "none" } };
  const elementsMap = {
    "paper-outline-reader": {
      remove() {
        calls.removedIds.push("paper-outline-reader");
      },
    },
    "paper-outline-style": {
      remove() {
        calls.removedIds.push("paper-outline-style");
      },
    },
    outlineView,
  };
  const readerDoc = {
    getElementById: (id) => elementsMap[id] || null,
    removeEventListener(type) {
      if (type === "click") calls.clickRemoved += 1;
    },
  };
  const fakeEventBus = {
    off(evt) {
      calls.eventBusOff.push(evt);
    },
  };
  const fakeReader = {
    type: "pdf",
    _iframeWindow: { document: readerDoc },
    _paperOutlineObserver: {
      disconnect() {
        calls.observerDisconnected += 1;
      },
    },
    _poSidebarClickDoc: readerDoc,
    _poSidebarClickHandler: () => {},
    _poEnsureEventBus: fakeEventBus,
    _poDocLoadedHandler: () => {},
    _poPageEventBus: fakeEventBus,
    _poPageChangingHandler: () => {},
  };

  const zotero = {
    initializationPromise: Promise.resolve(),
    Prefs: {
      get: () => undefined,
      set() {},
      clear() {},
    },
    PreferencePanes: {
      async register(cfg) {
        return cfg.id;
      },
      unregister(id) {
        calls.prefUnregistered.push(id);
      },
    },
    MenuManager: {
      registerMenu: (cfg) => cfg.menuID,
      unregisterMenu() {},
    },
    Reader: {
      _readers: [fakeReader],
      registerEventListener() {},
      unregisterEventListener(evt, fn) {
        calls.readerUnregistered.push({ evt, fn });
      },
    },
    Notifier: {
      registerObserver: () => "obs-1",
      unregisterObserver() {},
    },
    Utilities: {
      Internal: {
        async openPreferences(paneID) {
          calls.openedPrefPane.push(paneID);
        },
      },
    },
    DataDirectory: { dir: "/mock" },
    getMainWindows: () => [],
    getMainWindow: () => null,
    debug() {},
  };

  const bootstrapSource = fs.readFileSync(path.join(ROOT, "bootstrap.js"), "utf8");
  const coreSource = fs.readFileSync(path.join(ROOT, "paperOutline.js"), "utf8");
  const ctx = vm.createContext({
    Zotero: zotero,
    Services: {
      scriptloader: {
        loadSubScript() {
          vm.runInContext(coreSource, ctx, { filename: "paperOutline.js" });
        },
      },
    },
    IOUtils: { exists: async () => false },
    PathUtils: { join: (...p) => p.join("/") },
    console,
    Map,
    Set,
    URL,
    setTimeout,
    clearTimeout,
  });

  vm.runInContext(bootstrapSource, ctx, { filename: "bootstrap.js" });
  await ctx.startup({ id: "paper-outline@example.com", version: "1.8.0", rootURI: "chrome://po/" });

  assert.ok(zotero.PaperOutlineGPT);
  assert.equal(ctx.PaperOutline._prefPaneID, "paper-outline-prefpane");

  await ctx.PaperOutline.openSettings();
  assert.deepEqual(calls.openedPrefPane, ["paper-outline-prefpane"]);

  ctx.shutdown();

  assert.deepEqual(calls.prefUnregistered, ["paper-outline-prefpane"]);
  assert.equal(outlineView.style.display, "");
  assert.ok(calls.removedIds.includes("paper-outline-reader"));
  assert.ok(calls.removedIds.includes("paper-outline-style"));
  assert.equal(calls.observerDisconnected, 1);
  assert.equal(calls.clickRemoved, 1);
  assert.deepEqual(calls.eventBusOff.sort(), ["documentloaded", "pagechanging"]);
  assert.ok(calls.readerUnregistered.some((e) => e.evt === "renderToolbar"));
  assert.ok(calls.readerUnregistered.some((e) => e.evt === "renderSidebarAnnotationHeader"));
  assert.equal(Object.hasOwn(zotero, "PaperOutlineGPT"), false);
  assert.equal(ctx.PaperOutline, undefined);
});

test("URL 协议校验拦截公网 http:// 与 file://，放行 https:// 与本地回环", () => {
  const { outline } = loadPaperOutline();

  assert.equal(
    outline._validateApiUrl("https://api.deepseek.com/chat/completions"),
    "https://api.deepseek.com/chat/completions"
  );
  assert.equal(
    outline._validateApiUrl("http://localhost:11434/v1/chat/completions"),
    "http://localhost:11434/v1/chat/completions"
  );
  assert.equal(
    outline._validateApiUrl("http://127.0.0.1:11434/v1/chat/completions"),
    "http://127.0.0.1:11434/v1/chat/completions"
  );
  assert.throws(() => outline._validateApiUrl("http://api.example.com/v1/chat/completions"), /https:\/\//);
  assert.throws(() => outline._validateApiUrl("file:///etc/passwd"), /https:\/\//);
  assert.throws(() => outline._validateHttpsUrl("http://localhost:11434/test"), /https:\/\//);
});

test("cleanSpaces 正确清理中文间及中英间多余空格并保留英文词间空格与段落空行", () => {
  const { outline } = loadPaperOutline();
  const input = "中 文 PDF   复 制 文 字 2026 年   hello   world 结 尾\n换 行 续 接\n\n第 二 段 含 AI 模 型。";
  const expected = "中文PDF复制文字2026年hello world结尾换行续接\n\n第二段含AI模型。";
  assert.equal(outline.cleanSpaces(input), expected);
});
