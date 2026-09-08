import AsyncStorage from '@react-native-async-storage/async-storage';
import {makeAutoObservable} from 'mobx';
import {makePersistable} from 'mobx-persist-store';

type ConversationFeatures = {
  memoriesEnabled: boolean;
};

export type PalMemorySnapshot = {
  sessionId: string;
  updatedAt: number;
  cover: string;
};

const MAX_PAL_MEMORY_SESSIONS = 16;

class ChatFeatureStore {
  conversationFeatures: Record<string, ConversationFeatures> = {};
  newChatMemoriesEnabled = false;
  modelSystemPrompts: Record<string, string> = {};
  palMemoriesEnabled: Record<string, boolean> = {};
  palMemorySnapshots: Record<string, PalMemorySnapshot[]> = {};

  constructor() {
    makeAutoObservable(this);
    makePersistable(this, {
      name: 'ChatFeatureStore',
      properties: [
        'conversationFeatures',
        'newChatMemoriesEnabled',
        'modelSystemPrompts',
        'palMemoriesEnabled',
        'palMemorySnapshots',
      ],
      storage: AsyncStorage,
    });
  }

  hasModelSystemPrompt(modelId: string): boolean {
    return Object.prototype.hasOwnProperty.call(
      this.modelSystemPrompts,
      modelId,
    );
  }

  getModelSystemPrompt(modelId?: string): string | undefined {
    if (!modelId || !this.hasModelSystemPrompt(modelId)) {
      return undefined;
    }
    return this.modelSystemPrompts[modelId];
  }

  setModelSystemPrompt(modelId: string, prompt: string): void {
    this.modelSystemPrompts = {...this.modelSystemPrompts, [modelId]: prompt};
  }

  clearModelSystemPrompt(modelId: string): void {
    if (!this.hasModelSystemPrompt(modelId)) {
      return;
    }
    const next = {...this.modelSystemPrompts};
    delete next[modelId];
    this.modelSystemPrompts = next;
  }

  getMemoriesEnabled(sessionId?: string): boolean {
    if (!sessionId) {
      return this.newChatMemoriesEnabled;
    }
    return (
      this.conversationFeatures[sessionId]?.memoriesEnabled ??
      this.newChatMemoriesEnabled
    );
  }

  setMemoriesEnabled(sessionId: string | undefined, enabled: boolean): void {
    if (!sessionId) {
      this.newChatMemoriesEnabled = enabled;
      return;
    }
    this.conversationFeatures = {
      ...this.conversationFeatures,
      [sessionId]: {memoriesEnabled: enabled},
    };
  }

  /**
   * When a staged new-chat preference gets its real session id, pin the choice
   * to that conversation and reset the next-chat default to off.
   */
  ensureConversationPreference(sessionId?: string): boolean {
    if (!sessionId) {
      return this.newChatMemoriesEnabled;
    }
    const existing = this.conversationFeatures[sessionId];
    if (existing) {
      return existing.memoriesEnabled;
    }
    const enabled = this.newChatMemoriesEnabled;
    this.conversationFeatures = {
      ...this.conversationFeatures,
      [sessionId]: {memoriesEnabled: enabled},
    };
    this.newChatMemoriesEnabled = false;
    return enabled;
  }

  getPalMemoriesEnabled(palId?: string): boolean {
    if (!palId) {
      return false;
    }
    return this.palMemoriesEnabled[palId] === true;
  }

  setPalMemoriesEnabled(palId: string, enabled: boolean): void {
    this.palMemoriesEnabled = {
      ...this.palMemoriesEnabled,
      [palId]: enabled,
    };
  }

  /**
   * Store one compact snapshot per conversation for a Pal. Re-running a turn
   * in the same conversation replaces that conversation's snapshot instead of
   * appending duplicate history. The newest bounded set is retained so Pal
   * memory cannot grow without limit in AsyncStorage.
   */
  upsertPalMemorySnapshot(
    palId: string,
    sessionId: string,
    cover: string,
  ): void {
    const normalizedCover = cover.trim();
    if (!palId || !sessionId || !normalizedCover) {
      return;
    }

    const previous = this.palMemorySnapshots[palId] ?? [];
    const withoutCurrentSession = previous.filter(
      snapshot => snapshot.sessionId !== sessionId,
    );
    const next = [
      ...withoutCurrentSession,
      {sessionId, updatedAt: Date.now(), cover: normalizedCover},
    ]
      .sort((left, right) => left.updatedAt - right.updatedAt)
      .slice(-MAX_PAL_MEMORY_SESSIONS);

    this.palMemorySnapshots = {
      ...this.palMemorySnapshots,
      [palId]: next,
    };
  }

  /**
   * Return only memories that belong to the requested Pal. The active session
   * is excluded so current-chat context never gets duplicated as Pal memory.
   */
  getPalMemorySnapshots(
    palId?: string,
    excludeSessionId?: string,
  ): PalMemorySnapshot[] {
    if (!palId) {
      return [];
    }
    return (this.palMemorySnapshots[palId] ?? []).filter(
      snapshot => snapshot.sessionId !== excludeSessionId,
    );
  }
}

export const chatFeatureStore = new ChatFeatureStore();
export {ChatFeatureStore};
