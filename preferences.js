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
    "paper-outline-mineru-auto-upload": {
      key: "mineruAutoUpload",
      fallback: false,
      confirmUpload: true,
    },
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
    _mineruTesting: false,
    _mineruTokenSnapshot: "",

    init() {
      if (this._ready) return;
      this._ready = true;
      this.bindTogglePreferences();
      this.updateProvider(false);
      this.bindMineruPreferences();

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
          if (setting.confirmUpload && element.checked) {
            const token = String(
              Zotero.Prefs.get("extensions.paperoutline.mineruToken", true) || ""
            ).trim();
            if (!token) {
              element.checked = false;
              window.alert("请先填写 MinerU Token，再开启默认上传。");
              const tokenElement = byId("paper-outline-mineru-token");
              if (tokenElement) tokenElement.focus();
              return;
            }
            const confirmed = window.confirm(
              "开启后，遇到没有可读取文字的扫描 PDF，Paper Outline 会把当前 PDF 发送至 MinerU 完成文字识别，不再逐篇询问。\n\n普通 PDF 不会上传。是否开启？"
            );
            if (!confirmed) {
              element.checked = false;
              return;
            }
          }
          Zotero.Prefs.set(prefName, !!element.checked, true);
        });
      });
    },

    bindMineruPreferences() {
      const tokenElement = byId("paper-outline-mineru-token");
      if (!tokenElement) return;

      const savedToken = String(
        Zotero.Prefs.get("extensions.paperoutline.mineruToken", true) || ""
      ).trim();
      tokenElement.value = savedToken;
      this._mineruTokenSnapshot = savedToken;

      if (
        savedToken &&
        !parseInt(
          Zotero.Prefs.get("extensions.paperoutline.mineruTokenSavedAt", true) || "0",
          10
        )
      ) {
        Zotero.Prefs.set(
          "extensions.paperoutline.mineruTokenSavedAt",
          String(Date.now()),
          true
        );
      }

      tokenElement.addEventListener("change", () => {
        const token = String(tokenElement.value || "").trim();
        Zotero.Prefs.set("extensions.paperoutline.mineruToken", token, true);
        if (token !== this._mineruTokenSnapshot) {
          Zotero.Prefs.set(
            "extensions.paperoutline.mineruTokenSavedAt",
            token ? String(Date.now()) : "0",
            true
          );
          Zotero.Prefs.set("extensions.paperoutline.mineruTokenExpired", false, true);
          Zotero.Prefs.set(
            "extensions.paperoutline.mineruExpiryReminderAt",
            "0",
            true
          );
          this._mineruTokenSnapshot = token;
        }
        this.updateMineruStatus();
      });

      this.updateMineruStatus();
    },

    setMineruStatus(state, message) {
      const status = byId("paper-outline-mineru-status");
      if (!status) return;
      status.dataset.state = state;
      status.className = "paper-outline-status paper-outline-status-" + state;
      status.textContent = message;
    },

    updateMineruStatus() {
      const api = Zotero && Zotero.PaperOutlineGPT;
      const tokenElement = byId("paper-outline-mineru-token");
      const token = String((tokenElement && tokenElement.value) || "").trim();
      if (!token) {
        this.setMineruStatus(
          "idle",
          "尚未设置 MinerU。扫描 PDF 暂时无法生成总结和目录。"
        );
        return;
      }
      if (!api || typeof api.getMineruTokenStatus !== "function") {
        this.setMineruStatus("dirty", "Token 已填写，重启 Zotero 后可检查状态。");
        return;
      }
      const status = api.getMineruTokenStatus({ token });
      if (status.state === "expired") {
        this.setMineruStatus(
          "error",
          "Token 可能已到期，请前往 MinerU 重新创建并替换。"
        );
      } else if (status.state === "warning") {
        this.setMineruStatus(
          "dirty",
          "Token 即将到期 · 按保存时间估算还剩 " +
            status.daysLeft +
            " 天（预计 " +
            status.dateText +
            " 到期）"
        );
      } else {
        this.setMineruStatus(
          "success",
          "Token 已保存 · 按保存时间估算可用至 " + status.dateText
        );
      }
    },

    async testMineruConnection() {
      if (this._mineruTesting) return;
      const button = byId("paper-outline-mineru-test-button");
      const tokenElement = byId("paper-outline-mineru-token");
      const token = String((tokenElement && tokenElement.value) || "").trim();
      const api = Zotero && Zotero.PaperOutlineGPT;

      if (!token) {
        this.setMineruStatus("error", "请先粘贴 MinerU Token。");
        if (tokenElement) tokenElement.focus();
        return;
      }
      if (!api || typeof api.testMineruConnection !== "function") {
        this.setMineruStatus("error", "插件尚未完成加载，请重启 Zotero 后再试。");
        return;
      }

      Zotero.Prefs.set("extensions.paperoutline.mineruToken", token, true);
      if (token !== this._mineruTokenSnapshot) {
        Zotero.Prefs.set(
          "extensions.paperoutline.mineruTokenSavedAt",
          String(Date.now()),
          true
        );
        Zotero.Prefs.set("extensions.paperoutline.mineruTokenExpired", false, true);
        Zotero.Prefs.set("extensions.paperoutline.mineruExpiryReminderAt", "0", true);
        this._mineruTokenSnapshot = token;
      }

      this._mineruTesting = true;
      if (button) {
        button.disabled = true;
        button.label = "正在检查…";
      }
      this.setMineruStatus("testing", "正在验证 MinerU Token，请稍候…");
      try {
        const result = await api.testMineruConnection({ token });
        this.setMineruStatus(
          "success",
          "连接成功 · 按保存时间估算可用至 " + result.dateText
        );
      } catch (error) {
        const message = String((error && error.message) || error || "未知错误")
          .replace(/^Error:\s*/i, "")
          .trim();
        this.setMineruStatus("error", "检查失败：" + message);
      } finally {
        this._mineruTesting = false;
        if (button) {
          button.disabled = false;
          button.label = "检查连接";
        }
      }
    },

    openMineruTokenPage() {
      const api = Zotero && Zotero.PaperOutlineGPT;
      if (api && typeof api.openMineruTokenPage === "function") {
        api.openMineruTokenPage();
      } else {
        Zotero.launchURL("https://mineru.net/apiManage/token");
      }
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
          ? "留空时自动查询服务商当前可用模型；查询失败时使用：" + preset.model
          : "如接口支持 /models，可留空自动查询；否则请填写模型名称。";
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
