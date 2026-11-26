import { describe, expect, it } from "vitest";
import { formatComposerPlaceholder } from "../src/utils/composer";

describe("composer placeholder formatting", () => {
  it("uses active prompt i-chat-title for first turn and follow-up turns", () => {
    expect(
      formatComposerPlaceholder({
        hasMessages: false,
        promptTitle: "Geminyan",
        modelDisplayName: "Gemini 4 Neon",
      })
    ).toBe("Ask Geminyan");

    expect(
      formatComposerPlaceholder({
        hasMessages: true,
        promptTitle: "Geminyan",
        modelDisplayName: "Gemini 4 Neon",
      })
    ).toBe("Reply to Geminyan");
  });

  it("falls back to active model display name when prompt is Default", () => {
    expect(
      formatComposerPlaceholder({
        hasMessages: false,
        modelDisplayName: "Gemini 4 Neon",
      })
    ).toBe("Ask Gemini 4 Neon");

    expect(
      formatComposerPlaceholder({
        hasMessages: true,
        modelDisplayName: "Gemini 4 Neon",
      })
    ).toBe("Reply to Gemini 4 Neon");
  });

  it("falls back to generic prompts when neither prompt nor model is active", () => {
    expect(formatComposerPlaceholder({ hasMessages: false })).toBe("Ask anything…");
    expect(formatComposerPlaceholder({ hasMessages: true })).toBe("Reply…");
  });
});
