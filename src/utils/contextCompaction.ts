import {contentToText, type MemoryMessage} from '../services/memory/optMem';

export type PromptMessage = MemoryMessage & Record<string, unknown>;

export const estimateTextTokens = (text: string): number =>
  Math.max(1, Math.ceil(text.length / 4));

export const estimateMessagesTokens = (messages: PromptMessage[]): number =>
  messages.reduce(
    (total, message) => total + estimateTextTokens(contentToText(message.content)) + 4,
    0,
  );

export type ContextCompactionResult = {
  messages: PromptMessage[];
  prunedMessages: PromptMessage[];
  compacted: boolean;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
};

/**
 * Drop only the oldest turns once the prompt is close to the configured
 * context ceiling. A caller can turn prunedMessages into a summary/memory
 * block and fold that into the leading system message.
 */
export const compactConversationForContext = (
  messages: PromptMessage[],
  contextLimit: number,
  systemTokens = 0,
  triggerRatio = 0.82,
  targetRatio = 0.68,
): ContextCompactionResult => {
  const conversationTokens = estimateMessagesTokens(messages);
  const estimatedTokensBefore = systemTokens + conversationTokens;
  const safeLimit = Math.max(256, Math.floor(contextLimit));

  if (
    messages.length <= 4 ||
    estimatedTokensBefore < Math.floor(safeLimit * triggerRatio)
  ) {
    return {
      messages,
      prunedMessages: [],
      compacted: false,
      estimatedTokensBefore,
      estimatedTokensAfter: estimatedTokensBefore,
    };
  }

  const targetPromptTokens = Math.max(256, Math.floor(safeLimit * targetRatio));
  const conversationBudget = Math.max(128, targetPromptTokens - systemTokens);
  const kept: PromptMessage[] = [];
  let keptTokens = 0;

  // Preserve at least the latest four API messages even when they exceed the
  // target. This keeps the current user turn and the immediately preceding
  // assistant/tool exchange coherent.
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    const cost = estimateMessagesTokens([message]);
    if (kept.length >= 4 && keptTokens + cost > conversationBudget) {
      break;
    }
    kept.unshift(message);
    keptTokens += cost;
  }

  const prunedCount = Math.max(0, messages.length - kept.length);
  const prunedMessages = messages.slice(0, prunedCount);
  if (prunedMessages.length === 0) {
    return {
      messages,
      prunedMessages: [],
      compacted: false,
      estimatedTokensBefore,
      estimatedTokensAfter: estimatedTokensBefore,
    };
  }

  return {
    messages: kept,
    prunedMessages,
    compacted: true,
    estimatedTokensBefore,
    estimatedTokensAfter: systemTokens + keptTokens,
  };
};

export const buildExtractiveCompactionSummary = (
  messages: PromptMessage[],
  maxTokens: number,
): string => {
  if (messages.length === 0 || maxTokens <= 0) {
    return '';
  }
  const maxChars = Math.max(160, maxTokens * 4);
  const lines = messages
    .map(message => {
      const text = contentToText(message.content);
      if (!text) {
        return '';
      }
      const role = message.role || 'message';
      const clipped = text.length > 320 ? `${text.slice(0, 317)}...` : text;
      return `${role}: ${clipped}`;
    })
    .filter(Boolean);
  const joined = lines.join('\n');
  if (joined.length <= maxChars) {
    return joined;
  }
  const half = Math.floor((maxChars - 5) / 2);
  return `${joined.slice(0, half)}\n...\n${joined.slice(-half)}`;
};
