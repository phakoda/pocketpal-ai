import {
  buildExtractiveCompactionSummary,
  compactConversationForContext,
} from '../contextCompaction';

describe('contextCompaction', () => {
  it('does not compact a prompt that is below the trigger threshold', () => {
    const messages = [
      {role: 'user', content: 'hello'},
      {role: 'assistant', content: 'hi'},
    ];

    const result = compactConversationForContext(messages, 4096, 50);

    expect(result.compacted).toBe(false);
    expect(result.messages).toBe(messages);
  });

  it('prunes oldest turns while retaining the newest prompt window', () => {
    const messages = Array.from({length: 12}, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `turn ${index + 1} ${'x'.repeat(900)}`,
    }));

    const result = compactConversationForContext(messages, 2048, 50);

    expect(result.compacted).toBe(true);
    expect(result.prunedMessages.length).toBeGreaterThan(0);
    expect(result.messages.length).toBeGreaterThanOrEqual(4);
    expect(result.messages.at(-1)?.content).toContain('turn 12');
    expect(result.estimatedTokensAfter).toBeLessThan(
      result.estimatedTokensBefore,
    );
  });

  it('bounds extractive summaries', () => {
    const summary = buildExtractiveCompactionSummary(
      [{role: 'user', content: 'x'.repeat(4000)}],
      100,
    );

    expect(summary.length).toBeLessThanOrEqual(400);
  });
});
