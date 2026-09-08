import React, {useEffect, useRef, useState} from 'react';
import {useTheme} from '../../hooks/useTheme';
import {
  Alert,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import {
  Button,
  Dialog,
  HelperText,
  Portal,
  Switch,
  Text,
  TextInput,
} from 'react-native-paper';
import {observer} from 'mobx-react';
import {runInAction} from 'mobx';
import {chatSessionStore, modelStore, palStore} from '../../store';
import {ModelOrigin} from '../../utils/types';
import {getModelMemoryRequirement} from '../../utils/memoryEstimator';
import {formatBytes} from '../../utils';
import {
  contextCeiling,
  modelContextMaximum,
  parseContextLimit,
  parseThinkingBudget,
} from '../../services/conversation/limits';
import {noteMemory, wakeMemory} from '../../services/conversation/optmem';
import {
  ConversationPreferences,
  conversationRuntime,
  defaultPreferences,
  mobileMemory,
  NEW_CONVERSATION_KEY,
  palMemoryScope,
  readPalMemoryIsolation,
  readPreferences,
  savePalMemoryIsolation,
  savePreferences,
  SHARED_MEMORY_SCOPE,
  type MemoryScope,
} from '../../services/conversation/storage';

// English copy is kept together in this draft; translation into the app's
// locale schema is a pre-merge task listed in docs/conversation-features.md.
export const ConversationControls = observer(() => {
  const {height} = useWindowDimensions();
  const theme = useTheme();
  const operationPending = useRef(false);
  const sessionId = chatSessionStore.activeSessionId ?? NEW_CONVERSATION_KEY;
  const model = modelStore.activeModel;
  const isLocal = !!model && model.origin !== ModelOrigin.REMOTE;
  const activePalId = chatSessionStore.activePalId;
  const activePal = activePalId
    ? palStore.pals.find(pal => pal.id === activePalId)
    : undefined;
  const localPal = activePal?.type === 'local' ? activePal : undefined;
  const busy = modelStore.inferencing || modelStore.isContextLoading;
  const [visible, setVisible] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [prefs, setPrefs] =
    useState<ConversationPreferences>(defaultPreferences);
  const [autoCompact, setAutoCompact] = useState(true);
  const preferenceRevision = conversationRuntime.preferenceRevision;
  const [palMemoryIsolation, setPalMemoryIsolation] = useState(false);
  const [context, setContext] = useState('');
  const [prompt, setPrompt] = useState('');
  const [thinking, setThinking] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [memoryPreview, setMemoryPreview] = useState('');
  const [loadedFor, setLoadedFor] = useState('');
  const editorKey = JSON.stringify([sessionId, activePalId, model?.id]);
  const maximum = modelContextMaximum(model);
  const ceiling = contextCeiling(
    maximum,
    modelStore.activeContextSettings?.n_ctx,
  );
  const thinkingSupported =
    isLocal && !!model?.thinkingStartTag && !!model?.thinkingEndTag;
  const blocked = busy || loading || saving || loadedFor !== editorKey;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    Promise.all([
      readPreferences(sessionId),
      localPal ? readPalMemoryIsolation(localPal.id) : Promise.resolve(false),
    ])
      .then(([value, isolated]) => {
        if (!cancelled) {
          setLoadedFor(editorKey);
          setPrefs(value);
          setPalMemoryIsolation(isolated);
        }
      })
      .catch(reason => {
        if (!cancelled) {
          setError(String(reason instanceof Error ? reason.message : reason));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [visible, sessionId, editorKey, localPal, preferenceRevision]);

  // Keep unsaved model-form fields separate from immediately persisted memory
  // switches. New-chat preference transfer publishes a revision above.
  useEffect(() => {
    let cancelled = false;
    setMemoryPreview('');
    setNote('');
    setContext(String(Math.min(modelStore.contextInitParams.n_ctx, ceiling)));
    setPrompt(model?.chatTemplate.systemPrompt ?? '');
    readPreferences(sessionId)
      .then(value => {
        if (!cancelled) {
          setAutoCompact(value.autoCompact);
          setThinking(
            value.thinkingBudget === undefined
              ? ''
              : String(value.thinkingBudget),
          );
        }
      })
      .catch(reason => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    visible,
    sessionId,
    editorKey,
    ceiling,
    model?.chatTemplate.systemPrompt,
  ]);

  let estimatedBytes: number | undefined;
  const nCtx = Number(context);
  if (
    isLocal &&
    model &&
    Number.isSafeInteger(nCtx) &&
    nCtx >= 200 &&
    nCtx <= ceiling &&
    model.ggufMetadata
  ) {
    const projection = modelStore.models.find(
      item => item.id === modelStore.activeProjectionModelId,
    );
    const draftId =
      model.defaultDraftModel ??
      modelStore.contextInitParams.selectedDraftModelId;
    const draft = modelStore.contextInitParams.speculativeEnabled
      ? modelStore.models.find(item => item.id === draftId)
      : undefined;
    // Metadata does not describe which layers use sliding windows. Estimate
    // a full cache per layer rather than undercount hybrid attention models.
    const conservativeModel = {
      ...model,
      ggufMetadata: {...model.ggufMetadata, sliding_window: undefined},
    };
    estimatedBytes = getModelMemoryRequirement(
      conservativeModel,
      projection,
      {
        ...modelStore.contextInitParams,
        n_ctx: nCtx,
        n_batch: Math.min(modelStore.contextInitParams.n_batch, nCtx),
        n_ubatch: Math.min(
          modelStore.contextInitParams.n_ubatch,
          modelStore.contextInitParams.n_batch,
          nCtx,
        ),
      },
      draft,
    );
  }

  const save = async () => {
    if (blocked || operationPending.current) {
      return;
    }
    operationPending.current = true;
    setSaving(true);
    setError('');
    try {
      const value = isLocal ? parseContextLimit(context, ceiling) : undefined;
      const budget = parseThinkingBudget(thinking);
      if (budget !== undefined && !thinkingSupported) {
        throw new Error(
          'Clear the numeric thinking limit: this model does not expose compatible thinking tags.',
        );
      }
      if (prompt.length > 32000) {
        throw new Error(
          'The model system prompt is limited to 32000 characters.',
        );
      }
      if (value !== undefined && budget !== undefined && budget > value - 32) {
        throw new Error(
          'The thinking limit must leave room in the context for the answer.',
        );
      }
      const targetId = model?.id;
      if (
        (chatSessionStore.activeSessionId ?? NEW_CONVERSATION_KEY) !==
          sessionId ||
        modelStore.activeModel?.id !== targetId ||
        chatSessionStore.activePalId !== activePalId
      ) {
        throw new Error(
          'The active chat, Pal, or model changed. Settings were not modified.',
        );
      }
      const persisted = await readPreferences(sessionId);
      await savePreferences(sessionId, {
        ...persisted,
        autoCompact,
        thinkingBudget: budget,
      });
      if (isLocal && model && value !== undefined) {
        modelStore.setNContext(value);
        runInAction(() => {
          model.chatTemplate = {...model.chatTemplate, systemPrompt: prompt};
        });
      }
      setVisible(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      operationPending.current = false;
      setSaving(false);
    }
  };

  const selectedMemoryScope = (): MemoryScope =>
    localPal && palMemoryIsolation
      ? palMemoryScope(localPal.id)
      : SHARED_MEMORY_SCOPE;

  const authorizeMemoryEditor = async () => {
    if (
      (chatSessionStore.activeSessionId ?? NEW_CONVERSATION_KEY) !==
        sessionId ||
      chatSessionStore.activePalId !== activePalId ||
      modelStore.inferencing
    ) {
      throw new Error(
        'The active chat or Pal changed, or a reply is running. Reopen Memories before editing.',
      );
    }
    if (
      localPal &&
      (await readPalMemoryIsolation(localPal.id)) !== palMemoryIsolation
    ) {
      throw new Error(
        "This Pal's memory scope changed. Reopen Memories before editing.",
      );
    }
  };

  const memoryAction = async (operation: 'preview' | 'note') => {
    if (blocked || operationPending.current) {
      return;
    }
    operationPending.current = true;
    setSaving(true);
    setError('');
    try {
      await authorizeMemoryEditor();
      const scope = selectedMemoryScope();
      const state =
        operation === 'note'
          ? await mobileMemory.update(
              memory => noteMemory(memory, note, sessionId),
              authorizeMemoryEditor,
              scope,
            )
          : await mobileMemory.read(scope, authorizeMemoryEditor);
      await authorizeMemoryEditor();
      const view = wakeMemory(state, 24);
      setMemoryPreview(
        view.nodes
          .map(node => `#${node.lo}-${node.hi}: ${node.text}`)
          .join('\n') +
          (view.omittedNodes
            ? `\n${view.omittedNodes} older nodes omitted from this preview.`
            : '') || 'No saved memories.',
      );
      if (operation === 'note') {
        setNote('');
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      operationPending.current = false;
      setSaving(false);
    }
  };

  const eraseMemories = async () => {
    try {
      await authorizeMemoryEditor();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return;
    }
    const confirmedScope = selectedMemoryScope();
    const palScoped = confirmedScope.kind === 'pal';
    Alert.alert(
      palScoped
        ? `Erase ${localPal?.name ?? 'this Pal'}'s memories?`
        : 'Erase shared memories?',
      palScoped
        ? "This permanently deletes only this Pal's memory notes and summaries on this device. Other Pals and shared memories are untouched."
        : 'This permanently deletes the shared memory notes and summaries on this device. Pal-scoped memories are untouched.',
      [
        {text: 'Cancel', style: 'cancel'},
        {
          text: 'Erase',
          style: 'destructive',
          onPress: () => {
            if (operationPending.current) {
              return;
            }
            operationPending.current = true;
            setSaving(true);
            mobileMemory
              .eraseAll(confirmedScope, authorizeMemoryEditor)
              .then(() => setMemoryPreview('No saved memories.'))
              .catch(reason =>
                setError(
                  reason instanceof Error ? reason.message : String(reason),
                ),
              )
              .finally(() => {
                operationPending.current = false;
                setSaving(false);
              });
          },
        },
      ],
    );
  };

  const persistMemorySwitch = async (
    field: 'useMemories' | 'automaticMemories',
    enabled: boolean,
  ) => {
    if (blocked || operationPending.current) {
      return;
    }
    operationPending.current = true;
    setSaving(true);
    setError('');
    try {
      await authorizeMemoryEditor();
      const current = await readPreferences(sessionId);
      const next = {...current, [field]: enabled};
      await authorizeMemoryEditor();
      await savePreferences(sessionId, next);
      setPrefs(value => ({...value, [field]: enabled}));
      conversationRuntime.setStatus(
        sessionId,
        enabled
          ? 'Memory setting saved. It applies to the next local text reply.'
          : field === 'useMemories'
            ? 'Memories off: the model will not read or write saved notes.'
            : 'Automatic memory saving off.',
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      operationPending.current = false;
      setSaving(false);
    }
  };

  const persistMemoryIsolation = async (enabled: boolean) => {
    if (!localPal || blocked || operationPending.current) {
      return;
    }
    operationPending.current = true;
    setSaving(true);
    setError('');
    try {
      await authorizeMemoryEditor();
      await savePalMemoryIsolation(localPal.id, enabled);
      setPalMemoryIsolation(enabled);
      setMemoryPreview('');
      conversationRuntime.setStatus(
        sessionId,
        enabled
          ? `Memories for ${localPal.name} are separate. Existing notes were not moved.`
          : 'Shared memory selected. Existing Pal memories were not moved.',
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      operationPending.current = false;
      setSaving(false);
    }
  };

  const memoryScopeText =
    localPal && palMemoryIsolation
      ? `${localPal.name} uses a separate on-device memory store. Across chats with this Pal, only memories previously saved for this Pal are loaded; shared memories and other Pals' memories are excluded.`
      : 'Memories use the shared on-device store across opted-in local chats. Turning memories off does not erase prior notes.';

  return (
    <View
      testID="conversation-controls-surface"
      style={{backgroundColor: theme.colors.background}}>
      <Button
        testID="conversation-options"
        icon="brain"
        theme={theme}
        accessibilityLabel="Open memories and context settings"
        onPress={() => setVisible(true)}>
        {loadedFor === editorKey && prefs.useMemories
          ? 'Memories: on · Context'
          : 'Memories & context'}
      </Button>
      {!!conversationRuntime.statuses[sessionId] && (
        <Text
          accessibilityLiveRegion="polite"
          variant="bodySmall"
          style={[styles.status, {color: theme.colors.onSurfaceVariant}]}>
          {conversationRuntime.statuses[sessionId]}
        </Text>
      )}
      <Portal>
        <Dialog
          theme={theme}
          style={{backgroundColor: theme.colors.surface}}
          visible={visible}
          onDismiss={() => {
            if (!saving) {
              setVisible(false);
            }
          }}>
          <Dialog.Title>Memories and model settings</Dialog.Title>
          <Dialog.ScrollArea style={{backgroundColor: theme.colors.surface}}>
            <ScrollView
              keyboardShouldPersistTaps="handled"
              style={{
                maxHeight: height * 0.6,
                backgroundColor: theme.colors.surface,
              }}
              contentContainerStyle={styles.content}>
              {!isLocal && (
                <Text theme={theme}>
                  Load an on-device text model to use memories in replies. You
                  can still manage stored notes and set consent here.
                </Text>
              )}
              <Text theme={theme} variant="titleMedium">
                Memories
              </Text>
              <Text theme={theme} variant="bodySmall">
                Memory switches save immediately. Notes stay on this device.
                Model access is off by default; you can view or erase notes even
                while it is off.
              </Text>
              <View style={styles.row}>
                <Text theme={theme} style={styles.label}>
                  Use local memories in this conversation
                </Text>
                <Switch
                  theme={theme}
                  accessibilityLabel="Use memories in this conversation"
                  testID="use-memories-switch"
                  disabled={blocked}
                  value={prefs.useMemories}
                  onValueChange={value =>
                    persistMemorySwitch('useMemories', value)
                  }
                />
              </View>
              <Text theme={theme} variant="bodySmall">
                Requires a loaded text context of at least 2048 tokens. With a
                smaller context, memory use pauses without blocking your reply.
                Off prevents model access; it does not erase notes.
              </Text>
              <View style={styles.row}>
                <Text theme={theme} style={styles.label}>
                  Automatically remember new facts
                </Text>
                <Switch
                  theme={theme}
                  accessibilityLabel="Automatically remember new facts"
                  testID="automatic-memories-switch"
                  disabled={blocked || !prefs.useMemories}
                  value={prefs.automaticMemories === true}
                  onValueChange={value =>
                    persistMemorySwitch('automaticMemories', value)
                  }
                />
              </View>
              <Text theme={theme} variant="bodySmall">
                Optional extra on-device generation after a completed reply. It
                saves up to three exact excerpts from your latest message, not
                the assistant's answer. This may include sensitive information:
                review and erase notes here. Nothing is backfilled from older
                chats.
              </Text>
              <Text theme={theme} variant="bodySmall">
                For a reliable explicit save, use Add a memory below or send
                /remember followed by one short line. Neither requires native
                tool calling. The app reports whether a note was actually saved.
              </Text>
              {localPal && (
                <>
                  <View style={styles.row}>
                    <Text theme={theme} style={styles.label}>
                      Keep memories separate for {localPal.name}
                    </Text>
                    <Switch
                      theme={theme}
                      accessibilityLabel={`Use separate memories for ${localPal.name}`}
                      testID="pal-memory-isolation-switch"
                      disabled={blocked}
                      value={palMemoryIsolation}
                      onValueChange={persistMemoryIsolation}
                    />
                  </View>
                  <Text theme={theme} variant="bodySmall">
                    This is a Pal-level setting and applies to every local chat
                    that uses this Pal.
                  </Text>
                </>
              )}
              <Text theme={theme} variant="bodySmall">
                {memoryScopeText}
              </Text>
              <Button
                theme={theme}
                disabled={blocked}
                onPress={() => memoryAction('preview')}>
                View saved memories in this store
              </Button>
              <Text theme={theme} selectable>
                {memoryPreview}
              </Text>
              <TextInput
                theme={theme}
                style={{backgroundColor: theme.colors.surfaceVariant}}
                label="Add a memory (one line, 280 UTF-8 bytes)"
                value={note}
                onChangeText={setNote}
                disabled={blocked}
              />
              <Button
                theme={theme}
                disabled={blocked || !note.trim()}
                onPress={() => memoryAction('note')}>
                Save memory
              </Button>
              <Button theme={theme} disabled={blocked} onPress={eraseMemories}>
                {localPal && palMemoryIsolation
                  ? `Erase ${localPal.name}'s memories`
                  : 'Erase shared memories'}
              </Button>
              <Text theme={theme} variant="titleMedium">
                Context and model
              </Text>
              <View style={styles.row}>
                <Text theme={theme} style={styles.label}>
                  Compact older text near the context limit
                </Text>
                <Switch
                  theme={theme}
                  accessibilityLabel="Automatic context compaction"
                  disabled={blocked || !isLocal}
                  value={autoCompact}
                  onValueChange={setAutoCompact}
                />
              </View>
              <Text theme={theme} variant="bodySmall">
                Summaries affect inference only. Original messages remain in the
                chat history.
              </Text>
              <TextInput
                theme={theme}
                style={{backgroundColor: theme.colors.surfaceVariant}}
                label="Context limit (tokens)"
                value={context}
                keyboardType="number-pad"
                disabled={blocked || !isLocal}
                onChangeText={setContext}
              />
              <Text theme={theme} variant="bodySmall">
                {maximum
                  ? `Model maximum: ${maximum} tokens.`
                  : `Model maximum unknown. Conservative editor ceiling: ${ceiling}; load GGUF metadata to verify larger limits.`}
              </Text>
              <Text theme={theme} variant="bodySmall">
                {estimatedBytes !== undefined && Number.isFinite(estimatedBytes)
                  ? `Estimated model memory: ${formatBytes(estimatedBytes, 1)}. Conservative full-cache projection, not a guarantee; actual sliding-window use, system buffers and embedded draft overhead can differ.`
                  : 'Memory estimate unavailable: load a model with valid GGUF metadata.'}
              </Text>
              <Text theme={theme} variant="bodySmall">
                Loaded context:{' '}
                {modelStore.activeContextSettings?.n_ctx ?? 'unknown'}. Reload
                the model to change its native allocation. Until then, inference
                uses the smaller configured/loaded/model limit. This context
                setting is global.
              </Text>
              <TextInput
                theme={theme}
                style={{backgroundColor: theme.colors.surfaceVariant}}
                label="Thinking limit per model step (tokens; blank = default)"
                value={thinking}
                keyboardType="number-pad"
                disabled={blocked || !isLocal}
                onChangeText={setThinking}
              />
              <Text theme={theme} variant="bodySmall">
                {thinkingSupported
                  ? 'Uses the native thinking budget. Zero requests an immediate thinking close. The effective budget is clamped to leave room for an answer. It is per generation step, not per multi-tool run.'
                  : 'No compatible thinking tags detected. Leave the numeric limit blank; the existing thinking on/off control remains separate.'}
              </Text>
              <TextInput
                theme={theme}
                style={{backgroundColor: theme.colors.surfaceVariant}}
                label="Model system prompt"
                value={prompt}
                multiline
                numberOfLines={5}
                maxLength={32000}
                disabled={blocked || !isLocal}
                onChangeText={setPrompt}
              />
              <Text theme={theme} variant="bodySmall">
                Applies to this model across chats. A Pal's system prompt still
                takes precedence. Changes take effect on the next reply.
              </Text>
              {!!error && (
                <HelperText type="error" accessibilityLiveRegion="assertive">
                  {error}
                </HelperText>
              )}
            </ScrollView>
          </Dialog.ScrollArea>
          <Dialog.Actions>
            <Button
              theme={theme}
              disabled={saving}
              onPress={() => setVisible(false)}>
              Close
            </Button>
            <Button
              theme={theme}
              loading={saving || loading}
              disabled={blocked}
              onPress={save}>
              Save settings
            </Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </View>
  );
});

const styles = StyleSheet.create({
  content: {paddingVertical: 12, gap: 12},
  row: {flexDirection: 'row', alignItems: 'center', gap: 12},
  label: {flex: 1},
  status: {paddingHorizontal: 16, paddingBottom: 4},
});
