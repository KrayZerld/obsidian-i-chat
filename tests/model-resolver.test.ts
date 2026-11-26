import { describe, expect, it } from "vitest";
import { ProviderRegistry } from "../src/providers/registry";
import {
  getAvailableModelGroups,
  pickDefaultModelId,
  resolveHistoryModelSelection,
  sortModelsForSettings,
} from "../src/core/model-resolver";
import { ModelInfo, PluginSettings, PromptItem } from "../src/types";

function createTestSettings(): { registry: ProviderRegistry; settings: PluginSettings } {
  const registry = new ProviderRegistry();
  const settings = registry.createDefaultSettings();

  const models: ModelInfo[] = [
    {
      id: "gemini-2.0-flash",
      displayName: "Gemini 2.0 Flash",
      platformId: "google-ai",
      capabilities: ["visual"],
      releaseOrder: 20000,
      orderIndex: 2,
    },
    {
      id: "gemini-2.5-flash",
      displayName: "Gemini 2.5 Flash",
      platformId: "google-ai",
      capabilities: ["visual", "think"],
      releaseOrder: 25000,
      orderIndex: 1,
    },
    {
      id: "gemini-2.5-pro",
      displayName: "Gemini 2.5 Pro",
      platformId: "google-ai",
      capabilities: ["visual", "think"],
      releaseOrder: 25100,
      orderIndex: 0,
    },
  ];

  settings.platforms["google-ai"].apiKey = "test-key";
  settings.platforms["google-ai"].cachedModels = models;
  settings.platforms["google-ai"].enabledModelIds = ["gemini-2.5-flash", "gemini-2.5-pro"];
  settings.activePlatformId = "google-ai";
  settings.activeModelId = "gemini-2.5-flash";
  settings.activeThinkingLevel = "medium";

  return { registry, settings };
}

describe("model-resolver", () => {
  it("lists only enabled models from platforms with an API key", () => {
    const { registry, settings } = createTestSettings();
    const groups = getAvailableModelGroups(settings, registry);
    expect(groups).toHaveLength(1);
    expect(groups[0].models.map((m) => m.id)).toEqual(["gemini-2.5-pro", "gemini-2.5-flash"]);

    settings.platforms["google-ai"].apiKey = "   ";
    expect(getAvailableModelGroups(settings, registry)).toHaveLength(0);
  });

  it("picks default model by platform priority", () => {
    const { settings } = createTestSettings();
    const models = settings.platforms["google-ai"].cachedModels;
    expect(pickDefaultModelId(models, ["gemini-2.5-flash", "gemini-2.5-pro"])).toBe(
      "gemini-2.5-flash"
    );
    expect(pickDefaultModelId(models, ["non-existent"])).toBe("gemini-2.5-pro");
  });

  it("sorts models by time or enabled-first", () => {
    const { settings } = createTestSettings();
    const models = settings.platforms["google-ai"].cachedModels;

    const byTime = sortModelsForSettings(models, ["gemini-2.0-flash"], "time");
    expect(byTime.map((m) => m.id)).toEqual([
      "gemini-2.5-pro",
      "gemini-2.5-flash",
      "gemini-2.0-flash",
    ]);

    const byEnabled = sortModelsForSettings(models, ["gemini-2.0-flash"], "enabled");
    expect(byEnabled.map((m) => m.id)).toEqual([
      "gemini-2.0-flash",
      "gemini-2.5-pro",
      "gemini-2.5-flash",
    ]);
  });

  it("resolves history model with priority: prompt -> note -> keep current + notice", () => {
    const { settings } = createTestSettings();

    const availablePrompt: PromptItem = {
      filePath: "i-Chat/Prompts/Agent.md",
      fileName: "Agent.md",
      title: "My Agent",
      platform: "google-ai",
      model: "gemini-2.5-pro",
      thinking: "high",
    };

    // 1. Prompt binding available -> prefer prompt binding
    const res1 = resolveHistoryModelSelection({
      settings,
      noteMeta: {
        prompt: "Agent.md",
        platform: "google-ai",
        model: "gemini-2.5-flash",
        thinking: "low",
      },
      restoredPrompt: availablePrompt,
    });
    expect(res1.source).toBe("prompt");
    expect(res1.modelId).toBe("gemini-2.5-pro");
    expect(res1.thinkingLevel).toBe("high");
    expect(res1.notice).toBeUndefined();

    // 2. Prompt binding disabled -> fallback to note's own model
    const disabledPrompt: PromptItem = {
      ...availablePrompt,
      model: "gemini-2.0-flash", // not enabled
    };
    const res2 = resolveHistoryModelSelection({
      settings,
      noteMeta: {
        prompt: "Agent.md",
        platform: "google-ai",
        model: "gemini-2.5-pro",
        thinking: "low",
      },
      restoredPrompt: disabledPrompt,
    });
    expect(res2.source).toBe("note");
    expect(res2.modelId).toBe("gemini-2.5-pro");
    expect(res2.thinkingLevel).toBe("low");
    expect(res2.notice).toBeUndefined();

    // 3. Both unavailable -> keep current & notify
    const res3 = resolveHistoryModelSelection({
      settings,
      noteMeta: {
        prompt: "Agent.md",
        platform: "google-ai",
        model: "gemini-2.0-flash", // disabled
      },
      restoredPrompt: disabledPrompt,
    });
    expect(res3.source).toBe("kept-current");
    expect(res3.modelId).toBe("gemini-2.5-flash");
    expect(res3.notice).toBeTruthy();
  });
});
