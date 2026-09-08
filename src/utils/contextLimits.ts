import type {Model} from './types';

const positiveFinite = (value: unknown): number | undefined => {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : undefined;
};

/** Prefer GGUF metadata parsed from the actual file; HF metadata is fallback. */
export const getModelMaxContext = (model?: Model | null): number | undefined =>
  positiveFinite(model?.ggufMetadata?.context_length) ??
  positiveFinite(model?.hfModel?.specs?.gguf?.context_length);

export const clampContextToModel = (
  requested: number,
  model?: Model | null,
  remoteContextLength?: number,
): number => {
  const maxContext =
    positiveFinite(remoteContextLength) ?? getModelMaxContext(model);
  const normalized = Math.max(1, Math.floor(requested));
  return maxContext ? Math.min(normalized, maxContext) : normalized;
};
