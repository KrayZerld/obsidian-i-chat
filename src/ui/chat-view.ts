import {
  Component,
  ItemView,
  MarkdownRenderer,
  Notice,
  TAbstractFile,
  WorkspaceLeaf,
  setIcon,
} from "obsidian";
import type IChatPlugin from "../main";
import { supportsWebSearch } from "../core/model-resolver";
import { ChatMessage, THINKING_LEVEL_LABELS } from "../types";
import {
  collectVaultFiles,
  extractDroppedOsFiles,
  parseObsidianOpenUri,
  readFileToAttachment,
  readVaultFileToAttachment,
} from "../utils/attachments";
import { resolvePasteAction } from "../utils/clipboard";
import { formatComposerPlaceholder } from "../utils/composer";
import { createIconButton, setButtonIcon } from "../utils/icons";
import { MentionToken, findActiveMentionToken } from "../utils/mention";
import { AgentPopover } from "./agent-popover";
import { HistoryModal } from "./history-modal";
import { MentionPopover } from "./mention-popover";
import { ModelPopover } from "./model-popover";

export const VIEW_TYPE_ICHAT = "obsidian-i-chat-view";

export class IChatView extends ItemView {
  private messagesEl!: HTMLElement;
  private messagesInnerEl!: HTMLElement;
  private attachmentsBarEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private fileInputEl!: HTMLInputElement;
  private modelTriggerEl!: HTMLButtonElement;
  private agentTriggerEl!: HTMLButtonElement;
  private webSearchBtnEl!: HTMLButtonElement;
  private scrollBottomBtnEl!: HTMLButtonElement;
  private sendBtnEl!: HTMLButtonElement;
  private composerInnerEl!: HTMLElement;

  private unsubscribe: (() => void) | null = null;
  private renderComponent: Component | null = null;
  private activePopover: { close(): void } | null = null;
  private mentionPopover: MentionPopover | null = null;
  private activeMentionToken: MentionToken | null = null;

  private autoScrollEnabled = true;
  private dragDepth = 0;
  private cachedVaultDragTargets: TAbstractFile[] = [];

  /** Memo keys to avoid redundant DOM rebuilds on streaming chunks. */
  private lastToolbarKey = "";
  private lastAttachmentsKey = "";
  private lastTabTitle = "";

  /** Active copy-check feedback timers keyed by button element. */
  private readonly copyResetTimers = new WeakMap<HTMLButtonElement, number>();

  /** Tracks explicit user expand/collapse overrides for thinking & sources blocks per message id (default collapsed). */
  private readonly thinkingExpandedOverride = new Map<string, boolean>();
  private readonly sourcesExpandedOverride = new Map<string, boolean>();

  /** Persistent streaming DOM handles for flicker-free, single-flight double-buffered updates. */
  private streamingRowEl: HTMLElement | null = null;
  private streamingThinkingHostEl: HTMLElement | null = null;
  private streamingBodyEl: HTMLElement | null = null;
  private streamingSourcesHostEl: HTMLElement | null = null;
  private streamingErrorHostEl: HTMLElement | null = null;
  private streamingMessageId: string | null = null;
  private streamingBodyComponent: Component | null = null;
  private streamingThinkingComponent: Component | null = null;
  private streamingThinkingKey = "";
  private streamingSourcesKey = "";
  private streamingBodyRenderedText = "";
  private streamingWaitingShown = false;
  private isBodyRendering = false;
  private bodyRenderQueued = false;
  private bodyRenderTimer: number | null = null;
  private renderedMessageIdsKey = "";

  constructor(leaf: WorkspaceLeaf, private readonly plugin: IChatPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_ICHAT;
  }

  getDisplayText(): string {
    return this.plugin.controller?.currentTitle || "i-Chat";
  }

  getIcon(): string {
    return "message-square";
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("ichat-view");

    // Drag & Drop file upload overlay + handlers
    this.setupDragAndDrop(root);

    // 1. Messages scroll area (full-width scroll container + centered reading column)
    this.messagesEl = root.createDiv({ cls: "ichat-messages" });
    this.messagesInnerEl = this.messagesEl.createDiv({ cls: "ichat-messages-inner" });
    this.messagesEl.addEventListener("scroll", () => {
      const distanceToBottom =
        this.messagesEl.scrollHeight -
        this.messagesEl.scrollTop -
        this.messagesEl.clientHeight;
      this.autoScrollEnabled = distanceToBottom < 48;
      this.updateScrollBottomButton(distanceToBottom);
    });

    // 2. Bottom composer (floating scroll-to-bottom button + centered composer inner)
    const composer = root.createDiv({ cls: "ichat-composer" });
    this.scrollBottomBtnEl = createIconButton(composer, {
      icon: "arrow-down",
      ariaLabel: "回到底部",
      className: "ichat-scroll-bottom-btn",
      onClick: () => {
        this.autoScrollEnabled = true;
        if (this.messagesEl) {
          this.messagesEl.scrollTo({
            top: this.messagesEl.scrollHeight,
            behavior: "smooth",
          });
        }
        this.updateScrollBottomButton(0);
      },
    });
    const composerInner = composer.createDiv({ cls: "ichat-composer-inner" });
    this.composerInnerEl = composerInner;

    // Hidden native OS file picker
    this.fileInputEl = composerInner.createEl("input", {
      type: "file",
      cls: "ichat-hidden-file-input",
      attr: { multiple: "multiple" },
    });
    this.fileInputEl.addEventListener("change", () => {
      void this.handleFilesSelected(this.fileInputEl.files);
      this.fileInputEl.value = "";
    });

    // Attachment chips row (filename only)
    this.attachmentsBarEl = composerInner.createDiv({ cls: "ichat-attachments-bar" });

    // Message input textarea
    this.inputEl = composerInner.createEl("textarea", {
      cls: "ichat-input",
      attr: {
        rows: "1",
        placeholder: "Ask anything…",
      },
    });
    this.mentionPopover = new MentionPopover({
      app: this.app,
      anchorEl: this.composerInnerEl,
      getActiveFile: () => this.plugin.getLastActiveMarkdownFile(),
      onSelect: (target) => {
        this.applyMentionSelection(target);
      },
      onClose: () => {
        this.activeMentionToken = null;
      },
    });
    this.inputEl.addEventListener("input", () => {
      this.autoResizeInput();
      this.updateSendButtonState();
      this.syncMentionPopover();
    });
    this.inputEl.addEventListener("click", () => {
      this.syncMentionPopover();
    });
    this.inputEl.addEventListener("keyup", (evt) => {
      if (evt.key === "ArrowLeft" || evt.key === "ArrowRight" || evt.key === "Home" || evt.key === "End") {
        this.syncMentionPopover();
      }
    });
    this.inputEl.addEventListener("keydown", (evt) => {
      if (this.mentionPopover?.isOpen() && !evt.isComposing) {
        if (evt.key === "ArrowDown") {
          evt.preventDefault();
          this.mentionPopover.moveSelection(1);
          return;
        }
        if (evt.key === "ArrowUp") {
          evt.preventDefault();
          this.mentionPopover.moveSelection(-1);
          return;
        }
        if (evt.key === "Enter" || evt.key === "Tab") {
          evt.preventDefault();
          this.mentionPopover.confirmSelection();
          return;
        }
        if (evt.key === "Escape") {
          evt.preventDefault();
          this.mentionPopover.close();
          return;
        }
      }

      if (evt.key === "Enter" && !evt.shiftKey && !evt.isComposing) {
        evt.preventDefault();
        void this.handleSendOrStop();
      }
    });
    this.inputEl.addEventListener("paste", (evt) => {
      const clipboardData = evt.clipboardData;
      if (!clipboardData) return;

      const files = Array.from(clipboardData.files ?? []);
      const plainText = clipboardData.getData("text/plain") ?? "";
      const html = clipboardData.getData("text/html") ?? "";

      const action = resolvePasteAction({ files, plainText, html });
      if (action.kind === "attachments") {
        evt.preventDefault();
        void this.handleFilesSelected(action.files);
      } else if (action.kind === "insert-text") {
        evt.preventDefault();
        this.insertTextIntoInput(action.text);
      }
    });

    // Toolbar
    const toolbar = composerInner.createDiv({ cls: "ichat-toolbar" });
    const leftGroup = toolbar.createDiv({ cls: "ichat-toolbar-group ichat-toolbar-left" });
    const rightGroup = toolbar.createDiv({ cls: "ichat-toolbar-group ichat-toolbar-right" });

    // [+] OS file picker
    createIconButton(leftGroup, {
      icon: "plus",
      ariaLabel: "添加附件",
      onClick: () => {
        this.fileInputEl.click();
      },
    });

    // [Model Thinking ▾]
    this.modelTriggerEl = leftGroup.createEl("button", {
      type: "button",
      cls: "ichat-selector-btn",
      attr: { "aria-label": "选择模型与思考等级" },
    });
    this.modelTriggerEl.addEventListener("click", (evt) => {
      evt.stopPropagation();
      this.openModelPopover();
    });

    // [Default / Prompt ▾]
    this.agentTriggerEl = leftGroup.createEl("button", {
      type: "button",
      cls: "ichat-selector-btn",
      attr: { "aria-label": "选择提示词" },
    });
    this.agentTriggerEl.addEventListener("click", (evt) => {
      evt.stopPropagation();
      void this.openAgentPopover();
    });

    leftGroup.createSpan({ cls: "ichat-toolbar-divider" });

    // [Web Search] (Google AI / DeepSeek deepseek-flash)
    this.webSearchBtnEl = createIconButton(leftGroup, {
      icon: "globe",
      ariaLabel: "开启联网搜索",
      className: "ichat-websearch-btn",
      onClick: () => {
        this.plugin.controller.toggleWebSearch();
      },
    });

    // [History]
    createIconButton(leftGroup, {
      icon: "history",
      ariaLabel: "历史对话",
      onClick: () => {
        this.closeActivePopover();
        new HistoryModal(this.app, {
          chatsFolder: this.plugin.settings.chatsFolder,
          currentFilePath: this.plugin.controller.currentFile?.path ?? null,
          chatStore: this.plugin.chatStore,
          onOpenChat: async (file) => {
            this.thinkingExpandedOverride.clear();
            this.sourcesExpandedOverride.clear();
            await this.plugin.controller.openHistoryChat(file);
            this.scrollToBottom(true);
          },
          onRenamedCurrentChat: (newTitle) => {
            this.plugin.controller.setCurrentTitle(newTitle);
          },
          onDeletedCurrentChat: () => {
            this.thinkingExpandedOverride.clear();
            this.sourcesExpandedOverride.clear();
            this.plugin.controller.startNewChat();
          },
        }).open();
      },
    });

    // [Setting]
    createIconButton(leftGroup, {
      icon: "settings",
      ariaLabel: "插件设置",
      onClick: () => {
        this.closeActivePopover();
        this.openPluginSettings();
      },
    });

    // [New]
    createIconButton(rightGroup, {
      icon: "square-pen",
      ariaLabel: "新建对话",
      onClick: () => {
        this.closeActivePopover();
        this.mentionPopover?.close();
        this.thinkingExpandedOverride.clear();
        this.sourcesExpandedOverride.clear();
        this.plugin.controller.startNewChat();
        this.inputEl.focus();
      },
    });

    // [Send] / [Stop]
    this.sendBtnEl = createIconButton(rightGroup, {
      icon: "send-horizontal",
      ariaLabel: "发送消息",
      className: "ichat-send-btn",
      onClick: () => {
        void this.handleSendOrStop();
      },
    });

    this.unsubscribe = this.plugin.controller.subscribe(() => {
      this.renderAll();
    });

    await this.plugin.controller.syncActiveState();
    this.renderAll();
  }

  async onClose(): Promise<void> {
    this.closeActivePopover();
    this.mentionPopover?.close();
    this.mentionPopover = null;
    this.clearStreamingHandles();
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    if (this.renderComponent) {
      this.renderComponent.unload();
      this.renderComponent = null;
    }
  }

  private clearStreamingHandles(): void {
    if (this.bodyRenderTimer !== null) {
      window.clearTimeout(this.bodyRenderTimer);
      this.bodyRenderTimer = null;
    }
    if (this.streamingBodyComponent) {
      this.streamingBodyComponent.unload();
      this.streamingBodyComponent = null;
    }
    if (this.streamingThinkingComponent) {
      this.streamingThinkingComponent.unload();
      this.streamingThinkingComponent = null;
    }
    this.streamingRowEl = null;
    this.streamingThinkingHostEl = null;
    this.streamingBodyEl = null;
    this.streamingSourcesHostEl = null;
    this.streamingErrorHostEl = null;
    this.streamingMessageId = null;
    this.streamingThinkingKey = "";
    this.streamingSourcesKey = "";
    this.streamingBodyRenderedText = "";
    this.streamingWaitingShown = false;
    this.isBodyRendering = false;
    this.bodyRenderQueued = false;
  }

  private renderAll(): void {
    this.syncTabTitle();
    this.renderToolbarState();
    this.syncComposerPlaceholder();
    this.renderPendingAttachments();
    this.renderMessages();
  }

  private syncComposerPlaceholder(): void {
    if (!this.inputEl) return;
    const controller = this.plugin.controller;
    const nextPlaceholder = formatComposerPlaceholder({
      hasMessages: controller.messages.length > 0,
      promptTitle: controller.activePrompt?.title,
      modelDisplayName: controller.getActiveModel()?.displayName,
    });
    if (this.inputEl.placeholder !== nextPlaceholder) {
      this.inputEl.placeholder = nextPlaceholder;
    }
  }

  private syncTabTitle(): void {
    const nextTitle = this.getDisplayText();
    if (nextTitle === this.lastTabTitle) {
      return;
    }
    this.lastTabTitle = nextTitle;

    // 1. Update Obsidian tab header
    const leafAny = this.leaf as unknown as {
      updateHeader?: () => void;
      tabHeaderInnerTitleEl?: HTMLElement;
    };
    if (typeof leafAny.updateHeader === "function") {
      leafAny.updateHeader();
    } else if (leafAny.tabHeaderInnerTitleEl) {
      leafAny.tabHeaderInnerTitleEl.setText(nextTitle);
    }

    // 2. Update view header title (next to back/forward arrows inside the pane)
    const viewAny = this as unknown as { titleEl?: HTMLElement };
    if (viewAny.titleEl) {
      viewAny.titleEl.setText(nextTitle);
    }
    const headerTitleEl = this.containerEl.querySelector<HTMLElement>(".view-header-title");
    if (headerTitleEl) {
      headerTitleEl.setText(nextTitle);
    }
  }

  private getObsidianDraggedTargets(): TAbstractFile[] {
    const dragManager = (this.app as unknown as {
      dragManager?: {
        draggable?: {
          type?: string;
          file?: TAbstractFile;
          files?: TAbstractFile[];
        };
      };
    }).dragManager;

    const draggable = dragManager?.draggable;
    if (!draggable) {
      return [];
    }
    if ((draggable.type === "file" || draggable.type === "folder") && draggable.file) {
      return [draggable.file];
    }
    if (draggable.type === "files" && Array.isArray(draggable.files)) {
      return draggable.files;
    }
    return [];
  }

  private setupDragAndDrop(root: HTMLElement): void {
    const overlay = root.createDiv({ cls: "ichat-drop-overlay" });
    const card = overlay.createDiv({ cls: "ichat-drop-card" });
    const iconEl = card.createSpan({ cls: "ichat-drop-icon" });
    setIcon(iconEl, "upload");
    card.createSpan({ cls: "ichat-drop-text", text: "释放文件或文件夹以添加附件" });

    const hasOsDraggedFiles = (evt: DragEvent): boolean => {
      const types = evt.dataTransfer?.types;
      return Boolean(types && Array.from(types).includes("Files"));
    };

    const hasSupportedDrag = (evt: DragEvent): boolean => {
      const vaultTargets = this.getObsidianDraggedTargets();
      if (vaultTargets.length > 0) {
        this.cachedVaultDragTargets = vaultTargets;
        return true;
      }
      return hasOsDraggedFiles(evt);
    };

    // Use capture phase so <textarea> never intercepts dropped obsidian:// links or folder names
    root.addEventListener(
      "dragenter",
      (evt) => {
        if (!hasSupportedDrag(evt)) return;
        evt.preventDefault();
        this.dragDepth++;
        root.addClass("is-drag-over");
      },
      true
    );

    root.addEventListener(
      "dragover",
      (evt) => {
        if (!hasSupportedDrag(evt)) return;
        evt.preventDefault();
        if (evt.dataTransfer) {
          evt.dataTransfer.dropEffect = "copy";
        }
        root.addClass("is-drag-over");
      },
      true
    );

    root.addEventListener(
      "dragleave",
      (evt) => {
        if (!hasSupportedDrag(evt) && !root.hasClass("is-drag-over")) return;
        this.dragDepth = Math.max(0, this.dragDepth - 1);
        if (this.dragDepth === 0) {
          root.removeClass("is-drag-over");
          this.cachedVaultDragTargets = [];
        }
      },
      true
    );

    root.addEventListener(
      "drop",
      (evt) => {
        const liveTargets = this.getObsidianDraggedTargets();
        let vaultTargets =
          liveTargets.length > 0 ? liveTargets : [...this.cachedVaultDragTargets];

        // Fallback: parse obsidian://open?vault=...&file=... if dragManager was already cleared
        if (vaultTargets.length === 0 && evt.dataTransfer) {
          const plainText = evt.dataTransfer.getData("text/plain") ?? "";
          const uriPath = parseObsidianOpenUri(plainText);
          if (uriPath) {
            const direct =
              this.app.vault.getAbstractFileByPath(uriPath) ??
              this.app.vault.getAbstractFileByPath(`${uriPath}.md`);
            if (direct) {
              vaultTargets = [direct];
            }
          }
        }

        const isOsFiles = hasOsDraggedFiles(evt);
        this.dragDepth = 0;
        this.cachedVaultDragTargets = [];
        root.removeClass("is-drag-over");

        if (vaultTargets.length > 0) {
          evt.preventDefault();
          evt.stopPropagation();
          void this.handleVaultTargetsDropped(vaultTargets);
          return;
        }

        if (isOsFiles && evt.dataTransfer) {
          evt.preventDefault();
          evt.stopPropagation();
          void this.handleOsDataTransferDropped(evt.dataTransfer);
        }
      },
      true
    );
  }

  private async handleVaultTargetsDropped(targets: TAbstractFile[]): Promise<void> {
    const { files, truncated } = collectVaultFiles(targets, 50);
    if (files.length === 0) {
      new Notice("该文件夹下没有可添加的文件。");
      return;
    }

    const loaded = [];
    for (const file of files) {
      try {
        loaded.push(await readVaultFileToAttachment(this.app, file));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        new Notice(`读取附件失败（${file.name}）：${msg}`);
      }
    }

    if (loaded.length > 0) {
      this.plugin.controller.addAttachments(loaded);
    }
    if (truncated) {
      new Notice("单次最多添加 50 个文件，已自动截取前 50 个。");
    }
  }

  private async handleOsDataTransferDropped(dataTransfer: DataTransfer): Promise<void> {
    const { files, truncated } = await extractDroppedOsFiles(dataTransfer, 50);
    if (files.length === 0) {
      new Notice("未检测到可添加的文件。");
      return;
    }

    const loaded = [];
    for (const file of files) {
      try {
        loaded.push(await readFileToAttachment(file));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        new Notice(`读取附件失败（${file.name}）：${msg}`);
      }
    }

    if (loaded.length > 0) {
      this.plugin.controller.addAttachments(loaded);
    }
    if (truncated) {
      new Notice("单次最多添加 50 个文件，已自动截取前 50 个。");
    }
  }

  private renderToolbarState(): void {
    const controller = this.plugin.controller;
    const model = controller.getActiveModel();
    const thinking = controller.getActiveThinkingLevel();
    const agentLabel = controller.activePrompt ? controller.activePrompt.title : "Default";
    const modelSupportsWebSearch = supportsWebSearch(model);
    const webSearchActive = modelSupportsWebSearch && controller.webSearchEnabled;

    const toolbarKey = `${model?.platformId ?? ""}|${model?.id ?? ""}|${thinking}|${agentLabel}|${controller.isStreaming}|${modelSupportsWebSearch}|${webSearchActive}`;
    if (toolbarKey === this.lastToolbarKey) {
      return;
    }
    this.lastToolbarKey = toolbarKey;

    // Model trigger label
    this.modelTriggerEl.empty();
    if (model) {
      this.modelTriggerEl.createSpan({ cls: "ichat-selector-text", text: model.displayName });
      if (model.capabilities.includes("think")) {
        this.modelTriggerEl.createSpan({
          cls: "ichat-selector-thinking",
          text: THINKING_LEVEL_LABELS[thinking],
        });
      }
    } else {
      this.modelTriggerEl.createSpan({ cls: "ichat-selector-text", text: "选择模型" });
    }
    const modelChevron = this.modelTriggerEl.createSpan({ cls: "ichat-chevron" });
    setIcon(modelChevron, "chevron-down");

    // Agent trigger label (displays i-chat-title)
    this.agentTriggerEl.empty();
    this.agentTriggerEl.createSpan({ cls: "ichat-selector-text", text: agentLabel });
    const agentChevron = this.agentTriggerEl.createSpan({ cls: "ichat-chevron" });
    setIcon(agentChevron, "chevron-down");

    // Native web search toggle (Google AI & DeepSeek deepseek-flash)
    this.webSearchBtnEl.toggleClass("is-hidden", !modelSupportsWebSearch);
    this.webSearchBtnEl.toggleClass("is-active", webSearchActive);
    this.webSearchBtnEl.setAttribute(
      "aria-label",
      webSearchActive ? "已开启联网搜索（点击关闭）" : "开启联网搜索"
    );

    // Send / Stop icon
    if (controller.isStreaming) {
      setButtonIcon(this.sendBtnEl, "square", "停止生成");
      this.sendBtnEl.addClass("is-streaming");
    } else {
      setButtonIcon(this.sendBtnEl, "send-horizontal", "发送消息");
      this.sendBtnEl.removeClass("is-streaming");
    }
    this.updateSendButtonState();
  }

  private updateSendButtonState(): void {
    if (!this.sendBtnEl || !this.inputEl) return;
    const controller = this.plugin.controller;
    if (controller.isStreaming) {
      this.sendBtnEl.removeClass("is-ready");
      this.sendBtnEl.removeClass("is-idle");
      return;
    }
    const canSend =
      this.inputEl.value.trim().length > 0 || controller.pendingAttachments.length > 0;
    this.sendBtnEl.toggleClass("is-ready", canSend);
    this.sendBtnEl.toggleClass("is-idle", !canSend);
  }

  private renderPendingAttachments(): void {
    const attachments = this.plugin.controller.pendingAttachments;
    const attachmentsKey = attachments.map((a) => a.id).join("|");
    if (attachmentsKey === this.lastAttachmentsKey) {
      return;
    }
    this.lastAttachmentsKey = attachmentsKey;

    this.attachmentsBarEl.empty();
    this.attachmentsBarEl.toggleClass("is-hidden", attachments.length === 0);

    for (const att of attachments) {
      const chip = this.attachmentsBarEl.createDiv({ cls: "ichat-attachment-chip" });
      chip.createSpan({ cls: "ichat-attachment-name", text: att.name });
      createIconButton(chip, {
        icon: "x",
        ariaLabel: `移除 ${att.name}`,
        className: "ichat-chip-remove",
        onClick: () => {
          this.plugin.controller.removeAttachment(att.id);
        },
      });
    }
    this.updateSendButtonState();
  }

  private renderMessages(): void {
    const controller = this.plugin.controller;
    const messages = controller.messages;
    const sourcePath = controller.currentFile?.path ?? "";
    const messageIdsKey = messages.map((m) => m.id).join("|");
    const lastMsg = messages[messages.length - 1];

    // Fast path: during active streaming of the same message list, incrementally update ONLY the streaming row
    if (
      controller.isStreaming &&
      lastMsg &&
      lastMsg.role === "assistant" &&
      lastMsg.isStreaming &&
      this.streamingRowEl &&
      this.streamingMessageId === lastMsg.id &&
      this.renderedMessageIdsKey === messageIdsKey
    ) {
      this.syncStreamingAssistantRow(lastMsg, sourcePath);
      return;
    }

    this.clearStreamingHandles();
    if (this.renderComponent) {
      this.renderComponent.unload();
    }
    this.renderComponent = new Component();
    this.renderComponent.load();
    this.renderedMessageIdsKey = messageIdsKey;

    this.messagesInnerEl.empty();

    if (messages.length === 0) {
      const empty = this.messagesInnerEl.createDiv({ cls: "ichat-empty-state" });
      const iconWrap = empty.createDiv({ cls: "ichat-empty-icon" });
      setIcon(iconWrap, "sparkles");
      empty.createDiv({ cls: "ichat-empty-title", text: "开始新的对话" });
      empty.createDiv({
        cls: "ichat-empty-sub",
        text: "在下方输入消息，按 Enter 发送，Shift + Enter 换行。",
      });
      this.updateScrollBottomButton(0);
      return;
    }

    // Locate the index of the LAST user message (only it gets [Retry])
    let lastUserIndex = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        lastUserIndex = i;
        break;
      }
    }

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role === "user") {
        this.renderUserMessage(msg, i === lastUserIndex, sourcePath);
      } else {
        const row = this.messagesInnerEl.createDiv({ cls: "ichat-message ichat-message-assistant" });
        if (msg.isStreaming) {
          this.initStreamingAssistantRow(row, msg, sourcePath);
        } else {
          this.renderAssistantMessageInto(row, msg, sourcePath, this.renderComponent);
        }
      }
    }

    if (this.autoScrollEnabled) {
      this.scrollToBottom(false);
    } else {
      this.updateScrollBottomButton();
    }
  }

  private initStreamingAssistantRow(
    row: HTMLElement,
    msg: ChatMessage,
    sourcePath: string
  ): void {
    this.streamingRowEl = row;
    this.streamingMessageId = msg.id;
    this.streamingThinkingHostEl = row.createDiv({ cls: "ichat-thinking-host" });
    this.streamingBodyEl = row.createDiv({
      cls: "ichat-bubble ichat-bubble-assistant markdown-rendered",
    });
    this.streamingSourcesHostEl = row.createDiv({ cls: "ichat-sources-host" });
    this.streamingErrorHostEl = row.createDiv({ cls: "ichat-error-host" });

    const footer = row.createDiv({ cls: "ichat-message-footer ichat-footer-assistant" });
    footer.createSpan({ cls: "ichat-timestamp", text: msg.timestamp });
    const copyBtn = createIconButton(footer, {
      icon: "copy",
      ariaLabel: "复制",
      className: "ichat-msg-action",
      onClick: () => {
        void this.copyText(msg.content, copyBtn);
      },
    });

    this.syncStreamingAssistantRow(msg, sourcePath);
  }

  private syncStreamingAssistantRow(msg: ChatMessage, sourcePath: string): void {
    if (
      !this.streamingThinkingHostEl ||
      !this.streamingBodyEl ||
      !this.streamingSourcesHostEl ||
      !this.streamingErrorHostEl
    ) {
      return;
    }

    // 1. Update collapsible thinking header/content only when state changes (default collapsed)
    const hasThinking = Boolean(msg.thinking && msg.thinking.trim().length > 0);
    const isExpanded = Boolean(this.thinkingExpandedOverride.get(msg.id));
    const thinkingKey = `${hasThinking}|${Boolean(msg.isThinking)}|${isExpanded}|${isExpanded ? (msg.thinking?.length ?? 0) : 0}`;

    if (thinkingKey !== this.streamingThinkingKey) {
      this.streamingThinkingKey = thinkingKey;
      if (this.streamingThinkingComponent) {
        this.streamingThinkingComponent.unload();
        this.streamingThinkingComponent = null;
      }
      this.streamingThinkingHostEl.empty();

      if (hasThinking && msg.thinking) {
        this.streamingThinkingComponent = new Component();
        this.streamingThinkingComponent.load();
        this.renderThinkingBlock(
          this.streamingThinkingHostEl,
          msg,
          isExpanded,
          sourcePath,
          this.streamingThinkingComponent,
          () => {
            this.thinkingExpandedOverride.set(msg.id, !isExpanded);
            this.streamingThinkingKey = "";
            this.syncStreamingAssistantRow(msg, sourcePath);
          }
        );
      }
    }

    // 2. Update assistant body with double-buffered offscreen Markdown rendering
    if (msg.content.length === 0) {
      const shouldShowWaiting = Boolean(msg.isStreaming && !msg.isThinking && !hasThinking);
      if (shouldShowWaiting && !this.streamingWaitingShown) {
        this.streamingWaitingShown = true;
        this.streamingBodyEl.empty();
        this.renderThinkingIndicator(this.streamingBodyEl);
      } else if (!shouldShowWaiting && this.streamingWaitingShown) {
        this.streamingWaitingShown = false;
        this.streamingBodyEl.empty();
      }
    } else {
      this.streamingWaitingShown = false;
      if (msg.content !== this.streamingBodyRenderedText) {
        this.requestDoubleBufferedBodyRender(msg, sourcePath);
      }
    }

    // 3. Collapsible web search sources if present (UI-only, default collapsed)
    const sourcesCount = msg.sources?.length ?? 0;
    const isSourcesExpanded = Boolean(this.sourcesExpandedOverride.get(msg.id));
    const sourcesKey = `${sourcesCount}|${isSourcesExpanded}`;
    if (sourcesKey !== this.streamingSourcesKey) {
      this.streamingSourcesKey = sourcesKey;
      this.streamingSourcesHostEl.empty();
      if (msg.sources && msg.sources.length > 0) {
        this.renderSourcesBlock(this.streamingSourcesHostEl, msg, isSourcesExpanded, () => {
          this.sourcesExpandedOverride.set(msg.id, !isSourcesExpanded);
          this.streamingSourcesKey = "";
          this.syncStreamingAssistantRow(msg, sourcePath);
        });
      }
    }

    // 4. Error banner if present
    this.streamingErrorHostEl.empty();
    if (msg.error) {
      this.streamingErrorHostEl.createDiv({ cls: "ichat-error-banner", text: msg.error });
    }
  }

  private requestDoubleBufferedBodyRender(msg: ChatMessage, sourcePath: string): void {
    if (this.isBodyRendering) {
      this.bodyRenderQueued = true;
      return;
    }
    if (this.bodyRenderTimer !== null) {
      return;
    }
    void this.flushDoubleBufferedBodyRender(msg, sourcePath);
  }

  private async flushDoubleBufferedBodyRender(
    msg: ChatMessage,
    sourcePath: string
  ): Promise<void> {
    const msgId = msg.id;
    const snapshot = msg.content;
    if (!this.streamingBodyEl || this.streamingMessageId !== msgId) {
      return;
    }

    this.isBodyRendering = true;
    this.bodyRenderQueued = false;

    const tempEl = document.createElement("div");
    tempEl.className = "markdown-rendered";
    const tempComp = new Component();
    tempComp.load();

    try {
      await MarkdownRenderer.render(this.app, snapshot, tempEl, sourcePath, tempComp);

      if (!this.streamingBodyEl || this.streamingMessageId !== msgId) {
        tempComp.unload();
        return;
      }

      const prevComp = this.streamingBodyComponent;
      this.streamingBodyComponent = tempComp;
      this.streamingBodyEl.replaceChildren(...Array.from(tempEl.childNodes));
      prevComp?.unload();
      this.streamingBodyRenderedText = snapshot;

      if (this.autoScrollEnabled) {
        this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
      } else {
        this.updateScrollBottomButton();
      }
    } finally {
      this.isBodyRendering = false;
    }

    if (
      this.streamingMessageId === msgId &&
      (this.bodyRenderQueued || msg.content !== this.streamingBodyRenderedText)
    ) {
      const len = msg.content.length;
      const delay = len > 8000 ? 120 : len > 3000 ? 75 : 40;
      this.bodyRenderTimer = window.setTimeout(() => {
        this.bodyRenderTimer = null;
        if (this.streamingMessageId === msgId) {
          void this.flushDoubleBufferedBodyRender(msg, sourcePath);
        }
      }, delay);
    }
  }

  private renderThinkingIndicator(parent: HTMLElement): void {
    const indicator = parent.createDiv({ cls: "ichat-thinking-indicator" });
    const sparkle = indicator.createSpan({ cls: "ichat-thinking-sparkle" });
    setIcon(sparkle, "sparkles");
    indicator.createSpan({ cls: "ichat-thinking-label", text: "思考中" });
  }

  private renderThinkingBlock(
    parent: HTMLElement,
    msg: ChatMessage,
    isExpanded: boolean,
    sourcePath: string,
    component: Component,
    onToggle: () => void
  ): void {
    const thinkBox = parent.createDiv({
      cls: `ichat-thinking-box ${isExpanded ? "is-expanded" : ""}`,
    });

    const toggleBtn = thinkBox.createEl("button", {
      type: "button",
      cls: "ichat-thinking-toggle",
    });
    const chevron = toggleBtn.createSpan({ cls: "ichat-thinking-chevron" });
    setIcon(chevron, isExpanded ? "chevron-down" : "chevron-right");
    if (msg.isThinking) {
      const sparkle = toggleBtn.createSpan({ cls: "ichat-thinking-sparkle" });
      setIcon(sparkle, "sparkles");
    }
    toggleBtn.createSpan({
      cls: "ichat-thinking-label",
      text: msg.isThinking ? "思考中" : "思考过程",
    });

    toggleBtn.addEventListener("click", onToggle);

    if (isExpanded && msg.thinking) {
      const thinkBody = thinkBox.createDiv({
        cls: "ichat-thinking-content markdown-rendered",
      });
      void MarkdownRenderer.render(
        this.app,
        msg.thinking,
        thinkBody,
        sourcePath,
        component
      );
    }
  }

  private renderSourcesBlock(
    parent: HTMLElement,
    msg: ChatMessage,
    isExpanded: boolean,
    onToggle: () => void
  ): void {
    const sources = msg.sources ?? [];
    if (sources.length === 0) return;

    const box = parent.createDiv({
      cls: `ichat-sources-box ${isExpanded ? "is-expanded" : ""}`,
    });

    const toggleBtn = box.createEl("button", {
      type: "button",
      cls: "ichat-thinking-toggle ichat-sources-toggle",
    });
    const chevron = toggleBtn.createSpan({ cls: "ichat-thinking-chevron" });
    setIcon(chevron, isExpanded ? "chevron-down" : "chevron-right");
    const globe = toggleBtn.createSpan({ cls: "ichat-sources-globe" });
    setIcon(globe, "globe");
    toggleBtn.createSpan({
      cls: "ichat-thinking-label",
      text: `参考来源 (${sources.length})`,
    });
    toggleBtn.addEventListener("click", onToggle);

    if (isExpanded) {
      const list = box.createDiv({ cls: "ichat-sources-list" });
      for (const source of sources) {
        const link = list.createEl("a", {
          cls: "ichat-source-link external-link",
          text: source.title,
          attr: {
            href: source.url,
            target: "_blank",
            rel: "noopener noreferrer",
          },
        });
        link.addEventListener("click", (evt) => {
          evt.preventDefault();
          window.open(source.url, "_blank", "noopener,noreferrer");
        });
      }
    }
  }

  private renderUserMessage(
    msg: ChatMessage,
    isLastUserMessage: boolean,
    sourcePath: string
  ): void {
    const row = this.messagesInnerEl.createDiv({ cls: "ichat-message ichat-message-user" });

    // Session-only attachment chips (filename only)
    if (msg.attachments && msg.attachments.length > 0) {
      const attRow = row.createDiv({ cls: "ichat-message-attachments" });
      for (const att of msg.attachments) {
        const chip = attRow.createDiv({ cls: "ichat-attachment-chip is-readonly" });
        chip.createSpan({ cls: "ichat-attachment-name", text: att.name });
      }
    }

    if (msg.content.length > 0) {
      const bubble = row.createDiv({
        cls: "ichat-bubble ichat-bubble-user markdown-rendered",
      });
      void MarkdownRenderer.render(
        this.app,
        msg.content,
        bubble,
        sourcePath,
        this.renderComponent!
      );
    }

    // Footer: [Copy] [Retry] YYYY-MM-DD HH:mm:ss
    const footer = row.createDiv({ cls: "ichat-message-footer ichat-footer-user" });

    const copyBtn = createIconButton(footer, {
      icon: "copy",
      ariaLabel: "复制",
      className: "ichat-msg-action",
      onClick: () => {
        void this.copyText(msg.content, copyBtn);
      },
    });

    if (isLastUserMessage && !this.plugin.controller.isStreaming) {
      createIconButton(footer, {
        icon: "rotate-cw",
        ariaLabel: "重试最后一轮",
        className: "ichat-msg-action",
        onClick: () => {
          this.autoScrollEnabled = true;
          void this.plugin.controller.retryLastTurn();
        },
      });
    }

    footer.createSpan({ cls: "ichat-timestamp", text: msg.timestamp });
  }

  private renderAssistantMessageInto(
    row: HTMLElement,
    msg: ChatMessage,
    sourcePath: string,
    component: Component
  ): void {
    // Collapsible Thinking block (UI only, default collapsed)
    if (msg.thinking && msg.thinking.trim().length > 0) {
      const isExpanded = Boolean(this.thinkingExpandedOverride.get(msg.id));
      const thinkHost = row.createDiv({ cls: "ichat-thinking-host" });
      this.renderThinkingBlock(thinkHost, msg, isExpanded, sourcePath, component, () => {
        this.thinkingExpandedOverride.set(msg.id, !isExpanded);
        this.renderedMessageIdsKey = "";
        this.renderMessages();
      });
    }

    // Response Markdown body
    const bodyEl = row.createDiv({
      cls: "ichat-bubble ichat-bubble-assistant markdown-rendered",
    });
    if (msg.content.length > 0) {
      void MarkdownRenderer.render(
        this.app,
        msg.content,
        bodyEl,
        sourcePath,
        component
      );
    } else if (msg.isStreaming && !msg.isThinking) {
      this.renderThinkingIndicator(bodyEl);
    }

    // Collapsible web search sources (UI only, default collapsed)
    if (msg.sources && msg.sources.length > 0) {
      const isExpanded = Boolean(this.sourcesExpandedOverride.get(msg.id));
      const sourcesHost = row.createDiv({ cls: "ichat-sources-host" });
      this.renderSourcesBlock(sourcesHost, msg, isExpanded, () => {
        this.sourcesExpandedOverride.set(msg.id, !isExpanded);
        this.renderedMessageIdsKey = "";
        this.renderMessages();
      });
    }

    if (msg.error) {
      row.createDiv({ cls: "ichat-error-banner", text: msg.error });
    }

    // Footer: YYYY-MM-DD HH:mm:ss [Copy]
    const footer = row.createDiv({ cls: "ichat-message-footer ichat-footer-assistant" });
    footer.createSpan({ cls: "ichat-timestamp", text: msg.timestamp });

    const copyBtn = createIconButton(footer, {
      icon: "copy",
      ariaLabel: "复制",
      className: "ichat-msg-action",
      onClick: () => {
        void this.copyText(msg.content, copyBtn);
      },
    });
  }

  private syncMentionPopover(): void {
    if (!this.mentionPopover || !this.inputEl) return;
    const caret = this.inputEl.selectionStart ?? this.inputEl.value.length;
    const token = findActiveMentionToken(this.inputEl.value, caret);
    if (!token) {
      this.activeMentionToken = null;
      if (this.mentionPopover.isOpen()) {
        this.mentionPopover.close();
      }
      return;
    }

    this.activeMentionToken = token;
    if (this.mentionPopover.isOpen()) {
      this.mentionPopover.updateQuery(token.query);
    } else {
      this.closeActivePopover();
      this.mentionPopover.open(token.query);
    }
  }

  private applyMentionSelection(target: TAbstractFile): void {
    const caret = this.inputEl.selectionStart ?? this.inputEl.value.length;
    const token =
      this.activeMentionToken ?? findActiveMentionToken(this.inputEl.value, caret);
    this.activeMentionToken = null;
    if (token) {
      const before = this.inputEl.value.slice(0, token.start);
      const after = this.inputEl.value.slice(token.end);
      this.inputEl.value = `${before}${after}`;
      const nextCaret = before.length;
      this.inputEl.setSelectionRange(nextCaret, nextCaret);
      this.autoResizeInput();
      this.updateSendButtonState();
    }
    this.inputEl.focus();
    void this.handleVaultTargetsDropped([target]);
  }

  private async handleSendOrStop(): Promise<void> {
    this.mentionPopover?.close();
    const controller = this.plugin.controller;
    if (controller.isStreaming) {
      controller.stopStreaming();
      return;
    }

    const text = this.inputEl.value;
    if (!text.trim() && controller.pendingAttachments.length === 0) {
      return;
    }

    this.inputEl.value = "";
    this.autoResizeInput();
    this.updateSendButtonState();
    this.autoScrollEnabled = true;

    await controller.sendMessage(text);
  }

  private insertTextIntoInput(text: string): void {
    const el = this.inputEl;
    el.focus();
    const insertedViaExecCommand =
      typeof document.execCommand === "function" &&
      document.execCommand("insertText", false, text);
    if (!insertedViaExecCommand) {
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? el.value.length;
      el.setRangeText(text, start, end, "end");
    }
    this.autoResizeInput();
    this.updateSendButtonState();
  }

  private async handleFilesSelected(fileList: FileList | File[] | null): Promise<void> {
    if (!fileList || fileList.length === 0) {
      return;
    }

    const loaded = [];
    for (const file of Array.from(fileList)) {
      try {
        loaded.push(await readFileToAttachment(file));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        new Notice(`读取附件失败（${file.name}）：${msg}`);
      }
    }

    if (loaded.length > 0) {
      this.plugin.controller.addAttachments(loaded);
    }
  }

  private openModelPopover(): void {
    this.closeActivePopover();
    const controller = this.plugin.controller;
    const popover = new ModelPopover({
      anchorEl: this.modelTriggerEl,
      groups: controller.getAvailableModelGroups(),
      activePlatformId: controller.settings.activePlatformId,
      activeModelId: controller.settings.activeModelId,
      activeThinkingLevel: controller.getActiveThinkingLevel(),
      onSelectModel: (platformId, modelId, thinking) => {
        void controller.selectModel(platformId, modelId, thinking);
      },
      onSelectThinkingLevel: (level) => {
        void controller.selectThinkingLevel(level);
      },
      onOpenSettings: () => {
        this.openPluginSettings();
      },
    });
    this.activePopover = popover;
    popover.open();
  }

  private async openAgentPopover(): Promise<void> {
    this.closeActivePopover();
    const prompts = await this.plugin.promptStore.listPrompts(
      this.plugin.settings.promptsFolder
    );
    const popover = new AgentPopover({
      anchorEl: this.agentTriggerEl,
      prompts,
      activePromptFile: this.plugin.settings.activePromptFile,
      onSelect: (prompt) => {
        void this.plugin.controller.selectPrompt(prompt);
      },
    });
    this.activePopover = popover;
    popover.open();
  }

  private closeActivePopover(): void {
    this.mentionPopover?.close();
    if (this.activePopover) {
      this.activePopover.close();
      this.activePopover = null;
    }
  }

  private openPluginSettings(): void {
    const settingManager = (this.app as unknown as {
      setting?: { open: () => void; openTabById: (id: string) => void };
    }).setting;
    if (settingManager) {
      settingManager.open();
      settingManager.openTabById(this.plugin.manifest.id);
    }
  }

  private autoResizeInput(): void {
    this.inputEl.style.height = "auto";
    const maxHeight = 160;
    const nextHeight = Math.min(this.inputEl.scrollHeight, maxHeight);
    this.inputEl.style.height = `${Math.max(nextHeight, 24)}px`;
  }

  private updateScrollBottomButton(distanceOverride?: number): void {
    if (!this.scrollBottomBtnEl || !this.messagesEl) return;
    const distanceToBottom =
      distanceOverride ??
      this.messagesEl.scrollHeight -
        this.messagesEl.scrollTop -
        this.messagesEl.clientHeight;
    const hasScrollableContent =
      this.messagesEl.scrollHeight > this.messagesEl.clientHeight + 40;
    this.scrollBottomBtnEl.toggleClass(
      "is-visible",
      hasScrollableContent && distanceToBottom > 120
    );
  }

  private scrollToBottom(force: boolean): void {
    if (force) {
      this.autoScrollEnabled = true;
    }
    window.requestAnimationFrame(() => {
      if (this.messagesEl) {
        this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
        this.updateScrollBottomButton(0);
      }
    });
  }

  private async copyText(text: string, buttonEl?: HTMLButtonElement): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      if (buttonEl) {
        const existingTimer = this.copyResetTimers.get(buttonEl);
        if (existingTimer !== undefined) {
          window.clearTimeout(existingTimer);
        }
        setButtonIcon(buttonEl, "check", "已复制");
        buttonEl.addClass("is-copied");

        const timer = window.setTimeout(() => {
          this.copyResetTimers.delete(buttonEl);
          if (buttonEl.isConnected) {
            setButtonIcon(buttonEl, "copy", "复制");
            buttonEl.removeClass("is-copied");
          }
        }, 1200);
        this.copyResetTimers.set(buttonEl, timer);
      }
    } catch {
      new Notice("复制失败");
    }
  }
}
