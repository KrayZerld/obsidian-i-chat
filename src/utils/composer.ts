export interface ComposerPlaceholderParams {
  hasMessages: boolean;
  promptTitle?: string;
  modelDisplayName?: string;
}

/**
 * Formats the Composer textarea placeholder based on conversation turn state,
 * active prompt title (i-chat-title), and active model display name.
 */
export function formatComposerPlaceholder(params: ComposerPlaceholderParams): string {
  const target = params.promptTitle?.trim() || params.modelDisplayName?.trim() || "";
  if (!params.hasMessages) {
    return target ? `Ask ${target}` : "Ask anything…";
  }
  return target ? `Reply to ${target}` : "Reply…";
}
