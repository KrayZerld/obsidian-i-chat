import { PlatformConfig, PlatformId, PluginSettings } from "../types";
import { LLMProvider } from "./base";
import { GoogleAIProvider } from "./google-ai";
import { OpenAICompatibleProvider } from "./openai-compatible";

export class ProviderRegistry {
  private readonly providers = new Map<PlatformId, LLMProvider>();

  constructor() {
    this.register(new GoogleAIProvider());
    this.register(
      new OpenAICompatibleProvider({
        id: "openai",
        name: "OpenAI",
        defaultBaseUrl: "https://api.openai.com/v1",
        defaultModelPriority: ["gpt-4.1", "gpt-4o", "gpt-4o-mini", "o4-mini"],
      })
    );
    this.register(
      new OpenAICompatibleProvider({
        id: "deepseek",
        name: "DeepSeek",
        defaultBaseUrl: "https://api.deepseek.com/v1",
        defaultModelPriority: ["deepseek-flash", "deepseek-chat", "deepseek-reasoner"],
      })
    );
    this.register(
      new OpenAICompatibleProvider({
        id: "openrouter",
        name: "OpenRouter",
        defaultBaseUrl: "https://openrouter.ai/api/v1",
        defaultModelPriority: [
          "openai/gpt-4.1",
          "anthropic/claude-sonnet-4",
          "google/gemini-2.5-flash",
          "deepseek/deepseek-chat",
        ],
      })
    );
    this.register(
      new OpenAICompatibleProvider({
        id: "openai-compatible",
        name: "OpenAI Compatible",
        defaultBaseUrl: "https://api.openai.com/v1",
        defaultModelPriority: [],
      })
    );
  }

  register(provider: LLMProvider): void {
    this.providers.set(provider.id, provider);
  }

  get(id: PlatformId): LLMProvider | undefined {
    return this.providers.get(id);
  }

  list(): LLMProvider[] {
    return Array.from(this.providers.values());
  }

  createDefaultPlatformConfig(provider: LLMProvider): PlatformConfig {
    return {
      id: provider.id,
      apiKey: "",
      baseUrl: "",
      lastTestStatus: "untested",
      enabledModelIds: [],
      cachedModels: [],
    };
  }

  createDefaultSettings(): PluginSettings {
    const providers = this.list();
    const platforms: Record<string, PlatformConfig> = {};
    for (const provider of providers) {
      platforms[provider.id] = this.createDefaultPlatformConfig(provider);
    }

    const firstId = providers[0]?.id ?? "google-ai";
    return {
      platforms,
      selectedSettingsPlatformId: firstId,
      defaultThinkingLevel: "medium",
      promptsFolder: "i-Chat/Prompts",
      chatsFolder: "i-Chat/Chats",
      activePlatformId: firstId,
      activeModelId: "",
      activeThinkingLevel: "medium",
      activePromptFile: "",
      modelSortBy: "enabled",
    };
  }

  ensurePlatformConfigs(settings: PluginSettings): PluginSettings {
    const defaults = this.createDefaultSettings();
    const mergedPlatforms: Record<string, PlatformConfig> = {
      ...defaults.platforms,
    };

    for (const [id, saved] of Object.entries(settings.platforms ?? {})) {
      const provider = this.get(id);
      const base = provider
        ? this.createDefaultPlatformConfig(provider)
        : {
            id,
            apiKey: "",
            baseUrl: "",
            lastTestStatus: "untested" as const,
            enabledModelIds: [],
            cachedModels: [],
          };

      mergedPlatforms[id] = {
        ...base,
        ...saved,
        id,
        enabledModelIds: Array.isArray(saved.enabledModelIds) ? [...saved.enabledModelIds] : [],
        cachedModels: Array.isArray(saved.cachedModels) ? [...saved.cachedModels] : [],
      };
    }

    return {
      ...defaults,
      ...settings,
      platforms: mergedPlatforms,
    };
  }
}
