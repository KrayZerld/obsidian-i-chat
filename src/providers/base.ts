import { ChatMessage, ModelInfo, PlatformId, SearchSource, ThinkingLevel } from "../types";

export interface StreamChatParams {
  apiKey: string;
  baseUrl: string;
  model: ModelInfo;
  messages: ChatMessage[];
  systemPrompt?: string;
  thinkingLevel?: ThinkingLevel;
  /** Disables thinking when supported (used for background title generation). */
  disableThinking?: boolean;
  /** Enables native server-side web search (Google AI Grounding / DeepSeek Web Tools). */
  enableWebSearch?: boolean;
  signal?: AbortSignal;
  onThinkingDelta?: (delta: string) => void;
  onTextDelta: (delta: string) => void;
  onSearchSources?: (sources: SearchSource[]) => void;
  onServerToolCalls?: (calls: unknown[]) => void;
}

export interface LLMProvider {
  readonly id: PlatformId;
  readonly name: string;
  readonly defaultBaseUrl: string;
  readonly defaultModelPriority: readonly string[];

  fetchModels(apiKey: string, baseUrl: string): Promise<ModelInfo[]>;
  streamChat(params: StreamChatParams): Promise<void>;
}
