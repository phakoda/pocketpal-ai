/**
 * Clean-room mobile adaptation of OptMem's documented append-only log and
 * binary-summary commands. No upstream Python is bundled or executed.
 * See docs/conversation-features.md for compatibility differences.
 */
export interface MemoryNode {lo: number; hi: number; text: string;}
export interface MemoryEntry {text: string; createdAt: string; sourceSessionId: string;}
export interface MemoryState {version: 1; log: MemoryEntry[]; summaries: Record<string, string>;}
export const EMPTY_MEMORY = (): MemoryState => ({version: 1, log: [], summaries: {}});
export const MEMORY_ENTRY_BYTES = 280;
export const MAX_MEMORY_ENTRIES = 10000;

export function utf8Bytes(text: string): number {
  let size = 0;
  for (const character of text) {
    const code = character.codePointAt(0)!;
    size += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return size;
}

export function validateNote(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('A memory must be text.');
  }
  const text = value.trim();
  if (!text || /[\r\n\u0000-\u001f\u007f]/.test(text) || utf8Bytes(text) > MEMORY_ENTRY_BYTES) {
    throw new Error('A memory must be one non-empty line of at most 280 UTF-8 bytes.');
  }
  return text;
}

export function rangeKey(lo: number, hi: number): string {
  return `${lo}-${hi}`;
}

function assertRange(state: MemoryState, lo: number, hi: number): void {
  const size = hi - lo + 1;
  if (!Number.isSafeInteger(lo) || !Number.isSafeInteger(hi) || lo < 0 || hi >= state.log.length ||
      size < 1 || !Number.isInteger(Math.log2(size)) || lo % size !== 0) {
    throw new Error('Memory range must be an existing, aligned power-of-two range (inclusive endpoints).');
  }
}

export function parseMemory(value: unknown): MemoryState {
  if (!value || typeof value !== 'object') {
    throw new Error('Memory storage is invalid. It has not been overwritten.');
  }
  const raw = value as Partial<MemoryState>;
  if (raw.version !== 1 || !Array.isArray(raw.log) || raw.log.length > MAX_MEMORY_ENTRIES ||
      !raw.summaries || typeof raw.summaries !== 'object' || Array.isArray(raw.summaries)) {
    throw new Error('Memory storage version or shape is invalid. It has not been overwritten.');
  }
  const log = raw.log.map(entry => {
    if (!entry || typeof entry.createdAt !== 'string' || !Number.isFinite(Date.parse(entry.createdAt)) ||
        typeof entry.sourceSessionId !== 'string' || entry.sourceSessionId.length > 256) {
      throw new Error('A memory record is invalid.');
    }
    return {...entry, text: validateNote(entry.text)};
  });
  const state: MemoryState = {version: 1, log, summaries: {}};
  for (const [key, text] of Object.entries(raw.summaries)) {
    if (!/^\d+-\d+$/.test(key)) {
      throw new Error('A memory summary range is invalid.');
    }
    const [lo, hi] = key.split('-').map(Number);
    assertRange(state, lo, hi);
    if (lo === hi) {
      throw new Error('A summary cannot replace a raw memory.');
    }
    state.summaries[key] = validateNote(text);
  }
  return state;
}

export function noteMemory(state: MemoryState, text: unknown, sourceSessionId: string, now = new Date()): MemoryState {
  const note = validateNote(text);
  // Literal deduplication does not try to merge semantically different facts.
  if (state.log.some(entry => entry.text === note)) {
    return state;
  }
  if (state.log.length >= MAX_MEMORY_ENTRIES) {
    throw new Error('Mobile memory storage has reached 10000 notes. Erase memories in the editor to reset it.');
  }
  if (!sourceSessionId || sourceSessionId.length > 256) {
    throw new Error('A valid source conversation is required.');
  }
  return {...state, log: [...state.log, {text: note, createdAt: now.toISOString(), sourceSessionId}]};
}

function nodeText(state: MemoryState, lo: number, hi: number): string | undefined {
  return lo === hi ? state.log[lo]?.text : state.summaries[rangeKey(lo, hi)];
}

/** Return one due merge with both halves available, smallest ranges first. */
export function pendingMerge(state: MemoryState): {lo: number; hi: number; children: MemoryNode[]} | undefined {
  for (let size = 2; size <= state.log.length; size *= 2) {
    for (let lo = 0; lo + size <= state.log.length; lo += size) {
      const hi = lo + size - 1;
      if (state.summaries[rangeKey(lo, hi)] !== undefined) {
        continue;
      }
      const mid = lo + size / 2;
      const left = nodeText(state, lo, mid - 1);
      const right = nodeText(state, mid, hi);
      if (left !== undefined && right !== undefined) {
        return {lo, hi, children: [{lo, hi: mid - 1, text: left}, {lo: mid, hi, text: right}]};
      }
    }
  }
  return undefined;
}

export function mergeMemory(state: MemoryState, lo: number, hi: number, text: unknown): MemoryState {
  assertRange(state, lo, hi);
  const pending = pendingMerge(state);
  if (!pending || pending.lo !== lo || pending.hi !== hi) {
    throw new Error('This is not the next pending merge. Read nap again.');
  }
  return {...state, summaries: {...state.summaries, [rangeKey(lo, hi)]: validateNote(text)}};
}

/** OptMem forget means invalidate a summary, not delete a raw note. */
export function forgetSummary(state: MemoryState, lo: number, hi: number): MemoryState {
  assertRange(state, lo, hi);
  if (lo === hi) {
    throw new Error('forget invalidates summaries only. Erase memories in the editor to delete personal data.');
  }
  const summaries = {...state.summaries};
  // Invalidate ancestors too, otherwise wake could still present the bad fact.
  for (const key of Object.keys(summaries)) {
    const [start, end] = key.split('-').map(Number);
    if (start <= lo && end >= hi) {
      delete summaries[key];
    }
  }
  return {...state, summaries};
}

export function zoomMemory(state: MemoryState, lo: number, hi: number): MemoryNode[] {
  assertRange(state, lo, hi);
  if (lo === hi) {
    return [{lo, hi, text: state.log[lo].text}];
  }
  const mid = lo + (hi - lo + 1) / 2;
  return [[lo, mid - 1], [mid, hi]].map(([start, end]) => ({
    lo: start, hi: end,
    text: nodeText(state, start, end) ?? '[Summary pending; zoom this range again to read its children.]',
  }));
}

/** Bounded literal recall deliberately avoids evaluating model-supplied regex. */
export function recallMemory(state: MemoryState, query: string, offset = 0, count = 12): {nodes: MemoryNode[]; nextOffset?: number} {
  if (!query.trim() || query.length > 280 || !Number.isSafeInteger(offset) || offset < 0 ||
      !Number.isSafeInteger(count) || count < 1 || count > 96) {
    throw new Error('Recall needs a non-empty literal query and a valid page offset/count.');
  }
  const matches = state.log.flatMap((entry, i) =>
    entry.text.toLocaleLowerCase().includes(query.toLocaleLowerCase()) ? [{lo: i, hi: i, text: entry.text}] : [],
  );
  return {
    nodes: matches.slice(offset, offset + count),
    nextOffset: offset + count < matches.length ? offset + count : undefined,
  };
}

/**
 * Cover all notes with available tree nodes, then expand the most recent
 * ranges while the reading budget allows. Missing summaries never silently
 * erase notes: omitted nodes are counted and remain available to recall/zoom.
 */
export function wakeMemory(state: MemoryState, lines = 12): {nodes: MemoryNode[]; omittedNodes: number} {
  if (!Number.isSafeInteger(lines) || lines < 1 || lines > 96) {
    throw new Error('Wake budget must be between 1 and 96 lines.');
  }
  const nodes: MemoryNode[] = [];
  let lo = 0;
  while (lo < state.log.length) {
    let size = 1;
    for (let next = 2; lo % next === 0 && lo + next <= state.log.length; next *= 2) {
      if (state.summaries[rangeKey(lo, lo + next - 1)] !== undefined) {
        size = next;
      }
    }
    nodes.push({lo, hi: lo + size - 1, text: nodeText(state, lo, lo + size - 1)!});
    lo += size;
  }
  while (nodes.length < lines) {
    let index = nodes.length - 1;
    while (index >= 0 && nodes[index].lo === nodes[index].hi) {
      index -= 1;
    }
    if (index < 0) {
      break;
    }
    const parent = nodes[index];
    const children = zoomMemory(state, parent.lo, parent.hi);
    nodes.splice(index, 1, ...children);
  }
  return {nodes: nodes.slice(-lines), omittedNodes: Math.max(0, nodes.length - lines)};
}
