import { describe, expect, it } from 'vitest';
import { assertExplicitAppearance, facialDetailContract } from './facialDetail';

describe('explicit facial detail output', () => {
  it.each(['tag', 'nl'])('rejects new %s placeholders before old profile prose can hide detailed fields', field => {
    const content = { tag: 'adult artist, oval face', nl: 'An adult artist has an oval face.', [field]: '@画家' };
    expect(() => assertExplicitAppearance(content)).toThrow('直接写全');
  });
  it('checks individual NAI characters as well as Base', () => {
    expect(() => assertExplicitAppearance({ tag: '1other, studio', nl: 'An artist stands in a studio.', characters: [
      { name: '画家', tag: 'adult artist', nl: '@画家 stands by an easel.' },
    ] })).toThrow('占位符');
  });
  it.each([
    { tag: 'landscape, mountains', nl: 'Mountains rise beyond the lake.' },
    { tag: 'adult artist, from behind', nl: 'An adult artist is seen from behind.' },
    { tag: 'adult artist, mask', nl: 'An adult artist wears a mask that covers the lower face.' },
    { tag: 'adult artist, angular jaw, aquiline profile', nl: 'The adult artist has an angular jaw and an aquiline profile.' },
  ])('does not pretend a word-presence test can prove facial visibility or accuracy', content => {
    expect(() => assertExplicitAppearance(content)).not.toThrow();
  });
  it('distinguishes authorized design from existing facts and preserves composition exceptions', () => {
    const contract = facialDetailContract({ mixed: true, characterPrompts: false, allowDesign: true });
    for (const field of ['face', 'eyebrows', 'eyeShape', 'nose', 'mouth']) expect(contract).toContain(field);
    expect(contract).toContain('不能声称设计细节是原文事实');
    expect(contract).toContain('背影');
    expect(contract).toContain('非人角色');
    expect(contract).toContain('tag / nl 必须分别包含');
  });
  it('retains backend boundaries and can disable design', () => {
    const nai = facialDetailContract({ mixed: true, characterPrompts: true, allowDesign: false });
    expect(nai).toContain('characters[].tag / characters[].nl');
    expect(nai).toContain('Base 不放个人五官');
    expect(nai).toContain('未提供的固定结构不擅自创造');
    const old = facialDetailContract({ mixed: false, characterPrompts: false, allowDesign: true });
    expect(old).toContain('当前后端只消费 tag');
    expect(old).not.toContain('tag / nl 必须分别包含');
  });
});
