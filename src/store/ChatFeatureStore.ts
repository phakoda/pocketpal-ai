import AsyncStorage from '@react-native-async-storage/async-storage';
import {makeAutoObservable} from 'mobx';
import {makePersistable} from 'mobx-persist-store';

type ConversationFeatures = {
  memoriesEnabled: boolean;
};

class ChatFeatureStore {
  conversationFeatures: Record<string, ConversationFeatures> = {};
  newChatMemoriesEnabled = false;
  modelSystemPrompts: Record<string, string> = {};

  constructor() {
    makeAutoObservable(this);
    makePersistable(this, {
      name: 'ChatFeatureStore',
      properties: [
        'conversationFeatures',
        'newChatMemoriesEnabled',
        'modelSystemPrompts',
      ],
      storage: AsyncStorage,
    });
  }

  hasModelSystemPrompt(modelId: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.modelSystemPrompts, modelId);
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
}

export const chatFeatureStore = new ChatFeatureStore();
export {ChatFeatureStore};
