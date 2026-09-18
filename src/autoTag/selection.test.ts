import { describe, expect, it } from 'vitest';
import {
  insertSelectionImage, canInsertSelectionImage, prepareSelectionCharState, prepareSelectionImageText, selectionSnapshotMatches, selectionSwipeId,
  type SelectionImageSnapshot,
} from '@/autoTag/selection';
import { matchesImageTagLayout, parseImageTags } from '@/st/imageTagRegex';
import type { STContext, STMessage } from '@/st/context';
import { createCharTagNewOp, createCharTagSetOp, emptyCharFields, type CharTagEntry } from '@/state/charTags';
import { extractCharRefNames } from '@/autoTag/charAnchors';

const image = { tag: '1girl, holding a book', nl: '', negative: '', characters: [], size: 'portrait' as const };

describe('selection image preparation', () => {
  it('targets only selected narrative and excludes hidden metadata', () => {
    const target = prepareSelectionImageText('她翻开书。\n<think>不应画这里</think>\n她望向窗外。', []);
    expect(target.segments.map(segment => segment.text)).toEqual(['她翻开书。', '她望向窗外。']);
    expect(target.promptText).not.toContain('不应画这里');
    expect(() => prepareSelectionImageText('   ', [])).toThrow();
    expect(() => prepareSelectionImageText('字'.repeat(12_001), [])).toThrow(/过长/);
    expect(() => prepareSelectionImageText('<bbi_image>旧图</bbi_image>', [])).toThrow(/没有可绘制/);
  });

  it('inserts directly after the selection while retaining both surrounding text and exact existing tags', () => {
    const source = '第一段\r\n<bbi_image>old one</bbi_image>\r\n第二段\r\n<bbi_image>old two</bbi_image>';
    const offset = source.indexOf('第二段') + '第二段'.length;
    const next = insertSelectionImage(source, source, image, offset)!;
    expect(next.seq).toBe(1);
    expect(next.text.startsWith(source.slice(0, offset))).toBe(true);
    expect(next.text.endsWith(source.slice(offset))).toBe(true);
    expect(parseImageTags(next.text).filter((_, seq) => seq !== next.seq)).toEqual(parseImageTags(source));
    expect(parseImageTags(next.text)).toHaveLength(3);
    expect(insertSelectionImage(`${source}编辑`, source, image, offset)).toBeNull();
    expect(canInsertSelectionImage(source, offset)).toBe(true);
    expect(next.text).not.toContain('insertion probe');
    for (const invalid of [undefined, 0, -1, source.length + 1, 1.5, source.indexOf('old one') + 2]) {
      expect(insertSelectionImage(source, source, image, invalid)).toBeNull();
    }
  });

  it('rejects dangling and nested open tags that would consume the appended image', () => {
    for (const source of [
      '正文\n<bbi_image>unfinished',
      '正文\n<bbi_image>outer <bbi_image>inner',
      '<bbi_image>old</bbi_image>\n<bbi_image>unfinished',
      '<bbi_image>outer <bbi_image>inner</bbi_image>\n<bbi_image>unfinished',
    ]) {
      expect(canInsertSelectionImage(source, source.length)).toBe(false);
      expect(insertSelectionImage(source, source, image, source.length)).toBeNull();
    }
  });

  it('rejects a stale complete layout even when a duplicated tag still matches at the old seq', () => {
    const tag = '<bbi_image>same</bbi_image>';
    const source = `选区${tag}${tag}`;
    const layout = parseImageTags(source);
    const next = insertSelectionImage(source, source, image, 2)!;
    expect(parseImageTags(next.text)[1]).toBe(layout[1]);
    expect(matchesImageTagLayout(next.text, layout)).toBe(false);
  });

  it('keeps before-floor appearance and same-floor new characters without applying late permanent changes', () => {
    const base: CharTagEntry = {
      name: '小雪', fields: { ...emptyCharFields(), hair: 'black hair' }, raw: '', nl: '',
      source: 'ai', desc: '', history: [],
    };
    const create = createCharTagNewOp({ ...base, name: '阿黛尔', fields: { ...emptyCharFields(), hair: 'silver hair' } })!;
    const dye = createCharTagSetOp('小雪', 'hair', 'red hair')!;
    const state = prepareSelectionCharState([base], { v: 1, swipe: 0, ops: [create, dye] }, 0, new Set());
    expect(state.entries.find(entry => entry.name === '小雪')?.fields.hair).toBe('black hair');
    expect(state.entries.find(entry => entry.name === '阿黛尔')?.fields.hair).toBe('silver hair');
    expect([...state.changedNames]).toEqual(['小雪']);
    expect(prepareSelectionCharState([base], { v: 1, swipe: 1, ops: [create, dye] }, 0, new Set()).entries).toHaveLength(1);
    expect(extractCharRefNames('@小雪, @阿黛尔 and @小雪')).toEqual(['小雪', '阿黛尔']);
  });

  it('checks chat, message identity, swipe, and exact source independently', () => {
    const message = { name: '角色', mes: '正文', send_date: 'date-a', swipes: ['正文'], swipe_id: 0 } as STMessage;
    const snapshot: SelectionImageSnapshot = { chatId: 'chat-a', swipeId: 0, source: '正文', message };
    const context = { getCurrentChatId: () => 'chat-a', chat: [message] } as STContext;
    expect(selectionSnapshotMatches(context, 0, snapshot)).toBe(true);
    expect(selectionSnapshotMatches({ ...context, getCurrentChatId: () => 'chat-b' }, 0, snapshot)).toBe(false);
    for (const changed of [
      { ...message, mes: '编辑正文' }, { ...message, swipe_id: 1 }, { ...message, send_date: 'date-b' },
    ]) expect(selectionSnapshotMatches({ ...context, chat: [changed] }, 0, snapshot)).toBe(false);
    expect(selectionSnapshotMatches({ ...context, chat: [{ ...message }] }, 0, snapshot)).toBe(true);
    expect(selectionSnapshotMatches(context, 1, snapshot)).toBe(false);
    expect(selectionSwipeId({ ...message, swipes: undefined })).toBeNull();
  });
});
