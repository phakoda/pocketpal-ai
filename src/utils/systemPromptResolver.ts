import type {Pal} from '../types/pal';
import type {Model} from './types';
import {generateFinalSystemPrompt} from './palshub-template-parser';
import {chatFeatureStore} from '../store/ChatFeatureStore';
import {chatSessionStore} from '../store/ChatSessionStore';
import {modelStore} from '../store/ModelStore';
import {buildOptMemCover} from '../services/memory/optMem';
import {
  buildExtractiveCompactionSummary,
  compactConversationForContext,
  estimateTextTokens,
  type PromptMessage,
} from './contextCompaction';

export interface SystemPromptDependencies {
  pal?: Pal | null;
  model?: Model | null;
}

/**
 * Resolves the system prompt based on priority:
 * 1. Pal's system prompt (with parameter rendering if needed)
 * 2. User-edited prompt for this model (including an intentionally empty one)
 * 3. Fallback to model's chat template system prompt
 * 4. Empty string if neither exists
 */
export function resolveSystemPrompt(
  dependencies: SystemPromptDependencies,
): string {
  const {pal, model} = dependencies;

  // Priority 1: Pal's system prompt
  if (pal?.systemPrompt) {
    // Check if the pal has parameters that need rendering
    if (pal.parameters && Object.keys(pal.parameters).length > 0) {
      return generateFinalSystemPrompt(pal.systemPrompt, pal.parameters);
    } else {
      return pal.systemPrompt;
    }
  }

  // Priority 2: explicit per-model user override. Undefined means no override;
  // an empty string is a valid override that disables the model prompt.
  if (model?.id) {
    const override = chatFeatureStore.getModelSystemPrompt(model.id);
    if (override !== undefined) {
      return override;
    }
  }

  // Priority 3: Model's chat template system prompt
  if (model?.chatTemplate?.systemPrompt) {
    return model.chatTemplate.systemPrompt;
  }

  // Priority 4: Empty string
  return '';
}

type ChatMessage = {role: string; content?: unknown} & Record<string, unknown>;

const optMemLineBudget = (contextLimit: number): number =>
  Math.max(4, Math.min(20, Math.floor(contextLimit / 1024) + 2));

/**
 * Fold the system prompt + every talent fragment into ONE leading system
 * message; a second system message makes strict chat templates raise.
 *
 * Context management happens here because every local/remote completion path
 * passes through this single prompt assembly point:
 * - memories ON: old turns are represented by an OptMem-style binary cover;
 * - all chats: once estimated usage crosses 82% of n_ctx, oldest raw turns are
 *   compacted toward a 68% target, leaving headroom for the next completion.
 */
export function assembleMessages(
  systemMessages: Array<{role: 'system'; content: string}>,
  systemPromptFragments: string[],
  followingMessages: ChatMessage[],
): ChatMessage[] {
  const parts = [
    ...systemMessages.map(msg => msg.content),
    ...systemPromptFragments,
  ].filter(part => part.trim().length > 0);

  const contextLimit = Math.max(
    256,
    modelStore.activeContextSettings?.n_ctx ??
      modelStore.contextInitParams.n_ctx ??
      4096,
  );
  const sessionId = chatSessionStore.activeSessionId || undefined;
  const memoriesEnabled = chatFeatureStore.ensureConversationPreference(sessionId);

  let workingMessages = followingMessages as PromptMessage[];

  // Memory mode keeps a verbatim recent window and replaces older raw turns
  // with a bounded binary-decay cover. This is derived from the durable chat
  // history on each prompt, so there is no hidden background worker or second
  // source of truth to get out of sync after edits.
  if (memoriesEnabled && workingMessages.length > 8) {
    const memorySource = workingMessages.slice(0, -8);
    const memoryCover = buildOptMemCover(
      memorySource,
      optMemLineBudget(contextLimit),
    );
    if (memoryCover) {
      parts.push(
        `Conversation memory (OptMem-inspired compact cover):\n${memoryCover}`,
      );
      workingMessages = workingMessages.slice(-8);
    }
  }

  const systemTokens = estimateTextTokens(parts.join('\n\n'));
  const compaction = compactConversationForContext(
    workingMessages,
    contextLimit,
    systemTokens,
  );

  if (compaction.compacted) {
    const summaryBudget = Math.max(96, Math.floor(contextLimit * 0.12));
    const summary = memoriesEnabled
      ? buildOptMemCover(
          compaction.prunedMessages,
          optMemLineBudget(contextLimit),
        )
      : buildExtractiveCompactionSummary(
          compaction.prunedMessages,
          summaryBudget,
        );
    if (summary) {
      parts.push(
        `Earlier conversation compacted automatically to preserve context:\n${summary}`,
      );
    }
    workingMessages = compaction.messages;
  }

  const leadingSystemMessage: ChatMessage[] = parts.length
    ? [{role: 'system', content: parts.join('\n\n')}]
    : [];

  const messages = [...leadingSystemMessage, ...workingMessages];

  if (__DEV__) {
    const systemPositions = messages
      .map((msg, index) => (msg.role === 'system' ? index : -1))
      .filter(index => index >= 0);
    if (
      systemPositions.length > 1 ||
      (systemPositions.length === 1 && systemPositions[0] !== 0)
    ) {
      console.error(
        'assembleMessages: chat templates require at most one leading system ' +
          `message, but found system messages at [${systemPositions.join(', ')}].`,
      );
    }
  }

  return messages;
}

/**
 * Resolves system prompt and formats it as a system message array
 * Returns empty array if no system prompt is available
 */
export function resolveSystemMessages(
  dependencies: SystemPromptDependencies,
): Array<{role: 'system'; content: string}> {
  const systemPrompt = resolveSystemPrompt(dependencies);

  if (!systemPrompt.trim()) {
    return [];
  }

  return [
    {
      role: 'system' as const,
      content: systemPrompt,
    },
  ];
}
