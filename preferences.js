/* global Zotero */

(function () {
  const PROVIDERS = {
    deepseek: { label: "DeepSeek", model: "deepseek-v4-flash" },
    openai: { label: "OpenAI", model: "gpt-4o-mini" },
    moonshot: { label: "月之暗面 Kimi", model: "moonshot-v1-8k" },
    zhipu: { label: "智谱 GLM", model: "glm-4-flash" },
    qwen: { label: "通义千问 Qwen", model: "qwen-plus" },
    siliconflow: { label: "硅基流动 SiliconFlow", model: "deepseek-ai/DeepSeek-V3" },
    ollama: { label: "本地 Ollama", model: "qwen2.5" },
    custom: { label: "自定义服务", model: "" },
  };

  const TOGGLE_PREFERENCES = {
    "paper-outline-auto-summary": { key: "autoSummary", fallback: true },
    "paper-outline-auto-outline": { key: "autoOutline", fallback: true },
    "paper-outline-despace-button": { key: "despaceButton", fallback: true },
    "paper-outline-copy-file": { key: "copyFile", fallback: true },
    "paper-outline-save-as-note": { key: "saveAsNote", fallback: false },
  };

  function byId(id) {
    return document.getElementById(id);
  }

  function emitPreferenceChange(element) {
    try {
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    } catch (e) {}
  }

  window.PaperOutlinePrefsUI = {
    _ready: false,
    _testing: false,

    init() {
      if (this._ready) return;
      this._ready = true;
      this.bindTogglePreferences();
      this.updateProvider(false);

      [
        "paper-outline-provider",
        "paper-outline-api-key",
        "paper-outline-model",
        "paper-outline-api-url",
      ].forEach((id) => {
        const element = byId(id);
        if (!element) return;
        element.addEventListener(id === "paper-outline-provider" ? "command" : "input", () => {
          if (id === "paper-outline-provider") this.updateProvider(true);
          this.markConnectionDirty();
        });
      });
    },

    bindTogglePreferences() {
      Object.keys(TOGGLE_PREFERENCES).forEach((id) => {
        const element = byId(id);
        const setting = TOGGLE_PREFERENCES[id];
        if (!element || !setting) return;

        const prefName = "extensions.paperoutline." + setting.key;
        const current = Zotero.Prefs.get(prefName, true);
        element.checked =
          current === undefined || current === null ? setting.fallback : !!current;
        element.addEventListener("change", () => {
          Zotero.Prefs.set(prefName, !!element.checked, true);
        });
      });
    },

    updateProvider(resetKnownDefault) {
      const providerElement = byId("paper-outline-provider");
      const modelElement = byId("paper-outline-model");
      const modelHint = byId("paper-outline-model-hint");
      const keyHint = byId("paper-outline-key-hint");
      const apiDetails = byId("paper-outline-api-details");
      if (!providerElement || !modelElement) return;

      const provider = providerElement.value || "deepseek";
      const preset = PROVIDERS[provider] || PROVIDERS.deepseek;
      const knownDefaults = Object.keys(PROVIDERS)
        .map((key) => PROVIDERS[key].model)
        .filter(Boolean);

      if (
        resetKnownDefault &&
        modelElement.value &&
        knownDefaults.includes(modelElement.value) &&
        modelElement.value !== preset.model
      ) {
        modelElement.value = "";
        emitPreferenceChange(modelElement);
      }

      if (modelHint) {
        modelHint.textContent = preset.model
          ? "留空时使用默认模型：" + preset.model
          : "自定义服务需要填写模型名称。";
      }
      if (keyHint) {
        keyHint.textContent =
          provider === "ollama"
            ? "本地 Ollama 无需 API Key。"
            : provider === "custom"
              ? "如自定义接口需要鉴权，请填写 API Key。"
              : "仅保存在本机 Zotero 设置中。";
      }
      if (apiDetails && provider === "custom") apiDetails.open = true;
    },

    markConnectionDirty() {
      const status = byId("paper-outline-test-status");
      if (!status || status.dataset.state === "idle" || this._testing) return;
      this.setStatus("dirty", "配置已修改，请重新测试连接。");
    },

    setStatus(state, message) {
      const status = byId("paper-outline-test-status");
      if (!status) return;
      status.dataset.state = state;
      status.className = "paper-outline-status paper-outline-status-" + state;
      status.textContent = message;
    },

    async testConnection() {
      if (this._testing) return;
      const button = byId("paper-outline-test-button");
      const providerElement = byId("paper-outline-provider");
      const keyElement = byId("paper-outline-api-key");
      const modelElement = byId("paper-outline-model");
      const urlElement = byId("paper-outline-api-url");
      const api = Zotero && Zotero.PaperOutlineGPT;

      if (!api || typeof api.testConnection !== "function") {
        this.setStatus("error", "插件尚未完成加载，请重启 Zotero 后再试。");
        return;
      }

      this._testing = true;
      if (button) {
        button.disabled = true;
        button.label = "正在测试…";
      }
      this.setStatus("testing", "正在连接服务商并验证模型，请稍候…");

      try {
        const result = await api.testConnection({
          provider: providerElement ? providerElement.value : "deepseek",
          key: keyElement ? keyElement.value : "",
          model: modelElement ? modelElement.value : "",
          url: urlElement ? urlElement.value : "",
        });
        const providerLabel =
          (PROVIDERS[result.provider] && PROVIDERS[result.provider].label) || result.label;
        this.setStatus(
          "success",
          "连接成功 · " + providerLabel + " · " + result.model + " · " + result.elapsed + " ms"
        );
      } catch (error) {
        const message = String((error && error.message) || error || "未知错误")
          .replace(/^Error:\s*/i, "")
          .trim();
        this.setStatus("error", "连接失败：" + message);
      } finally {
        this._testing = false;
        if (button) {
          button.disabled = false;
          button.label = "测试连接";
        }
      }
    },

    restoreDefaultPrompts() {
      const api = Zotero && Zotero.PaperOutlineGPT;
      const outlinePrompt = byId("paper-outline-outline-prompt");
      const summaryPrompt = byId("paper-outline-summary-prompt");
      const status = byId("paper-outline-prompt-reset-status");

      if (!api || !api.DEFAULT_PROMPT || !api.SUMMARY_PROMPT) {
        if (status) status.textContent = "插件尚未完成加载，请重启 Zotero 后再试。";
        return;
      }

      if (outlinePrompt) {
        outlinePrompt.value = api.DEFAULT_PROMPT;
        emitPreferenceChange(outlinePrompt);
      }
      if (summaryPrompt) {
        summaryPrompt.value = api.SUMMARY_PROMPT;
        emitPreferenceChange(summaryPrompt);
      }

      // 显式写入，避免不同 Zotero 版本对 HTML textarea 的偏好绑定时机不同。
      Zotero.Prefs.set("extensions.paperoutline.prompt", api.DEFAULT_PROMPT, true);
      Zotero.Prefs.set("extensions.paperoutline.summaryPrompt", api.SUMMARY_PROMPT, true);
      if (status) status.textContent = "已恢复目录与总结的默认提示词。";
    },
  };
})();
