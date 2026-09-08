import {buildOptMemCover, type MemoryMessage} from './optMem';

export type PalMemorySnapshot = {
  sessionId: string;
  updatedAt: number;
  content: string;
};

export const MAX_PAL_MEMORY_SNAPSHOTS = 24;
const MAX_PAL_SNAPSHOT_CHARS = 6000;

/**
 * Upsert one compact per-chat snapshot in a Pal's private archive. The archive
 * is bounded and newest-first on eviction so persistent storage cannot grow
 * without limit.
 */
export const upsertPalMemorySnapshot = (
  snapshots: PalMemorySnapshot[],
  snapshot: PalMemorySnapshot,
  maxSnapshots = MAX_PAL_MEMORY_SNAPSHOTS,
): PalMemorySnapshot[] => {
  const content = snapshot.content.trim().slice(0, MAX_PAL_SNAPSHOT_CHARS);
  if (!snapshot.sessionId || !content) {
    return snapshots;
  }

  const next = [
    ...snapshots.filter(item => item.sessionId !== snapshot.sessionId),
    {...snapshot, content},
  ].sort((a, b) => a.updatedAt - b.updatedAt);

  return next.slice(-Math.max(1, Math.floor(maxSnapshots)));
};

/**
 * Build the prompt-facing cover from prior chat snapshots for exactly one Pal.
 * Callers are responsible for selecting the Pal-specific archive first; this
 * helper deliberately has no cross-Pal lookup surface.
 */
export const buildPalMemoryCover = (
  snapshots: PalMemorySnapshot[],
  maxLines: number,
): string => {
  const messages: MemoryMessage[] = snapshots
    .slice()
    .sort((a, b) => a.updatedAt - b.updatedAt)
    .map(snapshot => ({
      role: 'user',
      content: `Prior chat memory: ${snapshot.content}`,
    }));

  return buildOptMemCover(messages, maxLines);
};
