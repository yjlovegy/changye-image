import { beforeEach, describe, expect, it, vi } from 'vitest';
import { collectAppearanceReferences, completeCharacterAppearance, parseAppearanceCompletion } from '@/autoTag/charCompletion';
import { emptyCharFields } from '@/state/charTags';
import type { STContext } from '@/st/context';

const mocks = vi.hoisted(() => ({
  main: vi.fn(), channelRequest: vi.fn(), channel: vi.fn(),
  book: vi.fn(), card: vi.fn(), persona: vi.fn(), worldbook: vi.fn(), context: vi.fn(),
}));
vi.mock('@/api/client', () => ({ requestViaMainApi: mocks.main, requestCompletion: mocks.channelRequest }));
vi.mock('@/autoTag/bookMemory', () => ({ readBookMemory: mocks.book }));
vi.mock('@/autoTag/context', () => ({ fetchCharCard: mocks.card, fetchUserPersona: mocks.persona, fetchWorldInfo: mocks.worldbook }));
vi.mock('@/state/settings', () => ({
  getTagGenChannel: mocks.channel,
  settings: { autoTag: { contextMessages: 2 }, excludes: { customStripTags: [] } },
}));
vi.mock('@/st/context', async importOriginal => ({
  ...await importOriginal<typeof import('@/st/context')>(), getContext: mocks.context,
}));

function context(): STContext {
  return {
    chat: [{ name: '小雪', is_user: false, is_system: false, mes: '小雪抬头。<bbi_image>obsolete drawing prompt</bbi_image>' }],
    name1: '玩家', name2: '小雪', characterId: 0, getCurrentChatId: () => 'chat-one',
  } as STContext;
}
const draft = () => ({ fields: emptyCharFields(), raw: '', nl: '' });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.main.mockResolvedValue('{"fields":{},"evidence":{}}');
  mocks.channelRequest.mockResolvedValue('{"fields":{},"evidence":{}}');
  mocks.channel.mockReturnValue(null);
  mocks.book.mockReturnValue(null);
  mocks.card.mockReturnValue('');
  mocks.persona.mockReturnValue('');
  mocks.worldbook.mockResolvedValue('');
  mocks.context.mockReturnValue(context());
});

describe('appearance reference completion', () => {
  it.each([false, true])('validates JSON inside the request before success can be recorded (channel=%s)', async useChannel => {
    mocks.channel.mockReturnValue(useChannel ? { id: 'configured' } : null);
    const succeeded = vi.fn();
    const request = useChannel ? mocks.channelRequest : mocks.main;
    request.mockImplementation(async (...args: unknown[]) => {
      const options = args.at(-1) as { validate?: (raw: string) => void };
      expect(options.validate).toBeTypeOf('function');
      options.validate?.('plain response without JSON');
      succeeded();
      return 'plain response without JSON';
    });
    await expect(completeCharacterAppearance(context(), '小雪', draft())).rejects.toThrow('可解析的角色资料补全 JSON');
    expect(succeeded).not.toHaveBeenCalled();
  });

  it('accepts an explicit no-evidence result but rejects malformed fields/evidence in request validation', async () => {
    expect((await completeCharacterAppearance(context(), '小雪', draft())).status).toBe('no-evidence');
    const validate = mocks.main.mock.calls[0][1].validate;
    expect(() => validate('{"fields":{},"evidence":{}}')).not.toThrow();
    expect(() => validate('{"fields":[],"evidence":{}}')).toThrow('fields 或 evidence');
    expect(() => validate('{"fields":{}}')).toThrow('fields 或 evidence');
  });

  it('collects card, persona, activated worldbook, book and story without requiring a book record', async () => {
    mocks.card.mockReturnValue('小雪长着细弯眉。');
    mocks.worldbook.mockResolvedValue('小雪的鼻梁挺直。');
    mocks.persona.mockReturnValue('玩家的眼睛是棕色。');
    const refs = await collectAppearanceReferences(context(), '小雪', draft());
    expect(refs.map(reference => reference.id)).toEqual(['card', 'persona', 'story', 'worldbook']);
    expect(refs.find(reference => reference.id === 'story')?.text).toContain('小雪抬头');
    expect(refs.find(reference => reference.id === 'story')?.text).not.toContain('obsolete drawing prompt');
    expect(mocks.worldbook.mock.calls[0][4]).toEqual(['小雪']);
  });

  it('does not restore inactive raw tags as evidence over structured appearance', async () => {
    const existing = draft();
    existing.fields.hair = 'black hair';
    existing.raw = 'red hair';
    expect(await collectAppearanceReferences({ ...context(), chat: [] }, '小雪', existing)).toEqual([]);
    existing.fields.hair = '';
    expect((await collectAppearanceReferences({ ...context(), chat: [] }, '小雪', existing))[0]).toMatchObject({ id: 'existing', text: 'red hair' });
  });

  it('skips model calls when no source or no missing field exists', async () => {
    expect((await completeCharacterAppearance({ ...context(), chat: [] }, '小雪', draft())).status).toBe('no-source');
    const full = draft();
    for (const field of Object.keys(full.fields) as Array<keyof typeof full.fields>) full.fields[field] = 'recorded';
    expect((await completeCharacterAppearance(context(), '小雪', full)).status).toBe('no-missing');
    expect(mocks.main).not.toHaveBeenCalled();
    expect(mocks.channelRequest).not.toHaveBeenCalled();
  });

  it('uses the existing channel once and requires evidence before returning draft changes', async () => {
    mocks.card.mockReturnValue('小雪的鼻梁挺直。她的眉毛细而弯。');
    const channel = { id: 'configured-channel' };
    mocks.channel.mockReturnValue(channel);
    mocks.channelRequest.mockResolvedValue(JSON.stringify({
      fields: { hair: 'red hair', nose: 'straight nose', eyebrows: 'thin arched eyebrows', mouth: 'full lips' },
      evidence: {
        hair: { source: 'card', quote: '小雪的鼻梁挺直' },
        nose: { source: 'card', quote: '小雪的鼻梁挺直' },
        eyebrows: { source: 'card', quote: '她的眉毛细而弯' },
        mouth: { source: 'card', quote: '她的嘴唇丰满' },
      },
    }));
    const existing = draft();
    existing.fields.hair = 'black hair';
    const result = await completeCharacterAppearance(context(), '小雪', existing);
    expect(result.fields).toEqual({ nose: 'straight nose', eyebrows: 'thin arched eyebrows' });
    expect(existing.fields.hair).toBe('black hair');
    expect(mocks.channelRequest).toHaveBeenCalledTimes(1);
    expect(mocks.channelRequest.mock.calls[0][0]).toBe(channel);
    expect(mocks.main).not.toHaveBeenCalled();
    const sent = mocks.channelRequest.mock.calls[0][1];
    expect(sent[0].content).toContain('没有依据就省略，包括发色和瞳色');
    expect(sent[1].content).toContain('existingFields');
  });

  it('does not send a model request after chat changes while references load', async () => {
    mocks.card.mockReturnValue('小雪细弯眉');
    mocks.context.mockReturnValue({ ...context(), getCurrentChatId: () => 'other-chat' });
    await expect(completeCharacterAppearance(context(), '小雪', draft())).rejects.toThrow('聊天已切换');
    expect(mocks.main).not.toHaveBeenCalled();
  });

  it('rejects a switch between unsaved cards even when both chat ids are absent', async () => {
    const before = {
      ...context(), chat: [], getCurrentChatId: () => undefined,
      characters: [{ name: '小雪', avatar: 'snow.png' }, { name: '阿黛尔', avatar: 'adele.png' }],
    };
    mocks.card.mockReturnValue('小雪长着细弯眉');
    mocks.context.mockReturnValue({ ...before, characterId: 1, name2: '阿黛尔' });
    await expect(completeCharacterAppearance(before, '小雪', draft())).rejects.toThrow('角色卡或聊天已切换');
    expect(mocks.main).not.toHaveBeenCalled();
  });

  it('rejects a late response after the active card changes and leaves the original draft untouched', async () => {
    mocks.card.mockReturnValue('小雪的鼻梁挺直。');
    const originalDraft = draft();
    originalDraft.fields.hair = 'black hair';
    mocks.main.mockImplementationOnce(async () => {
      mocks.context.mockReturnValue({ ...context(), characterId: 1, name2: '另一角色' });
      return JSON.stringify({ fields: { nose: 'straight nose' }, evidence: { nose: { source: 'card', quote: '小雪的鼻梁挺直' } } });
    });
    await expect(completeCharacterAppearance(context(), '小雪', originalDraft)).rejects.toThrow('角色卡或聊天已切换');
    expect(originalDraft.fields.nose).toBe('');
    expect(originalDraft.fields.hair).toBe('black hair');
  });

  it('rejects unknown fields, invalid sources, injection markup and unsupported quotes', () => {
    const parsed = parseAppearanceCompletion(JSON.stringify({
      fields: { face: 'oval face', eyes: '<bbi_image>blue eyes', pose: 'standing', nose: 'straight nose' },
      evidence: {
        face: { source: 'missing', quote: '椭圆脸' },
        eyes: { source: 'card', quote: '椭圆脸' },
        pose: { source: 'card', quote: '椭圆脸' },
        nose: { source: 'card', quote: '鼻梁挺直' },
      },
    }), {}, [{ id: 'card', label: '角色卡', text: '她有椭圆脸。' }]);
    expect(parsed.fields).toEqual({});
  });
});
