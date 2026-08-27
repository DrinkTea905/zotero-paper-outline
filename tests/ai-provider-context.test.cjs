const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadPaperOutline(options = {}) {
  const prefs = options.prefs || {};
  const zotero = {
    Prefs: {
      get(name) {
        return prefs[name.replace("extensions.paperoutline.", "")];
      },
    },
    HTTP: { request: options.request || (async () => { throw new Error("unexpected request"); }) },
    debug() {},
  };
  const source = fs.readFileSync(path.join(__dirname, "..", "paperOutline.js"), "utf8");
  const context = vm.createContext({ Zotero: zotero, console, Map, Set });
  vm.runInContext(source, context, { filename: "paperOutline.js" });
  return { outline: context.PaperOutline, prefs };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test("MiMo 复用现有 provider 解析与模型发现", async () => {
  const requests = [];
  const { outline } = loadPaperOutline({
    request: async (method, url, options) => {
      requests.push({ method, url, options });
      if (method === "GET") {
        return { responseText: JSON.stringify({ data: [{ id: "mimo-v2.5-pro" }, { id: "mimo-v2.5" }] }) };
      }
      return {
        responseText: JSON.stringify({ choices: [{ message: { content: "OK" } }] }),
      };
    },
  });

  const defaults = outline._resolveAI({ provider: "mimo", key: "secret", url: "", model: "" });
  assert.equal(defaults.url, "https://api.xiaomimimo.com/v1/chat/completions");
  assert.equal(defaults.model, "mimo-v2.5");
  assert.equal(defaults.modelIsCustom, false);

  const result = await outline.testConnection({
    provider: "mimo",
    key: "secret",
    url: "",
    model: "",
  });
  assert.equal(result.model, "mimo-v2.5");
  assert.equal(requests[0].method, "GET");
  assert.equal(requests[0].url, "https://api.xiaomimimo.com/v1/models");
  assert.equal(requests[0].options.headers.Authorization, "Bearer secret");
  assert.equal(requests[1].method, "POST");
  const payload = JSON.parse(requests[1].options.body);
  assert.equal(payload.model, "mimo-v2.5");
  assert.deepEqual(payload.thinking, { type: "disabled" });
  assert.equal(payload.max_completion_tokens, 32);
  assert.equal(Object.hasOwn(payload, "max_tokens"), false);

  assert.equal(
    outline._chooseAvailableModel("mimo", ["mimo-v2.5-pro", "mimo-voiceclone-7b"], "mimo-v2.5"),
    "mimo-v2.5-pro"
  );

  const overridden = outline._resolveAI({
    provider: "mimo",
    key: "secret",
    url: "https://proxy.example/v1/chat/completions",
    model: "mimo-custom",
  });
  assert.equal(overridden.url, "https://proxy.example/v1/chat/completions");
  assert.equal(overridden.model, "mimo-custom");
  assert.equal(overridden.modelIsCustom, true);
});

test("深度思考为插件级开关，仅对声明支持的 provider 生效", async () => {
  const { outline, prefs } = loadPaperOutline({ prefs: { deepThinking: false } });
  const payloads = [];
  outline._post = async (url, headers, payload) => {
    payloads.push(plain(payload));
    return { choices: [{ message: { content: "ok" } }] };
  };

  for (const provider of ["mimo", "deepseek", "openai"]) {
    const config = outline._resolveAI({ provider, key: "k", url: "", model: "" });
    await outline.callAI("system", "user", { task: "summary", json: false, config });
  }
  assert.deepEqual(payloads[0].thinking, { type: "disabled" });
  assert.deepEqual(payloads[1].thinking, { type: "disabled" });
  assert.equal(Object.hasOwn(payloads[2], "thinking"), false);

  prefs.deepThinking = true;
  const config = outline._resolveAI({ provider: "mimo", key: "k", url: "", model: "" });
  await outline.callAI("system", "user", { task: "outline", config });
  assert.deepEqual(payloads[3].thinking, { type: "enabled" });
  assert.deepEqual(payloads[3].response_format, { type: "json_object" });

  await outline.callAI("system", "user", { config });
  assert.equal(Object.hasOwn(payloads[4], "thinking"), false);
});

test("整篇总结按模型上下文动态计算，未知模型回退 60000", () => {
  const { outline } = loadPaperOutline();
  const mimo = outline._resolveAI({ provider: "mimo", key: "k", url: "", model: "" });
  const shortPromptLimit = outline._summaryInputLimit(mimo, "short", "prefix");
  const longPromptLimit = outline._summaryInputLimit(mimo, "x".repeat(10000), "prefix");
  assert.equal(outline._contextWindowTokens(mimo), 1048576);
  assert.ok(shortPromptLimit > 60000);
  assert.ok(shortPromptLimit < 1048576);
  assert.ok(longPromptLimit < shortPromptLimit);

  const openai = outline._resolveAI({ provider: "openai", key: "k", url: "", model: "" });
  assert.equal(outline._contextWindowTokens(openai), 128000);

  const unknown = outline._resolveAI({
    provider: "custom",
    key: "",
    url: "https://example.com/v1/chat/completions",
    model: "unknown-model",
  });
  assert.equal(outline._contextWindowTokens(unknown), 0);
  assert.equal(outline._summaryInputLimit(unknown, "system", "prefix"), 60000);

  const moonshot = outline._resolveAI({ provider: "moonshot", key: "k", url: "", model: "" });
  assert.throws(
    () => outline._summaryInputLimit(moonshot, "x".repeat(9000), "prefix"),
    /总结提示词过长/
  );
});

test("mimo-v2.5 总结不再把 60000 字符作为固定截断点", async () => {
  const { outline } = loadPaperOutline();
  const config = outline._resolveAI({ provider: "mimo", key: "k", url: "", model: "" });
  outline._prepareAI = async () => config;
  let userPrompt = "";
  outline.callAI = async (system, user, options) => {
    userPrompt = user;
    assert.equal(options.task, "summary");
    assert.equal(options.config, config);
    return "summary";
  };

  const fullText = "A".repeat(65000) + "RESULT_AFTER_60000" + "B".repeat(25000) + "CONCLUSION_AT_END";
  const item = { getField: () => "Long paper" };
  assert.equal(await outline.generateSummary(item, null, { fullText }), "summary");
  assert.ok(userPrompt.length > 60000);
  assert.match(userPrompt, /RESULT_AFTER_60000/);
  assert.match(userPrompt, /CONCLUSION_AT_END/);
});

test("超出未知模型 fallback 时等距保留全文各位置", () => {
  const { outline } = loadPaperOutline();
  const fullText = "A".repeat(40000) + "B".repeat(40000) + "C".repeat(40000) +
    "D".repeat(40000) + "E".repeat(40000);
  const selected = outline._textForSummary(fullText, 60000);
  assert.ok(selected.length <= 60000);
  assert.ok(selected.length > 59000);
  for (const marker of ["A", "B", "C", "D", "E"]) assert.match(selected, new RegExp(marker));
  assert.match(selected, /已等距省略部分原文/);
});

test("MiMo 目录仍走统一 JSON 请求与解析链", async () => {
  const { outline } = loadPaperOutline({ prefs: { deepThinking: false } });
  const config = outline._resolveAI({ provider: "mimo", key: "k", url: "", model: "" });
  outline._prepareAI = async () => config;
  outline._setCache = () => {};
  let sentPayload;
  outline._post = async (url, headers, payload) => {
    sentPayload = plain(payload);
    return {
      choices: [{ message: { content: '{"outline":[{"level":1,"title":"一、引言","summary":"问题"}]}' } }],
    };
  };
  const result = await outline.generateOutline(
    { key: "ITEM" },
    null,
    { fullText: "一、引言\n正文" }
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].title, "一、引言");
  assert.deepEqual(sentPayload.response_format, { type: "json_object" });
  assert.deepEqual(sentPayload.thinking, { type: "disabled" });
});

test("模型刷新重试仍保留 JSON 与深度思考设置", async () => {
  const { outline } = loadPaperOutline({ prefs: { deepThinking: false } });
  const initial = outline._resolveAI({ provider: "mimo", key: "k", url: "", model: "" });
  const sent = [];
  outline._prepareAI = async () => ({ ...initial, model: "mimo-v2.5-pro" });
  outline._post = async (url, headers, payload) => {
    sent.push(plain(payload));
    if (sent.length === 1) {
      const error = new Error("model not found");
      error.status = 404;
      error.body = "model not found";
      throw error;
    }
    return { choices: [{ message: { content: '{"outline":[]}' } }] };
  };

  await outline.callAI("system", "user", { task: "outline", config: initial });
  assert.equal(sent.length, 2);
  assert.equal(sent[1].model, "mimo-v2.5-pro");
  assert.deepEqual(sent[1].response_format, { type: "json_object" });
  assert.deepEqual(sent[1].thinking, { type: "disabled" });
});

test("设置页与默认偏好暴露 MiMo 和通用深度思考开关", () => {
  const root = path.join(__dirname, "..");
  assert.match(fs.readFileSync(path.join(root, "preferences.xhtml"), "utf8"), /value="mimo"/);
  assert.match(fs.readFileSync(path.join(root, "preferences.js"), "utf8"), /paper-outline-deep-thinking/);
  assert.match(fs.readFileSync(path.join(root, "prefs.js"), "utf8"), /deepThinking", false/);
});
