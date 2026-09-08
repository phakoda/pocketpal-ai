import {buildOptMemCover} from '../optMem';

describe('buildOptMemCover', () => {
  it('keeps recent memories detailed while merging older equal-size blocks', () => {
    const messages = Array.from({length: 12}, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `turn ${index + 1}`,
    }));

    const cover = buildOptMemCover(messages, 4);
    const lines = cover.split('\n');

    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain('#1-8');
    expect(lines[2]).toContain('#11 user: turn 11');
    expect(lines[3]).toContain('#12 assistant: turn 12');
  });

  it('returns an empty cover when there is no conversational text', () => {
    expect(buildOptMemCover([{role: 'tool', content: 'ignored'}])).toBe('');
  });
});
