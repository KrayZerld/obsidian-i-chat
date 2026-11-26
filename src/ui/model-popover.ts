import { setIcon } from "obsidian";
import {
  AvailableModelGroup,
  ModelInfo,
  PlatformId,
  THINKING_LEVELS,
  THINKING_LEVEL_LABELS,
  ThinkingLevel,
} from "../types";

export interface ModelPopoverOptions {
  anchorEl: HTMLElement;
  groups: AvailableModelGroup[];
  activePlatformId: PlatformId;
  activeModelId: string;
  activeThinkingLevel: ThinkingLevel;
  onSelectModel: (platformId: PlatformId, modelId: string, thinkingLevel: ThinkingLevel) => void;
  onSelectThinkingLevel: (level: ThinkingLevel) => void;
  onOpenSettings: () => void;
}

export class ModelPopover {
  private popoverEl: HTMLElement | null = null;
  private bindListenersTimer: number | null = null;
  private selectedThinking: ThinkingLevel;
  private activeModel: ModelInfo | undefined;

  constructor(private readonly options: ModelPopoverOptions) {
    this.selectedThinking = options.activeThinkingLevel;
    for (const group of options.groups) {
      if (group.platformId === options.activePlatformId) {
        this.activeModel = group.models.find((m) => m.id === options.activeModelId);
      }
    }
  }

  open(): void {
    this.close();

    const pop = document.body.createDiv({ cls: "ichat-popover ichat-model-popover" });
    this.popoverEl = pop;

    // Header: compact Thinking Level selector (Option A)
    const header = pop.createDiv({ cls: "ichat-popover-header" });
    header.createSpan({ cls: "ichat-popover-title", text: "思考等级" });

    const levelGroup = header.createDiv({ cls: "ichat-thinking-group" });
    const activeSupportsThink = this.activeModel
      ? this.activeModel.capabilities.includes("think")
      : true;
    if (!activeSupportsThink) {
      levelGroup.addClass("is-muted");
    }

    const levelButtons: Array<{ level: ThinkingLevel; btn: HTMLButtonElement }> = [];
    for (const level of THINKING_LEVELS) {
      const btn = levelGroup.createEl("button", {
        type: "button",
        cls: `ichat-thinking-btn ${this.selectedThinking === level ? "is-active" : ""}`,
        text: THINKING_LEVEL_LABELS[level],
      });
      btn.addEventListener("click", (evt) => {
        evt.stopPropagation();
        this.selectedThinking = level;
        for (const item of levelButtons) {
          item.btn.toggleClass("is-active", item.level === level);
        }
        this.options.onSelectThinkingLevel(level);
      });
      levelButtons.push({ level, btn });
    }

    // Body: grouped enabled models
    const body = pop.createDiv({ cls: "ichat-popover-body" });

    if (this.options.groups.length === 0) {
      const empty = body.createDiv({ cls: "ichat-popover-empty" });
      empty.createDiv({ text: "暂无可用模型，请先在 BYOK 设置中填写 Key 并启用模型。" });
      const goBtn = empty.createEl("button", {
        type: "button",
        cls: "ichat-link-btn",
        text: "前往设置",
      });
      goBtn.addEventListener("click", (evt) => {
        evt.stopPropagation();
        this.close();
        this.options.onOpenSettings();
      });
    } else {
      for (const group of this.options.groups) {
        const groupEl = body.createDiv({ cls: "ichat-model-group" });
        groupEl.createDiv({ cls: "ichat-model-group-label", text: group.platformName });

        for (const model of group.models) {
          const isActive =
            group.platformId === this.options.activePlatformId &&
            model.id === this.options.activeModelId;

          const row = groupEl.createEl("button", {
            type: "button",
            cls: `ichat-popover-item ${isActive ? "is-selected" : ""}`,
          });

          const left = row.createDiv({ cls: "ichat-popover-item-main" });
          left.createSpan({ cls: "ichat-popover-item-name", text: model.displayName });

          const badges = left.createDiv({ cls: "ichat-capability-badges" });
          if (model.capabilities.includes("visual")) {
            badges.createSpan({ cls: "ichat-badge", text: "Visual" });
          }
          if (model.capabilities.includes("think")) {
            badges.createSpan({ cls: "ichat-badge", text: "Think" });
          }

          if (isActive) {
            const check = row.createSpan({ cls: "ichat-popover-check" });
            setIcon(check, "check");
          }

          row.addEventListener("click", (evt) => {
            evt.stopPropagation();
            this.options.onSelectModel(group.platformId, model.id, this.selectedThinking);
            this.close();
          });
        }
      }
    }

    this.positionPopover(pop, this.options.anchorEl);

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
