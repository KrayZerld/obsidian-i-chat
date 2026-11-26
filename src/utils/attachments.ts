import type { App, TAbstractFile, TFile, TFolder } from "obsidian";
import { Attachment, createId } from "../types";

const TEXT_EXTENSIONS = new Set([
  "md",
  "markdown",
  "txt",
  "json",
  "jsonl",
  "csv",
  "tsv",
  "xml",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "env",
  "log",
  "html",
  "htm",
  "css",
  "scss",
  "less",
  "js",
  "mjs",
  "cjs",
  "jsx",
  "ts",
  "tsx",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "swift",
  "c",
  "cpp",
  "cc",
  "h",
  "hpp",
  "cs",
  "php",
  "sql",
  "sh",
  "bash",
  "zsh",
  "ps1",
  "bat",
  "cmd",
  "dockerfile",
  "tex",
  "svg",
]);

const MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  pdf: "application/pdf",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  mp4: "video/mp4",
  webm: "video/webm",
  md: "text/markdown",
  txt: "text/plain",
  json: "application/json",
  csv: "text/csv",
};

function getExtension(fileName: string): string {
  const dotIdx = fileName.lastIndexOf(".");
  if (dotIdx <= 0 || dotIdx === fileName.length - 1) {
    return "";
  }
  return fileName.slice(dotIdx + 1).toLowerCase();
}

export function isTextExtension(fileName: string): boolean {
  return TEXT_EXTENSIONS.has(getExtension(fileName));
}

export function isTextAttachmentFile(file: File): boolean {
  if (isTextExtension(file.name)) {
    return true;
  }
  if (file.type.startsWith("text/")) {
    return true;
  }
  if (
    file.type === "application/json" ||
    file.type === "application/xml" ||
    file.type === "application/javascript" ||
    file.type === "application/typescript"
  ) {
    return true;
  }
  return false;
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const commaIdx = result.indexOf(",");
      resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error(`无法读取文件: ${file.name}`));
    reader.readAsDataURL(file);
  });
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

export async function readFileToAttachment(file: File): Promise<Attachment> {
  const ext = getExtension(file.name);
  const mimeType = file.type || MIME_BY_EXTENSION[ext] || "application/octet-stream";

  if (isTextAttachmentFile(file)) {
    const textContent = await file.text();
    return {
      id: createId("att"),
      name: file.name,
      mimeType,
      kind: "text",
      textContent,
    };
  }

  const base64Data = await readAsBase64(file);
  return {
    id: createId("att"),
    name: file.name,
    mimeType,
    kind: "binary",
    base64Data,
  };
}

/**
 * Reads an Obsidian Vault TFile directly into an Attachment (filename only in chips).
 */
export async function readVaultFileToAttachment(app: App, file: TFile): Promise<Attachment> {
  const ext = file.extension.toLowerCase();
  const mimeType = MIME_BY_EXTENSION[ext] || "application/octet-stream";

  if (TEXT_EXTENSIONS.has(ext)) {
    const textContent = await app.vault.cachedRead(file);
    return {
      id: createId("att"),
      name: file.name,
      mimeType,
      kind: "text",
      textContent,
      sourcePath: file.path,
    };
  }

  const buffer = await app.vault.readBinary(file);
  return {
    id: createId("att"),
    name: file.name,
    mimeType,
    kind: "binary",
    base64Data: arrayBufferToBase64(buffer),
    sourcePath: file.path,
  };
}

function isVaultFolder(item: TAbstractFile): item is TFolder {
  return "children" in item && Array.isArray((item as TFolder).children);
}

function isVaultFile(item: TAbstractFile): item is TFile {
  return "extension" in item && typeof (item as TFile).extension === "string";
}

/**
 * Recursively collects TFiles from Vault files/folders up to maxFiles.
 */
export function collectVaultFiles(
  targets: TAbstractFile[],
  maxFiles = 50
): { files: TFile[]; truncated: boolean } {
  const files: TFile[] = [];
  const seen = new Set<string>();
  let truncated = false;

  const visit = (item: TAbstractFile): void => {
    if (files.length >= maxFiles) {
      truncated = true;
      return;
    }
    if (isVaultFile(item)) {
      if (!seen.has(item.path)) {
        seen.add(item.path);
        files.push(item);
      }
    } else if (isVaultFolder(item)) {
      const sorted = [...item.children].sort((a, b) => a.name.localeCompare(b.name));
      for (const child of sorted) {
        visit(child);
        if (truncated) return;
      }
    }
  };

  for (const target of targets) {
    visit(target);
    if (truncated) break;
  }

  return { files, truncated };
}

/**
 * Parses an `obsidian://open?vault=...&file=...` URI into a decoded Vault relative path.
 */
export function parseObsidianOpenUri(rawText: string): string | null {
  const trimmed = rawText.trim();
  if (!trimmed.toLowerCase().startsWith("obsidian://")) {
    return null;
  }
  try {
    const url = new URL(trimmed);
    const fileParam = url.searchParams.get("file");
    if (!fileParam) {
      return null;
    }
    return fileParam.replace(/^\/+/, "");
  } catch {
    return null;
  }
}

interface WebkitFileEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (success: (file: File) => void, error?: (err: unknown) => void) => void;
  createReader?: () => {
    readEntries: (
      success: (entries: WebkitFileEntry[]) => void,
      error?: (err: unknown) => void
    ) => void;
  };
}

function readAllDirectoryEntries(entry: WebkitFileEntry): Promise<WebkitFileEntry[]> {
  return new Promise((resolve, reject) => {
    if (!entry.createReader) {
      resolve([]);
      return;
    }
    const reader = entry.createReader();
    const collected: WebkitFileEntry[] = [];

    const readBatch = (): void => {
      reader.readEntries(
        (batch) => {
          if (batch.length === 0) {
            resolve(collected);
          } else {
            collected.push(...batch);
            readBatch();
          }
        },
        (err) => reject(err)
      );
    };

    readBatch();
  });
}

function readEntryFile(entry: WebkitFileEntry): Promise<File | null> {
  return new Promise((resolve) => {
    if (!entry.file) {
      resolve(null);
      return;
    }
    entry.file(
      (f) => resolve(f),
      () => resolve(null)
    );
  });
}

/**
 * Extracts OS-dropped files including recursively expanding dropped OS directories via webkitGetAsEntry.
 */
export async function extractDroppedOsFiles(
  dataTransfer: DataTransfer,
  maxFiles = 50
): Promise<{ files: File[]; truncated: boolean }> {
  const items = dataTransfer.items ? Array.from(dataTransfer.items) : [];
  const entries: WebkitFileEntry[] = [];

  for (const item of items) {
    const getEntry = (item as unknown as { webkitGetAsEntry?: () => WebkitFileEntry | null })
      .webkitGetAsEntry;
    if (typeof getEntry === "function") {
      const entry = getEntry.call(item);
      if (entry) {
        entries.push(entry);
      }
    }
  }

  if (entries.length === 0) {
    const plainFiles = dataTransfer.files ? Array.from(dataTransfer.files) : [];
    return {
      files: plainFiles.slice(0, maxFiles),
      truncated: plainFiles.length > maxFiles,
    };
  }

  const files: File[] = [];
  let truncated = false;

  const visitEntry = async (entry: WebkitFileEntry): Promise<void> => {
    if (files.length >= maxFiles) {
      truncated = true;
      return;
    }
    if (entry.isFile) {
      const file = await readEntryFile(entry);
      if (file) {
        files.push(file);
      }
    } else if (entry.isDirectory) {
      const children = await readAllDirectoryEntries(entry);
      children.sort((a, b) => a.name.localeCompare(b.name));
      for (const child of children) {
        await visitEntry(child);
        if (truncated) return;
      }
    }
  };

  for (const entry of entries) {
    await visitEntry(entry);
    if (truncated) break;
  }

  return { files, truncated };
}
