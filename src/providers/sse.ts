export interface ParsedSseResult {
  events: string[];
  remainder: string;
}

export function normalizeBaseUrl(url: string, fallback: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  return trimmed.length > 0 ? trimmed : fallback;
}

/**
 * Splits buffered SSE stream text into complete `data:` payloads and trailing partial buffer.
 */
export function extractSseDataPayloads(buffer: string): ParsedSseResult {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const blocks = normalized.split("\n\n");
  const remainder = blocks.pop() ?? "";
  const events: string[] = [];

  for (const block of blocks) {
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    if (dataLines.length > 0) {
      const payload = dataLines.join("\n").trim();
      if (payload && payload !== "[DONE]") {
        events.push(payload);
      }
    }
  }

  return { events, remainder };
}

export async function readApiErrorMessage(response: Response): Promise<string> {
  try {
    const text = await response.text();
    if (!text) {
      return `HTTP ${response.status} ${response.statusText}`;
    }
    try {
      const json = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
      if (typeof json?.error === "string" && json.error.trim()) {
        return json.error.trim();
      }
      if (json?.error && typeof json.error === "object" && json.error.message) {
        return json.error.message;
      }
      if (typeof json?.message === "string" && json.message.trim()) {
        return json.message.trim();
      }
    } catch {
      // Not JSON
    }
    return `HTTP ${response.status}: ${text.slice(0, 200)}`;
  } catch {
    return `HTTP ${response.status} ${response.statusText}`;
  }
}
