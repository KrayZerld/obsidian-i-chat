import { describe, expect, it } from "vitest";
import {
  buildGoogleContents,
  buildGoogleStreamRequestBody,
  buildGoogleThinkingConfig,
  detectGoogleModelCapabilities,
  extractGoogleGroundingSources,
  extractSseDataPayloads,
} from "../src/providers/google-ai";
import { ChatMessage, ModelInfo } from "../src/types";

describe("google-ai provider helpers", () => {
  it("extracts SSE data payloads across chunk boundaries and CRLF", () => {
    const chunk1 = 'data: {"candidates":[{"content":{"parts":[{"text":"Hel"}]}}]}\r\n\r\ndata: {"c';
    const r1 = extractSseDataPayloads(chunk1);
    expect(r1.events).toEqual(['{"candidates":[{"content":{"parts":[{"text":"Hel"}]}}]}']);
    expect(r1.remainder).toBe('data: {"c');

    const chunk2 = r1.remainder + 'andidates":[{"content":{"parts":[{"text":"lo"}]}}]}\n\ndata: [DONE]\n\n';
    const r2 = extractSseDataPayloads(chunk2);
    expect(r2.events).toEqual(['{"candidates":[{"content":{"parts":[{"text":"lo"}]}}]}']);
    expect(r2.remainder).toBe("");
  });

  it("detects Visual and Think capabilities accurately", () => {
    expect(detectGoogleModelCapabilities({}, "gemini-2.5-flash")).toEqual(["visual", "think"]);
    expect(detectGoogleModelCapabilities({}, "gemini-2.0-flash")).toEqual(["visual"]);
    expect(detectGoogleModelCapabilities({ thinking: false }, "gemini-2.5-custom")).toEqual([
      "visual",
    ]);
    expect(detectGoogleModelCapabilities({ thinking: true }, "gemini-2.0-custom")).toEqual([
      "visual",
      "think",
    ]);
  });

  it("builds thinkingConfig according to model generation", () => {
    const model25: ModelInfo = {
      id: "gemini-2.5-flash",
      displayName: "Gemini 2.5 Flash",
      platformId: "google-ai",
      capabilities: ["visual", "think"],
      releaseOrder: 25000,
      orderIndex: 0,
    };
    expect(buildGoogleThinkingConfig(model25, "high")).toEqual({
      includeThoughts: true,
      thinkingBudget: 24576,
    });

    const modelNeon: ModelInfo = {
      id: "gemini-neon",
      displayName: "Gemini Neon",
      platformId: "google-ai",
      capabilities: ["visual", "think"],
      releaseOrder: 40000,
      orderIndex: 0,
    };
    expect(buildGoogleThinkingConfig(modelNeon, "low")).toEqual({
      includeThoughts: true,
      thinkingLevel: "LOW",
    });

    const nonThink: ModelInfo = {
      id: "gemini-2.0-flash",
      displayName: "Gemini 2.0 Flash",
      platformId: "google-ai",
      capabilities: ["visual"],
      releaseOrder: 20000,
      orderIndex: 1,
    };
    expect(buildGoogleThinkingConfig(nonThink, "high")).toBeUndefined();
  });

  it("maps text and binary attachments into Google API parts", () => {
    const messages: ChatMessage[] = [
      {
        id: "u1",
        role: "user",
        timestamp: "2026-11-17 11:24:42",
        content: "帮我看下这两个文件",
        attachments: [
          {
            id: "a1",
            name: "Report.md",
            mimeType: "text/markdown",
            kind: "text",
            textContent: "# Summary",
          },
          {
            id: "a2",
            name: "Screenshot.png",
            mimeType: "image/png",
            kind: "binary",
            base64Data: "iVBORw0KGgo=",
          },
        ],
      },
      {
        id: "m1",
        role: "assistant",
        timestamp: "2026-11-17 11:24:50",
        content: "好的",
      },
    ];

    const contents = buildGoogleContents(messages);
    expect(contents).toHaveLength(2);
    expect(contents[0].role).toBe("user");
    expect(contents[0].parts).toEqual([
      { text: "[Attachment: Report.md]\n# Summary" },
      { inlineData: { mimeType: "image/png", data: "iVBORw0KGgo=" } },
      { text: "帮我看下这两个文件" },
    ]);
    expect(contents[1]).toEqual({
      role: "model",
      parts: [{ text: "好的" }],
    });
  });

  it("builds google_search tool and disables thinking when requested", () => {
    const model25: ModelInfo = {
      id: "gemini-2.5-flash",
      displayName: "Gemini 2.5 Flash",
      platformId: "google-ai",
      capabilities: ["visual", "think"],
      releaseOrder: 25000,
      orderIndex: 0,
    };

    const withSearch = buildGoogleStreamRequestBody({
      model: model25,
      messages: [],
      thinkingLevel: "medium",
      enableWebSearch: true,
    });
    expect(withSearch.tools).toEqual([{ google_search: {} }]);
    expect(withSearch.generationConfig).toEqual({
      thinkingConfig: { includeThoughts: true, thinkingBudget: 8192 },
    });

    const withoutThinking = buildGoogleStreamRequestBody({
      model: model25,
      messages: [],
      thinkingLevel: "high",
      disableThinking: true,
      enableWebSearch: false,
    });
    expect(withoutThinking.tools).toBeUndefined();
    expect(withoutThinking.generationConfig).toEqual({
      thinkingConfig: { includeThoughts: false, thinkingBudget: 0 },
    });
  });

  it("extracts and deduplicates web grounding sources from groundingMetadata", () => {
    const sources = extractGoogleGroundingSources({
      groundingChunks: [
        { web: { uri: "https://obsidian.md/changelog", title: "Obsidian Changelog" } },
        { web: { uri: "https://obsidian.md/changelog", title: "Duplicate" } },
        { web: { uri: "https://ai.google.dev/gemini-api/docs" } },
        { web: { uri: "javascript:alert(1)", title: "Unsafe" } },
      ],
    });

    expect(sources).toEqual([
      { title: "Obsidian Changelog", url: "https://obsidian.md/changelog" },
      { title: "ai.google.dev", url: "https://ai.google.dev/gemini-api/docs" },
    ]);
  });
});
