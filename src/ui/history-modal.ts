import { App, Modal, Notice, SearchComponent, TFile, TextComponent } from "obsidian";
import { ChatHistoryItem } from "../types";
import { ChatStore } from "../storage/chat-store";
import { createIconButton } from "../utils/icons";
import { formatTimestamp } from "../utils/time";

export interface HistoryModalOptions {
  chatsFolder: string;
  currentFilePath: string | null;
  chatStore: ChatStore;
  onOpenChat: (file: TFile) => Promise<void>;
  onRenamedCurrentChat?: (newTitle: string) => void;
  onDeletedCurrentChat: () => void;
}

export class HistoryModal extends Modal {
  private items: ChatHistoryItem[] = [];
  private query = "";
  private editingFilePath: string | null = null;
  private listEl!: HTMLElement;

  constructor(app: App, private readonly options: HistoryModalOptions) {
    super(app);
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("ichat-history-modal");
    this.setTitle("历史对话");

    const searchWrap = contentEl.createDiv({ cls: "ichat-history-search" });
    const search = new SearchComponent(searchWrap);
    search.setPlaceholder("搜索对话标题…").onChange((value) => {
      this.query = value.trim().toLowerCase();
      this.renderList();
    });

    this.listEl = contentEl.createDiv({ cls: "ichat-history-list" });
    this.listEl.createDiv({ cls: "ichat-popover-empty", text: "加载中…" });

    await this.reloadItems();
    search.inputEl.focus();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async reloadItems(): Promise<void> {
    this.items = await this.options.chatStore.listHistory(this.options.chatsFolder);
    this.renderList();
  }

  private renderList(): void {
    this.listEl.empty();

    const filtered = this.items.filter((item) => {
      if (!this.query) return true;
      return item.title.toLowerCase().includes(this.query);
    });

    if (filtered.length === 0) {
      const text = this.items.length === 0 ? "暂无历史对话记录" : "未找到匹配的对话";
      this.listEl.createDiv({ cls: "ichat-popover-empty", text });
      return;
    }

    for (const item of filtered) {
      const isActive = item.filePath === this.options.currentFilePath;
      const row = this.listEl.createDiv({
        cls: `ichat-history-item ${isActive ? "is-selected" : ""}`,
      });

      if (this.editingFilePath === item.filePath) {
        this.renderRenameRow(row, item);
        continue;
      }

      const main = row.createDiv({ cls: "ichat-history-item-main" });
      main.createDiv({ cls: "ichat-history-item-title", text: item.title });
      main.createDiv({
        cls: "ichat-history-item-time",
        text: formatTimestamp(new Date(item.mtime)),
      });

      main.addEventListener("click", async () => {
        const abstract = this.app.vault.getAbstractFileByPath(item.filePath);
        if (!(abstract instanceof TFile)) {
          new Notice("对话笔记不存在或已被移动。");
          return;
        }
        this.close();
        await this.options.onOpenChat(abstract);
      });

      const actions = row.createDiv({ cls: "ichat-history-item-actions" });

      createIconButton(actions, {
        icon: "pencil",
        ariaLabel: "重命名标题",
        onClick: () => {
          this.editingFilePath = item.filePath;
          this.renderList();
        },
      });

      createIconButton(actions, {
        icon: "trash-2",
        ariaLabel: "删除对话",
        className: "ichat-danger-btn",
        onClick: async () => {
          const abstract = this.app.vault.getAbstractFileByPath(item.filePath);
          if (abstract instanceof TFile) {
            await this.options.chatStore.deleteChatNote(abstract);
            if (item.filePath === this.options.currentFilePath) {
              this.options.onDeletedCurrentChat();
            }
            await this.reloadItems();
          }
        },
      });
    }
  }

  private renderRenameRow(row: HTMLElement, item: ChatHistoryItem): void {
    const textComp = new TextComponent(row);
    textComp.setValue(item.title);
    const input = textComp.inputEl;
    input.addClass("ichat-rename-input");

    const commit = async (): Promise<void> => {
      const nextTitle = input.value.trim();
      this.editingFilePath = null;
      if (nextTitle && nextTitle !== item.title) {
        const abstract = this.app.vault.getAbstractFileByPath(item.filePath);
        if (abstract instanceof TFile) {
          await this.options.chatStore.renameChatTitle(abstract, nextTitle);
          item.title = nextTitle;
          if (item.filePath === this.options.currentFilePath) {
            this.options.onRenamedCurrentChat?.(nextTitle);
          }
        }
      }
      this.renderList();
    };

    const cancel = (): void => {
      this.editingFilePath = null;
      this.renderList();
    };

    input.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter" && !evt.isComposing) {
        evt.preventDefault();
        void commit();
      } else if (evt.key === "Escape") {
        evt.preventDefault();
        cancel();
      }
    });

    const actions = row.createDiv({ cls: "ichat-history-item-actions" });
    createIconButton(actions, {
      icon: "check",
      ariaLabel: "确认重命名",
      onClick: () => {
        void commit();
      },
    });
    createIconButton(actions, {
      icon: "x",
      ariaLabel: "取消",
      onClick: cancel,
    });

    window.setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
  }
}
