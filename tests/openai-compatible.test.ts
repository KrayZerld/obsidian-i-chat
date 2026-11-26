import { describe, expect, it } from "vitest";
import {
  buildOpenAIMessages,
  buildOpenAIStreamRequestBody,
  detectOpenAIModelCapabilities,
  extractOpenAIAnnotationSources,
  extractOpenAIDeltaTexts,
  isOpenAIChatModel,
  normalizeOpenAIBaseUrl,
  supportsDeepSeekWebSearch,
  supportsOpenAIReasoningEffort,
} from "../src/providers/openai-compatible";
import { supportsWebSearch } from "../src/core/model-resolver";
import { ProviderRegistry } from "../src/providers/registry";
import { ChatMessage, ModelInfo } from "../src/types";

describe("openai-compatible provider helpers", () => {
  it("registers the 5 built-in BYOK platforms in ProviderRegistry", () => {
    const registry = new ProviderRegistry();
    expect(registry.list().map((p) => p.id)).toEqual([
      "google-ai",
      "openai",
      "deepseek",
      "openrouter",
      "openai-compatible",
    ]);
  });

  it("normalizes base URLs including bare domains and trailing endpoint suffixes", () => {
    expect(normalizeOpenAIBaseUrl("https://api.openai.com", "https://api.openai.com/v1")).toBe(
      "https://api.openai.com/v1"
    );
    expect(
      normalizeOpenAIBaseUrl("https://api.deepseek.com/v1/chat/completions", "https://api.deepseek.com/v1")
    ).toBe("https://api.deepseek.com/v1");
    expect(
      normalizeOpenAIBaseUrl("https://openrouter.ai/api/v1/models", "https://openrouter.ai/api/v1")
    ).toBe("https://openrouter.ai/api/v1");
    expect(normalizeOpenAIBaseUrl("  ", "https://api.openai.com/v1")).toBe(
      "https://api.openai.com/v1"
    );
  });

  it("filters out non-chat models and infers Visual / Think capabilities", () => {
    expect(isOpenAIChatModel("gpt-4.1")).toBe(true);
    expect(isOpenAIChatModel("deepseek-reasoner")).toBe(true);
    expect(isOpenAIChatModel("text-embedding-3-large")).toBe(false);
    expect(isOpenAIChatModel("whisper-1")).toBe(false);
    expect(isOpenAIChatModel("dall-e-3")).toBe(false);

    expect(detectOpenAIModelCapabilities("gpt-4o")).toEqual(["visual"]);
    expect(detectOpenAIModelCapabilities("o4-mini")).toEqual(["visual", "think"]);
    expect(detectOpenAIModelCapabilities("o3-mini")).toEqual(["think"]);
    expect(detectOpenAIModelCapabilities("deepseek-reasoner")).toEqual(["think"]);
    expect(detectOpenAIModelCapabilities("deepseek-chat")).toEqual([]);
    expect(detectOpenAIModelCapabilities("anthropic/claude-sonnet-4")).toEqual(["visual", "think"]);
  });

  it("builds multimodal OpenAI messages with system prompt, text attachments, and images", () => {
    const messages: ChatMessage[] = [
      {
        id: "u1",
        role: "user",
        timestamp: "2026-11-23 20:00:00",
        content: "总结图片和文档",
        attachments: [
          {
            id: "a1",
            name: "Notes.md",
            mimeType: "text/markdown",
            kind: "text",
            textContent: "Hello world",
          },
          {
            id: "a2",
            name: "Chart.png",
            mimeType: "image/png",
            kind: "binary",
            base64Data: "AAAA",
          },
        ],
      },
      {
        id: "m1",
        role: "assistant",
        timestamp: "2026-11-23 20:00:05",
        content: "好的",
      },
    ];

    const built = buildOpenAIMessages(messages, "You are helpful.");
    expect(built).toEqual([
      { role: "system", content: "You are helpful." },
      {
        role: "user",
        content: [
          { type: "text", text: "[Attachment: Notes.md]\nHello world\n\n总结图片和文档" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        ],
      },
      { role: "assistant", content: "好的" },
    ]);
  });

  it("extracts reasoning_content, reasoning, and content deltas from stream chunks", () => {
    expect(
      extractOpenAIDeltaTexts({ reasoning_content: "思考中…", content: null })
    ).toEqual({ thinking: "思考中…", content: "" });

    expect(
      extractOpenAIDeltaTexts({ reasoning: "step 1", content: "Answer" })
    ).toEqual({ thinking: "step 1", content: "Answer" });

    expect(
      extractOpenAIDeltaTexts({ reasoning_content: "", reasoning: "fallback step", content: null })
    ).toEqual({ thinking: "fallback step", content: "" });

    expect(
      extractOpenAIDeltaTexts({ content: [{ type: "text", text: "Part A" }, { type: "text", text: " Part B" }] })
    ).toEqual({ thinking: "", content: "Part A Part B" });
  });

  it("injects reasoning_effort only for supported reasoning models and skips when disableThinking is set", () => {
    const o4Model: ModelInfo = {
      id: "o4-mini",
      displayName: "o4-mini",
      platformId: "openai",
      capabilities: ["visual", "think"],
      releaseOrder: 1,
      orderIndex: 0,
    };
    const deepseekR1: ModelInfo = {
      id: "deepseek-reasoner",
      displayName: "DeepSeek Reasoner",
      platformId: "deepseek",
      capabilities: ["think"],
      releaseOrder: 1,
      orderIndex: 0,
    };

    expect(supportsOpenAIReasoningEffort("openai", "o4-mini")).toBe(true);
    expect(supportsOpenAIReasoningEffort("deepseek", "deepseek-reasoner")).toBe(false);

    const enabledBody = buildOpenAIStreamRequestBody({
      model: o4Model,
      platformId: "openai",
      messages: [],
      thinkingLevel: "high",
    });
    expect(enabledBody.reasoning_effort).toBe("high");

    const disabledBody = buildOpenAIStreamRequestBody({
      model: o4Model,
      platformId: "openai",
      messages: [],
      thinkingLevel: "high",
      disableThinking: true,
    });
    expect(disabledBody.reasoning_effort).toBeUndefined();

    const dsBody = buildOpenAIStreamRequestBody({
      model: deepseekR1,
      platformId: "deepseek",
      messages: [],
      thinkingLevel: "high",
    });
    expect(dsBody.reasoning_effort).toBeUndefined();
  });

  it("supports DeepSeek deepseek-flash native web search, read_url, thinking control, annotations, and multi-turn server_tool_calls", () => {
    const deepseekFlash: ModelInfo = {
      id: "deepseek-flash",
      displayName: "deepseek-flash",
      platformId: "deepseek",
      capabilities: detectOpenAIModelCapabilities("deepseek-flash"),
      releaseOrder: 1,
      orderIndex: 0,
    };
    const deepseekChat: ModelInfo = {
      id: "deepseek-chat",
      displayName: "deepseek-chat",
      platformId: "deepseek",
      capabilities: [],
      releaseOrder: 1,
      orderIndex: 1,
    };

    expect(deepseekFlash.capabilities).toEqual(["visual", "think"]);
    expect(supportsDeepSeekWebSearch("deepseek", "deepseek-flash")).toBe(true);
    expect(supportsDeepSeekWebSearch("deepseek", "deepseek-chat")).toBe(false);
    expect(supportsWebSearch(deepseekFlash)).toBe(true);
    expect(supportsWebSearch(deepseekChat)).toBe(false);

    const serverToolCalls = [{ index: 0, calls: [{ id: "call_1", type: "web_search_call" }] }];
    const history: ChatMessage[] = [
      { id: "u1", role: "user", timestamp: "2026-11-25 19:00:00", content: "今天新闻" },
      {
        id: "a1",
        role: "assistant",
        timestamp: "2026-11-25 19:00:05",
        content: "最新进展如下",
        serverToolCalls,
      },
      { id: "u2", role: "user", timestamp: "2026-11-25 19:00:10", content: "展开第一条" },
    ];

    const withSearch = buildOpenAIStreamRequestBody({
      model: deepseekFlash,
      platformId: "deepseek",
      messages: history,
      thinkingLevel: "medium",
      enableWebSearch: true,
    });
    expect(withSearch.tools).toEqual([
      { type: "deepseek_web_search", name: "deepseek_web_search" },
      { type: "deepseek_read_url", name: "deepseek_read_url" },
    ]);
    expect(withSearch.thinking).toEqual({ type: "enabled" });
    expect(withSearch.reasoning_effort).toBe("high");
    expect((withSearch.messages as Array<Record<string, unknown>>)[1].server_tool_calls).toEqual(
      serverToolCalls
    );

    // Non-DeepSeek platforms must NOT receive DeepSeek-specific server_tool_calls
    const openaiMsgs = buildOpenAIMessages(history, undefined, "openai");
    expect(openaiMsgs[1].server_tool_calls).toBeUndefined();

    // Auto-title background call disables thinking cleanly
    const disabledThinking = buildOpenAIStreamRequestBody({
      model: deepseekFlash,
      platformId: "deepseek",
      messages: [],
      disableThinking: true,
      enableWebSearch: false,
    });
    expect(disabledThinking.thinking).toEqual({ type: "disabled" });
    expect(disabledThinking.reasoning_effort).toBe("none");
    expect(disabledThinking.tools).toBeUndefined();

    // Extracts and deduplicates url_citation annotations
    const sources = extractOpenAIAnnotationSources([
      {
        type: "url_citation",
        url_citation: { url: "https://api-docs.deepseek.com/news", title: "DeepSeek News" },
      },
      {
        type: "url_citation",
        url_citation: { url: "https://api-docs.deepseek.com/news", title: "Duplicate" },
      },
      { type: "url_citation", url_citation: { url: "https://example.org/post" } },
      { type: "url_citation", url_citation: { url: "javascript:alert(1)", title: "Bad" } },
    ]);
    expect(sources).toEqual([
      { title: "DeepSeek News", url: "https://api-docs.deepseek.com/news" },
      { title: "example.org", url: "https://example.org/post" },
    ]);
  });
});
