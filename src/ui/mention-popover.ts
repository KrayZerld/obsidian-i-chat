import { App, TAbstractFile, TFile, TFolder, setIcon } from "obsidian";
import { resolveNoteDisplayTitle } from "../utils/mention";

export interface MentionCandidate {
  target: TAbstractFile;
  kind: "active" | "file" | "folder";
  label: string;
  subLabel: string;
  searchText: string;
}

export interface MentionPopoverOptions {
  app: App;
  anchorEl: HTMLElement;
  getActiveFile: () => TFile | null;
  onSelect: (target: TAbstractFile) => void;
  onClose?: () => void;
}

const MAX_RESULTS = 3;

export class MentionPopover {
  private popoverEl: HTMLElement | null = null;
  private listEl: HTMLElement | null = null;
  private bindListenersTimer: number | null = null;
  private candidates: MentionCandidate[] = [];
  private selectedIndex = 0;
  private query = "";

  constructor(private readonly options: MentionPopoverOptions) {}

  isOpen(): boolean {
    return this.popoverEl !== null;
  }

  open(query: string): void {
    this.query = query;
    this.selectedIndex = 0;

    if (!this.popoverEl) {
      const pop = document.body.createDiv({ cls: "ichat-popover ichat-mention-popover" });
      this.popoverEl = pop;
      this.listEl = pop.createDiv({ cls: "ichat-popover-body" });

      this.bindListenersTimer = window.setTimeout(() => {
        this.bindListenersTimer = null;
        if (!this.popoverEl) return;
        document.addEventListener("mousedown", this.handleOutsideClick);
      }, 0);
    }

    this.refreshCandidates();
    this.renderList();
    this.positionPopover();
  }

  updateQuery(query: string): void {
    if (!this.popoverEl) {
      this.open(query);
      return;
    }
    this.query = query;
    this.selectedIndex = 0;
    this.refreshCandidates();
    this.renderList();
    this.positionPopover();
  }

  close(): void {
    const wasOpen = this.popoverEl !== null;
    if (this.bindListenersTimer !== null) {
      window.clearTimeout(this.bindListenersTimer);
      this.bindListenersTimer = null;
    }
    document.removeEventListener("mousedown", this.handleOutsideClick);
    if (this.popoverEl) {
      this.popoverEl.remove();
      this.popoverEl = null;
      this.listEl = null;
    }
    this.candidates = [];
    this.selectedIndex = 0;
    if (wasOpen) {
      this.options.onClose?.();
    }
  }

  moveSelection(delta: number): void {
    if (this.candidates.length === 0) return;
    const len = this.candidates.length;
    this.selectedIndex = (this.selectedIndex + delta + len) % len;
    this.renderList();
  }

  confirmSelection(): boolean {
    const picked = this.candidates[this.selectedIndex];
    if (!picked) {
      return false;
    }
    const target = picked.target;
    this.options.onSelect(target);
    this.close();
    return true;
  }

  private getFileDisplayTitle(file: TFile): string {
    if (file.extension.toLowerCase() === "md") {
      const fm = this.options.app.metadataCache.getFileCache(file)?.frontmatter as
        | Record<string, unknown>
        | undefined;
      return resolveNoteDisplayTitle(fm, file.basename);
    }
    return file.name;
  }

  private matchesQuery(candidate: MentionCandidate, q: string): number {
    if (!q) return 1;
    const labelLower = candidate.label.toLowerCase();
    const pathLower = candidate.target.path.toLowerCase();
    if (labelLower === q) return 100;
    if (labelLower.startsWith(q)) return 80;
    if (labelLower.includes(q)) return 60;
    if (pathLower.includes(q)) return 40;
    if (candidate.searchText.includes(q)) return 20;
    return 0;
  }

  private refreshCandidates(): void {
    const q = this.query.trim().toLowerCase();
    const results: MentionCandidate[] = [];

    const activeFile = this.options.getActiveFile();
    const activePath = activeFile?.path ?? "";

    if (activeFile) {
      const activeTitle = this.getFileDisplayTitle(activeFile);
      const activeCandidate: MentionCandidate = {
        target: activeFile,
        kind: "active",
        label: activeTitle,
        subLabel: activeFile.path,
        searchText: `${activeTitle} ${activeFile.basename} ${activeFile.path} 当前活跃笔记 当前笔记 active`.toLowerCase(),
      };
      if (!q || this.matchesQuery(activeCandidate, q) > 0) {
        results.push(activeCandidate);
      }
    }

    const scoredVaultItems: Array<{ candidate: MentionCandidate; score: number }> = [];
    const allItems = this.options.app.vault.getAllLoadedFiles();

    for (const item of allItems) {
      if (item.path === "" || item.path === "/" || item.path === activePath) {
        continue;
      }

      if (item instanceof TFile) {
        const label = this.getFileDisplayTitle(item);
        const candidate: MentionCandidate = {
          target: item,
          kind: "file",
          label,
          subLabel: item.path,
          searchText: `${label} ${item.name} ${item.path}`.toLowerCase(),
        };
        const score = this.matchesQuery(candidate, q);
        if (score > 0) {
          scoredVaultItems.push({
            candidate,
            score: score + (item.extension.toLowerCase() === "md" ? 5 : 0),
          });
        }
      } else if (item instanceof TFolder) {
        const candidate: MentionCandidate = {
          target: item,
          kind: "folder",
          label: item.name,
          subLabel: item.path,
          searchText: `${item.name} ${item.path}`.toLowerCase(),
        };
        const score = this.matchesQuery(candidate, q);
        if (score > 0) {
          scoredVaultItems.push({ candidate, score });
        }
      }
    }

    scoredVaultItems.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.candidate.label.localeCompare(b.candidate.label);
    });

    const remainingSlots = Math.max(0, MAX_RESULTS - results.length);
    for (let i = 0; i < Math.min(remainingSlots, scoredVaultItems.length); i++) {
      results.push(scoredVaultItems[i].candidate);
    }

    this.candidates = results;
    if (this.selectedIndex >= this.candidates.length) {
      this.selectedIndex = 0;
    }
  }

  private renderList(): void {
    if (!this.listEl) return;
    this.listEl.empty();

    if (this.candidates.length === 0) {
      this.listEl.createDiv({
        cls: "ichat-popover-empty",
        text: "未找到匹配的笔记或文件夹",
      });
      return;
    }

    this.candidates.forEach((item, index) => {
      const isSelected = index === this.selectedIndex;
      const row = this.listEl!.createEl("button", {
        type: "button",
        cls: `ichat-popover-item ichat-mention-item ${isSelected ? "is-active" : ""}`,
      });

      const iconWrap = row.createSpan({ cls: "ichat-mention-icon" });
      setIcon(
        iconWrap,
        item.kind === "active"
          ? "file-check"
          : item.kind === "folder"
            ? "folder"
            : "file-text"
      );

      const main = row.createDiv({ cls: "ichat-popover-item-main" });
      const titleRow = main.createDiv({ cls: "ichat-mention-title-row" });
      titleRow.createSpan({ cls: "ichat-popover-item-name", text: item.label });
      if (item.kind === "active") {
        titleRow.createSpan({ cls: "ichat-badge ichat-mention-active-badge", text: "当前笔记" });
      }
      main.createSpan({ cls: "ichat-popover-item-sub", text: item.subLabel });

      row.addEventListener("mouseenter", () => {
        if (this.selectedIndex !== index) {
          this.selectedIndex = index;
          this.updateActiveRowClass();
        }
      });

      // Prevent textarea blur on click
      row.addEventListener("mousedown", (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        const target = item.target;
        this.options.onSelect(target);
        this.close();
      });
    });

    const activeRow = this.listEl.querySelector<HTMLElement>(".ichat-mention-item.is-active");
    activeRow?.scrollIntoView({ block: "nearest" });
  }

  private updateActiveRowClass(): void {
    if (!this.listEl) return;
    const rows = this.listEl.querySelectorAll<HTMLElement>(".ichat-mention-item");
    rows.forEach((row, idx) => {
      row.toggleClass("is-active", idx === this.selectedIndex);
    });
  }

  private positionPopover(): void {
    if (!this.popoverEl) return;
    const rect = this.options.anchorEl.getBoundingClientRect();
    const margin = 8;
    const width = Math.min(Math.max(rect.width, 300), 420);
    this.popoverEl.style.width = `${Math.round(width)}px`;

    const popRect = this.popoverEl.getBoundingClientRect();
    let left = rect.left;
    if (left + popRect.width > window.innerWidth - margin) {
      left = Math.max(margin, window.innerWidth - popRect.width - margin);
    }

    let top = rect.top - popRect.height - 6;
    if (top < margin) {
      top = Math.min(window.innerHeight - popRect.height - margin, rect.bottom + 6);
    }

    this.popoverEl.style.left = `${Math.round(left)}px`;
    this.popoverEl.style.top = `${Math.round(top)}px`;
  }

  private readonly handleOutsideClick = (evt: MouseEvent): void => {
    const target = evt.target as Node | null;
    if (!target) return;
    if (this.popoverEl?.contains(target) || this.options.anchorEl.contains(target)) {
      return;
    }
    this.close();
  };
}
