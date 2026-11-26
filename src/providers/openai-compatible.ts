import {
  ChatMessage,
  ModelCapability,
  ModelInfo,
  PlatformId,
  SearchSource,
  ThinkingLevel,
} from "../types";
import { LLMProvider, StreamChatParams } from "./base";
import { extractSseDataPayloads, normalizeBaseUrl, readApiErrorMessage } from "./sse";

interface OpenAIApiModel {
  id?: string;
  name?: string;
  created?: number;
  owned_by?: string;
}

interface OpenAIModelsResponse {
  data?: OpenAIApiModel[];
  models?: OpenAIApiModel[];
}

interface OpenAIDeltaContentPart {
  type?: string;
  text?: string;
}

export interface OpenAIAnnotation {
  type?: string;
  url?: string;
  title?: string;
  url_citation?: {
    url?: string;
    title?: string;
  };
}

interface OpenAIStreamDelta {
  content?: string | OpenAIDeltaContentPart[] | null;
  reasoning_content?: string | null;
  reasoning?: string | null;
  annotations?: OpenAIAnnotation[];
  server_tool_calls?: unknown[];
}

interface OpenAIStreamChunk {
  choices?: Array<{
    delta?: OpenAIStreamDelta;
    message?: OpenAIStreamDelta;
    finish_reason?: string | null;
  }>;
  error?: {
    message?: string;
    type?: string;
    code?: string | number;
  };
}

export interface OpenAICompatibleProviderConfig {
  id: PlatformId;
  name: string;
  defaultBaseUrl: string;
  defaultModelPriority: readonly string[];
}

export function normalizeOpenAIBaseUrl(rawUrl: string, fallback: string): string {
  let base = normalizeBaseUrl(rawUrl, fallback);
  base = base.replace(/\/chat\/completions$/i, "").replace(/\/models$/i, "");
  base = base.replace(/\/+$/, "");

  try {
    const parsed = new URL(base);
    if (!parsed.pathname || parsed.pathname === "/") {
      return `${base}/v1`;
    }
  } catch {
    // Keep user-supplied string if URL parsing fails
  }
  return base;
}

export function isOpenAIChatModel(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  const excludedPatterns = [
    "embedding",
    "embed-",
    "whisper",
    "tts",
    "dall-e",
    "gpt-image",
    "imagen",
    "flux",
    "stable-diffusion",
    "moderation",
    "transcribe",
    "realtime",
    "sora",
    "babbage",
    "davinci",
    "rerank",
    "text-search",
    "text-similarity",
    "code-search",
    "audio-preview",
  ];
  return !excludedPatterns.some((p) => lower.includes(p));
}

export function isDeepSeekFlashModel(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  return /(?:^|\/)deepseek(?:[-_].*)?flash/i.test(lower);
}

export function supportsDeepSeekWebSearch(platformId: PlatformId, modelId: string): boolean {
  return platformId === "deepseek" && isDeepSeekFlashModel(modelId);
}

export function detectOpenAIModelCapabilities(modelId: string): ModelCapability[] {
  const lower = modelId.toLowerCase();
  const caps: ModelCapability[] = [];

  if (isDeepSeekFlashModel(modelId)) {
    return ["visual", "think"];
  }

  const isExplicitlyTextOnly =
    lower.includes("o1-mini") ||
    lower.includes("o3-mini") ||
    lower.includes("deepseek-chat") ||
    lower.includes("deepseek-reasoner") ||
    lower.includes("deepseek-r1") ||
    lower.includes("deepseek-v3") ||
    lower.includes("qwq");

  const visualPatterns = [
    "gpt-4o",
    "gpt-4.1",
    "gpt-4.5",
    "gpt-5",
    "gpt-4-vision",
    "gpt-4-turbo",
    "o4-mini",
    "claude-3",
    "claude-4",
    "claude-sonnet",
    "claude-opus",
    "claude-haiku-4",
    "gemini",
    "vision",
    "qwen-vl",
    "qwen2-vl",
    "qwen2.5-vl",
    "qwen3-vl",
    "qvq",
    "glm-4v",
    "glm-4.5v",
    "pixtral",
    "llava",
    "internvl",
    "minicpm-v",
  ];
  const isO1OrO3Vision =
    (/(?:^|\/)o1(?:$|-)/i.test(lower) && !lower.includes("o1-mini") && !lower.includes("o1-preview")) ||
    (/(?:^|\/)o3(?:$|-)/i.test(lower) && !lower.includes("o3-mini"));

  if (!isExplicitlyTextOnly && (isO1OrO3Vision || visualPatterns.some((p) => lower.includes(p)))) {
    caps.push("visual");
  }

  const thinkPatterns = [
    /(?:^|\/)o1(?:$|-)/i,
    /(?:^|\/)o3(?:$|-)/i,
    /(?:^|\/)o4(?:$|-)/i,
    /(?:^|\/)gpt-5/i,
    /deepseek-reasoner/i,
    /deepseek-r1/i,
    /(?:^|[/-])r1(?:$|[/-])/i,
    /qwq/i,
    /qvq/i,
    /thinking/i,
    /reasoner/i,
    /claude-3[.-]7/i,
    /claude-(?:sonnet|opus|haiku)-4/i,
    /claude-4/i,
    /gemini-2\.5/i,
    /gemini-3/i,
    /gemini-4/i,
  ];
  if (thinkPatterns.some((re) => re.test(lower))) {
    caps.push("think");
  }

  return caps;
}

export function supportsOpenAIReasoningEffort(platformId: PlatformId, modelId: string): boolean {
  const lower = modelId.toLowerCase();
  if (platformId === "deepseek") {
    return false;
  }
  return (
    /(?:^|\/)o1(?:$|-)/i.test(lower) ||
    /(?:^|\/)o3(?:$|-)/i.test(lower) ||
    /(?:^|\/)o4(?:$|-)/i.test(lower) ||
    /(?:^|\/)gpt-5/i.test(lower)
  );
}

export function computeOpenAIReleaseOrder(raw: OpenAIApiModel, orderIndex: number): number {
  if (typeof raw.created === "number" && Number.isFinite(raw.created) && raw.created > 0) {
    // Normalize Unix timestamp (seconds or milliseconds) to a stable comparable score
    const seconds = raw.created > 1e12 ? raw.created / 1000 : raw.created;
    return seconds + Math.max(0, 500 - orderIndex) * 0.0001;
  }
  return Math.max(0, 10_000 - orderIndex);
}

type OpenAIMessageContent =
  | string
  | Array<
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string } }
    >;

export interface OpenAIChatMessage {
  role: "system" | "user" | "assistant";
  content: OpenAIMessageContent;
  server_tool_calls?: unknown[];
}

export function buildOpenAIMessages(
  messages: ChatMessage[],
  systemPrompt?: string,
  platformId?: PlatformId
): OpenAIChatMessage[] {
  const result: OpenAIChatMessage[] = [];

  if (systemPrompt && systemPrompt.trim().length > 0) {
    result.push({
      role: "system",
      content: systemPrompt.trim(),
    });
  }

  for (const msg of messages) {
    if (msg.role === "assistant") {
      const assistantMessage: OpenAIChatMessage = {
        role: "assistant",
        content: msg.content,
      };
      if (
        platformId === "deepseek" &&
        Array.isArray(msg.serverToolCalls) &&
        msg.serverToolCalls.length > 0
      ) {
        assistantMessage.server_tool_calls = msg.serverToolCalls;
      }
      result.push(assistantMessage);
      continue;
    }

    const attachments = msg.attachments ?? [];
    const textChunks: string[] = [];
    const imageUrls: string[] = [];

    for (const att of attachments) {
      if (att.kind === "text" && att.textContent !== undefined) {
        textChunks.push(`[Attachment: ${att.name}]\n${att.textContent}`);
      } else if (att.kind === "binary" && att.base64Data) {
        if (att.mimeType.toLowerCase().startsWith("image/")) {
          imageUrls.push(`data:${att.mimeType};base64,${att.base64Data}`);
        } else {
          textChunks.push(`[Binary Attachment: ${att.name} (${att.mimeType})]`);
        }
      }
    }

    if (msg.content.length > 0) {
      textChunks.push(msg.content);
    }

    const combinedText = textChunks.join("\n\n");

    if (imageUrls.length > 0) {
      const parts: Array<
        { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }
      > = [];
      if (combinedText.length > 0) {
        parts.push({ type: "text", text: combinedText });
      }
      for (const url of imageUrls) {
        parts.push({ type: "image_url", image_url: { url } });
      }
      result.push({
        role: "user",
        content: parts,
      });
    } else {
      result.push({
        role: "user",
        content: combinedText,
      });
    }
  }

  return result;
}

export function extractOpenAIDeltaTexts(delta: OpenAIStreamDelta | undefined): {
  thinking: string;
  content: string;
} {
  if (!delta) {
    return { thinking: "", content: "" };
  }

  const thinking =
    typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0
      ? delta.reasoning_content
      : typeof delta.reasoning === "string" && delta.reasoning.length > 0
        ? delta.reasoning
        : "";

  let content = "";
  if (typeof delta.content === "string") {
    content = delta.content;
  } else if (Array.isArray(delta.content)) {
    for (const part of delta.content) {
      if (typeof part?.text === "string") {
        content += part.text;
      }
    }
  }

  return { thinking, content };
}

export function extractOpenAIAnnotationSources(
  annotations: OpenAIAnnotation[] | undefined
): SearchSource[] {
  if (!Array.isArray(annotations) || annotations.length === 0) {
    return [];
  }

  const seen = new Set<string>();
  const sources: SearchSource[] = [];

  for (const item of annotations) {
    const rawUrl = item?.url_citation?.url ?? item?.url;
    const url = typeof rawUrl === "string" ? rawUrl.trim() : "";
    if (!url || !/^https?:\/\//i.test(url) || seen.has(url)) {
      continue;
    }
    seen.add(url);

    const rawTitle = item?.url_citation?.title ?? item?.title;
    let title = typeof rawTitle === "string" ? rawTitle.trim() : "";
    if (!title) {
      try {
        title = new URL(url).hostname;
      } catch {
        title = url;
      }
    }
    sources.push({ title, url });
  }

  return sources;
}

const DEEPSEEK_FLASH_EFFORT_MAP: Record<ThinkingLevel, "low" | "high" | "max"> = {
  low: "low",
  medium: "high",
  high: "max",
};

export function buildOpenAIStreamRequestBody(params: {
  model: ModelInfo;
  platformId: PlatformId;
  messages: ChatMessage[];
  systemPrompt?: string;
  thinkingLevel?: ThinkingLevel;
  disableThinking?: boolean;
  enableWebSearch?: boolean;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: params.model.id,
    messages: buildOpenAIMessages(params.messages, params.systemPrompt, params.platformId),
    stream: true,
  };

  if (supportsDeepSeekWebSearch(params.platformId, params.model.id)) {
    if (params.disableThinking) {
      body.thinking = { type: "disabled" };
      body.reasoning_effort = "none";
    } else if (params.thinkingLevel) {
      body.thinking = { type: "enabled" };
      body.reasoning_effort = DEEPSEEK_FLASH_EFFORT_MAP[params.thinkingLevel];
    }

    if (params.enableWebSearch) {
      body.tools = [
        { type: "deepseek_web_search", name: "deepseek_web_search" },
        { type: "deepseek_read_url", name: "deepseek_read_url" },
      ];
    }
  } else if (
    !params.disableThinking &&
    params.thinkingLevel &&
    params.model.capabilities.includes("think") &&
    supportsOpenAIReasoningEffort(params.platformId, params.model.id)
  ) {
    body.reasoning_effort = params.thinkingLevel;
  }

  return body;
}

export class OpenAICompatibleProvider implements LLMProvider {
  readonly id: PlatformId;
  readonly name: string;
  readonly defaultBaseUrl: string;
  readonly defaultModelPriority: readonly string[];

  constructor(config: OpenAICompatibleProviderConfig) {
    this.id = config.id;
    this.name = config.name;
    this.defaultBaseUrl = config.defaultBaseUrl;
    this.defaultModelPriority = config.defaultModelPriority;
  }

  async fetchModels(apiKey: string, baseUrl: string): Promise<ModelInfo[]> {
    const trimmedKey = apiKey.trim();
    if (!trimmedKey) {
      throw new Error("请先填写 API Key");
    }

    const base = normalizeOpenAIBaseUrl(baseUrl, this.defaultBaseUrl);
    const url = `${base}/models`;
    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => timeoutController.abort(), 20_000);

    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${trimmedKey}`,
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

    const data = (await response.json()) as OpenAIModelsResponse;
    const rawList = Array.isArray(data.data)
      ? data.data
      : Array.isArray(data.models)
        ? data.models
        : [];

    const models: ModelInfo[] = [];
    const seen = new Set<string>();
    let orderIndex = 0;

    for (const raw of rawList) {
      const id = (raw.id ?? "").trim();
      if (!id || seen.has(id) || !isOpenAIChatModel(id)) {
        continue;
      }
      seen.add(id);

      const displayName = (raw.name && raw.name.trim()) || id;
      models.push({
        id,
        displayName,
        platformId: this.id,
        capabilities: detectOpenAIModelCapabilities(id),
        releaseOrder: computeOpenAIReleaseOrder(raw, orderIndex),
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

    const base = normalizeOpenAIBaseUrl(params.baseUrl, this.defaultBaseUrl);
    const url = `${base}/chat/completions`;
    const requestBody = buildOpenAIStreamRequestBody({
      model: params.model,
      platformId: this.id,
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
        Authorization: `Bearer ${trimmedKey}`,
      },
      body: JSON.stringify(requestBody),
      signal: params.signal,
    });

    if (!response.ok) {
      throw new Error(await readApiErrorMessage(response));
    }

    if (!response.body) {
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
      let chunk: OpenAIStreamChunk;
      try {
        chunk = JSON.parse(payload) as OpenAIStreamChunk;
      } catch {
        continue;
      }

      if (chunk.error?.message) {
        throw new Error(chunk.error.message);
      }

      const choices = chunk.choices ?? [];
      for (const choice of choices) {
        const payloadObj = choice.delta ?? choice.message;
        const { thinking, content } = extractOpenAIDeltaTexts(payloadObj);
        if (thinking.length > 0 && !params.disableThinking) {
          params.onThinkingDelta?.(thinking);
        }
        if (content.length > 0) {
          params.onTextDelta(content);
        }

        const sources = extractOpenAIAnnotationSources(payloadObj?.annotations);
        if (sources.length > 0) {
          params.onSearchSources?.(sources);
        }

        if (
          Array.isArray(payloadObj?.server_tool_calls) &&
          payloadObj.server_tool_calls.length > 0
        ) {
          params.onServerToolCalls?.(payloadObj.server_tool_calls);
        }
      }
    }
  }
}
