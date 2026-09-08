import {ChatFeatureStore} from '../ChatFeatureStore';

describe('ChatFeatureStore Pal memories', () => {
  let store: ChatFeatureStore;

  beforeEach(() => {
    store = new ChatFeatureStore();
  });

  it('stores the Pal memory toggle independently for each Pal', () => {
    store.setPalMemoriesEnabled('pal-a', true);

    expect(store.getPalMemoriesEnabled('pal-a')).toBe(true);
    expect(store.getPalMemoriesEnabled('pal-b')).toBe(false);
    expect(store.getPalMemoriesEnabled()).toBe(false);
  });

  it('returns only snapshots belonging to the requested Pal and excludes the active session', () => {
    store.upsertPalMemorySnapshot('pal-a', 'session-a1', 'A one');
    store.upsertPalMemorySnapshot('pal-a', 'session-a2', 'A two');
    store.upsertPalMemorySnapshot('pal-b', 'session-b1', 'B one');

    expect(store.getPalMemorySnapshots('pal-a', 'session-a2')).toEqual([
      expect.objectContaining({sessionId: 'session-a1', cover: 'A one'}),
    ]);
    expect(store.getPalMemorySnapshots('pal-b')).toEqual([
      expect.objectContaining({sessionId: 'session-b1', cover: 'B one'}),
    ]);
  });

  it('replaces the compact snapshot for an existing conversation instead of duplicating it', () => {
    store.upsertPalMemorySnapshot('pal-a', 'session-a1', 'old cover');
    store.upsertPalMemorySnapshot('pal-a', 'session-a1', 'new cover');

    expect(store.getPalMemorySnapshots('pal-a')).toHaveLength(1);
    expect(store.getPalMemorySnapshots('pal-a')[0]).toEqual(
      expect.objectContaining({sessionId: 'session-a1', cover: 'new cover'}),
    );
  });

  it('bounds each Pal archive to the newest sixteen conversations', () => {
    for (let index = 0; index < 20; index += 1) {
      store.upsertPalMemorySnapshot(
        'pal-a',
        `session-${index}`,
        `cover ${index}`,
      );
    }

    const snapshots = store.getPalMemorySnapshots('pal-a');
    expect(snapshots).toHaveLength(16);
    expect(snapshots.some(snapshot => snapshot.sessionId === 'session-0')).toBe(
      false,
    );
    expect(
      snapshots.some(snapshot => snapshot.sessionId === 'session-19'),
    ).toBe(true);
  });
});
