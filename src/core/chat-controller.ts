import { App, Notice, TFile } from "obsidian";
import {
  Attachment,
  AvailableModelGroup,
  ChatMessage,
  ChatNoteMeta,
  ModelInfo,
  PlatformId,
  PluginSettings,
  PromptItem,
  SearchSource,
  ThinkingLevel,
  createId,
} from "../types";
import { ProviderRegistry } from "../providers/registry";
import { ChatStore } from "../storage/chat-store";
import { parseChatFrontmatter } from "../storage/note-codec";
import { PromptStore } from "../storage/prompt-store";
import {
  findCachedModel,
  getAvailableModelGroups,
  isModelAvailable,
  resolveHistoryModelSelection,
  supportsWebSearch,
} from "./model-resolver";
import { buildAutoTitlePrompt, sanitizeGeneratedTitle } from "./title-generator";
import { extractChatTitle, formatTimestamp } from "../utils/time";

export type ControllerListener = () => void;

export interface ChatControllerHost {
  app: App;
  settings: PluginSettings;
  registry: ProviderRegistry;
  chatStore: ChatStore;
  promptStore: PromptStore;
  saveSettings(): Promise<void>;
}

export class ChatController {
  currentFile: TFile | null = null;
  currentTitle = "";
  messages: ChatMessage[] = [];
  pendingAttachments: Attachment[] = [];
  isStreaming = false;
  activePrompt: PromptItem | null = null;
  webSearchEnabled = false;

  private abortController: AbortController | null = null;
  private titleAbortController: AbortController | null = null;
  private hasManualTitle = false;
  private sessionToken = 0;
  private readonly listeners = new Set<ControllerListener>();

  constructor(private readonly host: ChatControllerHost) {}

  subscribe(listener: ControllerListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  get settings(): PluginSettings {
    return this.host.settings;
  }

  getAvailableModelGroups(): AvailableModelGroup[] {
    return getAvailableModelGroups(this.settings, this.host.registry);
  }

  getActiveModel(): ModelInfo | undefined {
    const { activePlatformId, activeModelId } = this.settings;
    if (!isModelAvailable(this.settings, activePlatformId, activeModelId)) {
      return undefined;
    }
    return findCachedModel(this.settings, activePlatformId, activeModelId);
  }

  getActiveThinkingLevel(): ThinkingLevel {
    return this.settings.activeThinkingLevel || this.settings.defaultThinkingLevel || "medium";
  }

  /**
   * Ensures activePlatformId / activeModelId points to an available model if one exists,
   * and syncs activePrompt metadata from the prompts folder.
   */
  async syncActiveState(): Promise<void> {
    if (!this.getActiveModel()) {
      const groups = this.getAvailableModelGroups();
      const firstGroup = groups[0];
      const firstModel = firstGroup?.models[0];
      if (firstGroup && firstModel) {
        this.settings.activePlatformId = firstGroup.platformId;
        this.settings.activeModelId = firstModel.id;
        await this.host.saveSettings();
      }
    }

    if (this.settings.activePromptFile) {
      this.activePrompt =
        (await this.host.promptStore.findPromptByRef(
          this.settings.promptsFolder,
          this.settings.activePromptFile
        )) ?? null;
    } else {
      this.activePrompt = null;
    }

    this.notify();
  }

  addAttachments(items: Attachment[]): number {
    if (items.length === 0) return 0;

    const existingPaths = new Set(
      this.pendingAttachments
        .map((a) => a.sourcePath)
        .filter((p): p is string => Boolean(p))
    );

    const unique: Attachment[] = [];
    for (const item of items) {
      if (item.sourcePath) {
        if (existingPaths.has(item.sourcePath)) {
          continue;
        }
        existingPaths.add(item.sourcePath);
      }
      unique.push(item);
    }

    if (unique.length === 0) {
      return 0;
    }

    this.pendingAttachments.push(...unique);
    this.notify();
    return unique.length;
  }

  removeAttachment(id: string): void {
    this.pendingAttachments = this.pendingAttachments.filter((a) => a.id !== id);
    this.notify();
  }

  toggleWebSearch(): void {
    this.webSearchEnabled = !this.webSearchEnabled;
    this.notify();
  }

  /**
   * Manually selects a model (and optionally thinking level) in the chat view.
   * When a prompt is active, writes the binding back to that prompt file's frontmatter.
   */
  async selectModel(
    platformId: PlatformId,
    modelId: string,
    thinkingLevel?: ThinkingLevel
  ): Promise<void> {
    this.settings.activePlatformId = platformId;
    this.settings.activeModelId = modelId;
    if (thinkingLevel) {
      this.settings.activeThinkingLevel = thinkingLevel;
    }
    await this.host.saveSettings();

    await this.persistBindingToActivePrompt();
    this.notify();
  }

  async selectThinkingLevel(level: ThinkingLevel): Promise<void> {
    this.settings.activeThinkingLevel = level;
    await this.host.saveSettings();

    await this.persistBindingToActivePrompt();
    this.notify();
  }

  private async persistBindingToActivePrompt(): Promise<void> {
    if (!this.activePrompt) {
      return;
    }
    const model = this.getActiveModel();
    if (!model) {
      return;
    }
    const thinking = model.capabilities.includes("think")
      ? this.getActiveThinkingLevel()
      : undefined;

    try {
      await this.host.promptStore.writeModelBinding(
        this.activePrompt.filePath,
        model.platformId,
        model.id,
        thinking
      );
      this.activePrompt = {
        ...this.activePrompt,
        platform: model.platformId,
        model: model.id,
        thinking,
      };
    } catch (err) {
      console.error("[obsidian-i-chat] Failed to write model binding to prompt:", err);
      new Notice("写入提示词模型绑定失败，请检查提示词文件权限。");
    }
  }

  private async ensureActivePromptFrontmatter(
    explicitModel?: ModelInfo,
    explicitThinking?: ThinkingLevel
  ): Promise<void> {
    const prompt = this.activePrompt;
    if (!prompt) {
      return;
    }

    const model = explicitModel ?? this.getActiveModel();
    const thinking = model
      ? explicitModel
        ? explicitThinking
        : model.capabilities.includes("think")
          ? this.getActiveThinkingLevel()
          : undefined
      : undefined;

    const fallbackBinding = model
      ? {
          platformId: model.platformId,
          modelId: model.id,
          thinking,
        }
      : undefined;

    try {
      const resolved = await this.host.promptStore.ensurePromptFrontmatter(
        prompt.filePath,
        fallbackBinding
      );
      if (resolved && this.activePrompt?.filePath === prompt.filePath) {
        this.activePrompt = {
          ...this.activePrompt,
          title: resolved.title,
          platform: resolved.platform,
          model: resolved.model,
          thinking: resolved.thinking,
        };
      }
    } catch (err) {
      console.error("[obsidian-i-chat] Failed to ensure prompt frontmatter:", err);
    }
  }

  /**
   * Manually selects a prompt in the chat view.
   * Automatically switches to the model bound in that prompt's frontmatter if available,
   * and backfills missing i-chat-* frontmatter if the prompt file lacks it.
   */
  async selectPrompt(prompt: PromptItem | null): Promise<void> {
    this.activePrompt = prompt;
    this.settings.activePromptFile = prompt ? prompt.fileName : "";

    if (prompt && prompt.platform && prompt.model) {
      if (isModelAvailable(this.settings, prompt.platform, prompt.model)) {
        this.settings.activePlatformId = prompt.platform;
        this.settings.activeModelId = prompt.model;
        if (prompt.thinking) {
          this.settings.activeThinkingLevel = prompt.thinking;
        }
      } else {
        new Notice(`提示词「${prompt.title}」绑定的模型当前不可用，已保持当前模型。`);
      }
    }

    await this.host.saveSettings();
    if (prompt) {
      await this.ensureActivePromptFrontmatter();
    }
    this.notify();
  }

  startNewChat(): void {
    this.sessionToken++;
    this.abortTitleGeneration();
    if (this.isStreaming) {
      this.stopStreaming();
      this.isStreaming = false;
    }
    this.currentFile = null;
    this.currentTitle = "";
    this.hasManualTitle = false;
    this.messages = [];
    this.pendingAttachments = [];
    this.notify();
  }

  setCurrentTitle(title: string): void {
    this.hasManualTitle = true;
    this.abortTitleGeneration();
    this.currentTitle = title.trim();
    this.notify();
  }

  stopStreaming(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  abortTitleGeneration(): void {
    if (this.titleAbortController) {
      this.titleAbortController.abort();
      this.titleAbortController = null;
    }
  }

  async openHistoryChat(file: TFile): Promise<void> {
    const token = ++this.sessionToken;
    this.abortTitleGeneration();
    if (this.isStreaming) {
      this.stopStreaming();
      this.isStreaming = false;
    }

    const { meta, messages } = await this.host.chatStore.loadChatNote(file);
    if (token !== this.sessionToken) {
      return;
    }

    this.currentFile = file;
    this.currentTitle = meta.title || file.basename;
    this.hasManualTitle = false;
    this.messages = messages;
    this.pendingAttachments = [];

    // 1. Restore prompt from note frontmatter
    let restoredPrompt: PromptItem | undefined;
    if (meta.prompt) {
      restoredPrompt = await this.host.promptStore.findPromptByRef(
        this.settings.promptsFolder,
        meta.prompt
      );
      if (token !== this.sessionToken) {
        return;
      }
    }
    this.activePrompt = restoredPrompt ?? null;
    this.settings.activePromptFile = restoredPrompt ? restoredPrompt.fileName : "";

    // 2. Resolve model: prompt binding -> note's own model -> keep current + Notice
    const resolved = resolveHistoryModelSelection({
      settings: this.settings,
      noteMeta: meta,
      restoredPrompt,
    });

    this.settings.activePlatformId = resolved.platformId;
    this.settings.activeModelId = resolved.modelId;
    this.settings.activeThinkingLevel = resolved.thinkingLevel;

    await this.host.saveSettings();
    if (token !== this.sessionToken) {
      return;
    }

    if (resolved.notice) {
      new Notice(resolved.notice);
    }

    this.notify();
  }

  async sendMessage(rawText: string): Promise<void> {
    if (this.isStreaming) {
      return;
    }

    const text = rawText.trim();
    const attachments = [...this.pendingAttachments];
    if (!text && attachments.length === 0) {
      return;
    }

    const model = this.getActiveModel();
    if (!model) {
      new Notice("请先在设置页（BYOK）配置 API Key 并启用至少一个模型。");
      return;
    }

    const hasImageAttachment = attachments.some(
      (att) => att.kind === "binary" && att.mimeType.startsWith("image/")
    );
    if (hasImageAttachment && !model.capabilities.includes("visual")) {
      new Notice(`当前模型「${model.displayName}」未标记 Visual 能力，图片可能无法识别。`);
    }

    // Drop any trailing empty failed/aborted assistant stub before appending a new user turn
    while (
      this.messages.length > 0 &&
      this.messages[this.messages.length - 1].role === "assistant" &&
      this.messages[this.messages.length - 1].content.trim().length === 0
    ) {
      this.messages.pop();
    }

    const userMsg: ChatMessage = {
      id: createId("user"),
      role: "user",
      timestamp: formatTimestamp(new Date()),
      content: text,
      attachments: attachments.length > 0 ? attachments : undefined,
    };

    this.messages.push(userMsg);
    this.pendingAttachments = [];

    await this.streamAssistantReply(model);
  }

  /**
   * Retries ONLY the last turn, overwriting its assistant response in memory and in the chat note.
   */
  async retryLastTurn(): Promise<void> {
    if (this.isStreaming || this.messages.length === 0) {
      return;
    }

    const model = this.getActiveModel();
    if (!model) {
      new Notice("当前没有可用的模型，请先在设置页检查 BYOK 配置。");
      return;
    }

    const lastMsg = this.messages[this.messages.length - 1];
    if (lastMsg.role === "assistant") {
      this.messages.pop();
    }

    if (this.messages.length === 0 || this.messages[this.messages.length - 1].role !== "user") {
      return;
    }

    await this.streamAssistantReply(model);
  }

  private async streamAssistantReply(model: ModelInfo): Promise<void> {
    const provider = this.host.registry.get(model.platformId);
    const platformConfig = this.settings.platforms[model.platformId];
    if (!provider || !platformConfig || !platformConfig.apiKey.trim()) {
      new Notice("当前模型所属平台未配置有效的 API Key。");
      return;
    }

    const token = this.sessionToken;
    const assistantMsg: ChatMessage = {
      id: createId("assistant"),
      role: "assistant",
      timestamp: formatTimestamp(new Date()),
      content: "",
      thinking: "",
      isStreaming: true,
      isThinking: false,
    };

    const requestMessages = this.messages.filter(
      (m) => !(m.role === "assistant" && m.content.trim().length === 0)
    );
    this.messages.push(assistantMsg);
    this.isStreaming = true;
    this.abortController = new AbortController();
    this.notify();

    const thinkingLevel = model.capabilities.includes("think")
      ? this.getActiveThinkingLevel()
      : undefined;

    if (this.activePrompt) {
      await this.ensureActivePromptFrontmatter(model, thinkingLevel);
      if (token !== this.sessionToken) {
        assistantMsg.isStreaming = false;
        assistantMsg.isThinking = false;
        return;
      }
    }

    const systemPrompt = this.activePrompt
      ? await this.host.promptStore.readPromptBody(this.activePrompt.filePath)
      : undefined;

    if (token !== this.sessionToken) {
      assistantMsg.isStreaming = false;
      assistantMsg.isThinking = false;
      return;
    }

    const enableWebSearch = supportsWebSearch(model) && this.webSearchEnabled;

    try {
      await provider.streamChat({
        apiKey: platformConfig.apiKey,
        baseUrl: platformConfig.baseUrl,
        model,
        messages: requestMessages,
        systemPrompt,
        thinkingLevel,
        enableWebSearch,
        signal: this.abortController.signal,
        onThinkingDelta: (delta) => {
          if (token !== this.sessionToken) return;
          assistantMsg.isThinking = true;
          assistantMsg.thinking = (assistantMsg.thinking ?? "") + delta;
          this.notify();
        },
        onTextDelta: (delta) => {
          if (token !== this.sessionToken) return;
          assistantMsg.isThinking = false;
          assistantMsg.content += delta;
          this.notify();
        },
        onSearchSources: (incoming: SearchSource[]) => {
          if (token !== this.sessionToken || incoming.length === 0) return;
          const existing = assistantMsg.sources ?? [];
          const seen = new Set(existing.map((s) => s.url));
          let changed = false;
          const next = [...existing];
          for (const source of incoming) {
            if (!seen.has(source.url)) {
              seen.add(source.url);
              next.push(source);
              changed = true;
            }
          }
          if (changed) {
            assistantMsg.sources = next;
            this.notify();
          }
        },
        onServerToolCalls: (calls: unknown[]) => {
          if (token !== this.sessionToken || calls.length === 0) return;
          assistantMsg.serverToolCalls = calls;
        },
      });
    } catch (err) {
      if (token !== this.sessionToken) {
        return;
      }
      const isAbort = err instanceof DOMException && err.name === "AbortError";
      if (!isAbort) {
        const errMsg = err instanceof Error ? err.message : String(err);
        assistantMsg.error = errMsg;
        new Notice(`请求失败：${errMsg}`);
      }
    } finally {
      assistantMsg.isStreaming = false;
      assistantMsg.isThinking = false;
      if (token !== this.sessionToken) {
        return;
      }
      assistantMsg.timestamp = formatTimestamp(new Date());
      this.isStreaming = false;
      this.abortController = null;

      await this.persistCurrentChat(model, thinkingLevel, token);
      if (token !== this.sessionToken) {
        return;
      }
      this.notify();
    }
  }

  private async persistCurrentChat(
    model: ModelInfo,
    thinkingLevel: ThinkingLevel | undefined,
    sessionToken: number
  ): Promise<void> {
    if (this.messages.length === 0) {
      return;
    }

    // Never persist empty assistant messages (e.g. failed request or aborted before first text delta)
    const persistableMessages = this.messages.filter(
      (m) => !(m.role === "assistant" && m.content.trim().length === 0)
    );
    if (persistableMessages.length === 0) {
      return;
    }

    const hasAssistantContent = persistableMessages.some(
      (m) => m.role === "assistant" && m.content.trim().length > 0
    );
    const fileExists =
      this.currentFile !== null &&
      this.host.app.vault.getAbstractFileByPath(this.currentFile.path) instanceof TFile;

    if (!fileExists && !hasAssistantContent) {
      return;
    }

    const firstUserMsg = persistableMessages.find((m) => m.role === "user");
    const firstAssistantMsg = persistableMessages.find(
      (m) => m.role === "assistant" && m.content.trim().length > 0
    );
    const defaultTitle =
      this.currentTitle.trim() || extractChatTitle(firstUserMsg?.content ?? "", 15);

    const meta: ChatNoteMeta = {
      title: defaultTitle,
      prompt: this.activePrompt ? this.activePrompt.fileName : undefined,
      platform: model.platformId,
      model: model.id,
      thinking: thinkingLevel,
    };

    try {
      if (!fileExists || !this.currentFile) {
        const isFreshFirstTurn = !this.currentFile && !this.hasManualTitle;
        const createdFile = await this.host.chatStore.createChatNote(
          this.settings.chatsFolder,
          meta,
          persistableMessages
        );
        this.currentFile = createdFile;
        this.currentTitle = defaultTitle;

        if (isFreshFirstTurn && firstAssistantMsg) {
          void this.generateAndApplyAutoTitle({
            file: createdFile,
            sessionToken,
            model,
            userText: firstUserMsg?.content ?? "",
            assistantText: firstAssistantMsg.content,
            initialTitle: defaultTitle,
          });
        }
      } else {
        this.currentTitle = await this.host.chatStore.updateChatNote(
          this.currentFile,
          meta,
          persistableMessages
        );
      }
    } catch (err) {
      console.error("[obsidian-i-chat] Failed to save chat note:", err);
      new Notice("自动保存对话笔记失败，请检查对话记录路径设置。");
    }
  }

  private async generateAndApplyAutoTitle(params: {
    file: TFile;
    sessionToken: number;
    model: ModelInfo;
    userText: string;
    assistantText: string;
    initialTitle: string;
  }): Promise<void> {
    const provider = this.host.registry.get(params.model.platformId);
    const platformConfig = this.settings.platforms[params.model.platformId];
    if (!provider || !platformConfig || !platformConfig.apiKey.trim()) {
      return;
    }

    this.abortTitleGeneration();
    const controller = new AbortController();
    this.titleAbortController = controller;
    const timeoutId = window.setTimeout(() => controller.abort(), 25_000);

    let generated = "";
    try {
      const promptMsg: ChatMessage = {
        id: createId("title"),
        role: "user",
        timestamp: formatTimestamp(new Date()),
        content: buildAutoTitlePrompt(params.userText, params.assistantText),
      };

      await provider.streamChat({
        apiKey: platformConfig.apiKey,
        baseUrl: platformConfig.baseUrl,
        model: params.model,
        messages: [promptMsg],
        disableThinking: true,
        enableWebSearch: false,
        signal: controller.signal,
        onTextDelta: (delta) => {
          generated += delta;
        },
      });
    } catch {
      // Silently keep default first-15-chars title on any network/model error or abort
      return;
    } finally {
      window.clearTimeout(timeoutId);
      if (this.titleAbortController === controller) {
        this.titleAbortController = null;
      }
    }

    const nextTitle = sanitizeGeneratedTitle(generated);
    if (!nextTitle || nextTitle === params.initialTitle) {
      return;
    }

    // Abort write if session switched, user manually renamed, or file was deleted/edited externally
    if (
      params.sessionToken !== this.sessionToken ||
      this.hasManualTitle ||
      this.currentFile?.path !== params.file.path
    ) {
      return;
    }

    const liveFile = this.host.app.vault.getAbstractFileByPath(params.file.path);
    if (!(liveFile instanceof TFile)) {
      return;
    }

    try {
      const raw = await this.host.app.vault.read(liveFile);
      const diskTitle = parseChatFrontmatter(raw).meta.title?.trim();
      if (diskTitle && diskTitle !== params.initialTitle) {
        return;
      }

      await this.host.chatStore.renameChatTitle(liveFile, nextTitle);
      if (
        params.sessionToken === this.sessionToken &&
        !this.hasManualTitle &&
        this.currentFile?.path === liveFile.path
      ) {
        this.currentTitle = nextTitle;
        this.notify();
      }
    } catch {
      // Silently ignore persistence errors for background title update
    }
  }
}
