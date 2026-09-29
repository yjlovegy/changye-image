import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cachedCurrentAppearance, currentAppearanceText, parseCurrentChanges, saveCurrentAppearance, syncCurrentAppearance } from './currentAppearance';
import { emptyCharFields, type CharTagEntry } from '@/state/charTags';
import type { STContext, STMessage } from '@/st/context';
const mock = vi.hoisted(() => ({ request: vi.fn(), context: vi.fn() }));
vi.mock('@/api/client', () => ({ requestCompletion: mock.request, requestViaMainApi: mock.request }));
vi.mock('@/state/settings', () => ({ getTagGenChannel: () => null, settings: { excludes: { customStripTags: [] } } }));
vi.mock('@/st/context', async original => ({ ...await original<typeof import('@/st/context')>(), getContext: mock.context }));
const message = (mes: string): STMessage => ({ mes, name: '小雪', is_user: false, is_system: false });
const entries: CharTagEntry[] = [{ name: '小雪', fields: { ...emptyCharFields(), hair: 'long black hair, high ponytail, straight bangs' }, raw: '', nl: '', source: 'manual', desc: '', history: [] }];
let ctx: STContext;
beforeEach(() => {
  vi.clearAllMocks();
  ctx = { chat: [message('小雪解开马尾，长发披散。')], chatMetadata: { unrelated: 123 }, name1: '玩家', name2: '小雪', getCurrentChatId: () => 'a', saveMetadataDebounced: vi.fn() } as unknown as STContext;
  mock.context.mockImplementation(() => ctx);
  mock.request.mockImplementation(async (messages: any[], options: any) => {
    const input = JSON.parse(messages[1].content);
    const changes = input.sources.flatMap((s: any) => s.text.includes('解开马尾') ? [{ name: '小雪', field: 'hair', value: 'long black hair, straight bangs, hair down', floor: s.floor, quote: '解开马尾' }] : s.text.includes('扎回马尾') ? [{ name: '小雪', field: 'hair', value: 'long black hair, straight bangs, high ponytail', floor: s.floor, quote: '扎回马尾' }] : []);
    const raw = JSON.stringify({ changes }); options.validate(raw); return raw;
  });
});
describe('chat-local current appearance', () => {
  it('keeps loose hair across silent floors and only restores after an explicit change', async () => {
    await syncCurrentAppearance(ctx, entries, 1);
    ctx.chat.push(message('她翻书。'), message('她喝茶。'), message('她望向窗外。'));
    const loose = await syncCurrentAppearance(ctx, entries, 4);
    expect(loose['小雪'].hair?.value).toContain('hair down');
    expect(entries[0].fields.hair).toContain('high ponytail');
    const last = JSON.parse(mock.request.mock.calls.at(-1)![0][1].content);
    expect(last.sources.map((s: any) => s.floor)).toEqual([1, 2, 3]);
    expect(last.current['小雪'].hair.value).toContain('hair down');
    ctx.chat.push(message('她扎回马尾。'));
    expect((await syncCurrentAppearance(ctx, entries, 5))['小雪'].hair?.value).toContain('high ponytail');
    expect(ctx.chatMetadata.unrelated).toBe(123);
  });
  it('reuses cached state without model calls, including after new image markup', async () => {
    await syncCurrentAppearance(ctx, entries, 1);
    ctx.chat[0].mes += '<bbi_image>new drawing</bbi_image>';
    await syncCurrentAppearance(ctx, entries, 1);
    expect(mock.request).toHaveBeenCalledTimes(1);
  });
  it.each(['edit', 'swipe', 'delete'] as const)('invalidates stale prefixes after %s', async change => {
    await syncCurrentAppearance(ctx, entries, 1);
    if (change === 'edit') ctx.chat[0].mes = '她坐下。';
    if (change === 'swipe') { ctx.chat[0].swipe_id = 1; ctx.chat[0].mes = '她坐下。'; }
    if (change === 'delete') ctx.chat = [message('另一条正文。')];
    expect(cachedCurrentAppearance(ctx, entries)['小雪']).toBeUndefined();
    expect((await syncCurrentAppearance(ctx, entries, 1))['小雪']).toBeUndefined();
  });
  it('does not carry a future hairstyle into an old floor', async () => {
    ctx.chat.unshift(message('她坐下。'));
    await syncCurrentAppearance(ctx, entries, 2);
    expect((await syncCurrentAppearance(ctx, entries, 1))['小雪']).toBeUndefined();
  });
  it('manual reset survives replay and a later explicit story change wins', async () => {
    await syncCurrentAppearance(ctx, entries, 1);
    saveCurrentAppearance(ctx, '小雪', { hair: '' });
    ctx.chat.push(message('她翻书。'));
    expect((await syncCurrentAppearance(ctx, entries, 2))['小雪'].hair).toBeUndefined();
    ctx.chat.push(message('小雪解开马尾，长发披散。'));
    expect((await syncCurrentAppearance(ctx, entries, 3))['小雪'].hair?.floor).toBe(2);
  });
  it('preview never mutates cached metadata or manual state', async () => {
    await syncCurrentAppearance(ctx, entries, 1);
    ctx.chat.push(message('她扎回马尾。'));
    const before = JSON.stringify(ctx.chatMetadata);
    expect((await syncCurrentAppearance(ctx, entries, 2, undefined, false))['小雪'].hair?.value).toContain('high ponytail');
    expect(JSON.stringify(ctx.chatMetadata)).toBe(before);
  });
  it('does not save a response after changing chat or modifying the source', async () => {
    mock.request.mockImplementationOnce(async () => { ctx.chat[0].mes = '已修改'; return '{"changes":[]}'; });
    await expect(syncCurrentAppearance(ctx, entries, 1)).rejects.toThrow('已变化');
    expect(ctx.chatMetadata).toEqual({ unrelated: 123 });
  });
  it('respects cancellation before processing and saves no empty success state', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(syncCurrentAppearance(ctx, entries, 1, controller.signal)).rejects.toThrow();
    expect(mock.request).not.toHaveBeenCalled();
    expect(ctx.chatMetadata).toEqual({ unrelated: 123 });
  });
  it('keeps chat caches isolated', async () => {
    await syncCurrentAppearance(ctx, entries, 1);
    ctx = { ...ctx, chatMetadata: {}, chat: [message('她坐下。')], getCurrentChatId: () => 'b' };
    expect((await syncCurrentAppearance(ctx, entries, 1))['小雪']).toBeUndefined();
  });
  it('requires verbatim evidence and rejects invented hair accessories', () => {
    const sources = [{ floor: 0, text: '小雪解开马尾，长发披散。' }];
    const change = { name: '小雪', field: 'hair', value: 'hair down, hairclip', floor: 0, quote: '长发披散' };
    expect(parseCurrentChanges(JSON.stringify({ changes: [change] }), sources, new Set(['小雪']))).toEqual([]);
    expect(parseCurrentChanges(JSON.stringify({ changes: [{ ...change, value: 'hair down', quote: '她戴了发卡' }] }), sources, new Set(['小雪']))).toEqual([]);
  });
  it('keeps the explicit current-state priority for locked profiles', () => {
    expect(currentAppearanceText({ '小雪': { hair: { value: 'hair down', quote: '解开马尾', floor: 0 } } })).toContain('locked 只禁止修改基础档案');
  });
});
