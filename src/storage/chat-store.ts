import { App, TFile, normalizePath } from "obsidian";
import {
  ChatHistoryItem,
  ChatMessage,
  ChatNoteMeta,
  FRONTMATTER_KEYS,
} from "../types";
import { formatFileStamp } from "../utils/time";
import {
  buildTurnsFromMessages,
  parseChatFrontmatter,
  parseChatNote,
  resolveUniqueChatFileName,
  serializeChatNote,
} from "./note-codec";

export class ChatStore {
  constructor(private readonly app: App) {}

  private normalizeFolder(folder: string): string {
    const trimmed = folder.trim().replace(/^\/+|\/+$/g, "");
    return trimmed ? normalizePath(trimmed) : "";
  }

  async ensureFolderExists(folder: string): Promise<string> {
    const normFolder = this.normalizeFolder(folder);
    if (!normFolder) {
      return "";
    }
    const segments = normFolder.split("/");
    let current = "";
    for (const seg of segments) {
      current = current ? `${current}/${seg}` : seg;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (!existing) {
        await this.app.vault.createFolder(current);
      }
    }
    return normFolder;
  }

  async createChatNote(
    chatsFolder: string,
    meta: ChatNoteMeta,
    messages: ChatMessage[],
    now: Date = new Date()
  ): Promise<TFile> {
    const normFolder = await this.ensureFolderExists(chatsFolder);
    const stamp = formatFileStamp(now);

    const existingNames = new Set<string>();
    for (const file of this.app.vault.getMarkdownFiles()) {
      const parentPath = file.parent ? normalizePath(file.parent.path) : "";
      const expectedParent = normFolder || "/";
      if (
        (normFolder === "" && (parentPath === "" || parentPath === "/")) ||
        parentPath === expectedParent
      ) {
        existingNames.add(file.name);
      }
    }

    const fileName = resolveUniqueChatFileName(stamp, existingNames);
    const fullPath = normFolder ? `${normFolder}/${fileName}` : fileName;
    const content = serializeChatNote(meta, buildTurnsFromMessages(messages));
    return await this.app.vault.create(fullPath, content);
  }

  /**
   * Updates an existing chat note while preserving any user-edited i-chat-title in frontmatter.
   */
  async updateChatNote(
    file: TFile,
    meta: ChatNoteMeta,
    messages: ChatMessage[]
  ): Promise<string> {
    let existingTitle: string | undefined;
    try {
      const raw = await this.app.vault.cachedRead(file);
      const parsed = parseChatFrontmatter(raw);
      if (parsed.meta.title && parsed.meta.title.trim().length > 0) {
        existingTitle = parsed.meta.title.trim();
      }
    } catch {
      // Ignore read errors and fall back to meta.title
    }

    const finalTitle = existingTitle || meta.title || file.basename;
    const mergedMeta: ChatNoteMeta = {
      ...meta,
      title: finalTitle,
    };

    const content = serializeChatNote(mergedMeta, buildTurnsFromMessages(messages));
    await this.app.vault.modify(file, content);
    return finalTitle;
  }

  async renameChatTitle(file: TFile, newTitle: string): Promise<void> {
    const trimmed = newTitle.trim();
    if (!trimmed) {
      return;
    }
    await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
      fm[FRONTMATTER_KEYS.title] = trimmed;
    });
  }

  async deleteChatNote(file: TFile): Promise<void> {
    await this.app.vault.trash(file, true);
  }

  async loadChatNote(file: TFile): Promise<{ meta: ChatNoteMeta; messages: ChatMessage[] }> {
    const raw = await this.app.vault.read(file);
    return parseChatNote(raw);
  }

  async listHistory(chatsFolder: string): Promise<ChatHistoryItem[]> {
    const normFolder = this.normalizeFolder(chatsFolder);
    const prefix = normFolder ? `${normFolder}/` : "";

    const files = this.app.vault
      .getMarkdownFiles()
      .filter((f) => {
        const normPath = normalizePath(f.path);
        if (!normFolder) {
          return !normPath.includes("/");
        }
        return normPath.startsWith(prefix);
      })
      .sort((a, b) => b.stat.mtime - a.stat.mtime);

    const items: ChatHistoryItem[] = [];
    for (const file of files) {
      const cacheFm = this.app.metadataCache.getFileCache(file)?.frontmatter;
      let meta: ChatNoteMeta = {};

      if (cacheFm && FRONTMATTER_KEYS.title in cacheFm) {
        meta = {
          title:
            typeof cacheFm[FRONTMATTER_KEYS.title] === "string"
              ? cacheFm[FRONTMATTER_KEYS.title].trim()
              : undefined,
          prompt:
            typeof cacheFm[FRONTMATTER_KEYS.prompt] === "string"
              ? cacheFm[FRONTMATTER_KEYS.prompt].trim()
              : undefined,
          platform:
            typeof cacheFm[FRONTMATTER_KEYS.platform] === "string"
              ? cacheFm[FRONTMATTER_KEYS.platform].trim()
              : undefined,
          model:
            typeof cacheFm[FRONTMATTER_KEYS.model] === "string"
              ? cacheFm[FRONTMATTER_KEYS.model].trim()
              : undefined,
        };
      } else {
        const raw = await this.app.vault.cachedRead(file);
        meta = parseChatFrontmatter(raw).meta;
      }

      items.push({
        filePath: file.path,
        fileName: file.name,
        title: meta.title || file.basename,
        mtime: file.stat.mtime,
        meta,
      });
    }

    return items;
  }
}
