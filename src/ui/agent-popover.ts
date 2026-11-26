import { SearchComponent, setIcon } from "obsidian";
import { PromptItem } from "../types";

export interface AgentPopoverOptions {
  anchorEl: HTMLElement;
  prompts: PromptItem[];
  activePromptFile: string;
  onSelect: (prompt: PromptItem | null) => void;
}

export class AgentPopover {
  private popoverEl: HTMLElement | null = null;
  private listEl: HTMLElement | null = null;
  private bindListenersTimer: number | null = null;
  private query = "";

  constructor(private readonly options: AgentPopoverOptions) {}

  open(): void {
    this.close();

    const pop = document.body.createDiv({ cls: "ichat-popover ichat-agent-popover" });
    this.popoverEl = pop;

    const searchWrap = pop.createDiv({ cls: "ichat-popover-search" });
    const search = new SearchComponent(searchWrap);
    search.setPlaceholder("搜索提示词…").onChange((value) => {
      this.query = value.trim().toLowerCase();
      this.renderList();
    });

    this.listEl = pop.createDiv({ cls: "ichat-popover-body" });
    this.renderList();

    this.positionPopover(pop, this.options.anchorEl);
    search.inputEl.focus();

    this.bindListenersTimer = window.setTimeout(() => {
      this.bindListenersTimer = null;
      if (!this.popoverEl) return;
      document.addEventListener("mousedown", this.handleOutsideClick);
      document.addEventListener("keydown", this.handleKeyDown);
    }, 0);
  }

  close(): void {
    if (this.bindListenersTimer !== null) {
      window.clearTimeout(this.bindListenersTimer);
      this.bindListenersTimer = null;
    }
    document.removeEventListener("mousedown", this.handleOutsideClick);
    document.removeEventListener("keydown", this.handleKeyDown);
    if (this.popoverEl) {
      this.popoverEl.remove();
      this.popoverEl = null;
    }
  }

  private renderList(): void {
    if (!this.listEl) return;
    this.listEl.empty();

    // "Default" (no prompt) option
    if (!this.query || "默认".includes(this.query) || "无提示词".includes(this.query) || "default".includes(this.query)) {
      const isDefaultActive = !this.options.activePromptFile;
      const defaultRow = this.listEl.createEl("button", {
        type: "button",
        cls: `ichat-popover-item ${isDefaultActive ? "is-selected" : ""}`,
      });
      defaultRow.createSpan({ cls: "ichat-popover-item-name", text: "默认" });
      if (isDefaultActive) {
        const check = defaultRow.createSpan({ cls: "ichat-popover-check" });
        setIcon(check, "check");
      }
      defaultRow.addEventListener("click", (evt) => {
        evt.stopPropagation();
        this.options.onSelect(null);
        this.close();
      });
    }

    const filtered = this.options.prompts.filter((item) => {
      if (!this.query) return true;
      return (
        item.title.toLowerCase().includes(this.query) ||
        item.fileName.toLowerCase().includes(this.query)
      );
    });

    if (filtered.length === 0) {
      const emptyText =
        this.options.prompts.length === 0
          ? "提示词目录下暂无 Markdown 文件"
          : "未找到匹配的提示词";
      this.listEl.createDiv({ cls: "ichat-popover-empty", text: emptyText });
      return;
    }

    for (const item of filtered) {
      const isActive = item.fileName === this.options.activePromptFile;
      const row = this.listEl.createEl("button", {
        type: "button",
        cls: `ichat-popover-item ${isActive ? "is-selected" : ""}`,
      });

      const main = row.createDiv({ cls: "ichat-popover-item-main" });
      main.createSpan({ cls: "ichat-popover-item-name", text: item.title });
      if (item.model) {
        main.createSpan({ cls: "ichat-popover-item-sub", text: item.model });
      }

      if (isActive) {
        const check = row.createSpan({ cls: "ichat-popover-check" });
        setIcon(check, "check");
      }

      row.addEventListener("click", (evt) => {
        evt.stopPropagation();
        this.options.onSelect(item);
        this.close();
      });
    }
  }

  private readonly handleOutsideClick = (evt: MouseEvent): void => {
    const target = evt.target as Node | null;
    if (!target) return;
    if (this.popoverEl?.contains(target) || this.options.anchorEl.contains(target)) {
      return;
    }
    this.close();
  };

  private readonly handleKeyDown = (evt: KeyboardEvent): void => {
    if (evt.key === "Escape") {
      evt.preventDefault();
      this.close();
    }
  };

  private positionPopover(pop: HTMLElement, anchor: HTMLElement): void {
    const rect = anchor.getBoundingClientRect();
    const popRect = pop.getBoundingClientRect();
    const margin = 8;

    let left = rect.left;
    if (left + popRect.width > window.innerWidth - margin) {
      left = Math.max(margin, window.innerWidth - popRect.width - margin);
    }

    let top = rect.top - popRect.height - 6;
    if (top < margin) {
      top = Math.min(window.innerHeight - popRect.height - margin, rect.bottom + 6);
    }

    pop.style.left = `${Math.round(left)}px`;
    pop.style.top = `${Math.round(top)}px`;
  }
}
