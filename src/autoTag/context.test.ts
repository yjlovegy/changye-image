import { describe, expect, it, vi } from 'vitest';
import { fetchCharCard, fetchWorldInfo } from '@/autoTag/context';
import type { STContext } from '@/st/context';

const mocks = vi.hoisted(() => ({ check: vi.fn() }));
vi.mock('@/st/context', () => ({
  getCheckWorldInfo: async () => mocks.check,
  getContext: () => ({}),
  getEjsTemplate: () => null,
}));
vi.mock('@/state/settings', () => ({ settings: { excludes: { customStripTags: [] } } }));
vi.mock('@/autoTag/excludes', () => ({
  isWorldInfoEntryExcluded: () => false,
  sortWorldInfoEntriesLikeST: (entries: unknown[]) => entries,
}));

describe('appearance context sources', () => {
  it('reads nested v2 card fields when top-level host fields are empty and expands macros', () => {
    const context = {
      characterId: 0,
      characters: [{ name: '小雪', avatar: 'x.png', description: '', data: { description: '{{char}}长着细弯眉。', personality: '沉静', scenario: '' } }],
      substituteParams: (text: string) => text.replaceAll('{{char}}', '小雪'),
    } as unknown as STContext;
    expect(fetchCharCard(context)).toContain('小雪长着细弯眉');
    expect(fetchCharCard(context)).not.toContain('{{char}}');
  });

  it('activates name-specific worldbook evidence even before the first chat message', async () => {
    mocks.check.mockResolvedValue({ allActivatedEntries: new Set([{ content: '小雪的鼻梁挺直。' }]) });
    expect(await fetchWorldInfo([], [], '玩家', '小雪', ['小雪'])).toBe('小雪的鼻梁挺直。');
    expect(mocks.check.mock.calls[0][0]).toEqual(['小雪']);
    expect(mocks.check.mock.calls[0][2]).toBe(true);
  });
});
