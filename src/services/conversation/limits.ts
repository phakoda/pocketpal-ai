/** Pure policies shared by the editor and the inference adapter. */
export const MIN_CONTEXT_TOKENS = 200;
export const UNKNOWN_CONTEXT_CEILING = 4096;

function positiveInteger(value: unknown): number | undefined {
  const n = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0
    ? n
    : undefined;
}

export function modelContextMaximum(model?: {
  ggufMetadata?: {context_length?: unknown};
  hfModel?: {specs?: {gguf?: {context_length?: unknown}}};
} | null): number | undefined {
  // The actual file wins over repository-wide metadata (which can describe
  // another variant). Never infer a model's context from its name.
  return positiveInteger(model?.ggufMetadata?.context_length) ??
    positiveInteger(model?.hfModel?.specs?.gguf?.context_length);
}

export function contextCeiling(
  maximum: number | undefined,
  loaded?: number,
): number {
  return positiveInteger(maximum) ?? positiveInteger(loaded) ?? UNKNOWN_CONTEXT_CEILING;
}

export function parseContextLimit(text: string, maximum: number): number {
  if (!/^\d+$/.test(text.trim())) {
    throw new Error('Context limit must be a whole number.');
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < MIN_CONTEXT_TOKENS || value > maximum) {
    throw new Error(`Context limit must be between ${MIN_CONTEXT_TOKENS} and ${maximum} tokens.`);
  }
  return value;
}

export function effectiveContextLimit(
  requested: number | undefined,
  loaded: number,
  maximum?: number,
): number {
  if (!positiveInteger(loaded) || loaded < MIN_CONTEXT_TOKENS) {
    throw new Error('The loaded context size is unavailable. Reload the model.');
  }
  const cap = Math.min(loaded, positiveInteger(maximum) ?? loaded);
  const result = Math.min(positiveInteger(requested) ?? cap, cap);
  if (result < MIN_CONTEXT_TOKENS) {
    throw new Error('The model context is too small for this feature.');
  }
  return result;
}

export function parseThinkingBudget(text: string): number | undefined {
  if (!text.trim()) {
    return undefined;
  }
  if (!/^\d+$/.test(text.trim())) {
    throw new Error('Thinking limit must be a non-negative whole number, or blank.');
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value > 1_000_000) {
    throw new Error('Thinking limit must be at most 1000000 tokens.');
  }
  return value;
}

/** Leave room for an answer and control tokens, including a forced think close. */
export function outputReserve(limit: number, nPredict?: number): number {
  const preferred = typeof nPredict === 'number' && Number.isFinite(nPredict) && nPredict > 0
    ? Math.floor(nPredict)
    : 1024;
  return Math.max(16, Math.min(preferred, Math.floor(limit / 4)));
}

/** Keep a meaningful amount of the output budget for the visible answer. */
export function boundedThinkingBudget(requested: number, outputTokens: number): number {
  if (!Number.isSafeInteger(requested) || requested < 0) {
    throw new Error('Invalid thinking budget.');
  }
  return Math.min(requested, Math.max(0, outputTokens - Math.min(128, Math.floor(outputTokens / 3))));
}
