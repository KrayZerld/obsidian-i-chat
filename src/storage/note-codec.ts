import {
  ChatMessage,
  ChatNoteMeta,
  ChatTurn,
  FRONTMATTER_KEYS,
  PlatformId,
  ThinkingLevel,
  createId,
  isThinkingLevel,
} from "../types";

export interface PromptModelBinding {
  platformId: PlatformId;
  modelId: string;
  thinking?: ThinkingLevel;
}

export interface PromptFrontmatterPatch {
  needsWrite: boolean;
  title?: string;
  binding?: PromptModelBinding;
  resolved: {
    title: string;
    platform?: PlatformId;
    model?: string;
    thinking?: ThinkingLevel;
  };
}

const TIMESTAMP_LINE_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const HR_LINE_RE = /^\s{0,3}---\s*$/;
const LEGACY_FENCE_OPEN_RE = /^\s{0,3}(`{3,})\s*markdown\s*$/i;

/**
 * Formats a single user or assistant message block as plain Markdown:
 * line 1 is YYYY-MM-DD HH:mm:ss, followed by the message content.
 */
export function formatMessageBlock(timestamp: string, content: string): string {
  const cleanTimestamp = timestamp.trim();
  const normalizedContent = content.replace(/\r\n/g, "\n");
  return normalizedContent.length > 0
    ? `${cleanTimestamp}\n${normalizedContent}`
    : cleanTimestamp;
}

/**
 * Formats a YAML scalar value safely so special characters, leading/trailing spaces,
 * or YAML keywords never corrupt frontmatter parsing.
 */
export function formatYamlScalar(value: string): string {
  const cleaned = value.replace(/\r?\n/g, " ");
  const needsQuotes =
    cleaned.length === 0 ||
    /^\s|\s$/.test(cleaned) ||
    /[:#[\]{}&*!|>'"%@`?,]/.test(cleaned) ||
    /^(true|false|yes|no|null|~)$/i.test(cleaned) ||
    /^-?\d+(\.\d+)?$/.test(cleaned);

  if (!needsQuotes) {
    return cleaned;
  }
  const escaped = cleaned.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

export function parseYamlScalar(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    const inner = trimmed.slice(1, -1);
    return inner.replace(/\\(["\\])/g, "$1");
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

/**
 * Serializes chat note frontmatter using i-chat-* keys.
 * Omits i-chat-prompt when unset and omits i-chat-thinking when unset.
 */
export function serializeChatFrontmatter(meta: ChatNoteMeta): string {
  const lines: string[] = ["---"];
  if (meta.title !== undefined && meta.title.trim().length > 0) {
    lines.push(`${FRONTMATTER_KEYS.title}: ${formatYamlScalar(meta.title.trim())}`);
  }
  if (meta.prompt !== undefined && meta.prompt.trim().length > 0) {
    lines.push(`${FRONTMATTER_KEYS.prompt}: ${formatYamlScalar(meta.prompt.trim())}`);
  }
  if (meta.platform !== undefined && meta.platform.trim().length > 0) {
    lines.push(`${FRONTMATTER_KEYS.platform}: ${formatYamlScalar(meta.platform.trim())}`);
  }
  if (meta.model !== undefined && meta.model.trim().length > 0) {
    lines.push(`${FRONTMATTER_KEYS.model}: ${formatYamlScalar(meta.model.trim())}`);
  }
  if (meta.thinking !== undefined) {
    lines.push(`${FRONTMATTER_KEYS.thinking}: ${formatYamlScalar(meta.thinking)}`);
  }
  lines.push("---");
  return lines.join("\n");
}

/**
 * Converts flat ChatMessage[] into paired ChatTurn[] for persistence.
 * Thinking traces and attachments are intentionally excluded from disk format.
 */
export function buildTurnsFromMessages(messages: ChatMessage[]): ChatTurn[] {
  const turns: ChatTurn[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      turns.push({
        user: {
          timestamp: msg.timestamp,
          content: msg.content,
        },
      });
    } else if (msg.role === "assistant") {
      const current = turns[turns.length - 1];
      if (current && !current.assistant) {
        current.assistant = {
          timestamp: msg.timestamp,
          content: msg.content,
        };
      } else {
        // Defensive fallback if an assistant message ever appears without a preceding user turn
        turns.push({
          user: { timestamp: msg.timestamp, content: "" },
          assistant: { timestamp: msg.timestamp, content: msg.content },
        });
      }
    }
  }
  return turns;
}

/**
 * Serializes all conversation turns into the note body.
 * Each message (user or assistant) is written as plain Markdown with its timestamp on line 1,
 * followed by `---`.
 */
export function serializeChatBody(turns: ChatTurn[]): string {
  const blocks: string[] = [];
  for (const turn of turns) {
    blocks.push(`${formatMessageBlock(turn.user.timestamp, turn.user.content)}\n\n---`);
    if (turn.assistant) {
      blocks.push(`${formatMessageBlock(turn.assistant.timestamp, turn.assistant.content)}\n\n---`);
    }
  }
  return blocks.join("\n\n");
}

/**
 * Serializes a full Markdown chat note (frontmatter + body).
 */
export function serializeChatNote(meta: ChatNoteMeta, turns: ChatTurn[]): string {
  const fm = serializeChatFrontmatter(meta);
  const body = serializeChatBody(turns);
  return body.length > 0 ? `${fm}\n\n${body}\n` : `${fm}\n`;
}

export function hasYamlFrontmatter(raw: string): boolean {
  const normalized = raw.replace(/\r\n/g, "\n");
  return /^---\n[\s\S]*?\n---(?:\n|$)/.test(normalized);
}

/**
 * Computes which i-chat-* frontmatter fields need to be backfilled for a prompt note
 * without overwriting any existing user-defined title or model binding.
 */
export function computePromptFrontmatterPatch(
  raw: string,
  fallbackTitle: string,
  fallbackBinding?: PromptModelBinding
): PromptFrontmatterPatch {
  const hasFm = hasYamlFrontmatter(raw);
  const { meta } = parseChatFrontmatter(raw);

  const hasTitle = Boolean(meta.title && meta.title.trim().length > 0);
  const hasBinding = Boolean(
    meta.platform && meta.platform.trim().length > 0 && meta.model && meta.model.trim().length > 0
  );

  const titleToWrite = !hasTitle ? fallbackTitle : undefined;
  const bindingToWrite = !hasBinding && fallbackBinding ? fallbackBinding : undefined;
  const needsWrite = !hasFm || titleToWrite !== undefined || bindingToWrite !== undefined;

  return {
    needsWrite,
    title: titleToWrite,
    binding: bindingToWrite,
    resolved: {
      title: hasTitle ? meta.title!.trim() : fallbackTitle,
      platform: hasBinding ? meta.platform!.trim() : fallbackBinding?.platformId,
      model: hasBinding ? meta.model!.trim() : fallbackBinding?.modelId,
      thinking: hasBinding ? meta.thinking : fallbackBinding?.thinking,
    },
  };
}

/**
 * Parses leading YAML frontmatter for i-chat-* fields and returns remaining body.
 */
export function parseChatFrontmatter(raw: string): { meta: ChatNoteMeta; body: string } {
  const normalized = raw.replace(/\r\n/g, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!match) {
    return { meta: {}, body: normalized };
  }

  const fmText = match[1];
  const body = normalized.slice(match[0].length);
  const meta: ChatNoteMeta = {};

  for (const line of fmText.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx <= 0) continue;
    const key = line.slice(0, colonIdx).trim();
    const rawVal = line.slice(colonIdx + 1);
    const val = parseYamlScalar(rawVal);

    if (key === FRONTMATTER_KEYS.title && val) {
      meta.title = val;
    } else if (key === FRONTMATTER_KEYS.prompt && val) {
      meta.prompt = val;
    } else if (key === FRONTMATTER_KEYS.platform && val) {
      meta.platform = val;
    } else if (key === FRONTMATTER_KEYS.model && val) {
      meta.model = val;
    } else if (key === FRONTMATTER_KEYS.thinking) {
      const lowered = val.toLowerCase();
      if (isThinkingLevel(lowered)) {
        meta.thinking = lowered;
      }
    }
  }

  return { meta, body };
}

function findNextNonEmptyLine(lines: string[], fromIndex: number): number {
  for (let i = fromIndex; i < lines.length; i++) {
    if (lines[i].trim().length > 0) {
      return i;
    }
  }
  return -1;
}

function trimTrailingBlankLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim().length === 0) {
    end--;
  }
  return lines.slice(0, end);
}

/**
 * Parses the plain (unfenced) chat note format:
 *   YYYY-MM-DD HH:mm:ss
 *   message content...
 *
 *   ---
 *
 * Only treats `---` as a message boundary when followed by a timestamp line
 * (after optional blank lines) or when it is the trailing delimiter at EOF,
 * so horizontal rules or YAML frontmatter examples inside message bodies stay intact.
 */
function parsePlainChatBody(lines: string[], firstNonEmptyIndex: number): ChatMessage[] {
  const messages: ChatMessage[] = [];
  let currentStart = firstNonEmptyIndex;

  const commitSegment = (startLine: number, endLineExclusive: number): void => {
    const timestamp = (lines[startLine] ?? "").trim();
    const contentLines = trimTrailingBlankLines(lines.slice(startLine + 1, endLineExclusive));
    const role: "user" | "assistant" = messages.length % 2 === 0 ? "user" : "assistant";

    messages.push({
      id: createId(role),
      role,
      timestamp,
      content: contentLines.join("\n"),
    });
  };

  for (let i = currentStart + 1; i < lines.length; i++) {
    if (!HR_LINE_RE.test(lines[i])) {
      continue;
    }

    const nextIdx = findNextNonEmptyLine(lines, i + 1);
    if (nextIdx === -1) {
      commitSegment(currentStart, i);
      currentStart = -1;
      break;
    }

    if (TIMESTAMP_LINE_RE.test(lines[nextIdx].trim())) {
      commitSegment(currentStart, i);
      currentStart = nextIdx;
      i = nextIdx;
    }
  }

  if (currentStart !== -1) {
    commitSegment(currentStart, lines.length);
  }

  return messages;
}

/**
 * Backward-compatible parser for legacy chat notes wrapped in ```markdown fences.
 */
function parseLegacyFencedBody(lines: string[]): ChatMessage[] {
  const messages: ChatMessage[] = [];

  let inFence = false;
  let fenceLen = 0;
  let blockLines: string[] = [];
  let blocksInCurrentTurn = 0;

  const commitBlock = (): void => {
    const firstLine = (blockLines[0] ?? "").trim();
    const content = blockLines.slice(1).join("\n");
    const role: "user" | "assistant" = blocksInCurrentTurn === 0 ? "user" : "assistant";

    messages.push({
      id: createId(role),
      role,
      timestamp: firstLine,
      content,
    });

    blocksInCurrentTurn++;
    if (blocksInCurrentTurn >= 2) {
      blocksInCurrentTurn = 0;
    }
  };

  for (const line of lines) {
    if (!inFence) {
      if (HR_LINE_RE.test(line)) {
        blocksInCurrentTurn = 0;
        continue;
      }
      const openMatch = line.match(LEGACY_FENCE_OPEN_RE);
      if (openMatch) {
        inFence = true;
        fenceLen = openMatch[1].length;
        blockLines = [];
      }
    } else {
      const closeMatch = line.match(/^\s{0,3}(`{3,})\s*$/);
      if (closeMatch && closeMatch[1].length >= fenceLen) {
        commitBlock();
        inFence = false;
        fenceLen = 0;
        blockLines = [];
      } else {
        blockLines.push(line);
      }
    }
  }

  if (inFence && blockLines.length > 0) {
    commitBlock();
  }

  return messages;
}

/**
 * Parses chat note body, supporting both the current plain Markdown format
 * and legacy ```markdown fenced chat notes.
 */
export function parseChatNoteBody(body: string): ChatMessage[] {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const firstIdx = findNextNonEmptyLine(lines, 0);
  if (firstIdx === -1) {
    return [];
  }

  if (LEGACY_FENCE_OPEN_RE.test(lines[firstIdx])) {
    return parseLegacyFencedBody(lines);
  }
  return parsePlainChatBody(lines, firstIdx);
}

export function parseChatNote(raw: string): { meta: ChatNoteMeta; messages: ChatMessage[] } {
  const { meta, body } = parseChatFrontmatter(raw);
  const messages = parseChatNoteBody(body);
  return { meta, messages };
}

/**
 * Generates a non-colliding chat note filename: {YYYYMMDDhhmmss}.md,
 * appending -2, -3, ... when existingNames already contains that name.
 */
export function resolveUniqueChatFileName(
  fileStamp: string,
  existingNames: ReadonlySet<string>
): string {
  const baseName = `${fileStamp}.md`;
  if (!existingNames.has(baseName)) {
    return baseName;
  }
  let suffix = 2;
  while (existingNames.has(`${fileStamp}-${suffix}.md`)) {
    suffix++;
  }
  return `${fileStamp}-${suffix}.md`;
}
