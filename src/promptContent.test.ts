import { describe, expect, it } from 'vitest';
import { assertMixedPrompt, combinePromptParts } from '@/promptContent';

describe('mixed prompt content', () => {
  it('preserves both parts without inventing a description for legacy tags', () => {
    expect(combinePromptParts(' 1girl, black hair ', 'She reads beside the window.')).toBe('1girl, black hair\nShe reads beside the window.');
    expect(combinePromptParts('1girl')).toBe('1girl');
    expect(combinePromptParts('same', 'same')).toBe('same');
  });
  it.each(['', '1girl, black hair, smiling', '她在窗边微笑。'])('rejects missing English prose %j', nl => {
    expect(() => assertMixedPrompt({ tag: '1girl', nl })).toThrow('完整英文自然语言');
  });
  it('requires prose for each native character prompt while allowing original names', () => {
    const base = { tag: '1girl, room', nl: 'One girl stands in a quiet room.' };
    expect(() => assertMixedPrompt({ ...base, characters: [{ name: '小雪', tag: 'girl, black hair', nl: '' }] })).toThrow('小雪');
    expect(() => assertMixedPrompt({ ...base, characters: [{ name: '小雪', tag: 'girl, black hair', nl: '小雪 smiles softly as she leans against the wall.' }] })).not.toThrow();
  });
});
