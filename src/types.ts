export type ThinkingLevel = "low" | "medium" | "high";

export type PlatformId = string;

export type TestStatus = "untested" | "ok" | "err";

export type ModelCapability = "visual" | "think";

export type ModelSortBy = "time" | "enabled";

export interface ModelInfo {
  id: string;
  displayName: string;
  platformId: PlatformId;
  capabilities: ModelCapability[];
  /** Higher value = newer / prioritized when sorting by time. */
  releaseOrder: number;
  /** Original index returned by provider API. */
  orderIndex: number;
}

export interface PlatformConfig {
  id: PlatformId;
  apiKey: string;
  baseUrl: string;
  lastTestStatus: TestStatus;
  lastTestError?: string;
  enabledModelIds: string[];
  cachedModels: ModelInfo[];
}

export interface PluginSettings {
  platforms: Record<string, PlatformConfig>;
  selectedSettingsPlatformId: PlatformId;
  defaultThinkingLevel: ThinkingLevel;
  promptsFolder: string;
  chatsFolder: string;
  activePlatformId: PlatformId;
  activeModelId: string;
  activeThinkingLevel: ThinkingLevel;
  activePromptFile: string;
  modelSortBy: ModelSortBy;
}

export interface SearchSource {
  title: string;
  url: string;
}

export interface Attachment {
  id: string;
  /** Display filename only (e.g. Report.md, Screenshot.png). */
  name: string;
  mimeType: string;
  kind: "text" | "binary";
  textContent?: string;
  base64Data?: string;
  /** Full Vault file path when attached from Vault (used for deduplication). */
  sourcePath?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  /** Formatted as YYYY-MM-DD HH:mm:ss */
  timestamp: string;
  content: string;
  /** UI-only thinking trace, never persisted to chat note. */
  thinking?: string;
  /** UI & active-session memory only, never persisted to chat note. */
  attachments?: Attachment[];
  /** UI-only web search citations (e.g. Gemini Grounding / DeepSeek Web Tools), never persisted. */
  sources?: SearchSource[];
  /** Session-only DeepSeek server_tool_calls payload echoed back on multi-turn follow-ups, never persisted. */
  serverToolCalls?: unknown[];
  isStreaming?: boolean;
  isThinking?: boolean;
  error?: string;
}

export interface ChatTurn {
  user: {
    timestamp: string;
    content: string;
  };
  assistant?: {
    timestamp: string;
    content: string;
  };
}

export interface ChatNoteMeta {
  title?: string;
  /** Relative filename inside promptsFolder (e.g. Agent.md). */
  prompt?: string;
  platform?: PlatformId;
  model?: string;
  thinking?: ThinkingLevel;
}

export interface PromptItem {
  /** Full Vault file path. */
  filePath: string;
  /** Path relative to promptsFolder (usually Agent.md). */
  fileName: string;
  /** From i-chat-title frontmatter, falling back to basename without .md. */
  title: string;
  platform?: PlatformId;
  model?: string;
  thinking?: ThinkingLevel;
}

export interface ChatHistoryItem {
  filePath: string;
  fileName: string;
  /** From i-chat-title frontmatter, falling back to basename without .md. */
  title: string;
  mtime: number;
  meta: ChatNoteMeta;
}

export interface AvailableModelGroup {
  platformId: PlatformId;
  platformName: string;
  models: ModelInfo[];
}

export const FRONTMATTER_KEYS = {
  title: "i-chat-title",
  prompt: "i-chat-prompt",
  platform: "i-chat-platform",
  model: "i-chat-model",
  thinking: "i-chat-thinking",
} as const;

export const THINKING_LEVELS: readonly ThinkingLevel[] = ["low", "medium", "high"] as const;

export const THINKING_LEVEL_LABELS: Record<ThinkingLevel, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
};

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return value === "low" || value === "medium" || value === "high";
}

export function createId(prefix = "msg"): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
