/**
 * Clean-room memory cover inspired by the public OptMem design:
 * append-only conversation records are folded into equal-sized binary blocks,
 * so older context is summarized more aggressively while recent turns stay
 * detailed. No OptMem source code is copied here.
 */

export type MemoryMessage = {
  role: string;
  content?: unknown;
};

type MemoryBlock = {
  start: number;
  end: number;
  size: number;
  text: string;
};

const MEMORY_LINE_CHARS = 280;

const normalizeWhitespace = (value: string): string =>
  value.replace(/\s+/g, ' ').trim();

export const contentToText = (content: unknown): string => {
  if (typeof content === 'string') {
    return normalizeWhitespace(content);
  }
  if (Array.isArray(content)) {
    return normalizeWhitespace(
      content
        .map(part => {
          if (typeof part === 'string') {
            return part;
          }
          if (part && typeof part === 'object' && 'text' in part) {
            const text = (part as {text?: unknown}).text;
            return typeof text === 'string' ? text : '';
          }
          return '';
        })
        .filter(Boolean)
        .join(' '),
    );
  }
  if (content == null) {
    return '';
  }
  try {
    return normalizeWhitespace(JSON.stringify(content));
  } catch {
    return '';
  }
};

const compactLine = (value: string, maxChars = MEMORY_LINE_CHARS): string => {
  const text = normalizeWhitespace(value);
  if (text.length <= maxChars) {
    return text;
  }
  if (maxChars < 24) {
    return text.slice(0, Math.max(0, maxChars));
  }
  const head = Math.ceil((maxChars - 3) * 0.62);
  const tail = maxChars - 3 - head;
  return `${text.slice(0, head)}...${text.slice(-tail)}`;
};

const messageToBlock = (message: MemoryMessage, index: number): MemoryBlock => {
  const role = message.role === 'assistant' ? 'assistant' : 'user';
  return {
    start: index,
    end: index,
    size: 1,
    text: compactLine(`${role}: ${contentToText(message.content)}`),
  };
};

const mergeBlocks = (left: MemoryBlock, right: MemoryBlock): MemoryBlock => ({
  start: left.start,
  end: right.end,
  size: left.size + right.size,
  text: compactLine(`${left.text} | ${right.text}`),
});

/**
 * Build a bounded OptMem-style cover. The oldest equal-sized adjacent blocks
 * are merged first, which yields binary-decay detail: the newest memories stay
 * one-record blocks while old material collapses into progressively larger
 * summaries.
 */
export const buildOptMemCover = (
  messages: MemoryMessage[],
  maxLines = 16,
): string => {
  const usable = messages
    .filter(message => message.role === 'user' || message.role === 'assistant')
    .filter(message => contentToText(message.content).length > 0);

  if (usable.length === 0 || maxLines <= 0) {
    return '';
  }

  const blocks = usable.map(messageToBlock);
  const boundedLines = Math.max(1, Math.floor(maxLines));

  while (blocks.length > boundedLines) {
    let mergeAt = -1;
    for (let i = 0; i < blocks.length - 1; i += 1) {
      if (blocks[i].size === blocks[i + 1].size) {
        mergeAt = i;
        break;
      }
    }
    if (mergeAt < 0) {
      mergeAt = 0;
    }
    blocks.splice(
      mergeAt,
      2,
      mergeBlocks(blocks[mergeAt], blocks[mergeAt + 1]),
    );
  }

  return blocks
    .map(block => {
      const range =
        block.start === block.end
          ? `#${block.start + 1}`
          : `#${block.start + 1}-${block.end + 1}`;
      return `${range} ${block.text}`;
    })
    .join('\n');
};
