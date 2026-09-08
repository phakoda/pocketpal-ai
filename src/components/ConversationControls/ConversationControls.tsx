import React, {useEffect, useState} from 'react';
import {Alert, ScrollView, StyleSheet, View, useWindowDimensions} from 'react-native';
import {Button, Dialog, HelperText, Portal, Switch, Text, TextInput} from 'react-native-paper';
import {observer} from 'mobx-react';
import {runInAction} from 'mobx';
import {chatSessionStore, modelStore, palStore} from '../../store';
import {ModelOrigin} from '../../utils/types';
import {getModelMemoryRequirement} from '../../utils/memoryEstimator';
import {formatBytes} from '../../utils';
import {
  contextCeiling, modelContextMaximum, parseContextLimit, parseThinkingBudget,
} from '../../services/conversation/limits';
import {noteMemory, wakeMemory} from '../../services/conversation/optmem';
import {
  ConversationPreferences, conversationRuntime, defaultPreferences, mobileMemory,
  NEW_CONVERSATION_KEY, palMemoryScope, readPalMemoryIsolation, readPreferences,
  savePalMemoryIsolation, savePreferences, SHARED_MEMORY_SCOPE, type MemoryScope,
} from '../../services/conversation/storage';

// English copy is kept together in this draft; translation into the app's
// locale schema is a pre-merge task listed in docs/conversation-features.md.
export const ConversationControls = observer(() => {
  const {height} = useWindowDimensions();
  const sessionId = chatSessionStore.activeSessionId ?? NEW_CONVERSATION_KEY;
  const model = modelStore.activeModel;
  const isLocal = !!model && model.origin !== ModelOrigin.REMOTE;
  const activePalId = chatSessionStore.activePalId;
  const activePal = activePalId ? palStore.pals.find(pal => pal.id === activePalId) : undefined;
  const localPal = activePal?.type === 'local' ? activePal : undefined;
  const busy = modelStore.inferencing || modelStore.isContextLoading;
  const [visible, setVisible] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [prefs, setPrefs] = useState<ConversationPreferences>(defaultPreferences);
  const [palMemoryIsolation, setPalMemoryIsolation] = useState(false);
  const [context, setContext] = useState('');
  const [prompt, setPrompt] = useState('');
  const [thinking, setThinking] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [memoryPreview, setMemoryPreview] = useState('');
  const maximum = modelContextMaximum(model);
  const ceiling = contextCeiling(maximum, modelStore.activeContextSettings?.n_ctx);
  const thinkingSupported = isLocal && !!model?.thinkingStartTag && !!model?.thinkingEndTag;
  const blocked = busy || loading || saving;

  useEffect(() => {
    if (!visible) { return; }
    let cancelled = false;
    setLoading(true);
    setError('');
    setMemoryPreview('');
    setNote('');
    setContext(String(Math.min(modelStore.contextInitParams.n_ctx, ceiling)));
    setPrompt(model?.chatTemplate.systemPrompt ?? '');
    Promise.all([
      readPreferences(sessionId),
      localPal ? readPalMemoryIsolation(localPal.id) : Promise.resolve(false),
    ]).then(([value, isolated]) => {
      if (!cancelled) {
        setPrefs(value);
        setPalMemoryIsolation(isolated);
        setThinking(value.thinkingBudget === undefined ? '' : String(value.thinkingBudget));
      }
    }).catch(reason => {
      if (!cancelled) { setError(String(reason instanceof Error ? reason.message : reason)); }
    }).finally(() => {
      if (!cancelled) { setLoading(false); }
    });
    return () => { cancelled = true; };
  }, [visible, sessionId, model?.id, localPal?.id, ceiling, model?.chatTemplate.systemPrompt]);

  let estimatedBytes: number | undefined;
  const nCtx = Number(context);
  if (isLocal && model && Number.isSafeInteger(nCtx) && nCtx >= 200 && nCtx <= ceiling && model.ggufMetadata) {
    const projection = modelStore.models.find(item => item.id === modelStore.activeProjectionModelId);
    const draftId = model.defaultDraftModel ?? modelStore.contextInitParams.selectedDraftModelId;
    const draft = modelStore.contextInitParams.speculativeEnabled
      ? modelStore.models.find(item => item.id === draftId) : undefined;
    // Metadata does not describe which layers use sliding windows. Estimate
    // a full cache per layer rather than undercount hybrid attention models.
    const conservativeModel = {...model, ggufMetadata: {...model.ggufMetadata, sliding_window: undefined}};
    estimatedBytes = getModelMemoryRequirement(conservativeModel, projection, {
      ...modelStore.contextInitParams, n_ctx: nCtx,
      n_batch: Math.min(modelStore.contextInitParams.n_batch, nCtx),
      n_ubatch: Math.min(modelStore.contextInitParams.n_ubatch, modelStore.contextInitParams.n_batch, nCtx),
    }, draft);
  }

  const save = async () => {
    if (blocked) { return; }
    setSaving(true);
    setError('');
    try {
      const value = isLocal ? parseContextLimit(context, ceiling) : undefined;
      const budget = parseThinkingBudget(thinking);
      if (isLocal && prefs.useMemories && Math.min(value ?? 0, modelStore.activeContextSettings?.n_ctx ?? 0) < 2048) {
        throw new Error('Memories need at least 2048 loaded/configured context tokens. Reload with a larger context first.');
      }
      if (budget !== undefined && !thinkingSupported) {
        throw new Error('Clear the numeric thinking limit: this model does not expose compatible thinking tags.');
      }
      if (prompt.length > 32000) {
        throw new Error('The model system prompt is limited to 32000 characters.');
      }
      if (value !== undefined && budget !== undefined && budget > value - 32) {
        throw new Error('The thinking limit must leave room in the context for the answer.');
      }
      const targetId = model?.id;
      const targetPalId = localPal?.id;
      if (
        (chatSessionStore.activeSessionId ?? NEW_CONVERSATION_KEY) !== sessionId ||
        modelStore.activeModel?.id !== targetId ||
        chatSessionStore.activePalId !== activePalId
      ) {
        throw new Error('The active chat, Pal, or model changed. Settings were not modified.');
      }
      await savePreferences(sessionId, {...prefs, thinkingBudget: budget});
      if (targetPalId) {
        await savePalMemoryIsolation(targetPalId, palMemoryIsolation);
      }
      if (isLocal && model && value !== undefined) {
        modelStore.setNContext(value);
        runInAction(() => {
          model.chatTemplate = {...model.chatTemplate, systemPrompt: prompt};
        });
      }
      setVisible(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setSaving(false); }
  };

  const selectedMemoryScope = (): MemoryScope =>
    localPal && palMemoryIsolation ? palMemoryScope(localPal.id) : SHARED_MEMORY_SCOPE;

  const authorizeMemoryEditor = async () => {
    if (
      (chatSessionStore.activeSessionId ?? NEW_CONVERSATION_KEY) !== sessionId ||
      chatSessionStore.activePalId !== activePalId ||
      !(await readPreferences(sessionId)).useMemories ||
      modelStore.inferencing
    ) {
      throw new Error('Save memory consent first, then reopen this editor.');
    }
    if (localPal && (await readPalMemoryIsolation(localPal.id)) !== palMemoryIsolation) {
      throw new Error('Save this Pal\'s memory scope first, then reopen this editor.');
    }
  };

  const memoryAction = async (operation: 'preview' | 'note') => {
    if (blocked || !prefs.useMemories || !isLocal) { return; }
    setSaving(true);
    setError('');
    try {
      await authorizeMemoryEditor();
      const scope = selectedMemoryScope();
      const state = operation === 'note'
        ? await mobileMemory.update(
            memory => noteMemory(memory, note, sessionId),
            authorizeMemoryEditor,
            scope,
          )
        : await mobileMemory.read(scope);
      await authorizeMemoryEditor();
      const view = wakeMemory(state, 24);
      setMemoryPreview(view.nodes.map(node => `#${node.lo}-${node.hi}: ${node.text}`).join('\n') +
        (view.omittedNodes ? `\n${view.omittedNodes} older nodes omitted; use memo recall to retrieve them.` : '') || 'No saved memories.');
      if (operation === 'note') { setNote(''); }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setSaving(false); }
  };

  const eraseMemories = async () => {
    try {
      await authorizeMemoryEditor();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return;
    }
    const palScoped = selectedMemoryScope().kind === 'pal';
    Alert.alert(
      palScoped ? `Erase ${localPal?.name ?? 'this Pal'}'s memories?` : 'Erase shared memories?',
      palScoped
        ? 'This permanently deletes only this Pal\'s memory notes and summaries on this device. Other Pals and shared memories are untouched.'
        : 'This permanently deletes the shared memory notes and summaries on this device. Pal-scoped memories are untouched.',
      [
        {text: 'Cancel', style: 'cancel'},
        {text: 'Erase', style: 'destructive', onPress: () => {
          setSaving(true);
          mobileMemory.eraseAll(selectedMemoryScope()).then(() => setMemoryPreview('No saved memories.'))
            .catch(reason => setError(reason instanceof Error ? reason.message : String(reason)))
            .finally(() => setSaving(false));
        }},
      ],
    );
  };

  const memoryScopeText = localPal && palMemoryIsolation
    ? `${localPal.name} uses a separate on-device memory store. Across chats with this Pal, only memories previously saved for this Pal are loaded; shared memories and other Pals' memories are excluded.`
    : 'Memories use the shared on-device store across opted-in local chats. Turning memories off does not erase prior notes.';

  return (
    <View>
      <Button testID="conversation-options" disabled={busy || !model} onPress={() => setVisible(true)}>
        Conversation options
      </Button>
      {!!conversationRuntime.statuses[sessionId] && (
        <Text accessibilityLiveRegion="polite" variant="bodySmall" style={styles.status}>
          {conversationRuntime.statuses[sessionId]}
        </Text>
      )}
      <Portal>
        <Dialog visible={visible} onDismiss={() => { if (!saving) { setVisible(false); } }}>
          <Dialog.Title>Conversation and model settings</Dialog.Title>
          <Dialog.ScrollArea>
            <ScrollView keyboardShouldPersistTaps="handled" style={{maxHeight: height * 0.6}} contentContainerStyle={styles.content}>
              {!isLocal && <Text>These new controls currently support on-device text models only.</Text>}
              <View style={styles.row}>
                <Text style={styles.label}>Compact older text near the context limit</Text>
                <Switch accessibilityLabel="Automatic context compaction" disabled={blocked || !isLocal}
                  value={prefs.autoCompact} onValueChange={value => setPrefs({...prefs, autoCompact: value})} />
              </View>
              <Text variant="bodySmall">Summaries affect inference only. Original messages remain in the chat history.</Text>
              <View style={styles.row}>
                <Text style={styles.label}>Use local memories in this conversation</Text>
                <Switch accessibilityLabel="Use memories in this conversation" disabled={blocked || !isLocal}
                  value={prefs.useMemories} onValueChange={value => setPrefs({...prefs, useMemories: value})} />
              </View>
              <Text variant="bodySmall">Requires at least 2048 context tokens. Off means no memory reads or writes for this conversation.</Text>
              {localPal && (
                <>
                  <View style={styles.row}>
                    <Text style={styles.label}>Keep memories separate for {localPal.name}</Text>
                    <Switch accessibilityLabel={`Use separate memories for ${localPal.name}`} disabled={blocked || !isLocal}
                      value={palMemoryIsolation} onValueChange={setPalMemoryIsolation} />
                  </View>
                  <Text variant="bodySmall">This is a Pal-level setting and applies to every local chat that uses this Pal.</Text>
                </>
              )}
              <Text variant="bodySmall">{memoryScopeText}</Text>
              <TextInput label="Context limit (tokens)" value={context} keyboardType="number-pad"
                disabled={blocked || !isLocal} onChangeText={setContext} />
              <Text variant="bodySmall">{maximum
                ? `Model maximum: ${maximum} tokens.`
                : `Model maximum unknown. Conservative editor ceiling: ${ceiling}; load GGUF metadata to verify larger limits.`}</Text>
              <Text variant="bodySmall">{estimatedBytes !== undefined && Number.isFinite(estimatedBytes)
                ? `Estimated model memory: ${formatBytes(estimatedBytes, 1)}. Conservative full-cache projection, not a guarantee; actual sliding-window use, system buffers and embedded draft overhead can differ.`
                : 'Memory estimate unavailable: load a model with valid GGUF metadata.'}</Text>
              <Text variant="bodySmall">Loaded context: {modelStore.activeContextSettings?.n_ctx ?? 'unknown'}. Reload the model to change its native allocation. Until then, inference uses the smaller configured/loaded/model limit. This context setting is global.</Text>
              <TextInput label="Thinking limit per model step (tokens; blank = default)" value={thinking}
                keyboardType="number-pad" disabled={blocked || !isLocal} onChangeText={setThinking} />
              <Text variant="bodySmall">{thinkingSupported
                ? 'Uses the native thinking budget. Zero requests an immediate thinking close. The effective budget is clamped to leave room for an answer. It is per generation step, not per multi-tool run.'
                : 'No compatible thinking tags detected. Leave the numeric limit blank; the existing thinking on/off control remains separate.'}</Text>
              <TextInput label="Model system prompt" value={prompt} multiline numberOfLines={5} maxLength={32000}
                disabled={blocked || !isLocal} onChangeText={setPrompt} />
              <Text variant="bodySmall">Applies to this model across chats. A Pal's system prompt still takes precedence. Changes take effect on the next reply.</Text>
              <Button disabled={blocked || !prefs.useMemories || !isLocal} onPress={() => memoryAction('preview')}>View saved memories</Button>
              <Text selectable>{memoryPreview}</Text>
              <TextInput label="Add a memory (one line, 280 UTF-8 bytes)" value={note} onChangeText={setNote}
                disabled={blocked || !prefs.useMemories || !isLocal} />
              <Button disabled={blocked || !prefs.useMemories || !isLocal || !note.trim()} onPress={() => memoryAction('note')}>Save memory</Button>
              <Button disabled={blocked || !prefs.useMemories || !isLocal} onPress={eraseMemories}>
                {localPal && palMemoryIsolation ? `Erase ${localPal.name}'s memories` : 'Erase shared memories'}
              </Button>
              {!!error && <HelperText type="error" accessibilityLiveRegion="assertive">{error}</HelperText>}
            </ScrollView>
          </Dialog.ScrollArea>
          <Dialog.Actions>
            <Button disabled={saving} onPress={() => setVisible(false)}>Cancel</Button>
            <Button loading={saving || loading} disabled={blocked} onPress={save}>Save settings</Button>
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
