export interface MentionToken {
  /** Index of '@' in the input text. */
  start: number;
  /** Caret end index of the active mention query. */
  end: number;
  /** Search query text after '@'. */
  query: string;
}

/**
 * Detects an active `@query` mention token immediately preceding the caret.
 * Triggers only when `@` is at the start of the text or preceded by whitespace,
 * preventing false positives on email addresses like `foo@bar.com`.
 */
export function findActiveMentionToken(text: string, caretIndex: number): MentionToken | null {
  if (caretIndex <= 0 || caretIndex > text.length) {
    return null;
  }

  const beforeCaret = text.slice(0, caretIndex);
  const atIdx = beforeCaret.lastIndexOf("@");
  if (atIdx < 0) {
    return null;
  }

  // Must be at start of text or preceded by whitespace
  if (atIdx > 0 && !/\s/.test(beforeCaret[atIdx - 1])) {
    return null;
  }

  const query = beforeCaret.slice(atIdx + 1);
  // Close mention popup once whitespace/newline is typed
  if (/\s/.test(query)) {
    return null;
  }

  return {
    start: atIdx,
    end: caretIndex,
    query,
  };
}

/**
 * Resolves the display title of a Markdown note from its Frontmatter `title` field,
 * falling back to its basename when `title` is absent or blank.
 */
export function resolveNoteDisplayTitle(
  frontmatter: Record<string, unknown> | undefined,
  fallbackBasename: string
): string {
  const raw = frontmatter?.title;
  if (typeof raw === "string" && raw.trim().length > 0) {
    return raw.trim();
  }
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return String(raw);
  }
  return fallbackBasename;
}
