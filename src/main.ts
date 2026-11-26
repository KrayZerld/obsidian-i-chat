import { MarkdownView, Plugin, TAbstractFile, TFile, WorkspaceLeaf } from "obsidian";
import { PluginSettings } from "./types";
import { ProviderRegistry } from "./providers/registry";
import { ChatStore } from "./storage/chat-store";
import { PromptStore } from "./storage/prompt-store";
import { ChatController } from "./core/chat-controller";
import { IChatSettingTab } from "./ui/setting-tab";
import { IChatView, VIEW_TYPE_ICHAT } from "./ui/chat-view";

export default class IChatPlugin extends Plugin {
  registry!: ProviderRegistry;
  settings!: PluginSettings;
  chatStore!: ChatStore;
  promptStore!: PromptStore;
  controller!: ChatController;
  private lastActiveMarkdownFile: TFile | null = null;

  async onload(): Promise<void> {
    this.registry = new ProviderRegistry();
    await this.loadSettings();

    this.chatStore = new ChatStore(this.app);
    this.promptStore = new PromptStore(this.app);
    this.controller = new ChatController(this);

    const initialMarkdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (initialMarkdownView?.file) {
      this.lastActiveMarkdownFile = initialMarkdownView.file;
    }

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (leaf?.view instanceof MarkdownView && leaf.view.file) {
          this.lastActiveMarkdownFile = leaf.view.file;
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("delete", (file: TAbstractFile) => {
        if (this.lastActiveMarkdownFile && file.path === this.lastActiveMarkdownFile.path) {
          this.lastActiveMarkdownFile = null;
        }
      })
    );

    this.registerView(VIEW_TYPE_ICHAT, (leaf) => new IChatView(leaf, this));

    this.addRibbonIcon("message-square", "Open i-Chat", () => {
      void this.activateView();
    });

    this.addCommand({
      id: "open-i-chat",
      name: "Open i-Chat",
      callback: () => {
        void this.activateView();
      },
    });

    this.addCommand({
      id: "new-i-chat",
      name: "Start new i-Chat conversation",
      callback: async () => {
        await this.activateView();
        this.controller.startNewChat();
      },
    });

    this.addSettingTab(new IChatSettingTab(this.app, this));
  }

  onunload(): void {
    this.controller?.stopStreaming();
    this.controller?.abortTitleGeneration();
  }

  getLastActiveMarkdownFile(): TFile | null {
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeView?.file) {
      this.lastActiveMarkdownFile = activeView.file;
    }
    if (!this.lastActiveMarkdownFile) {
      return null;
    }
    const live = this.app.vault.getAbstractFileByPath(this.lastActiveMarkdownFile.path);
    return live instanceof TFile ? live : null;
  }

  async loadSettings(): Promise<void> {
    const raw = (await this.loadData()) as Partial<PluginSettings> | null;
    const defaults = this.registry.createDefaultSettings();
    const merged: PluginSettings = {
      ...defaults,
      ...(raw ?? {}),
      platforms: {
        ...defaults.platforms,
        ...(raw?.platforms ?? {}),
      },
    };
    this.settings = this.registry.ensurePlatformConfigs(merged);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async activateView(): Promise<void> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE_ICHAT)[0] ?? null;

    if (!leaf) {
      leaf = workspace.getLeaf("tab");
      await leaf.setViewState({
        type: VIEW_TYPE_ICHAT,
        active: true,
      });
    }

    workspace.revealLeaf(leaf);
  }
}
