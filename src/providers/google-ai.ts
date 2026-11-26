import {
  ChatMessage,
  ModelCapability,
  ModelInfo,
  SearchSource,
  ThinkingLevel,
} from "../types";
import { LLMProvider, StreamChatParams } from "./base";
import {
  ParsedSseResult,
  extractSseDataPayloads,
  normalizeBaseUrl,
  readApiErrorMessage,
} from "./sse";

export { extractSseDataPayloads, normalizeBaseUrl };
export type { ParsedSseResult };

interface GoogleApiModel {
  name?: string;
  displayName?: string;
  description?: string;
  supportedGenerationMethods?: string[];
  thinking?: boolean;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
}

interface GoogleModelsResponse {
  models?: GoogleApiModel[];
  nextPageToken?: string;
}

interface GooglePart {
  text?: string;
  thought?: boolean;
  inlineData?: {
    mimeType: string;
    data: string;
  };
}

export interface GoogleGroundingChunk {
  web?: {
    uri?: string;
    title?: string;
  };
}

export interface GoogleGroundingMetadata {
  groundingChunks?: GoogleGroundingChunk[];
}

interface GoogleStreamChunk {
  candidates?: Array<{
    content?: {
      parts?: GooglePart[];
    };
    groundingMetadata?: GoogleGroundingMetadata;
    finishReason?: string;
  }>;
  error?: {
    code?: number;
    message?: string;
    status?: string;
  };
}

const THINKING_BUDGET_MAP: Record<ThinkingLevel, number> = {
  low: 1024,
  medium: 8192,
  high: 24576,
};

export function detectGoogleModelCapabilities(raw: GoogleApiModel, id: string): ModelCapability[] {
  const lowerId = id.toLowerCase();
  const caps: ModelCapability[] = [];

  // Visual capability: modern Gemini multimodal models & vision variants
  const isTextOnly =
    lowerId.includes("embedding") ||
    lowerId.includes("aqa") ||
    lowerId.includes("tts") ||
    lowerId.startsWith("gemma-2-") ||
    lowerId === "gemini-pro" ||
    lowerId === "gemini-1.0-pro";

  if (!isTextOnly && (lowerId.includes("gemini") || lowerId.includes("vision") || lowerId.includes("gemma-3"))) {
    caps.push("visual");
  }

  // Think capability: prefer explicit API metadata when provided, fallback to model family heuristics
  let supportsThink: boolean;
  if (typeof raw.thinking === "boolean") {
    supportsThink = raw.thinking;
  } else {
    const excludedNonThink =
      lowerId.includes("tts") ||
      lowerId.includes("image-generation") ||
      lowerId.includes("embedding") ||
      lowerId.includes("aqa");
    supportsThink =
      !excludedNonThink &&
      (lowerId.includes("thinking") ||
        lowerId.includes("gemini-2.5") ||
        lowerId.includes("gemini-3") ||
        lowerId.includes("gemini-4") ||
        lowerId.includes("neon"));
  }

  if (supportsThink) {
    caps.push("think");
  }

  return caps;
}

/**
 * Estimates a sortable release score (higher = newer) so "按时间" ordering surfaces newer models first.
 */
export function computeGoogleReleaseOrder(id: string, orderIndex: number): number {
  const lower = id.toLowerCase();

  // Extract major.minor version (e.g. gemini-2.5 -> 2.5, gemini-3 -> 3.0)
  let versionScore = 0;
  const verMatch = lower.match(/gemini-(\d+)(?:\.(\d+))?/);
  if (verMatch) {
    const major = Number.parseInt(verMatch[1], 10);
    const minor = verMatch[2] ? Number.parseInt(verMatch[2], 10) : 0;
    versionScore = major * 10000 + minor * 1000;
  } else if (lower.includes("neon")) {
    versionScore = 40000;
  } else if (lower.includes("gemma-3")) {
    versionScore = 15000;
  }

  // Extract MM-DD or YYYYMMDD date markers if present
  let dateScore = 0;
  const mmddMatch = lower.match(/(\d{2})-(\d{2})(?:$|[^0-9])/);
  if (mmddMatch) {
    const mm = Number.parseInt(mmddMatch[1], 10);
    const dd = Number.parseInt(mmddMatch[2], 10);
    if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
      dateScore = mm * 32 + dd;
    }
  } else if (lower.includes("preview") || lower.includes("exp")) {
    dateScore = 200;
  } else if (lower.includes("latest")) {
    dateScore = 150;
  }

  // Small tie-breaker preserving API listing stability
  return versionScore + dateScore + Math.max(0, 500 - orderIndex) * 0.001;
}

/**
 * Determines whether the Gemini model uses string `thinkingLevel` (3+ / Neon generation)
 * instead of numeric `thinkingBudget` (2.5 generation).
 */
export function usesThinkingLevelParam(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  if (lower.includes("neon")) {
    return true;
  }
  const verMatch = lower.match(/gemini-(\d+)(?:\.(\d+))?/);
  if (verMatch) {
    const major = Number.parseInt(verMatch[1], 10);
    return major >= 3;
  }
  return false;
}

export function buildGoogleThinkingConfig(
  model: ModelInfo,
  thinkingLevel?: ThinkingLevel,
  disableThinking?: boolean
): Record<string, unknown> | undefined {
  if (!model.capabilities.includes("think")) {
    return undefined;
  }

  if (disableThinking) {
    if (usesThinkingLevelParam(model.id)) {
      return {
        includeThoughts: false,
        thinkingLevel: "LOW",
      };
    }
    return {
      includeThoughts: false,
      thinkingBudget: 0,
    };
  }

  if (!thinkingLevel) {
    return undefined;
  }

  if (usesThinkingLevelParam(model.id)) {
    return {
      includeThoughts: true,
      thinkingLevel: thinkingLevel.toUpperCase(),
    };
  }

  return {
    includeThoughts: true,
    thinkingBudget: THINKING_BUDGET_MAP[thinkingLevel],
  };
}

export function extractGoogleGroundingSources(
  metadata: GoogleGroundingMetadata | undefined
): SearchSource[] {
  const chunks = metadata?.groundingChunks;
  if (!Array.isArray(chunks) || chunks.length === 0) {
    return [];
  }

  const seen = new Set<string>();
  const sources: SearchSource[] = [];

  for (const chunk of chunks) {
    const uri = chunk?.web?.uri?.trim();
    if (!uri || !/^https?:\/\//i.test(uri) || seen.has(uri)) {
      continue;
    }
    seen.add(uri);
    const rawTitle = chunk?.web?.title?.trim();
    let title = rawTitle || "";
    if (!title) {
      try {
        title = new URL(uri).hostname;
      } catch {
        title = uri;
      }
    }
    sources.push({ title, url: uri });
  }

  return sources;
}

export function buildGoogleStreamRequestBody(params: {
  model: ModelInfo;
  messages: ChatMessage[];
  systemPrompt?: string;
  thinkingLevel?: ThinkingLevel;
  disableThinking?: boolean;
  enableWebSearch?: boolean;
}): Record<string, unknown> {
  const requestBody: Record<string, unknown> = {
    contents: buildGoogleContents(params.messages),
  };

  if (params.systemPrompt && params.systemPrompt.trim().length > 0) {
    requestBody.systemInstruction = {
      parts: [{ text: params.systemPrompt.trim() }],
    };
  }

  const thinkingConfig = buildGoogleThinkingConfig(
    params.model,
    params.thinkingLevel,
    params.disableThinking
  );
  if (thinkingConfig) {
    requestBody.generationConfig = {
      thinkingConfig,
    };
  }

  if (params.enableWebSearch) {
    requestBody.tools = [{ google_search: {} }];
  }

  return requestBody;
}

export function buildGoogleContents(messages: ChatMessage[]): Array<{ role: string; parts: GooglePart[] }> {
  const contents: Array<{ role: string; parts: GooglePart[] }> = [];

  for (const msg of messages) {
    const parts: GooglePart[] = [];

    if (msg.role === "user" && msg.attachments && msg.attachments.length > 0) {
      for (const att of msg.attachments) {
        if (att.kind === "text" && att.textContent !== undefined) {
          parts.push({
            text: `[Attachment: ${att.name}]\n${att.textContent}`,
          });
        } else if (att.kind === "binary" && att.base64Data) {
          parts.push({
            inlineData: {
              mimeType: att.mimeType || "application/octet-stream",
              data: att.base64Data,
            },
          });
        }
      }
    }

    if (msg.content.length > 0 || parts.length === 0) {
      parts.push({ text: msg.content });
    }

    contents.push({
      role: msg.role === "assistant" ? "model" : "user",
      parts,
    });
  }

  return contents;
}

export class GoogleAIProvider implements LLMProvider {
  readonly id = "google-ai";
  readonly name = "Google AI";
  readonly defaultBaseUrl = "https://generativelanguage.googleapis.com";
  readonly defaultModelPriority = [
    "gemini-2.5-flash",
    "gemini-2.5-pro",
    "gemini-2.0-flash",
    "gemini-1.5-flash",
  ] as const;

  async fetchModels(apiKey: string, baseUrl: string): Promise<ModelInfo[]> {
    const trimmedKey = apiKey.trim();
    if (!trimmedKey) {
      throw new Error("请先填写 API Key");
    }

    const base = normalizeBaseUrl(baseUrl, this.defaultBaseUrl);
    const collected: GoogleApiModel[] = [];
    let pageToken: string | undefined;
    let pages = 0;

    do {
      const query = new URLSearchParams({ pageSize: "100" });
      if (pageToken) {
        query.set("pageToken", pageToken);
      }
      const url = `${base}/v1beta/models?${query.toString()}`;
      const timeoutController = new AbortController();
      const timeoutId = setTimeout(() => timeoutController.abort(), 20_000);
      let response: Response;
      try {
        response = await fetch(url, {
          method: "GET",
          headers: {
            "x-goog-api-key": trimmedKey,
          },
          signal: timeoutController.signal,
        });
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          throw new Error("请求超时（20s），请检查网络或代理设置");
        }
        throw err;
      } finally {
        clearTimeout(timeoutId);
      }

      if (!response.ok) {
        throw new Error(await readApiErrorMessage(response));
      }

      const data = (await response.json()) as GoogleModelsResponse;
      if (Array.isArray(data.models)) {
        collected.push(...data.models);
      }
      pageToken = data.nextPageToken;
      pages++;
    } while (pageToken && pages < 5);

    const models: ModelInfo[] = [];
    let orderIndex = 0;

    for (const raw of collected) {
      const methods = raw.supportedGenerationMethods ?? [];
      if (!methods.includes("generateContent")) {
        continue;
      }
      const rawName = raw.name ?? "";
      const id = rawName.startsWith("models/") ? rawName.slice("models/".length) : rawName;
      if (!id) {
        continue;
      }

      const lowerId = id.toLowerCase();
      if (lowerId.includes("embedding") || lowerId.includes("aqa")) {
        continue;
      }

      models.push({
        id,
        displayName: (raw.displayName ?? id).trim(),
        platformId: this.id,
        capabilities: detectGoogleModelCapabilities(raw, id),
        releaseOrder: computeGoogleReleaseOrder(id, orderIndex),
        orderIndex,
      });
      orderIndex++;
    }

    return models;
  }

  async streamChat(params: StreamChatParams): Promise<void> {
    const trimmedKey = params.apiKey.trim();
    if (!trimmedKey) {
      throw new Error("当前平台未配置 API Key");
    }

    const base = normalizeBaseUrl(params.baseUrl, this.defaultBaseUrl);
    const url = `${base}/v1beta/models/${encodeURIComponent(params.model.id)}:streamGenerateContent?alt=sse`;
    const requestBody = buildGoogleStreamRequestBody({
      model: params.model,
      messages: params.messages,
      systemPrompt: params.systemPrompt,
      thinkingLevel: params.thinkingLevel,
      disableThinking: params.disableThinking,
      enableWebSearch: params.enableWebSearch,
    });

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": trimmedKey,
      },
      body: JSON.stringify(requestBody),
      signal: params.signal,
    });

    if (!response.ok) {
      throw new Error(await readApiErrorMessage(response));
    }

    if (!response.body) {
      // Fallback if response.body stream is unavailable
      const fallbackText = await response.text();
      this.dispatchSsePayloads(extractSseDataPayloads(`${fallbackText}\n\n`).events, params);
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const { events, remainder } = extractSseDataPayloads(buffer);
        buffer = remainder;
        this.dispatchSsePayloads(events, params);
      }

      // Flush remaining bytes
      buffer += decoder.decode();
      if (buffer.trim().length > 0) {
        const { events } = extractSseDataPayloads(`${buffer}\n\n`);
        this.dispatchSsePayloads(events, params);
      }
    } finally {
      reader.releaseLock();
    }
  }

  private dispatchSsePayloads(payloads: string[], params: StreamChatParams): void {
    for (const payload of payloads) {
      let chunk: GoogleStreamChunk;
      try {
        chunk = JSON.parse(payload) as GoogleStreamChunk;
      } catch {
        continue;
      }

      if (chunk.error?.message) {
        throw new Error(chunk.error.message);
      }

      const candidates = chunk.candidates ?? [];
      for (const candidate of candidates) {
        const parts = candidate.content?.parts ?? [];
        for (const part of parts) {
          if (typeof part.text !== "string" || part.text.length === 0) {
            continue;
          }
          if (part.thought) {
            if (!params.disableThinking) {
              params.onThinkingDelta?.(part.text);
            }
          } else {
            params.onTextDelta(part.text);
          }
        }

        const sources = extractGoogleGroundingSources(candidate.groundingMetadata);
        if (sources.length > 0) {
          params.onSearchSources?.(sources);
        }
      }
    }
  }
}
