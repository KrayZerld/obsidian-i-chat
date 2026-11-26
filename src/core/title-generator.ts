const MAX_USER_EXCERPT_CHARS = 500;
const MAX_ASSISTANT_EXCERPT_CHARS = 500;

function clipExcerpt(text: string, maxChars: number): string {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  const chars = Array.from(normalized);
  if (chars.length <= maxChars) {
    return normalized;
  }
  return `${chars.slice(0, maxChars).join("")}…`;
}

/**
 * Builds a concise prompt asking the model to summarize the first turn into a short chat title.
 */
export function buildAutoTitlePrompt(userText: string, assistantText: string): string {
  const userExcerpt = clipExcerpt(userText, MAX_USER_EXCERPT_CHARS);
  const assistantExcerpt = clipExcerpt(assistantText, MAX_ASSISTANT_EXCERPT_CHARS);

  const lines: string[] = [
    "请根据以下首轮对话提炼一个简短标题。",
    "要求：",
    "1. 与对话主要语言保持一致；中文不超过 15 字，英文不超过 8 个词。",
    "2. 只输出标题本身，不要加引号、书名号、序号、标点后缀或任何解释。",
    "",
  ];

  if (userExcerpt) {
    lines.push(`用户：${userExcerpt}`);
  }
  if (assistantExcerpt) {
    lines.push(`助手：${assistantExcerpt}`);
  }

  return lines.join("\n");
}

/**
 * Cleans up LLM output into a single-line safe frontmatter/tab title.
 */
export function sanitizeGeneratedTitle(raw: string, maxLength = 48): string {
  const normalized = raw.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return "";
  }

  // Pick the first non-empty line in case the model emitted extra lines
  const firstLine =
    normalized
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";

  let cleaned = firstLine
    // Strip markdown heading / bullet prefixes
    .replace(/^#+\s*/, "")
    .replace(/^[-*•]\s*/, "")
    // Strip common "标题：" / "Title:" prefixes
    .replace(/^(?:对话)?(?:标题|title)\s*[:：-]\s*/i, "")
    // Strip wrapping markdown bold/italic/code markers
    .replace(/^[*_`]+|[*_`]+$/g, "")
    .trim();

  // Strip wrapping quote / bracket pairs repeatedly (e.g. "《标题》")
  let prev = "";
  while (cleaned !== prev) {
    prev = cleaned;
    cleaned = cleaned
      .replace(/^["'“”‘’《》「」『』【】\[\]()（）]+/, "")
      .replace(/["'“”‘’《》「」『』【】\[\]()（）]+$/, "")
      .trim();
  }

  // Collapse internal whitespace and trim trailing punctuation
  cleaned = cleaned.replace(/\s+/g, " ").replace(/[。！？.!?，,；;：:]+$/, "").trim();

  const chars = Array.from(cleaned);
  if (chars.length > maxLength) {
    return chars.slice(0, maxLength).join("").trim();
  }
  return cleaned;
}
