import { AbstractInputSuggest, App, TFolder } from "obsidian";

export class FolderSuggest extends AbstractInputSuggest<TFolder> {
  private readonly onSelectFolder: (folderPath: string) => void;

  constructor(
    app: App,
    private readonly textInputEl: HTMLInputElement,
    onSelectFolder: (folderPath: string) => void
  ) {
    super(app, textInputEl);
    this.onSelectFolder = onSelectFolder;
  }

  getSuggestions(inputStr: string): TFolder[] {
    const query = inputStr.trim().toLowerCase();
    const folders: TFolder[] = [];

    for (const abstractFile of this.app.vault.getAllLoadedFiles()) {
      if (abstractFile instanceof TFolder) {
        if (!abstractFile.path || abstractFile.path === "/") {
          continue;
        }
        if (!query || abstractFile.path.toLowerCase().includes(query)) {
          folders.push(abstractFile);
        }
      }
    }

    return folders.sort((a, b) => a.path.localeCompare(b.path)).slice(0, 50);
  }

  renderSuggestion(folder: TFolder, el: HTMLElement): void {
    el.setText(folder.path);
  }

  selectSuggestion(folder: TFolder): void {
    this.textInputEl.value = folder.path;
    this.textInputEl.trigger("input");
    this.onSelectFolder(folder.path);
    this.close();
  }
}
