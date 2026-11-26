import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type IChatPlugin from "../main";
import {
  ModelSortBy,
  PlatformConfig,
  THINKING_LEVELS,
  THINKING_LEVEL_LABELS,
  ThinkingLevel,
} from "../types";
import { pickDefaultModelId, sortModelsForSettings } from "../core/model-resolver";
import { FolderSuggest } from "./folder-suggest";

type SettingsTabId = "byok" | "chat";

export class IChatSettingTab extends PluginSettingTab {
  private activeTab: SettingsTabId = "byok";
  private modelSearch = "";
  private showApiKey = false;
  private isTesting = false;

  constructor(app: App, private readonly plugin: IChatPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("ichat-settings");

    // Tab navigation
    const tabBar = containerEl.createDiv({ cls: "ichat-settings-tabs" });
    const tabs: Array<{ id: SettingsTabId; label: string }> = [
      { id: "byok", label: "BYOK" },
      { id: "chat", label: "对话" },
    ];

    for (const tab of tabs) {
      const btn = tabBar.createEl("button", {
        type: "button",
        cls: `ichat-settings-tab ${this.activeTab === tab.id ? "is-active" : ""}`,
        text: tab.label,
      });
      btn.addEventListener("click", () => {
        if (this.activeTab !== tab.id) {
          this.activeTab = tab.id;
          this.display();
        }
      });
    }

    const panel = containerEl.createDiv({ cls: "ichat-settings-panel" });
    if (this.activeTab === "byok") {
      this.renderByokTab(panel);
    } else {
      this.renderChatTab(panel);
    }
  }

  private renderByokTab(container: HTMLElement): void {
    const providers = this.plugin.registry.list();
    let selectedId = this.plugin.settings.selectedSettingsPlatformId;
    if (!this.plugin.registry.get(selectedId) && providers.length > 0) {
      selectedId = providers[0].id;
      this.plugin.settings.selectedSettingsPlatformId = selectedId;
    }

    const provider = this.plugin.registry.get(selectedId);
    if (!provider) {
      container.createDiv({ text: "未注册可用平台。" });
      return;
    }

    let config: PlatformConfig | undefined = this.plugin.settings.platforms[selectedId];
    if (!config) {
      config = this.plugin.registry.createDefaultPlatformConfig(provider);
      this.plugin.settings.platforms[selectedId] = config;
    }
    const platformConfig = config;

    const groupEl = container.createDiv({ cls: "setting-group" });
    const itemsEl = groupEl.createDiv({ cls: "setting-items" });

    // 1. Native Platform dropdown
    new Setting(itemsEl)
      .setName("Platform")
      .setDesc("每个平台独立保存 API Key 与 Base URL，切换不会互相覆盖。")
      .addDropdown((dropdown) => {
        for (const item of providers) {
          dropdown.addOption(item.id, item.name);
        }
        dropdown.setValue(selectedId).onChange(async (value) => {
          this.plugin.settings.selectedSettingsPlatformId = value;
          this.showApiKey = false;
          this.modelSearch = "";
          await this.plugin.saveSettings();
          this.display();
        });
      });

    // 2. API Key row with status dot + native TextComponent + native ExtraButtonComponents
    const keySetting = new Setting(itemsEl)
      .setName("API Key")
      .setDesc("请输入API Key后点击测试按钮");

    const statusDot = keySetting.controlEl.createSpan({
      cls: `ichat-status-dot is-${platformConfig.lastTestStatus}`,
      attr: {
        "aria-label": this.formatTestStatusTooltip(platformConfig),
      },
    });

    keySetting
      .addText((text) => {
        text
          .setPlaceholder("输入 API Key…")
          .setValue(platformConfig.apiKey)
          .onChange(async (value) => {
            platformConfig.apiKey = value;
            if (platformConfig.lastTestStatus !== "untested") {
              platformConfig.lastTestStatus = "untested";
              platformConfig.lastTestError = undefined;
              statusDot.className = "ichat-status-dot is-untested";
              statusDot.setAttribute("aria-label", this.formatTestStatusTooltip(platformConfig));
            }
            await this.plugin.saveSettings();
            await this.plugin.controller.syncActiveState();
          });
        text.inputEl.type = this.showApiKey ? "text" : "password";
        text.inputEl.addClass("ichat-key-input");
      })
      .addExtraButton((btn) => {
        btn
          .setIcon(this.showApiKey ? "eye-off" : "eye")
          .setTooltip(this.showApiKey ? "隐藏 Key" : "显示 Key")
          .onClick(() => {
            this.showApiKey = !this.showApiKey;
            this.display();
          });
      })
      .addExtraButton((btn) => {
        btn
          .setIcon(this.isTesting ? "loader-2" : "plug")
          .setTooltip(this.isTesting ? "测试中…" : "测试 API Key 连接")
          .setDisabled(this.isTesting)
          .onClick(() => {
            void this.handleTestPlatform(platformConfig, provider.id);
          });
        btn.extraSettingsEl.addClass("ichat-test-btn");
        btn.extraSettingsEl.toggleClass("is-testing", this.isTesting);
      });

    // 3. Base URL
    const displayBaseUrl =
      platformConfig.baseUrl.trim() === provider.defaultBaseUrl ? "" : platformConfig.baseUrl;
    new Setting(itemsEl)
      .setName("Base URL")
      .setDesc("留空时使用默认地址")
      .addText((text) => {
        text
          .setPlaceholder(provider.defaultBaseUrl)
          .setValue(displayBaseUrl)
          .onChange(async (value) => {
            const trimmed = value.trim();
            platformConfig.baseUrl = trimmed === provider.defaultBaseUrl ? "" : trimmed;
            await this.plugin.saveSettings();
          });
        text.inputEl.addClass("ichat-baseurl-input");
      });

    // 4. Models list (native Obsidian 1.11+ setting-group card layout + native Search & Dropdown)
    const modelsGroup = container.createDiv({ cls: "setting-group ichat-models-group" });
    const headingSetting = new Setting(modelsGroup).setName("模型清单").setHeading();
    const listContainer = modelsGroup.createDiv({ cls: "setting-items ichat-models-list" });

    const renderModels = (): void => {
      listContainer.empty();
      const sorted = sortModelsForSettings(
        platformConfig.cachedModels,
        platformConfig.enabledModelIds,
        this.plugin.settings.modelSortBy
      );
      const q = this.modelSearch.trim().toLowerCase();
      const filtered = sorted.filter(
        (m) =>
          !q ||
          m.id.toLowerCase().includes(q) ||
          m.displayName.toLowerCase().includes(q)
      );

      if (platformConfig.cachedModels.length === 0) {
        listContainer.createDiv({
          cls: "ichat-models-empty",
          text: "暂无模型数据，请输入 API Key 后点击测试按钮拉取模型清单。",
        });
        return;
      }

      if (filtered.length === 0) {
        listContainer.createDiv({
          cls: "ichat-models-empty",
          text: "未找到匹配的模型。",
        });
        return;
      }

      const enabledSet = new Set(platformConfig.enabledModelIds);
      for (const model of filtered) {
        const modelSetting = new Setting(listContainer)
          .setName(model.displayName)
          .setDesc(model.id);

        modelSetting.settingEl.addClass("ichat-model-setting");
        modelSetting.descEl.addClass("ichat-model-id");

        if (model.capabilities.length > 0) {
          const tags = modelSetting.controlEl.createDiv({ cls: "ichat-capability-badges" });
          if (model.capabilities.includes("visual")) {
            tags.createSpan({ cls: "ichat-badge", text: "Visual" });
          }
          if (model.capabilities.includes("think")) {
            tags.createSpan({ cls: "ichat-badge", text: "Think" });
          }
        }

        modelSetting.addToggle((toggle) => {
          toggle.setValue(enabledSet.has(model.id)).onChange(async (checked) => {
            const next = new Set(platformConfig.enabledModelIds);
            if (checked) {
              next.add(model.id);
            } else {
              next.delete(model.id);
            }
            platformConfig.enabledModelIds = Array.from(next);
            await this.plugin.saveSettings();
            await this.plugin.controller.syncActiveState();
            if (this.plugin.settings.modelSortBy === "enabled") {
              renderModels();
            }
          });
        });
      }
    };

    headingSetting
      .addSearch((search) => {
        search
          .setPlaceholder("搜索模型 ID 或名称…")
          .setValue(this.modelSearch)
          .onChange((value) => {
            this.modelSearch = value;
            renderModels();
          });
        search.inputEl.addClass("ichat-models-search");
      })
      .addDropdown((dropdown) => {
        dropdown
          .addOption("enabled", "启用优先")
          .addOption("time", "按时间")
          .setValue(this.plugin.settings.modelSortBy)
          .onChange(async (value) => {
            this.plugin.settings.modelSortBy = value as ModelSortBy;
            await this.plugin.saveSettings();
            renderModels();
          });
      });

    renderModels();
  }

  private renderChatTab(container: HTMLElement): void {
    const groupEl = container.createDiv({ cls: "setting-group" });
    const itemsEl = groupEl.createDiv({ cls: "setting-items" });

    new Setting(itemsEl)
      .setName("默认思考等级")
      .setDesc("用于支持 Think 能力的模型，也可在对话页下拉面板中随时切换。")
      .addDropdown((dropdown) => {
        for (const level of THINKING_LEVELS) {
          dropdown.addOption(level, THINKING_LEVEL_LABELS[level]);
        }
        dropdown
          .setValue(this.plugin.settings.defaultThinkingLevel)
          .onChange(async (value) => {
            const next = value as ThinkingLevel;
            this.plugin.settings.defaultThinkingLevel = next;
            this.plugin.settings.activeThinkingLevel = next;
            await this.plugin.saveSettings();
            this.plugin.controller.notify();
          });
      });

    new Setting(itemsEl)
      .setName("提示词路径")
      .setDesc("存放提示词 Markdown 文件的 Vault 文件夹路径。")
      .addText((text) => {
        text
          .setPlaceholder("i-Chat/Prompts")
          .setValue(this.plugin.settings.promptsFolder)
          .onChange(async (value) => {
            this.plugin.settings.promptsFolder = value.trim();
            await this.plugin.saveSettings();
            await this.plugin.controller.syncActiveState();
          });
        new FolderSuggest(this.app, text.inputEl, async (folderPath) => {
          this.plugin.settings.promptsFolder = folderPath;
          await this.plugin.saveSettings();
          await this.plugin.controller.syncActiveState();
        });
      });

    new Setting(itemsEl)
      .setName("对话记录路径")
      .setDesc("自动保存对话笔记（{YYYYMMDDhhmmss}.md）的 Vault 文件夹路径。")
      .addText((text) => {
        text
          .setPlaceholder("i-Chat/Chats")
          .setValue(this.plugin.settings.chatsFolder)
          .onChange(async (value) => {
            this.plugin.settings.chatsFolder = value.trim();
            await this.plugin.saveSettings();
          });
        new FolderSuggest(this.app, text.inputEl, async (folderPath) => {
          this.plugin.settings.chatsFolder = folderPath;
          await this.plugin.saveSettings();
        });
      });
  }

  private async handleTestPlatform(config: PlatformConfig, platformId: string): Promise<void> {
    const provider = this.plugin.registry.get(platformId);
    if (!provider) return;

    if (!config.apiKey.trim()) {
      config.lastTestStatus = "err";
      config.lastTestError = "API Key 为空";
      await this.plugin.saveSettings();
      new Notice("请先填写 API Key。");
      this.display();
      return;
    }

    this.isTesting = true;
    this.display();

    try {
      const models = await provider.fetchModels(config.apiKey, config.baseUrl);
      config.cachedModels = models;
      config.lastTestStatus = "ok";
      config.lastTestError = undefined;

      // Clean up any enabled IDs that no longer exist
      const availableIds = new Set(models.map((m) => m.id));
      config.enabledModelIds = config.enabledModelIds.filter((id) => availableIds.has(id));

      // First-time setup: auto-enable platform default model when none enabled yet
      let autoEnabledModelId: string | null = null;
      if (config.enabledModelIds.length === 0) {
        autoEnabledModelId = pickDefaultModelId(models, provider.defaultModelPriority);
        if (autoEnabledModelId) {
          config.enabledModelIds = [autoEnabledModelId];
        }
      }

      if (
        !this.plugin.controller.getActiveModel() &&
        config.enabledModelIds.length > 0
      ) {
        this.plugin.settings.activePlatformId = platformId;
        this.plugin.settings.activeModelId = autoEnabledModelId ?? config.enabledModelIds[0];
      }

      await this.plugin.saveSettings();
      await this.plugin.controller.syncActiveState();

      if (autoEnabledModelId) {
        new Notice(`连接成功（OK），已拉取 ${models.length} 个模型并自动启用 ${autoEnabledModelId}。`);
      } else {
        new Notice(`连接成功（OK），已拉取 ${models.length} 个模型。`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      config.lastTestStatus = "err";
      config.lastTestError = message;
      await this.plugin.saveSettings();
      new Notice(`连接失败（ERR）：${message}`);
    } finally {
      this.isTesting = false;
      if (this.containerEl.isConnected) {
        this.display();
      }
    }
  }

  private formatTestStatusTooltip(config: PlatformConfig): string {
    if (config.lastTestStatus === "ok") {
      return "最近一次测试：OK";
    }
    if (config.lastTestStatus === "err") {
      return config.lastTestError
        ? `最近一次测试：ERR（${config.lastTestError}）`
        : "最近一次测试：ERR";
    }
    return "尚未测试";
  }
}
