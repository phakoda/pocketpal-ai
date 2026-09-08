import {View} from 'react-native';
import React, {useEffect, useMemo, useState} from 'react';

import {observer} from 'mobx-react';
import {InputSlider} from '../InputSlider';
import {Button, Text, Switch, SegmentedButtons} from 'react-native-paper';

import {TextInput} from '..';

import {useTheme} from '../../hooks';

import {createStyles} from './styles';

import {L10nContext} from '../../utils';
import {
  COMPLETION_PARAMS_METADATA,
  validateNumericField,
} from '../../utils/modelSettings';
import {CompletionParams} from '../../utils/completionTypes';
import {chatSessionStore, modelStore, serverStore} from '../../store';
import {chatFeatureStore} from '../../store/ChatFeatureStore';
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

export const CompletionSettings: React.FC<Props> = observer(({
  settings,
  onChange,
  disabled = false,
}) => {
  const theme = useTheme();
  const styles = createStyles(theme);
  const l10n = React.useContext(L10nContext);

  const activeModel = modelStore.activeModel;
  const activeSessionId = chatSessionStore.activeSessionId || undefined;
  const remoteMaxContext = activeModel?.id
    ? serverStore.remoteCaps[activeModel.id]?.contextLength
    : undefined;
  const modelMaxContext = remoteMaxContext ?? getModelMaxContext(activeModel);

  const [contextLimit, setContextLimit] = useState(
    modelStore.contextInitParams.n_ctx.toString(),
  );
  const [memoriesEnabled, setMemoriesEnabled] = useState(
    chatFeatureStore.getMemoriesEnabled(activeSessionId),
  );
  const embeddedSystemPrompt = activeModel?.chatTemplate?.systemPrompt ?? '';
  const [systemPrompt, setSystemPrompt] = useState(
    activeModel?.id
      ? (chatFeatureStore.getModelSystemPrompt(activeModel.id) ??
          embeddedSystemPrompt)
      : '',
  );

  useEffect(() => {
    setContextLimit(modelStore.contextInitParams.n_ctx.toString());
  }, [modelStore.contextInitParams.n_ctx, activeModel?.id]);

  useEffect(() => {
    setMemoriesEnabled(chatFeatureStore.getMemoriesEnabled(activeSessionId));
  }, [activeSessionId]);

  useEffect(() => {
    if (!activeModel?.id) {
      setSystemPrompt('');
      return;
    }
    setSystemPrompt(
      chatFeatureStore.getModelSystemPrompt(activeModel.id) ??
        (activeModel.chatTemplate?.systemPrompt ?? ''),
    );
  }, [activeModel?.id]);

  const parsedContextLimit = Number.parseInt(contextLimit, 10);
  const contextLimitValid =
    Number.isFinite(parsedContextLimit) &&
    parsedContextLimit >= modelStore.MIN_CONTEXT_SIZE &&
    (!modelMaxContext || parsedContextLimit <= modelMaxContext);

  const estimatedMemory = useMemo(() => {
    if (!activeModel || !contextLimitValid || activeModel.size <= 0) {
      return undefined;
    }
    try {
      return getModelMemoryRequirement(activeModel, undefined, {
        ...modelStore.contextInitParams,
        n_ctx: parsedContextLimit,
      });
    } catch {
      return undefined;
    }
  }, [
    activeModel,
    contextLimitValid,
    parsedContextLimit,
    modelStore.contextInitParams,
  ]);

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
    if (activeModel?.id) {
      chatFeatureStore.setModelSystemPrompt(activeModel.id, prompt);
    }
  };

  const resetSystemPrompt = () => {
    if (!activeModel?.id) {
      return;
    }
    chatFeatureStore.clearModelSystemPrompt(activeModel.id);
    setSystemPrompt(activeModel.chatTemplate?.systemPrompt ?? '');
  };

  const renderSlider = ({name, step = 0.01}: {name: string; step?: number}) => (
    <View style={styles.settingItem}>
      <InputSlider
        testID={`${name}-slider`}
        label={name.toUpperCase().replace('_', ' ')}
        labelVariant="labelSmall"
        description={l10n.completionParams[name]}
        value={settings[name]}
        onValueChange={value => onChange(name, value)}
        min={COMPLETION_PARAMS_METADATA[name]?.validation.min}
        max={COMPLETION_PARAMS_METADATA[name]?.validation.max}
        step={step}
        precision={Number.isInteger(step) ? 0 : 2}
        debounceMs={300} // Enable debouncing for sliders
        disabled={disabled}
      />
    </View>
  );

  const renderIntegerInput = ({name}: {name: keyof CompletionParams}) => {
    const metadata = COMPLETION_PARAMS_METADATA[name];
    if (!metadata) {
      return null;
    }

    const value = settings[name]?.toString() ?? '';
    const validation = validateNumericField(value, metadata.validation);

    return (
      <View style={styles.settingItem}>
        <Text variant="labelSmall" style={styles.settingLabel}>
          {String(name).toUpperCase().replace('_', ' ')}
        </Text>
        <Text style={styles.description}>
          {l10n.completionParams[String(name)]}
        </Text>
        <TextInput
          value={value}
          onChangeText={
            disabled ? () => {} : _value => onChange(String(name), _value)
          }
          keyboardType="numeric"
          error={!validation.isValid}
          helperText={validation.errorMessage}
          editable={!disabled}
          testID={`${String(name)}-input`}
        />
      </View>
    );
  };

  const renderSwitch = (name: string) => {
    // Convert snake_case to UPPER CASE with spaces for display
    const displayName = name.toUpperCase().replace(/_/g, ' ');

    return (
      <View style={styles.settingItem}>
        <View style={styles.switchHeader}>
          <Text variant="labelSmall" style={styles.settingLabel}>
            {displayName}
          </Text>
          <Switch
            value={settings[name]}
            onValueChange={disabled ? () => {} : value => onChange(name, value)}
            disabled={disabled}
            testID={`${name}-switch`}
          />
        </View>
        <Text style={styles.description}>{l10n.completionParams[name]}</Text>
      </View>
    );
  };

  const renderMirostatSelector = () => {
    const description = l10n.completionParams.mirostat;

    return (
      <View style={styles.settingItem}>
        <Text style={styles.settingLabel}>Mirostat</Text>
        {description && <Text style={styles.description}>{description}</Text>}
        <SegmentedButtons
          value={(settings.mirostat ?? 0).toString()}
          onValueChange={
            disabled
              ? () => {} // No-op function when disabled
              : value => onChange('mirostat', parseInt(value, 10))
          }
          density="high"
          buttons={[
            {
              value: '0',
              label: 'Off',
            },
            {
              value: '1',
              label: 'v1',
            },
            {
              value: '2',
              label: 'v2',
            },
          ]}
          style={styles.segmentedButtons}
        />
      </View>
    );
  };

  const isUnlimited = settings.n_predict === -1;

  const renderNPredictField = () => {
    const metadata = COMPLETION_PARAMS_METADATA.n_predict;
    const value = settings.n_predict?.toString() ?? '';
    const validation = metadata
      ? validateNumericField(value, metadata.validation)
      : {isValid: true};

    return (
      <View style={styles.settingItem}>
        <Text variant="labelSmall" style={styles.settingLabel}>
          N PREDICT
        </Text>
        <Text style={styles.description}>
          {l10n.completionParams.n_predict}
        </Text>
        <SegmentedButtons
          value={isUnlimited ? 'unlimited' : 'custom'}
          onValueChange={
            disabled
              ? () => {}
              : selected =>
                  onChange('n_predict', selected === 'unlimited' ? -1 : 1024)
          }
          density="high"
          buttons={[
            {
              value: 'unlimited',
              label: 'Unlimited',
              testID: 'n_predict-unlimited-btn',
            },
            {
              value: 'custom',
              label: 'Custom',
              testID: 'n_predict-custom-btn',
            },
          ]}
          style={styles.segmentedButtons}
        />
        {!isUnlimited && (
          <TextInput
            value={value}
            onChangeText={
              disabled ? () => {} : _value => onChange('n_predict', _value)
            }
            keyboardType="numeric"
            error={!validation.isValid}
            helperText={validation.errorMessage}
            editable={!disabled}
            testID="n_predict-input"
          />
        )}
      </View>
    );
  };

  const renderThinkingBudget = () => {
    const budget = settings.thinking_budget_tokens ?? -1;
    const unlimited = budget < 0;
    const maximum = Math.max(
      64,
      Math.min(
        modelMaxContext ?? modelStore.contextInitParams.n_ctx,
        modelStore.contextInitParams.n_ctx,
      ),
    );

    return (
      <View style={styles.settingItem}>
        <Text variant="labelSmall" style={styles.settingLabel}>
          THINKING LIMIT
        </Text>
        <Text style={styles.description}>
          Maximum tokens the model may spend inside a reasoning block. Unlimited
          uses the model/runtime default.
        </Text>
        <SegmentedButtons
          value={unlimited ? 'unlimited' : 'custom'}
          onValueChange={
            disabled
              ? () => {}
              : value =>
                  onChange(
                    'thinking_budget_tokens',
                    value === 'unlimited' ? -1 : Math.min(1024, maximum),
                  )
          }
          density="high"
          buttons={[
            {value: 'unlimited', label: 'Unlimited'},
            {value: 'custom', label: 'Custom'},
          ]}
          style={styles.segmentedButtons}
        />
        {!unlimited && (
          <InputSlider
            testID="thinking-budget-slider"
            value={Math.min(Math.max(64, budget), maximum)}
            onValueChange={value =>
              onChange('thinking_budget_tokens', Math.round(value))
            }
            min={64}
            max={maximum}
            step={64}
            precision={0}
            disabled={disabled}
          />
        )}
      </View>
    );
  };

  const renderContextAndMemory = () => {
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
            editable={!!activeModel}
            multiline
            numberOfLines={5}
            testID="model-system-prompt-input"
          />
          <Button
            mode="text"
            onPress={resetSystemPrompt}
            disabled={!activeModel}
            testID="reset-model-system-prompt">
            Reset to model default
          </Button>
        </View>
      </>
    );
  };

  return (
    <View style={styles.container} testID="completion-settings">
      {renderContextAndMemory()}
      {renderNPredictField()}
      {renderThinkingBudget()}
      {renderSwitch('include_thinking_in_context')}
      {renderSlider({name: 'temperature'})}
      {renderSlider({name: 'top_k', step: 1})}
      {renderSlider({name: 'top_p'})}
      {renderSlider({name: 'min_p'})}
      {renderSlider({name: 'xtc_threshold'})}
      {renderSlider({name: 'xtc_probability'})}
      {renderSlider({name: 'typical_p'})}
      {renderSlider({name: 'penalty_last_n', step: 1})}
      {renderSlider({name: 'penalty_repeat'})}
      {renderSlider({name: 'penalty_freq'})}
      {renderSlider({name: 'penalty_present'})}
      {renderMirostatSelector()}
      {(settings.mirostat ?? 0) > 0 && (
        <>
          {renderSlider({name: 'mirostat_tau', step: 1})}
          {renderSlider({name: 'mirostat_eta'})}
        </>
      )}
      {renderIntegerInput({name: 'seed'})}
      {renderSwitch('jinja')}
    </View>
  );
});
