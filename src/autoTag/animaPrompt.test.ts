import { describe, expect, it } from 'vitest';
import { ANIMA_EXAMPLES, animaVisualContract } from './animaPrompt';
import { assertExplicitAppearance, EXPLICIT_APPEARANCE_RETRY_INSTRUCTION } from './facialDetail';
import { assertMixedPrompt, combinePromptParts } from '@/promptContent';
import { parseImagePlan } from './protocol';
import { buildLibraryText } from './charAnchors';
import { emptyCharFields, type CharTagEntry } from '@/state/charTags';

describe('Anima shot-dependent output compatibility', () => {
  it.each(Object.entries(ANIMA_EXAMPLES))('accepts and preserves the neutral %s example without enforcing facial field counts', (_name, content) => {
    const raw = JSON.stringify({ images: [{ position: 'P1', ...content, size: 'portrait' }], changes: [] });
    const image = parseImagePlan(raw, [{ id: 'P1', sourceLine: 0, text: '一幅普通人物插画。' }], 1, 1, 'anima').images[0];
    expect(image.tag).toBe(content.tag);
    expect(image.nl).toBe(content.nl);
    expect(() => assertMixedPrompt(image)).not.toThrow();
    expect(() => assertExplicitAppearance(image)).not.toThrow();
    expect(combinePromptParts(image.tag, image.nl)).toBe(content.tag + '\n' + content.nl);
  });

  it('keeps every stored profile field available without changing the entry or its history', () => {
    const entry: CharTagEntry = {
      name: '画家', source: 'manual', raw: '', desc: '', nl: 'An adult artist.', history: [],
      fields: { ...emptyCharFields(), hair: 'silver hair', face: 'angular face', eyebrows: 'straight eyebrows',
        eyeShape: 'narrow eyes', eyes: 'red eyes', nose: 'convex nose bridge', mouth: 'thin lips', extra: 'scar on left cheek' },
    };
    const before = JSON.stringify(entry);
    const library = buildLibraryText([entry], new Set(['画家']));
    for (const value of Object.values(entry.fields).filter(Boolean)) expect(library).toContain(value);
    expect(library).toContain('[locked]');
    expect(JSON.stringify(entry)).toBe(before);
    expect(library).toContain('不能因本图省略而删除档案字段');
  });

  it('preserves design restrictions and does not restore exhaustive duplication on retry', () => {
    expect(animaVisualContract(false)).toContain('未提供的固定结构不擅自创造');
    expect(animaVisualContract(true)).toContain('已有非空字段和锁定条目不改');
    expect(EXPLICIT_APPEARANCE_RETRY_INSTRUCTION).toContain('按当前模式和景别');
    expect(EXPLICIT_APPEARANCE_RETRY_INSTRUCTION).not.toContain('直接写全每个人');
  });
});
