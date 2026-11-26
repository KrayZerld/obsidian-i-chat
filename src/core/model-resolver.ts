import {
  AvailableModelGroup,
  ChatNoteMeta,
  ModelInfo,
  ModelSortBy,
  PlatformId,
  PluginSettings,
  PromptItem,
  ThinkingLevel,
} from "../types";
import { ProviderRegistry } from "../providers/registry";
import { supportsDeepSeekWebSearch } from "../providers/openai-compatible";

/**
 * Returns true when the selected model natively supports server-side web search
 * (Google AI Grounding or DeepSeek Web Tools on deepseek-flash).
 */
export function supportsWebSearch(model: ModelInfo | undefined): boolean {
  if (!model) {
    return false;
  }
  if (model.platformId === "google-ai") {
    return true;
  }
  return supportsDeepSeekWebSearch(model.platformId, model.id);
}

export interface ResolvedModelSelection {
  platformId: PlatformId;
  modelId: string;
  thinkingLevel: ThinkingLevel;
  source: "prompt" | "note" | "kept-current";
  notice?: string;
}

/**
 * Returns true if the platform has a non-empty API Key and the model is both cached and enabled.
 */
export function isModelAvailable(
  settings: PluginSettings,
  platformId: PlatformId | undefined,
  modelId: string | undefined
): boolean {
  if (!platformId || !modelId) {
    return false;
  }
  const platform = settings.platforms[platformId];
  if (!platform || platform.apiKey.trim().length === 0) {
    return false;
  }
  if (!platform.enabledModelIds.includes(modelId)) {
    return false;
  }
  return platform.cachedModels.some((m) => m.id === modelId);
}

export function findCachedModel(
  settings: PluginSettings,
  platformId: PlatformId | undefined,
  modelId: string | undefined
): ModelInfo | undefined {
  if (!platformId || !modelId) {
    return undefined;
  }
  return settings.platforms[platformId]?.cachedModels.find((m) => m.id === modelId);
}

/**
 * Lists models available for the chat selector:
 * only platforms with an API key AND enabled models, grouped by platform.
 */
export function getAvailableModelGroups(
  settings: PluginSettings,
  registry: ProviderRegistry
): AvailableModelGroup[] {
  const groups: AvailableModelGroup[] = [];

  for (const provider of registry.list()) {
    const config = settings.platforms[provider.id];
    if (!config || config.apiKey.trim().length === 0) {
      continue;
    }

    const enabledSet = new Set(config.enabledModelIds);
    const models = config.cachedModels
      .filter((m) => enabledSet.has(m.id))
      .sort((a, b) => b.releaseOrder - a.releaseOrder || a.orderIndex - b.orderIndex);

    if (models.length > 0) {
      groups.push({
        platformId: provider.id,
        platformName: provider.name,
        models,
      });
    }
  }

  return groups;
}

/**
 * Picks the platform default model when first testing a platform with zero enabled models.
 */
export function pickDefaultModelId(
  models: ModelInfo[],
  priorityList: readonly string[]
): string | null {
  if (models.length === 0) {
    return null;
  }
  for (const candidateId of priorityList) {
    const exact = models.find((m) => m.id === candidateId);
    if (exact) {
      return exact.id;
    }
  }
  const sorted = [...models].sort(
    (a, b) => b.releaseOrder - a.releaseOrder || a.orderIndex - b.orderIndex
  );
  return sorted[0]?.id ?? null;
}

/**
 * Sorts platform models for the BYOK settings list.
 */
export function sortModelsForSettings(
  models: ModelInfo[],
  enabledModelIds: readonly string[],
  sortBy: ModelSortBy
): ModelInfo[] {
  const enabledSet = new Set(enabledModelIds);
  return [...models].sort((a, b) => {
    if (sortBy === "enabled") {
      const aEnabled = enabledSet.has(a.id) ? 1 : 0;
      const bEnabled = enabledSet.has(b.id) ? 1 : 0;
      if (aEnabled !== bEnabled) {
        return bEnabled - aEnabled;
      }
    }
    if (b.releaseOrder !== a.releaseOrder) {
      return b.releaseOrder - a.releaseOrder;
    }
    return a.orderIndex - b.orderIndex;
  });
}

/**
 * Resolves model selection when opening a historical chat note:
 * 1. Try the model bound to the restored prompt file (i-chat-platform / i-chat-model).
 * 2. If unavailable, fall back to the model recorded in the chat note itself.
 * 3. If both unavailable, keep the current active selection and return a user-facing notice.
 */
export function resolveHistoryModelSelection(params: {
  settings: PluginSettings;
  noteMeta: ChatNoteMeta;
  restoredPrompt?: PromptItem;
}): ResolvedModelSelection {
  const { settings, noteMeta, restoredPrompt } = params;

  // Step 1: Prompt-bound model
  if (restoredPrompt?.platform && restoredPrompt?.model) {
    if (isModelAvailable(settings, restoredPrompt.platform, restoredPrompt.model)) {
      return {
        platformId: restoredPrompt.platform,
        modelId: restoredPrompt.model,
        thinkingLevel:
          restoredPrompt.thinking ??
          noteMeta.thinking ??
          settings.activeThinkingLevel ??
          settings.defaultThinkingLevel,
        source: "prompt",
      };
    }
  }

  // Step 2: Chat note's own recorded model
  if (noteMeta.platform && noteMeta.model) {
    if (isModelAvailable(settings, noteMeta.platform, noteMeta.model)) {
      return {
        platformId: noteMeta.platform,
        modelId: noteMeta.model,
        thinkingLevel:
          noteMeta.thinking ?? settings.activeThinkingLevel ?? settings.defaultThinkingLevel,
        source: "note",
      };
    }
  }

  // Step 3: Keep current selection and notify if either prompt or note had a model configured
  const hadRecordedModel = Boolean(
    (restoredPrompt?.platform && restoredPrompt?.model) || (noteMeta.platform && noteMeta.model)
  );

  return {
    platformId: settings.activePlatformId,
    modelId: settings.activeModelId,
    thinkingLevel: settings.activeThinkingLevel ?? settings.defaultThinkingLevel,
    source: "kept-current",
    notice: hadRecordedModel
      ? "历史对话关联的模型当前不可用（未启用或平台未填写 Key），已保持当前模型设置。"
      : undefined,
  };
}
