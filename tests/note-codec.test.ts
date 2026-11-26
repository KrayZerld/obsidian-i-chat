import { describe, expect, it } from "vitest";
import {
  buildTurnsFromMessages,
  computePromptFrontmatterPatch,
  formatMessageBlock,
  parseChatNote,
  resolveUniqueChatFileName,
  serializeChatNote,
} from "../src/storage/note-codec";
import { extractChatTitle, formatFileStamp, formatTimestamp } from "../src/utils/time";
import { ChatMessage, ChatNoteMeta } from "../src/types";

describe("note-codec", () => {
  it("serializes plain unfenced chat note matching the exact template", () => {
    const meta: ChatNoteMeta = {
      title: "截取对话前15字",
      prompt: "Agent.md",
      platform: "google-ai",
      model: "gemini-2.5-flash",
      thinking: "high",
    };

    const messages: ChatMessage[] = [
      {
        id: "u1",
        role: "user",
        timestamp: "2026-11-22 19:56:26",
        content: "Hi Geminyan!",
      },
      {
        id: "a1",
        role: "assistant",
        timestamp: "2026-11-22 19:56:48",
        content: "Hi Captain",
      },
    ];

    const markdown = serializeChatNote(meta, buildTurnsFromMessages(messages));
    expect(markdown).toBe(
      [
        "---",
        "i-chat-title: 截取对话前15字",
        "i-chat-prompt: Agent.md",
        "i-chat-platform: google-ai",
        "i-chat-model: gemini-2.5-flash",
        "i-chat-thinking: high",
        "---",
        "",
        "2026-11-22 19:56:26",
        "Hi Geminyan!",
        "",
        "---",
        "",
        "2026-11-22 19:56:48",
        "Hi Captain",
        "",
        "---",
        "",
      ].join("\n")
    );
  });

  it("round-trips chat note with embedded code blocks, internal --- rules, and empty content", () => {
    const meta: ChatNoteMeta = {
      title: "测试：嵌套代码块 #1",
      prompt: "Agent.md",
      platform: "google-ai",
      model: "gemini-2.5-flash",
      thinking: "high",
    };

    const messages: ChatMessage[] = [
      {
        id: "u1",
        role: "user",
        timestamp: "2026-11-17 11:24:42",
        content: "",
        attachments: [
          {
            id: "a1",
            name: "Report.md",
            mimeType: "text/markdown",
            kind: "text",
            textContent: "should not be persisted",
          },
        ],
      },
      {
        id: "a1",
        role: "assistant",
        timestamp: "2026-11-17 11:24:50",
        content:
          "第一部分\n\n---\n\n```markdown\n---\ntitle: demo\n---\n\n```vb\nEnd With\n```\n```\n\n完成。",
        thinking: "internal reasoning should not be persisted",
      },
      {
        id: "u2",
        role: "user",
        timestamp: "2026-11-17 11:25:10",
        content: "末尾带分隔线\n\n---",
      },
      {
        id: "a2",
        role: "assistant",
        timestamp: "2026-11-17 11:25:18",
        content: "未闭合代码块：\n```ts\nconst x = 1;",
      },
      {
        id: "u3",
        role: "user",
        timestamp: "2026-11-17 11:25:30",
        content: "继续下一轮",
      },
    ];

    const markdown = serializeChatNote(meta, buildTurnsFromMessages(messages));

    // Thinking and attachments must NOT be persisted
    expect(markdown).not.toContain("should not be persisted");
    expect(markdown).not.toContain("internal reasoning");
    // No outer ```markdown wrapper around bubbles
    expect(markdown).not.toContain("```markdown\n2026-11-17");
    expect(markdown).not.toContain("````markdown\n2026-11-17");
    // Exact i-chat-* keys
    expect(markdown).toContain('i-chat-title: "测试：嵌套代码块 #1"');

    const parsed = parseChatNote(markdown);
    expect(parsed.meta).toEqual(meta);
    expect(parsed.messages).toHaveLength(5);
    expect(parsed.messages[0]).toMatchObject({
      role: "user",
      timestamp: "2026-11-17 11:24:42",
      content: "",
    });
    expect(parsed.messages[1]).toMatchObject({
      role: "assistant",
      timestamp: "2026-11-17 11:24:50",
      content: messages[1].content,
    });
    expect(parsed.messages[2]).toMatchObject({
      role: "user",
      timestamp: "2026-11-17 11:25:10",
      content: messages[2].content,
    });
    expect(parsed.messages[3]).toMatchObject({
      role: "assistant",
      timestamp: "2026-11-17 11:25:18",
      content: messages[3].content,
    });
    expect(parsed.messages[4]).toMatchObject({
      role: "user",
      timestamp: "2026-11-17 11:25:30",
      content: "继续下一轮",
    });
  });

  it("still parses legacy fenced ```markdown chat notes for backward compatibility", () => {
    const legacy = [
      "---",
      "i-chat-title: 旧版历史对话",
      "i-chat-platform: google-ai",
      "i-chat-model: gemini-2.5-flash",
      "---",
      "",
      "```markdown",
      "2026-11-17 11:24:42",
      "你好",
      "```",
      "",
      "````markdown",
      "2026-11-17 11:24:50",
      "代码：",
      "```ts",
      "console.log(1);",
      "```",
      "````",
      "",
      "---",
      "",
    ].join("\n");

    const parsed = parseChatNote(legacy);
    expect(parsed.meta.title).toBe("旧版历史对话");
    expect(parsed.messages).toHaveLength(2);
    expect(parsed.messages[0]).toMatchObject({
      role: "user",
      timestamp: "2026-11-17 11:24:42",
      content: "你好",
    });
    expect(parsed.messages[1]).toMatchObject({
      role: "assistant",
      timestamp: "2026-11-17 11:24:50",
      content: "代码：\n```ts\nconsole.log(1);\n```",
    });
  });

  it("omits i-chat-prompt and i-chat-thinking when unset", () => {
    const markdown = serializeChatNote(
      {
        title: "普通对话",
        platform: "google-ai",
        model: "gemini-2.0-flash",
      },
      [
        {
          user: { timestamp: "2026-11-17 11:24:42", content: "Hi" },
          assistant: { timestamp: "2026-11-17 11:24:45", content: "Hello" },
        },
      ]
    );

    expect(markdown).not.toContain("i-chat-prompt:");
    expect(markdown).not.toContain("i-chat-thinking:");
    expect(markdown).toContain("i-chat-title: 普通对话");
  });

  it("resolves same-second filename collisions with -2, -3 suffixes", () => {
    const existing = new Set<string>(["20261117112442.md", "20261117112442-2.md"]);
    expect(resolveUniqueChatFileName("20261117112443", existing)).toBe("20261117112443.md");
    expect(resolveUniqueChatFileName("20261117112442", existing)).toBe("20261117112442-3.md");
  });

  it("formats timestamps and extracts 15-char chat title cleanly", () => {
    const d = new Date(2026, 10, 17, 11, 24, 42);
    expect(formatTimestamp(d)).toBe("2026-11-17 11:24:42");
    expect(formatFileStamp(d)).toBe("20261117112442");

    expect(extractChatTitle("  请帮我设计一个 Obsidian\n插件架构方案并讨论细节  ")).toBe(
      "请帮我设计一个 Obsidia"
    );
    expect(extractChatTitle("短标题")).toBe("短标题");
    expect(extractChatTitle("   ")).toBe("新对话");
  });

  it("formats plain message block with timestamp on line 1", () => {
    expect(formatMessageBlock("2026-11-17 11:24:42", "获取当前时间")).toBe(
      "2026-11-17 11:24:42\n获取当前时间"
    );
    expect(formatMessageBlock("2026-11-17 11:24:42", "")).toBe("2026-11-17 11:24:42");
  });

  it("computes frontmatter backfill patch when a prompt file lacks frontmatter", () => {
    const patch = computePromptFrontmatterPatch("You are a strict translator.", "C2ES", {
      platformId: "google-ai",
      modelId: "gemini-2.5-flash",
      thinking: "high",
    });

    expect(patch.needsWrite).toBe(true);
    expect(patch.title).toBe("C2ES");
    expect(patch.binding).toEqual({
      platformId: "google-ai",
      modelId: "gemini-2.5-flash",
      thinking: "high",
    });
    expect(patch.resolved).toEqual({
      title: "C2ES",
      platform: "google-ai",
      model: "gemini-2.5-flash",
      thinking: "high",
    });
  });

  it("preserves existing i-chat title and model binding without overwriting", () => {
    const existing = [
      "---",
      "copilot-command-slash-enabled: true",
      "i-chat-title: 翻译官",
      "i-chat-platform: google-ai",
      "i-chat-model: gemini-2.5-pro",
      "i-chat-thinking: medium",
      "---",
      "",
      "System prompt body",
    ].join("\n");

    const patch = computePromptFrontmatterPatch(existing, "C2ES", {
      platformId: "google-ai",
      modelId: "gemini-2.5-flash",
      thinking: "low",
    });

    expect(patch.needsWrite).toBe(false);
    expect(patch.title).toBeUndefined();
    expect(patch.binding).toBeUndefined();
    expect(patch.resolved).toEqual({
      title: "翻译官",
      platform: "google-ai",
      model: "gemini-2.5-pro",
      thinking: "medium",
    });
  });

  it("backfills missing i-chat keys on prompt files that only contain third-party frontmatter", () => {
    const thirdPartyOnly = [
      "---",
      "copilot-command-slash-enabled: true",
      "---",
      "",
      "System prompt body",
    ].join("\n");

    const patch = computePromptFrontmatterPatch(thirdPartyOnly, "C2ES", {
      platformId: "google-ai",
      modelId: "gemini-2.5-flash",
    });

    expect(patch.needsWrite).toBe(true);
    expect(patch.title).toBe("C2ES");
    expect(patch.binding).toEqual({
      platformId: "google-ai",
      modelId: "gemini-2.5-flash",
    });
  });
});
