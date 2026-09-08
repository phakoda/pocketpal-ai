import React, {useEffect, useState} from 'react';
import {View} from 'react-native';
import {Button, SegmentedButtons, Switch, Text} from 'react-native-paper';

import {InputSlider} from '../InputSlider';
import {TextInput} from '../TextInput';
import {createStyles} from '../CompletionSettings/styles';
import {useTheme} from '../../hooks';
import {chatSessionStore, modelStore, serverStore} from '../../store';
import {chatFeatureStore} from '../../store/ChatFeatureStore';
import {CompletionParams} from '../../utils/completionTypes';
import {getModelMaxContext} from '../../utils/contextLimits';
import {getModelMemoryRequirement} from '../../utils/memoryEstimator';

interface Props {
  settings: CompletionParams;
  onChange: (name: string, value: any) => void;
  disabled?: boolean;
}

const formatMemory = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return 'Unavailable';
  }
  const gib = bytes / (1024 * 1024 * 1024);
  if (gib >= 1) {
    return `${gib.toFixed(gib >= 10 ? 1 : 2)} GiB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(0)} MiB`;
};

export const ChatContextSettings: React.FC<Props> = ({
  settings,
  onChange,
  disabled = false,
}) => {
  const theme = useTheme();
  const styles = createStyles(theme);
  const activeModel = modelStore.activeModel;
  const activeModelId = activeModel?.id;
  const activeSessionId = chatSessionStore.activeSessionId || undefined;
  const currentContextLimit = modelStore.contextInitParams.n_ctx;
  const embeddedSystemPrompt = activeModel?.chatTemplate?.systemPrompt ?? '';
  const remoteMaxContext = activeModelId
    ? serverStore.remoteCaps[activeModelId]?.contextLength
    : undefined;
  const modelMaxContext = remoteMaxContext ?? getModelMaxContext(activeModel);

  const [contextLimit, setContextLimit] = useState(
    currentContextLimit.toString(),
  );
  const [memoriesEnabled, setMemoriesEnabled] = useState(
    chatFeatureStore.getMemoriesEnabled(activeSessionId),
  );
  const [systemPrompt, setSystemPrompt] = useState(
    activeModelId
      ? (chatFeatureStore.getModelSystemPrompt(activeModelId) ??
          embeddedSystemPrompt)
      : '',
  );

  useEffect(() => {
    setContextLimit(currentContextLimit.toString());
  }, [activeModelId, currentContextLimit]);

  useEffect(() => {
    setMemoriesEnabled(chatFeatureStore.getMemoriesEnabled(activeSessionId));
  }, [activeSessionId]);

  useEffect(() => {
    if (!activeModelId) {
      setSystemPrompt('');
      return;
    }
    setSystemPrompt(
      chatFeatureStore.getModelSystemPrompt(activeModelId) ??
        embeddedSystemPrompt,
    );
  }, [activeModelId, embeddedSystemPrompt]);

  const parsedContextLimit = Number.parseInt(contextLimit, 10);
  const contextLimitValid =
    Number.isFinite(parsedContextLimit) &&
    parsedContextLimit >= modelStore.MIN_CONTEXT_SIZE &&
    (!modelMaxContext || parsedContextLimit <= modelMaxContext);

  let estimatedMemory: number | undefined;
  if (activeModel && contextLimitValid && activeModel.size > 0) {
    try {
      estimatedMemory = getModelMemoryRequirement(activeModel, undefined, {
        ...modelStore.contextInitParams,
        n_ctx: parsedContextLimit,
      });
    } catch {
      estimatedMemory = undefined;
    }
  }

  const applyContextLimit = () => {
    if (contextLimitValid) {
      modelStore.setNContext(parsedContextLimit);
    }
  };

  const updateMemories = (enabled: boolean) => {
    setMemoriesEnabled(enabled);
    chatFeatureStore.setMemoriesEnabled(activeSessionId, enabled);
  };

  const updateSystemPrompt = (prompt: string) => {
    setSystemPrompt(prompt);
    if (activeModelId) {
      chatFeatureStore.setModelSystemPrompt(activeModelId, prompt);
    }
  };

  const resetSystemPrompt = () => {
    if (!activeModelId) {
      return;
    }
    chatFeatureStore.clearModelSystemPrompt(activeModelId);
    setSystemPrompt(embeddedSystemPrompt);
  };

  const thinkingBudget = settings.thinking_budget_tokens ?? -1;
  const thinkingUnlimited = thinkingBudget < 0;
  const thinkingMaximum = Math.max(
    64,
    Math.min(modelMaxContext ?? currentContextLimit, currentContextLimit),
  );

  const contextHelper = !contextLimitValid
    ? modelMaxContext
      ? `Enter ${modelStore.MIN_CONTEXT_SIZE.toLocaleString()}–${modelMaxContext.toLocaleString()} tokens for this model.`
      : `Enter at least ${modelStore.MIN_CONTEXT_SIZE.toLocaleString()} tokens.`
    : modelMaxContext
      ? `Model maximum: ${modelMaxContext.toLocaleString()} tokens. Takes effect after the model reloads.`
      : 'Model maximum is not reported. Takes effect after the model reloads.';

  return (
    <>
      <View style={styles.settingItem}>
        <Text variant="labelSmall" style={styles.settingLabel}>
          CONTEXT LIMIT
        </Text>
        <Text style={styles.description}>
          Controls the model context allocation. The limit is capped by the
          active model's reported maximum when that metadata is available.
        </Text>
        <TextInput
          value={contextLimit}
          onChangeText={setContextLimit}
          onBlur={applyContextLimit}
          keyboardType="numeric"
          error={!contextLimitValid}
          helperText={contextHelper}
          editable={!disabled}
          testID="generation-context-limit-input"
        />
        <Text style={styles.description}>
          Estimated model + KV memory at this limit:{' '}
          {estimatedMemory === undefined
            ? 'unavailable for this model'
            : formatMemory(estimatedMemory)}
        </Text>
      </View>

      <View style={styles.settingItem}>
        <View style={styles.switchHeader}>
          <Text variant="labelSmall" style={styles.settingLabel}>
            CONVERSATION MEMORIES
          </Text>
          <Switch
            value={memoriesEnabled}
            onValueChange={updateMemories}
            disabled={disabled}
            testID="conversation-memories-switch"
          />
        </View>
        <Text style={styles.description}>
          Keep recent turns verbatim while folding older turns into a compact,
          OptMem-inspired binary memory cover. This toggle is stored per
          conversation.
        </Text>
      </View>

      <View style={styles.settingItem}>
        <Text variant="labelSmall" style={styles.settingLabel}>
          MODEL SYSTEM PROMPT
        </Text>
        <Text style={styles.description}>
          Edit the system prompt used by this model. Pal system prompts keep
          higher priority. An empty value intentionally disables the model
          prompt.
        </Text>
        <TextInput
          value={systemPrompt}
          onChangeText={updateSystemPrompt}
          editable={!disabled && !!activeModelId}
          multiline
          numberOfLines={5}
          testID="model-system-prompt-input"
        />
        <Button
          mode="text"
          onPress={resetSystemPrompt}
          disabled={disabled || !activeModelId}
          testID="reset-model-system-prompt">
          Reset to model default
        </Button>
      </View>

      <View style={styles.settingItem}>
        <Text variant="labelSmall" style={styles.settingLabel}>
          THINKING LIMIT
        </Text>
        <Text style={styles.description}>
          Maximum tokens the model may spend inside a reasoning block. Unlimited
          uses the model/runtime default.
        </Text>
        <SegmentedButtons
          value={thinkingUnlimited ? 'unlimited' : 'custom'}
          onValueChange={
            disabled
              ? () => {}
              : value =>
                  onChange(
                    'thinking_budget_tokens',
                    value === 'unlimited'
                      ? -1
                      : Math.min(1024, thinkingMaximum),
                  )
          }
          density="high"
          buttons={[
            {value: 'unlimited', label: 'Unlimited'},
            {value: 'custom', label: 'Custom'},
          ]}
          style={styles.segmentedButtons}
        />
        {!thinkingUnlimited && (
          <InputSlider
            testID="thinking-budget-slider"
            value={Math.min(Math.max(64, thinkingBudget), thinkingMaximum)}
            onValueChange={value =>
              onChange('thinking_budget_tokens', Math.round(value))
            }
            min={64}
            max={thinkingMaximum}
            step={64}
            precision={0}
            debounceMs={300}
            disabled={disabled}
          />
        )}
      </View>
    </>
  );
};
