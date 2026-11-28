/* global Zotero */

(function () {
  // 最小本地静态兜底（仅在无完整 Zotero.PaperOutlineGPT 环境的独立测试中使用）；
  // 运行期优先读取 Zotero.PaperOutlineGPT.PROVIDERS 作为单一数据源。
  const FALLBACK_PROVIDERS = {
    deepseek: {
      label: "DeepSeek（默认）",
      url: "https://api.deepseek.com/chat/completions",
      model: "deepseek-flash",
      supportsThinking: true,
    },
    mimo: {
      label: "Xiaomi MiMo",
      url: "https://api.xiaomimimo.com/v1/chat/completions",
      model: "mimo-v2.6-flash",
      supportsThinking: true,
    },
    moonshot: {
      label: "月之暗面 Kimi",
      url: "https://api.moonshot.cn/v1/chat/completions",
      model: "kimi-k2.6",
      supportsThinking: true,
    },
    zhipu: {
      label: "智谱 GLM",
      url: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
      model: "glm-4.7-flash",
      supportsThinking: true,
    },
    qwen: {
      label: "通义千问 Qwen",
      url: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
      model: "qwen-plus",
      supportsThinking: true,
    },
    siliconflow: {
      label: "硅基流动 SiliconFlow",
      url: "https://api.siliconflow.cn/v1/chat/completions",
      model: "deepseek-ai/DeepSeek-V3.2",
      supportsThinking: false,
    },
    ollama: {
      label: "本地 Ollama",
      url: "http://localhost:11434/v1/chat/completions",
      model: "qwen3",
      supportsThinking: false,
    },
    custom: {
      label: "自定义（手填 URL / 模型）",
      url: "",
      model: "",
      supportsThinking: false,
    },
  };

  const SUMMARY_PRESET_LABELS = {
    general: "通用学术",
    humanities: "人文社科 / 法史（经典）",
    stem: "理工 / 实验实证",
    brief: "极简速览",
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
    "paper-outline-trim-references": { key: "trimReferences", fallback: true },
    "paper-outline-save-as-note": { key: "saveAsNote", fallback: false },
    "paper-outline-deep-thinking": { key: "deepThinking", fallback: false },
  };

  const PROVIDER_CONFIG_FIELDS = {
    apiUrl: "paper-outline-api-url",
    apiKey: "paper-outline-api-key",
    model: "paper-outline-model",
  };
  const PROVIDER_CONFIG_PREFIX = "extensions.paperoutline.providerConfig.";

  function byId(id) {
    return document.getElementById(id);
  }

  function getCoreAPI() {
    return typeof Zotero !== "undefined" && Zotero ? Zotero.PaperOutlineGPT || null : null;
  }

  function getProviders() {
    const api = getCoreAPI();
    if (api && api.PROVIDERS && typeof api.PROVIDERS === "object") {
      return api.PROVIDERS;
    }
    return FALLBACK_PROVIDERS;
  }

  function emitPreferenceChange(element) {
    try {
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    } catch (e) {}
  }

  function isElementFocused(element) {
    try {
      return !!(element && document.activeElement === element);
    } catch (e) {
      return false;
    }
  }

  function clearElementChildren(element) {
    if (!element) return;
    if (typeof element.removeAllItems === "function") {
      element.removeAllItems();
      return;
    }
    while (element.firstChild) {
      element.removeChild(element.firstChild);
    }
  }

  function appendPickerOption(picker, label, value) {
    if (!picker) return;
    if (typeof picker.appendItem === "function") {
      picker.appendItem(label, value);
      return;
    }
    let option = null;
    if (typeof document.createElementNS === "function") {
      option = document.createElementNS("http://www.w3.org/1999/xhtml", "option");
    } else if (typeof document.createElement === "function") {
      option = document.createElement("option");
    }
    if (!option) return;
    option.value = value;
    option.textContent = label;
    if (typeof picker.appendChild === "function") {
      picker.appendChild(option);
    }
  }

  window.PaperOutlinePrefsUI = {
    _bound: false,
    _testing: false,
    _fetchingModels: false,
    _fetchSeq: 0,
    _mineruTesting: false,
    _mineruTokenSnapshot: "",
    _activeProvider: null,
    _restoringProvider: false,

    init() {
      const providerElement = byId("paper-outline-provider");
      this._activeProvider = this.normalizeProvider(
        Zotero.Prefs.get("extensions.paperoutline.provider", true) ||
          (providerElement && providerElement.value) ||
          "deepseek"
      );
      if (providerElement) providerElement.value = this._activeProvider;
      this.ensureProviderConfigMigration(this._activeProvider);
      this.restoreProviderConfig(this._activeProvider);

      if (!this._bound) {
        this._bound = true;
        this.bindTogglePreferences();
        this.bindMineruPreferences();
        this.bindSecretToggle("paper-outline-api-key", "po-api-key-toggle");
        this.bindSecretToggle("paper-outline-mineru-token", "po-mineru-token-toggle");
        this.bindModelPicker();
        this.bindSummaryPreset();

        if (providerElement) {
          providerElement.addEventListener("command", () => {
            this.switchProvider(providerElement.value);
            this.markConnectionDirty();
          });
        }
        Object.values(PROVIDER_CONFIG_FIELDS).forEach((id) => {
          const element = byId(id);
          if (!element) return;
          element.addEventListener("input", () => {
            this.saveActiveProviderConfig();
            this.markConnectionDirty();
          });
          element.addEventListener("change", () => this.saveActiveProviderConfig());
        });

        if (typeof window.addEventListener === "function") {
          window.addEventListener("pageshow", () => this.refreshDynamicState());
          window.addEventListener("focus", () => this.refreshDynamicState());
        }
      }

      this.refreshDynamicState();
    },

    refreshDynamicState() {
      this.syncToggleStates();
      this.syncSummaryPresetUI();
      this.updateProvider();
      this.syncMineruFromPrefs();
      this.updateMineruStatus();
      this.updateCacheButtons();
    },

    getProviderMeta(provider) {
      const providers = getProviders();
      const selected = this.normalizeProvider(provider);
      return providers[selected] || FALLBACK_PROVIDERS[selected] || providers.deepseek || FALLBACK_PROVIDERS.deepseek;
    },

    normalizeProvider(provider) {
      const providers = getProviders();
      return Object.prototype.hasOwnProperty.call(providers, provider) ? provider : "deepseek";
    },

    providerConfigPref(provider, key) {
      return PROVIDER_CONFIG_PREFIX + this.normalizeProvider(provider) + "." + key;
    },

    ensureProviderConfigMigration(provider) {
      if (Zotero.Prefs.get("extensions.paperoutline.providerConfigsMigrated", true) === true) {
        return;
      }
      const selected = this.normalizeProvider(provider);
      Object.keys(PROVIDER_CONFIG_FIELDS).forEach((key) => {
        const scopedName = this.providerConfigPref(selected, key);
        const existing = Zotero.Prefs.get(scopedName, true);
        if (existing === undefined || existing === null) {
          const legacy = Zotero.Prefs.get("extensions.paperoutline." + key, true);
          Zotero.Prefs.set(scopedName, String(legacy || ""), true);
        }
      });
      Zotero.Prefs.set("extensions.paperoutline.providerConfigsMigrated", true, true);
    },

    readProviderConfig(provider) {
      const selected = this.normalizeProvider(provider);
      const api = getCoreAPI();
      if (api && typeof api.getProviderConfig === "function") {
        return api.getProviderConfig(selected);
      }
      const config = {};
      Object.keys(PROVIDER_CONFIG_FIELDS).forEach((key) => {
        const value = Zotero.Prefs.get(this.providerConfigPref(selected, key), true);
        config[key] = value === undefined || value === null ? "" : String(value);
      });
      return config;
    },

    writeProviderConfig(provider, config, activate) {
      const selected = this.normalizeProvider(provider);
      const api = getCoreAPI();
      if (api && typeof api.saveProviderConfig === "function") {
        api.saveProviderConfig(selected, config, !!activate);
        return;
      }
      Object.keys(PROVIDER_CONFIG_FIELDS).forEach((key) => {
        const value = String((config && config[key]) || "");
        Zotero.Prefs.set(this.providerConfigPref(selected, key), value, true);
        if (activate) Zotero.Prefs.set("extensions.paperoutline." + key, value, true);
      });
      if (activate) Zotero.Prefs.set("extensions.paperoutline.provider", selected, true);
    },

    currentProviderConfig() {
      const config = {};
      Object.keys(PROVIDER_CONFIG_FIELDS).forEach((key) => {
        const element = byId(PROVIDER_CONFIG_FIELDS[key]);
        config[key] = String((element && element.value) || "");
      });
      return config;
    },

    saveActiveProviderConfig() {
      if (this._restoringProvider || !this._activeProvider) return;
      this.writeProviderConfig(this._activeProvider, this.currentProviderConfig(), true);
    },

    restoreProviderConfig(provider) {
      const selected = this.normalizeProvider(provider);
      const config = this.readProviderConfig(selected);
      this._restoringProvider = true;
      try {
        Object.keys(PROVIDER_CONFIG_FIELDS).forEach((key) => {
          const element = byId(PROVIDER_CONFIG_FIELDS[key]);
          if (element) element.value = String(config[key] || "");
        });
        this.writeProviderConfig(selected, config, true);
      } finally {
        this._restoringProvider = false;
      }
    },

    switchProvider(provider) {
      const next = this.normalizeProvider(provider);
      if (this._activeProvider && this._activeProvider !== next) {
        this.saveActiveProviderConfig();
      }
      this._activeProvider = next;
      this.resetModelPicker();
      this.resetSecretField("paper-outline-api-key", "po-api-key-toggle");
      this.restoreProviderConfig(next);
      this.updateProvider();
    },

    bindSecretToggle(inputId, toggleId) {
      const input = byId(inputId);
      const toggle = byId(toggleId);
      if (!input || !toggle) return;
      toggle.addEventListener("click", () => {
        const revealing = input.type !== "text";
        input.type = revealing ? "text" : "password";
        toggle.textContent = revealing ? "隐藏" : "显示";
        if (typeof toggle.setAttribute === "function") {
          toggle.setAttribute("aria-pressed", revealing ? "true" : "false");
        }
      });
    },

    resetSecretField(inputId, toggleId) {
      const input = byId(inputId);
      const toggle = byId(toggleId);
      if (input) input.type = "password";
      if (toggle) {
        toggle.textContent = "显示";
        if (typeof toggle.setAttribute === "function") {
          toggle.setAttribute("aria-pressed", "false");
        }
      }
    },

    syncToggleStates() {
      Object.keys(TOGGLE_PREFERENCES).forEach((id) => {
        const element = byId(id);
        const setting = TOGGLE_PREFERENCES[id];
        if (!element || !setting) return;
        const prefName = "extensions.paperoutline." + setting.key;
        const current = Zotero.Prefs.get(prefName, true);
        element.checked =
          current === undefined || current === null ? setting.fallback : !!current;
      });
    },

    bindTogglePreferences() {
      Object.keys(TOGGLE_PREFERENCES).forEach((id) => {
        const element = byId(id);
        const setting = TOGGLE_PREFERENCES[id];
        if (!element || !setting) return;

        const prefName = "extensions.paperoutline." + setting.key;
        element.addEventListener("change", () => {
          if (setting.confirmUpload && element.checked) {
            const tokenElement = byId("paper-outline-mineru-token");
            const token = String(
              Zotero.Prefs.get("extensions.paperoutline.mineruToken", true) ||
                (tokenElement && tokenElement.value) ||
                ""
            ).trim();
            if (!token) {
              element.checked = false;
              window.alert("请先填写 MinerU Token，再开启默认上传。");
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

    syncMineruFromPrefs() {
      const tokenElement = byId("paper-outline-mineru-token");
      if (!tokenElement || isElementFocused(tokenElement)) return;
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
    },

    persistMineruToken(rawValue) {
      const token = String(rawValue || "").trim();
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
    },

    bindMineruPreferences() {
      const tokenElement = byId("paper-outline-mineru-token");
      if (!tokenElement) return;

      this.syncMineruFromPrefs();

      const onTokenChange = () => this.persistMineruToken(tokenElement.value);
      // 同时监听 input 与 change，确保粘贴后无需失焦即实时写入偏好并刷新状态。
      tokenElement.addEventListener("input", onTokenChange);
      tokenElement.addEventListener("change", onTokenChange);
    },

    setMineruStatus(state, message) {
      const status = byId("paper-outline-mineru-status");
      if (!status) return;
      status.dataset.state = state;
      status.className = "paper-outline-status paper-outline-status-" + state;
      status.textContent = message;
    },

    updateMineruStatus() {
      const api = getCoreAPI();
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
      const api = getCoreAPI();

      if (!token) {
        this.setMineruStatus("error", "请先粘贴 MinerU Token。");
        if (tokenElement) tokenElement.focus();
        return;
      }
      if (!api || typeof api.testMineruConnection !== "function") {
        this.setMineruStatus("error", "插件尚未完成加载，请重启 Zotero 后再试。");
        return;
      }

      this.persistMineruToken(token);

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
      const api = getCoreAPI();
      if (api && typeof api.openMineruTokenPage === "function") {
        api.openMineruTokenPage();
      } else {
        Zotero.launchURL("https://mineru.net/apiManage/token");
      }
    },

    bindModelPicker() {
      const picker = byId("po-model-picker");
      if (!picker) return;
      const onSelect = () => {
        const modelElement = byId("paper-outline-model");
        const rawValue =
          picker.selectedItem && picker.selectedItem.value !== undefined
            ? picker.selectedItem.value
            : picker.value;
        const selected = String(rawValue || "").trim();
        if (modelElement) {
          modelElement.value = selected;
        }
        this.saveActiveProviderConfig();
        this.markConnectionDirty();
        if (selected) {
          this.setModelFetchStatus("success", "已选择模型：" + selected);
        } else {
          this.setModelFetchStatus("success", "已恢复自动追新模式（留空将自动选用最新推荐模型）。");
        }
      };
      picker.addEventListener("command", onSelect);
      picker.addEventListener("change", onSelect);
    },

    setModelFetchStatus(state, message) {
      const status = byId("po-model-fetch-status");
      if (!status) return;
      const text = String(message || "").trim();
      status.dataset.state = state || "idle";
      status.className = "paper-outline-fetch-status paper-outline-fetch-status-" + (state || "idle");
      status.textContent = text;
      status.hidden = !text;
    },

    resetModelPicker() {
      this._fetchSeq += 1;
      this._fetchingModels = false;
      const button = byId("po-fetch-models-btn");
      if (button) {
        button.disabled = false;
        button.label = "拉取模型";
      }
      const picker = byId("po-model-picker");
      if (picker) {
        clearElementChildren(picker);
        if ("selectedIndex" in picker || typeof picker.appendItem === "function") {
          picker.selectedIndex = -1;
        }
        picker.value = "";
        picker.hidden = true;
      }
      this.setModelFetchStatus("idle", "");
    },

    async fetchModels() {
      if (this._fetchingModels) return;
      const button = byId("po-fetch-models-btn");
      const picker = byId("po-model-picker");
      const providerElement = byId("paper-outline-provider");
      const keyElement = byId("paper-outline-api-key");
      const modelElement = byId("paper-outline-model");
      const urlElement = byId("paper-outline-api-url");
      const api = getCoreAPI();

      this.saveActiveProviderConfig();

      if (!api || typeof api.listAvailableModels !== "function") {
        this.setModelFetchStatus("error", "插件尚未完成加载，请重启 Zotero 后再试。");
        return;
      }

      const seq = ++this._fetchSeq;
      this._fetchingModels = true;
      if (button) {
        button.disabled = true;
        button.label = "正在拉取…";
      }
      if (picker) picker.hidden = true;
      this.setModelFetchStatus("testing", "正在从服务商拉取最新可用模型列表…");

      try {
        const result = await api.listAvailableModels(
          {
            provider: providerElement ? providerElement.value : "deepseek",
            url: urlElement ? urlElement.value : "",
            key: keyElement ? keyElement.value : "",
            model: modelElement ? modelElement.value : "",
          },
          true
        );

        if (seq !== this._fetchSeq) return;

        const rawList = Array.isArray(result)
          ? result
          : (result && (result.models || result.ids || result.available || result.data)) || [];
        const models = [];
        const seen = new Set();
        rawList.forEach((item) => {
          const id =
            typeof item === "string"
              ? item.trim()
              : String((item && item.id) || "").trim();
          if (id && !seen.has(id)) {
            seen.add(id);
            models.push(id);
          }
        });

        const recommended = String(
          (!Array.isArray(result) &&
            result &&
            (result.recommended || result.selected || result.defaultModel)) ||
            models[0] ||
            ""
        ).trim();

        if (!models.length) {
          if (picker) {
            clearElementChildren(picker);
            picker.hidden = true;
          }
          this.setModelFetchStatus(
            "error",
            "未拉取到可用模型；请检查 API Key / 接口地址，或直接手动输入模型名。"
          );
          return;
        }

        if (picker) {
          clearElementChildren(picker);
          const autoLabel = recommended
            ? "自动选择最新（推荐：" + recommended + "）"
            : "自动选择最新（留空）";
          appendPickerOption(picker, autoLabel, "");
          models.forEach((id) => {
            const label = id === recommended ? id + "（推荐）" : id;
            appendPickerOption(picker, label, id);
          });
          const currentModel = String((modelElement && modelElement.value) || "").trim();
          const matchedIndex = currentModel ? models.indexOf(currentModel) : -1;
          const targetValue = matchedIndex >= 0 ? currentModel : "";
          const targetIndex = matchedIndex >= 0 ? matchedIndex + 1 : 0;
          if ("selectedIndex" in picker || typeof picker.appendItem === "function") {
            picker.selectedIndex = targetIndex;
          }
          picker.value = targetValue;
          picker.hidden = false;
        }

        const summary =
          "已拉取 " +
          models.length +
          " 个可用模型" +
          (recommended ? " · 推荐：" + recommended : "") +
          "，可在下方下拉框中选择。";
        this.setModelFetchStatus("success", summary);
      } catch (error) {
        if (seq !== this._fetchSeq) return;
        const message = String((error && error.message) || error || "未知错误")
          .replace(/^Error:\s*/i, "")
          .trim();
        if (picker) {
          clearElementChildren(picker);
          picker.hidden = true;
        }
        this.setModelFetchStatus("error", "拉取模型失败：" + message);
      } finally {
        if (seq === this._fetchSeq) {
          this._fetchingModels = false;
          if (button) {
            button.disabled = false;
            button.label = "拉取模型";
          }
        }
      }
    },

    updateProvider() {
      const providerElement = byId("paper-outline-provider");
      const modelElement = byId("paper-outline-model");
      const modelHint = byId("paper-outline-model-hint");
      const keyHint = byId("paper-outline-key-hint");
      const urlElement = byId("paper-outline-api-url");
      const apiDetails = byId("paper-outline-api-details");
      const thinkingDesc = byId("paper-outline-deep-thinking-desc");
      if (!providerElement || !modelElement) return;

      const provider = this.normalizeProvider(providerElement.value || "deepseek");
      const preset = this.getProviderMeta(provider);

      if (modelHint) {
        modelHint.textContent = preset.model
          ? "留空 = 自动获取当前服务商最新推荐模型（升级不失效；兜底：" +
            preset.model +
            "）；也可点击右侧「拉取模型」手动选择。"
          : "留空 = 自动获取当前服务商最新推荐模型（升级不失效）；也可点击右侧「拉取模型」手动选择或直接填写。";
      }
      if (keyHint) {
        keyHint.textContent =
          provider === "ollama"
            ? "本地 Ollama 无需 API Key。"
            : provider === "custom"
              ? "当前自定义服务配置会单独保存；如需鉴权，请填写 API Key。"
              : "按服务商分别保存在本机 Zotero 设置中。";
      }
      if (urlElement) {
        urlElement.placeholder = preset.url
          ? "留空使用默认：" + preset.url
          : "必填：OpenAI 兼容的 chat/completions 接口地址";
      }
      if (thinkingDesc) {
        if (preset.supportsThinking) {
          thinkingDesc.textContent =
            "默认关闭；当前服务商支持深度思考参数，开启后分析更深入但响应时间更长。";
        } else if (provider === "custom") {
          thinkingDesc.textContent =
            "默认关闭；仅对支持深度思考参数的服务商生效。";
        } else {
          thinkingDesc.textContent =
            "默认关闭；仅对声明支持该参数的内置服务商生效（当前服务商默认不传该参数）。";
        }
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
      const api = getCoreAPI();

      this.saveActiveProviderConfig();

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
        const meta = this.getProviderMeta(result.provider);
        const providerLabel = (meta && meta.label) || result.label || result.provider;
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

    normalizeSummaryPreset(preset) {
      const api = getCoreAPI();
      const presets = (api && api.SUMMARY_PROMPT_PRESETS) || SUMMARY_PRESET_LABELS;
      if (preset && Object.prototype.hasOwnProperty.call(presets, preset)) {
        return preset;
      }
      return "humanities";
    },

    getSummaryPresetPrompt(preset) {
      const api = getCoreAPI();
      const key = this.normalizeSummaryPreset(preset);
      const presets = api && api.SUMMARY_PROMPT_PRESETS;
      if (presets && presets[key]) {
        if (typeof presets[key] === "string") return presets[key];
        if (typeof presets[key].prompt === "string") return presets[key].prompt;
      }
      return (api && api.SUMMARY_PROMPT) || "";
    },

    getSummaryPresetLabel(preset) {
      const api = getCoreAPI();
      const key = this.normalizeSummaryPreset(preset);
      const presets = api && api.SUMMARY_PROMPT_PRESETS;
      if (presets && presets[key] && typeof presets[key] === "object" && presets[key].label) {
        return presets[key].label;
      }
      return SUMMARY_PRESET_LABELS[key] || key;
    },

    syncSummaryPresetUI() {
      const presetElement = byId("po-summary-preset");
      if (!presetElement) return;
      const stored = Zotero.Prefs.get("extensions.paperoutline.summaryPreset", true);
      const selected = this.normalizeSummaryPreset(stored || presetElement.value || "humanities");
      presetElement.value = selected;
    },

    bindSummaryPreset() {
      const presetElement = byId("po-summary-preset");
      if (!presetElement) return;
      const onPresetChange = () => {
        const preset = this.normalizeSummaryPreset(presetElement.value);
        Zotero.Prefs.set("extensions.paperoutline.summaryPreset", preset, true);
        const promptText = this.getSummaryPresetPrompt(preset);
        const summaryPrompt = byId("paper-outline-summary-prompt");
        const status = byId("paper-outline-prompt-reset-status");
        if (promptText) {
          if (summaryPrompt) {
            summaryPrompt.value = promptText;
            emitPreferenceChange(summaryPrompt);
          }
          Zotero.Prefs.set("extensions.paperoutline.summaryPrompt", promptText, true);
          if (status) {
            status.textContent =
              "已切换为「" + this.getSummaryPresetLabel(preset) + "」总结模板。";
          }
        }
      };
      presetElement.addEventListener("command", onPresetChange);
      presetElement.addEventListener("change", onPresetChange);
    },

    restoreDefaultPrompts() {
      const api = getCoreAPI();
      const outlinePrompt = byId("paper-outline-outline-prompt");
      const summaryPrompt = byId("paper-outline-summary-prompt");
      const presetElement = byId("po-summary-preset");
      const status = byId("paper-outline-prompt-reset-status");

      if (!api || !api.DEFAULT_PROMPT || (!api.SUMMARY_PROMPT && !api.SUMMARY_PROMPT_PRESETS)) {
        if (status) status.textContent = "插件尚未完成加载，请重启 Zotero 后再试。";
        return;
      }

      const preset = this.normalizeSummaryPreset(
        (presetElement && presetElement.value) ||
          Zotero.Prefs.get("extensions.paperoutline.summaryPreset", true) ||
          "humanities"
      );
      const targetSummaryPrompt = this.getSummaryPresetPrompt(preset) || api.SUMMARY_PROMPT;

      if (outlinePrompt) {
        outlinePrompt.value = api.DEFAULT_PROMPT;
        emitPreferenceChange(outlinePrompt);
      }
      if (summaryPrompt) {
        summaryPrompt.value = targetSummaryPrompt;
        emitPreferenceChange(summaryPrompt);
      }

      // 显式写入，避免不同 Zotero 版本对 HTML textarea 的偏好绑定时机不同。
      Zotero.Prefs.set("extensions.paperoutline.summaryPreset", preset, true);
      Zotero.Prefs.set("extensions.paperoutline.prompt", api.DEFAULT_PROMPT, true);
      Zotero.Prefs.set("extensions.paperoutline.summaryPrompt", targetSummaryPrompt, true);
      if (status) {
        status.textContent =
          "已恢复目录默认提示词，并按「" +
          this.getSummaryPresetLabel(preset) +
          "」预设恢复总结提示词。";
      }
    },

    updateCacheButtons() {
      const btn = byId("po-clear-mineru-cache-btn");
      if (!btn) return;
      const api = getCoreAPI();
      btn.hidden = !!(api && typeof api.clearMineruCacheUI !== "function");
    },

    clearMineruCache() {
      const api = getCoreAPI();
      if (api && typeof api.clearMineruCacheUI === "function") {
        return api.clearMineruCacheUI();
      } else {
        window.alert("当前版本未检测到扫描 OCR 缓存清理接口，请重启 Zotero 后再试。");
      }
    },
  };
})();
