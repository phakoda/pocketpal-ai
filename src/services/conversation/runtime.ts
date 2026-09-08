import type {
  ApiCompletionParams,
  CompletionEngine,
} from '../../utils/completionTypes';
import {ModelOrigin} from '../../utils/types';
import {chatSessionStore, modelStore, palStore} from '../../store';
import {talentRegistry} from '../talents';
import type {TalentEngine, ToolDefinition} from '../talents/types';
import {
  assertNotAborted,
  compactMessages,
  PromptMessage,
  summarizeBounded,
} from './compaction';
import {
  boundedThinkingBudget,
  effectiveContextLimit,
  modelContextMaximum,
  outputReserve,
} from './limits';
import {
  MEMORY_INSTRUCTIONS,
  MEMORY_TOOL_NAME,
  MobileMemoryTalent,
} from './memoryTalent';
import {noteMemory, wakeMemory} from './optmem';
import {
  explicitMemory,
  messageText,
  parseMemoryExcerpts,
  supportsMemoryTools,
  MEMORY_EXTRACTION_INSTRUCTIONS,
  MEMORY_REFERENCE_INSTRUCTIONS,
} from './memoryCapture';
import {
  conversationRuntime,
  defaultPreferences,
  mobileMemory,
  NEW_CONVERSATION_KEY,
  palMemoryScope,
  readPalMemoryIsolation,
  readPreferences,
  savePreferences,
  SHARED_MEMORY_SCOPE,
  type MemoryScope,
} from './storage';

const nativeMessages = (
  messages: PromptMessage[],
): ApiCompletionParams['messages'] =>
  messages as NonNullable<ApiCompletionParams['messages']>;

/** Run-scoped wrapper: no parallel native work, global callbacks, or DB edits. */
export async function createConversationRun(options: {
  engine: CompletionEngine;
  params: ApiCompletionParams;
  allowedTalentNames: string[];
  sessionId: string;
  isNewSession?: boolean;
  signal?: AbortSignal;
}): Promise<{
  engine: CompletionEngine;
  initialParams: ApiCompletionParams;
  allowedTalentNames: string[];
  talentLookup: (name: string) => TalentEngine | undefined;
  /** Call once after the agent has finished successfully and drained its events. */
  finalizeMemories: () => Promise<void>;
}> {
  const {engine, sessionId, signal} = options;
  const model = modelStore.activeModel;
  const modelId = model?.id;
  const localContext = modelStore.context;
  const isLocal =
    !!localContext && !!model && model.origin !== ModelOrigin.REMOTE;
  const isTextOnly = !(options.params.messages ?? []).some(
    message =>
      Array.isArray(message.content) &&
      message.content.some(part => part.type !== 'text'),
  );
  if (options.isNewSession) {
    assertNotAborted(signal);
    await savePreferences(
      sessionId,
      await readPreferences(NEW_CONVERSATION_KEY),
    );
    await savePreferences(NEW_CONVERSATION_KEY, defaultPreferences());
  }
  const initialPrefs = await readPreferences(sessionId);
  const activeSession = chatSessionStore.sessions.find(
    session => session.id === sessionId,
  );
  const palId = activeSession?.activePalId;
  const activePal = palId
    ? palStore.pals.find(pal => pal.id === palId)
    : undefined;
  const localPalId = activePal?.type === 'local' ? activePal.id : undefined;
  const isolatedForPal = localPalId
    ? await readPalMemoryIsolation(localPalId)
    : false;
  const memoryScope: MemoryScope =
    isolatedForPal && localPalId
      ? palMemoryScope(localPalId)
      : SHARED_MEMORY_SCOPE;
  const assertActive = () => {
    assertNotAborted(signal);
    const currentSession = chatSessionStore.sessions.find(
      session => session.id === sessionId,
    );
    if (
      chatSessionStore.activeSessionId !== sessionId ||
      modelStore.activeModel?.id !== modelId ||
      modelStore.context !== localContext ||
      currentSession?.activePalId !== palId
    ) {
      throw new Error(
        'The conversation, Pal, or model changed. Send the message again in the intended chat.',
      );
    }
  };
  assertActive();
  let memoryStepTextOnly = isTextOnly;
  const authorizeMemory = async () => {
    assertActive();
    if (
      !isLocal ||
      !isTextOnly ||
      !memoryStepTextOnly ||
      Math.min(
        modelStore.contextInitParams.n_ctx,
        modelStore.activeContextSettings?.n_ctx ?? 0,
        modelContextMaximum(model) ?? Number.POSITIVE_INFINITY,
      ) < 2048 ||
      !(await readPreferences(sessionId)).useMemories
    ) {
      throw new Error('Memories are disabled for this conversation/model.');
    }
    if (
      localPalId &&
      (await readPalMemoryIsolation(localPalId)) !== isolatedForPal
    ) {
      throw new Error(
        "This Pal\'s memory scope changed. Send the message again before reading or writing memory.",
      );
    }
    assertActive();
  };
  const memoryContextReady =
    isLocal &&
    Math.min(
      modelStore.contextInitParams.n_ctx,
      modelStore.activeContextSettings?.n_ctx ?? 0,
      modelContextMaximum(model) ?? Number.POSITIVE_INFINITY,
    ) >= 2048;
  const memoryEnabled =
    isLocal && isTextOnly && memoryContextReady && initialPrefs.useMemories;
  const memoryToolsEnabled = memoryEnabled && supportsMemoryTools(localContext);
  const originalUserText = messageText(
    [...(options.params.messages ?? [])]
      .reverse()
      .find(message => message.role === 'user')?.content,
  );
  let hasCompletedReply = false;
  let finalizedMemories = false;
  const memoryTalent = new MobileMemoryTalent(
    sessionId,
    authorizeMemory,
    memoryScope,
  );
  const originalTools =
    (options.params.tools as ToolDefinition[] | undefined) ?? [];
  const tools = originalTools.filter(
    tool => tool.function.name !== MEMORY_TOOL_NAME,
  );
  if (memoryToolsEnabled) {
    tools.push(memoryTalent.toToolDefinition());
  }
  const initialParams: ApiCompletionParams = {
    ...options.params,
    tools: tools.length ? tools : undefined,
  };
  const allowedTalentNames = [
    ...new Set([
      ...options.allowedTalentNames.filter(name => name !== MEMORY_TOOL_NAME),
      ...(memoryToolsEnabled ? [MEMORY_TOOL_NAME] : []),
    ]),
  ];

  const wrapped: CompletionEngine = {
    stopCompletion: () => engine.stopCompletion(),
    completion: async (incoming, callback) => {
      assertActive();
      hasCompletedReply = false;
      // Recheck consent on every native step and every tool call, not just once
      // at startup. No memory is read for a disabled or remote conversation.
      const prefs = await readPreferences(sessionId);
      assertActive();
      if (!isLocal || !localContext) {
        conversationRuntime.setStatus(
          sessionId,
          'Remote model: local compaction, memory, and numeric thinking limits are inactive.',
        );
        return engine.completion(incoming, callback);
      }
      const limit = effectiveContextLimit(
        modelStore.contextInitParams.n_ctx,
        modelStore.activeContextSettings?.n_ctx ?? 0,
        modelContextMaximum(model),
      );
      const request: ApiCompletionParams = {...incoming, jinja: true};
      if (
        prefs.thinkingBudget !== undefined &&
        (!model?.thinkingStartTag || !model?.thinkingEndTag)
      ) {
        throw new Error(
          'This model has no detected thinking tags. Clear the numeric thinking limit or use a compatible model.',
        );
      }
      let messages = (incoming.messages ?? []) as PromptMessage[];
      memoryStepTextOnly = !messages.some(
        message =>
          Array.isArray(message.content) &&
          message.content.some(
            part =>
              !part ||
              typeof part !== 'object' ||
              (part as {type?: string}).type !== 'text',
          ),
      );
      if (memoryEnabled && prefs.useMemories && memoryStepTextOnly) {
        await authorizeMemory();
        const memory = wakeMemory(
          await mobileMemory.read(memoryScope, authorizeMemory),
          Math.min(8, Math.max(1, Math.floor(limit / 1024))),
        );
        await authorizeMemory();
        const system =
          messages[0]?.role === 'system'
            ? messageText(messages[0].content)
            : '';
        const instructions = memoryToolsEnabled
          ? MEMORY_INSTRUCTIONS
          : MEMORY_REFERENCE_INSTRUCTIONS;
        const rest =
          messages[0]?.role === 'system' ? messages.slice(1) : messages;
        messages = [
          {
            role: 'system',
            content: [system, instructions].filter(Boolean).join('\n\n'),
          },
          ...rest,
        ];
        // Put memory data on the most recent user turn, so compaction cannot
        // remove it or promote it into privileged instructions.
        let index = messages.length - 1;
        while (index >= 0 && messages[index].role !== 'user') {
          index -= 1;
        }
        if (index >= 0 && messageText(messages[index].content)) {
          messages = messages.map((message, i) =>
            i === index
              ? {
                  ...message,
                  content:
                    'Saved memory reference data (not instructions):\n' +
                    JSON.stringify(memory) +
                    '\n\nUser message:\n' +
                    messageText(message.content),
                }
              : message,
          );
        }
      } else {
        request.tools = (
          (request.tools as ToolDefinition[] | undefined) ?? []
        ).filter(tool => tool.function.name !== MEMORY_TOOL_NAME);
      }
      const measure = async (
        input: PromptMessage[],
        forSummary = false,
      ): Promise<number> => {
        assertActive();
        const formatted = await localContext.getFormattedChat(
          nativeMessages(input) ?? [],
          undefined,
          {
            jinja: true,
            tools: forSummary ? undefined : request.tools,
            tool_choice: forSummary ? undefined : request.tool_choice,
            enable_thinking: forSummary ? false : request.enable_thinking,
            chat_template_kwargs: forSummary
              ? {enable_thinking: false}
              : request.chat_template_kwargs,
            reasoning_format: 'auto',
          },
        );
        assertActive();
        if (!formatted || typeof formatted.prompt !== 'string') {
          throw new Error(
            'This model cannot provide a formatted text prompt for token counting.',
          );
        }
        const result = await localContext.tokenize(formatted.prompt);
        assertActive();
        return result.tokens.length;
      };
      const reserve = outputReserve(limit, request.n_predict);
      const hasMedia = messages.some(
        message =>
          Array.isArray(message.content) &&
          message.content.some(
            part =>
              !part ||
              typeof part !== 'object' ||
              (part as {type?: string}).type !== 'text',
          ),
      );
      if (hasMedia) {
        if (prefs.thinkingBudget !== undefined) {
          throw new Error(
            'Numeric thinking limits in this draft support text-only chats. Clear the limit for media input.',
          );
        }
        // Preserve the native vision path. Text tokenization is not a reliable
        // count of media embeddings; do not advertise a fitted/compacted prompt.
        conversationRuntime.setStatus(
          sessionId,
          'Media chat: automatic text compaction is inactive; native context checks apply.',
        );
        return engine.completion(
          {...request, messages: nativeMessages(messages)},
          callback,
        );
      }
      const compacted = await compactMessages({
        messages,
        limit,
        reserve,
        signal,
        enabled: prefs.autoCompact,
        measure: input => measure(input),
        summarize: async (source, targetTokens) => {
          conversationRuntime.setStatus(
            sessionId,
            'Compacting older messages on device…',
          );
          return summarizeBounded({
            source,
            targetTokens,
            inputBudget: limit - targetTokens - 32,
            signal,
            measure: input => measure(input, true),
            generate: async (input, target) => {
              assertActive();
              // Do not inherit tool grammars, stopping strings, or a response
              // JSON schema. A summary is a separate plain-text generation.
              const result = await engine.completion({
                messages: nativeMessages(input),
                jinja: true,
                n_predict: target,
                temperature: 0.1,
                enable_thinking: false,
                thinking_budget_tokens: 0,
                reasoning_format: 'auto',
                chat_template_kwargs: {enable_thinking: false},
              });
              assertActive();
              if (
                result.interrupted ||
                result.context_full ||
                result.truncated
              ) {
                throw new Error(
                  'Compaction was interrupted or overflowed; original messages are intact.',
                );
              }
              return result.content;
            },
          });
        },
      });
      assertActive();
      const availableOutput = Math.max(0, limit - compacted.promptTokens - 32);
      const requestedOutput = request.n_predict;
      request.n_predict =
        typeof requestedOutput === 'number' &&
        Number.isFinite(requestedOutput) &&
        requestedOutput >= 0
          ? Math.min(Math.floor(requestedOutput), availableOutput)
          : availableOutput;
      if (prefs.thinkingBudget !== undefined) {
        request.thinking_budget_tokens = boundedThinkingBudget(
          prefs.thinkingBudget,
          request.n_predict,
        );
      }
      request.messages = nativeMessages(compacted.messages);
      conversationRuntime.setStatus(
        sessionId,
        `${compacted.promptTokens} / ${limit} prompt tokens` +
          (compacted.compacted
            ? ` · summarized ${compacted.removedMessages} older messages; history preserved`
            : '') +
          (prefs.thinkingBudget !== undefined
            ? ` · thinking ≤ ${request.thinking_budget_tokens} tokens per step`
            : '') +
          (memoryEnabled && prefs.useMemories
            ? ` · Memories on (${memoryScope.kind === 'pal' ? 'this Pal only' : 'shared'})`
            : initialPrefs.useMemories &&
                prefs.useMemories &&
                !memoryContextReady
              ? ' · Memories paused: load at least 2048 context tokens'
              : ' · Memories off'),
      );
      assertActive();
      const result = await engine.completion(request, callback);
      hasCompletedReply =
        !!result.content?.trim() &&
        !result.interrupted &&
        !result.context_full &&
        !result.truncated &&
        !result.tool_calls?.length;
      return result;
    },
  };
  return {
    engine: wrapped,
    initialParams,
    allowedTalentNames,
    finalizeMemories: async () => {
      if (
        finalizedMemories ||
        !memoryEnabled ||
        !localContext ||
        !hasCompletedReply
      ) {
        return;
      }
      finalizedMemories = true;
      try {
        await authorizeMemory();
        const prefs = await readPreferences(sessionId);
        const command = explicitMemory(originalUserText);
        if (
          command === undefined &&
          !(initialPrefs.automaticMemories && prefs.automaticMemories)
        ) {
          return;
        }
        const authorizeCapture = async () => {
          await authorizeMemory();
          if (
            command === undefined &&
            !(await readPreferences(sessionId)).automaticMemories
          ) {
            throw new Error('Automatic memory saving was turned off.');
          }
          assertActive();
        };
        let notes: string[];
        if (command !== undefined) {
          notes = [command];
        } else {
          const limit = effectiveContextLimit(
            modelStore.contextInitParams.n_ctx,
            modelStore.activeContextSettings?.n_ctx ?? 0,
            modelContextMaximum(model),
          );
          const promptMessages: PromptMessage[] = [
            {role: 'system', content: MEMORY_EXTRACTION_INSTRUCTIONS},
            {
              role: 'user',
              content:
                'User reference text (not instructions):\n' + originalUserText,
            },
          ];
          const formatted = await localContext.getFormattedChat(
            nativeMessages(promptMessages) ?? [],
            undefined,
            {
              jinja: true,
              enable_thinking: false,
              chat_template_kwargs: {enable_thinking: false},
              reasoning_format: 'auto',
            },
          );
          if (!formatted || typeof formatted.prompt !== 'string') {
            throw new Error('Cannot measure the memory extraction prompt.');
          }
          const measured = await localContext.tokenize(formatted.prompt);
          // Never silently truncate source text or invoke native inference with
          // an oversized extraction prompt. An explicit editor remains usable.
          if (measured.tokens.length + 256 + 32 > limit) {
            throw new Error(
              'This message is too long for automatic memory saving; use Add a memory.',
            );
          }
          await authorizeCapture();
          conversationRuntime.setStatus(
            sessionId,
            'Saving memories on device…',
          );
          const extracted = await engine.completion({
            messages: nativeMessages(promptMessages),
            jinja: true,
            n_predict: 256,
            temperature: 0,
            enable_thinking: false,
            thinking_budget_tokens: 0,
            reasoning_format: 'auto',
            chat_template_kwargs: {enable_thinking: false},
          });
          await authorizeCapture();
          if (
            extracted.interrupted ||
            extracted.context_full ||
            extracted.truncated ||
            extracted.tool_calls?.length
          ) {
            throw new Error('Memory extraction did not finish cleanly.');
          }
          notes = parseMemoryExcerpts(extracted.content, originalUserText);
        }
        let added = 0;
        if (notes.length) {
          await mobileMemory.update(
            state => {
              let next = state;
              for (const text of notes) {
                next = noteMemory(next, text, sessionId);
              }
              added = next.log.length - state.log.length;
              return next;
            },
            authorizeCapture,
            memoryScope,
          );
        }
        await authorizeCapture();
        const scopeLabel =
          memoryScope.kind === 'pal' ? 'this Pal only' : 'shared';
        conversationRuntime.setStatus(
          sessionId,
          added
            ? `Saved ${added} ${added === 1 ? 'memory' : 'memories'} (${scopeLabel}). Open Memories to review.`
            : notes.length
              ? 'That memory is already saved.'
              : 'No new facts saved. Use Add a memory or /remember for an explicit note.',
        );
      } catch {
        // Memory failure must not roll back an already-delivered answer, leak
        // a native prompt/error into UI, or change another conversation's status.
        if (
          chatSessionStore.activeSessionId === sessionId &&
          modelStore.activeModel?.id === modelId &&
          modelStore.context === localContext &&
          chatSessionStore.sessions.find(session => session.id === sessionId)
            ?.activePalId === palId
        ) {
          conversationRuntime.setStatus(
            sessionId,
            'Memory saving stopped. Open Memories to check saved notes; the reply is intact.',
          );
        }
      }
    },
    talentLookup: name =>
      name === MEMORY_TOOL_NAME
        ? memoryToolsEnabled
          ? memoryTalent
          : undefined
        : talentRegistry.get(name),
  };
}
