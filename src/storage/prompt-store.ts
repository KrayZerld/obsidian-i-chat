import { App, TFile, normalizePath } from "obsidian";
import { FRONTMATTER_KEYS, PlatformId, PromptItem, ThinkingLevel, isThinkingLevel } from "../types";
import {
  PromptFrontmatterPatch,
  PromptModelBinding,
  computePromptFrontmatterPatch,
  parseChatFrontmatter,
} from "./note-codec";

export function stripFrontmatter(raw: string): string {
  const normalized = raw.replace(/\r\n/g, "\n");
  const match = normalized.match(/^---\n[\s\S]*?\n---(?:\n|$)/);
  if (!match) {
    return normalized.trim();
  }
  return normalized.slice(match[0].length).trim();
}

export class PromptStore {
  constructor(private readonly app: App) {}

  private normalizeFolder(folder: string): string {
    const trimmed = folder.trim().replace(/^\/+|\/+$/g, "");
    return trimmed ? normalizePath(trimmed) : "";
  }

  private getRelativeFileName(folder: string, filePath: string): string {
    const normFolder = this.normalizeFolder(folder);
    const normPath = normalizePath(filePath);
    if (normFolder && normPath.startsWith(`${normFolder}/`)) {
      return normPath.slice(normFolder.length + 1);
    }
    const parts = normPath.split("/");
    return parts[parts.length - 1] ?? normPath;
  }

  private async readPromptItem(folder: string, file: TFile): Promise<PromptItem> {
    const cacheFm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    let title: string | undefined;
    let platform: string | undefined;
    let model: string | undefined;
    let thinking: ThinkingLevel | undefined;

    if (cacheFm) {
      if (typeof cacheFm[FRONTMATTER_KEYS.title] === "string" && cacheFm[FRONTMATTER_KEYS.title].trim()) {
        title = cacheFm[FRONTMATTER_KEYS.title].trim();
      }
      if (typeof cacheFm[FRONTMATTER_KEYS.platform] === "string" && cacheFm[FRONTMATTER_KEYS.platform].trim()) {
        platform = cacheFm[FRONTMATTER_KEYS.platform].trim();
      }
      if (typeof cacheFm[FRONTMATTER_KEYS.model] === "string" && cacheFm[FRONTMATTER_KEYS.model].trim()) {
        model = cacheFm[FRONTMATTER_KEYS.model].trim();
      }
      const rawThinking = cacheFm[FRONTMATTER_KEYS.thinking];
      if (typeof rawThinking === "string" && isThinkingLevel(rawThinking.toLowerCase())) {
        thinking = rawThinking.toLowerCase() as ThinkingLevel;
      }
    } else {
      // Fallback when metadataCache has not indexed this file yet
      const raw = await this.app.vault.cachedRead(file);
      const { meta } = parseChatFrontmatter(raw);
      title = meta.title;
      platform = meta.platform;
      model = meta.model;
      thinking = meta.thinking;
    }

    return {
      filePath: file.path,
      fileName: this.getRelativeFileName(folder, file.path),
      title: title || file.basename,
      platform,
      model,
      thinking,
    };
  }

  async listPrompts(promptsFolder: string): Promise<PromptItem[]> {
    const normFolder = this.normalizeFolder(promptsFolder);
    if (!normFolder) {
      return [];
    }

    const prefix = `${normFolder}/`;
    const mdFiles = this.app.vault
      .getMarkdownFiles()
      .filter((f) => normalizePath(f.path).startsWith(prefix))
      .sort((a, b) => a.path.localeCompare(b.path));

    const items: PromptItem[] = [];
    for (const file of mdFiles) {
      items.push(await this.readPromptItem(normFolder, file));
    }
    return items.sort((a, b) => a.title.localeCompare(b.title));
  }

  async findPromptByRef(promptsFolder: string, promptRef: string | undefined): Promise<PromptItem | undefined> {
    if (!promptRef || !promptRef.trim()) {
      return undefined;
    }
    const cleanRef = promptRef.trim();
    const prompts = await this.listPrompts(promptsFolder);

    // 1. Exact relative fileName match (e.g. "Agent.md")
    const exactFileName = prompts.find((p) => p.fileName === cleanRef);
    if (exactFileName) {
      return exactFileName;
    }

    // 2. Match adding .md extension if omitted
    const withExt = cleanRef.endsWith(".md") ? cleanRef : `${cleanRef}.md`;
    const extMatch = prompts.find((p) => p.fileName === withExt);
    if (extMatch) {
      return extMatch;
    }

    // 3. Full path or basename match
    const normRef = normalizePath(cleanRef);
    return prompts.find(
      (p) =>
        normalizePath(p.filePath) === normRef ||
        p.fileName.endsWith(`/${withExt}`) ||
        p.title === cleanRef
    );
  }

  async readPromptBody(filePath: string): Promise<string> {
    const abstract = this.app.vault.getAbstractFileByPath(filePath);
    if (!(abstract instanceof TFile)) {
      return "";
    }
    const raw = await this.app.vault.cachedRead(abstract);
    return stripFrontmatter(raw);
  }

  /**
   * Ensures a prompt file has valid i-chat-* frontmatter when used.
   * Only backfills missing fields (i-chat-title, i-chat-platform, i-chat-model, i-chat-thinking)
   * and preserves all existing user properties.
   */
  async ensurePromptFrontmatter(
    filePath: string,
    fallbackBinding?: PromptModelBinding
  ): Promise<PromptFrontmatterPatch["resolved"] | null> {
    const abstract = this.app.vault.getAbstractFileByPath(filePath);
    if (!(abstract instanceof TFile)) {
      return null;
    }

    const raw = await this.app.vault.read(abstract);
    const patch = computePromptFrontmatterPatch(raw, abstract.basename, fallbackBinding);
    if (!patch.needsWrite) {
      return patch.resolved;
    }

    await this.app.fileManager.processFrontMatter(abstract, (fm: Record<string, unknown>) => {
      if (patch.title !== undefined) {
        const existingTitle = fm[FRONTMATTER_KEYS.title];
        if (typeof existingTitle !== "string" || !existingTitle.trim()) {
          fm[FRONTMATTER_KEYS.title] = patch.title;
        }
      }
      if (patch.binding) {
        const existingPlatform = fm[FRONTMATTER_KEYS.platform];
        const existingModel = fm[FRONTMATTER_KEYS.model];
        const hasPlatform =
          typeof existingPlatform === "string" && existingPlatform.trim().length > 0;
        const hasModel = typeof existingModel === "string" && existingModel.trim().length > 0;

        if (!hasPlatform || !hasModel) {
          fm[FRONTMATTER_KEYS.platform] = patch.binding.platformId;
          fm[FRONTMATTER_KEYS.model] = patch.binding.modelId;
          if (patch.binding.thinking) {
            fm[FRONTMATTER_KEYS.thinking] = patch.binding.thinking;
          } else {
            delete fm[FRONTMATTER_KEYS.thinking];
          }
        }
      }
    });

    return patch.resolved;
  }

  /**
   * Writes model binding (i-chat-platform, i-chat-model, i-chat-thinking) to a prompt file's frontmatter,
   * backfilling i-chat-title if missing while preserving all other user properties.
   */
  async writeModelBinding(
    filePath: string,
    platformId: PlatformId,
    modelId: string,
    thinking?: ThinkingLevel
  ): Promise<void> {
    const abstract = this.app.vault.getAbstractFileByPath(filePath);
    if (!(abstract instanceof TFile)) {
      return;
    }

    await this.app.fileManager.processFrontMatter(abstract, (fm: Record<string, unknown>) => {
      const existingTitle = fm[FRONTMATTER_KEYS.title];
      if (typeof existingTitle !== "string" || !existingTitle.trim()) {
        fm[FRONTMATTER_KEYS.title] = abstract.basename;
      }
      fm[FRONTMATTER_KEYS.platform] = platformId;
      fm[FRONTMATTER_KEYS.model] = modelId;
      if (thinking) {
        fm[FRONTMATTER_KEYS.thinking] = thinking;
      } else {
        delete fm[FRONTMATTER_KEYS.thinking];
      }
    });
  }
}
