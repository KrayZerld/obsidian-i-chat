function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Formats local date/time as "YYYY-MM-DD HH:mm:ss".
 */
export function formatTimestamp(date: Date = new Date()): string {
  const yyyy = date.getFullYear();
  const mm = pad2(date.getMonth() + 1);
  const dd = pad2(date.getDate());
  const hh = pad2(date.getHours());
  const mi = pad2(date.getMinutes());
  const ss = pad2(date.getSeconds());
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

/**
 * Formats local date/time as "YYYYMMDDhhmmss" for chat note filenames.
 */
export function formatFileStamp(date: Date = new Date()): string {
  const yyyy = date.getFullYear();
  const mm = pad2(date.getMonth() + 1);
  const dd = pad2(date.getDate());
  const hh = pad2(date.getHours());
  const mi = pad2(date.getMinutes());
  const ss = pad2(date.getSeconds());
  return `${yyyy}${mm}${dd}${hh}${mi}${ss}`;
}

/**
 * Extracts default chat title from first user message: first 15 Unicode characters.
 */
export function extractChatTitle(message: string, maxChars = 15): string {
  const normalized = message.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "新对话";
  }
  const chars = Array.from(normalized);
  return chars.slice(0, maxChars).join("").trim();
}
