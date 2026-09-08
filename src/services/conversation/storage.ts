import AsyncStorage from '@react-native-async-storage/async-storage';
import {makeAutoObservable, runInAction} from 'mobx';
import {EMPTY_MEMORY, MemoryState, parseMemory} from './optmem';

export interface ConversationPreferences {
  version: 1;
  autoCompact: boolean;
  useMemories: boolean;
  thinkingBudget?: number;
}
export const defaultPreferences = (): ConversationPreferences => ({
  version: 1, autoCompact: true, useMemories: false,
});
export const NEW_CONVERSATION_KEY = '__new_conversation__';
const key = (sessionId: string) => `conversation_features_v1:${encodeURIComponent(sessionId)}`;
const SHARED_MEMORY_KEY = 'conversation_optmem_mobile_v1';
const PAL_MEMORY_PREFIX = 'conversation_optmem_mobile_v1:pal:';
const PAL_ISOLATION_PREFIX = 'conversation_optmem_pal_isolation_v1:';

export type MemoryScope =
  | {kind: 'shared'}
  | {kind: 'pal'; palId: string};
export const SHARED_MEMORY_SCOPE: MemoryScope = {kind: 'shared'};

function validatedPalId(palId: string): string {
  if (!palId || palId.length > 256) {
    throw new Error('A valid local Pal is required for Pal-scoped memories.');
  }
  return palId;
}

export function palMemoryScope(palId: string): MemoryScope {
  return {kind: 'pal', palId: validatedPalId(palId)};
}

function memoryKey(scope: MemoryScope): string {
  return scope.kind === 'shared'
    ? SHARED_MEMORY_KEY
    : PAL_MEMORY_PREFIX + encodeURIComponent(validatedPalId(scope.palId));
}

function palIsolationKey(palId: string): string {
  return PAL_ISOLATION_PREFIX + encodeURIComponent(validatedPalId(palId));
}

/** Pal isolation is an explicit per-Pal preference, independent of chat consent. */
export async function readPalMemoryIsolation(palId: string): Promise<boolean> {
  const raw = await AsyncStorage.getItem(palIsolationKey(palId));
  if (!raw) {
    return false;
  }
  try {
    return JSON.parse(raw) === true;
  } catch {
    throw new Error("This Pal\'s memory isolation setting could not be read.");
  }
}

export async function savePalMemoryIsolation(palId: string, enabled: boolean): Promise<void> {
  await AsyncStorage.setItem(palIsolationKey(palId), JSON.stringify(enabled === true));
}

export function normalizePreferences(value: unknown): ConversationPreferences {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  if (raw.version !== 1) {
    return defaultPreferences();
  }
  return {
    version: 1,
    autoCompact: raw.autoCompact !== false,
    // A truthy string is not privacy consent.
    useMemories: raw.useMemories === true,
    thinkingBudget: typeof raw.thinkingBudget === 'number' &&
      Number.isSafeInteger(raw.thinkingBudget) && raw.thinkingBudget >= 0 && raw.thinkingBudget <= 1000000
      ? raw.thinkingBudget : undefined,
  };
}

export async function readPreferences(sessionId: string): Promise<ConversationPreferences> {
  const raw = await AsyncStorage.getItem(key(sessionId));
  if (!raw) {
    return defaultPreferences();
  }
  // Don't silently overwrite corrupted settings (especially consent).
  try {
    return normalizePreferences(JSON.parse(raw));
  } catch {
    throw new Error('Conversation settings could not be read. No settings were changed.');
  }
}

export async function savePreferences(sessionId: string, prefs: ConversationPreferences): Promise<void> {
  if (!sessionId) {
    throw new Error('Create a conversation before changing its settings.');
  }
  await AsyncStorage.setItem(key(sessionId), JSON.stringify(normalizePreferences(prefs)));
}

/** Serialize read/modify/write operations per scope to prevent lost notes and erase races. */
export class MobileMemoryRepository {
  private queues = new Map<string, Promise<unknown>>();
  private serialize<T>(scope: MemoryScope, operation: () => Promise<T>): Promise<T> {
    const storageKey = memoryKey(scope);
    const queue = this.queues.get(storageKey) ?? Promise.resolve();
    const result = queue.then(operation, operation);
    const settled = result.then(() => undefined, () => undefined);
    this.queues.set(storageKey, settled);
    settled.finally(() => {
      if (this.queues.get(storageKey) === settled) {
        this.queues.delete(storageKey);
      }
    });
    return result;
  }
  private async load(scope: MemoryScope): Promise<MemoryState> {
    const raw = await AsyncStorage.getItem(memoryKey(scope));
    if (!raw) {
      return EMPTY_MEMORY();
    }
    if (raw.length > 12 * 1024 * 1024) {
      throw new Error('Memory storage exceeds the mobile safety limit.');
    }
    return parseMemory(JSON.parse(raw));
  }
  read(scope: MemoryScope = SHARED_MEMORY_SCOPE): Promise<MemoryState> {
    return this.serialize(scope, () => this.load(scope));
  }
  update(
    transform: (state: MemoryState) => MemoryState,
    authorize: () => Promise<void>,
    scope: MemoryScope = SHARED_MEMORY_SCOPE,
  ): Promise<MemoryState> {
    return this.serialize(scope, async () => {
      const current = await this.load(scope);
      await authorize();
      const next = transform(current);
      if (next !== current) {
        await AsyncStorage.setItem(memoryKey(scope), JSON.stringify(next));
      }
      return next;
    });
  }
  eraseAll(scope: MemoryScope = SHARED_MEMORY_SCOPE): Promise<void> {
    return this.serialize(scope, () => AsyncStorage.removeItem(memoryKey(scope)));
  }
}
export const mobileMemory = new MobileMemoryRepository();

class ConversationRuntimeStore {
  statuses: Record<string, string> = {};
  constructor() { makeAutoObservable(this); }
  setStatus(sessionId: string, message: string) {
    runInAction(() => { this.statuses[sessionId] = message; });
  }
}
export const conversationRuntime = new ConversationRuntimeStore();
