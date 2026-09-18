import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  applyCharRefs,
  applyPositionedCharRefs,
  buildLibraryText,
  formatEntryForPrompt,
  generateCharTags,
  parseConvertedTags,
  resolveCharAnchors,
} from '@/autoTag/charAnchors';
import {
  createCharTagNewOp,
  createCharTagSetOp,
  emptyCharFields,
  type CharTagEntry,
} from '@/state/charTags';

const requests = vi.hoisted(() => ({ main: vi.fn(), channelRequest: vi.fn(), channel: vi.fn() }));
vi.mock('@/api/client', () => ({ requestViaMainApi: requests.main, requestCompletion: requests.channelRequest }));
vi.mock('@/state/settings', () => ({ getTagGenChannel: requests.channel }));

describe('generateCharTags request validation', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it.each([false, true])('rejects invalid JSON before the request is considered successful (channel=%s)', async useChannel => {
    requests.channel.mockReturnValue(useChannel ? { id: 'configured' } : null);
    const succeeded = vi.fn();
    (useChannel ? requests.channelRequest : requests.main).mockImplementation(async (...args: unknown[]) => {
      const options = args.at(-1) as { validate?: (raw: string) => void };
      expect(options.validate).toBeTypeOf('function');
      options.validate?.('plain response');
      succeeded();
      return 'plain response';
    });
    await expect(generateCharTags([{ name: '小雪', desc: '黑色长发。' }])).rejects.toThrow('可解析的角色外貌转换 JSON');
    expect(succeeded).not.toHaveBeenCalled();
  });

  it.each([false, true])('keeps a valid empty conversion and tolerant standalone parsing compatible (channel=%s)', async useChannel => {
    requests.channel.mockReturnValue(useChannel ? { id: 'configured' } : null);
    (useChannel ? requests.channelRequest : requests.main).mockImplementation(async (...args: unknown[]) => {
      const options = args.at(-1) as { validate?: (raw: string) => void };
      options.validate?.('{}');
      return '{}';
    });
    await expect(generateCharTags([{ name: '小雪', desc: '没有外貌资料。' }])).resolves.toEqual([]);
    expect(parseConvertedTags('plain response')).toEqual({});
  });
});

function entry(name: string, fields: Partial<Record<string, string>>, source: CharTagEntry['source'] = 'ai'): CharTagEntry {
  return {
    name,
    fields: { ...emptyCharFields(), ...fields },
    raw: '',
    nl: '',
    source,
    desc: '',
    history: [],
  };
}

describe('formatEntryForPrompt / buildLibraryText', () => {
  it('renders non-empty fields with labels in fixed order', () => {
    const text = formatEntryForPrompt(entry('小雪', { sex: '1girl', hair: 'long black hair', eyes: 'red eyes' }));
    expect(text).toBe('- 小雪: 性别=1girl, 头发=long black hair, 眼睛与眼型=red eyes');
  });

  it('falls back to raw tag when no structured fields', () => {
    const e = entry('旧角色', {});
    e.raw = '1girl, red eyes';
    expect(formatEntryForPrompt(e)).toBe('- 旧角色: tag=1girl, red eyes');
  });

  it('builds the library block with a header', () => {
    const text = buildLibraryText([entry('小雪', { sex: '1girl' })]);
    expect(text).toContain('【角色固定外貌库');
    expect(text).toContain('- 小雪: 性别=1girl');
  });

  it('returns empty string for no entries', () => {
    expect(buildLibraryText([])).toBe('');
  });

  it('marks locked entries and declares immutability in the header', () => {
    const text = buildLibraryText(
      [entry('小雪', { sex: '1girl' }), entry('张三', { sex: '1boy' })],
      new Set(['小雪']),
    );
    expect(text).toContain('- 小雪 [locked]: 性别=1girl');
    expect(text).toContain('- 张三: 性别=1boy');
    expect(text).toContain('[locked] are global and immutable');
    // 无锁定名时头部保持原样(不带锁定说明)
    expect(buildLibraryText([entry('小雪', { sex: '1girl' })])).not.toContain('immutable');
  });
});

describe('applyCharRefs', () => {
  it('keeps detailed identity while isolating scene preferences and inactive legacy tags', () => {
    const e = entry('小雪', { sex: '1girl', hair: 'long black hair', eyes: 'brown eyes', face: 'oval face', nose: 'straight nose', mouth: 'thin lips' });
    e.raw = '1girl, short red hair, blue eyes';
    e.preferences = { expression: 'faint smile', action: 'holding a book', pose: 'standing' };
    const library = buildLibraryText([e]);
    expect(library).toContain('脸型与轮廓=oval face');
    expect(library).toContain('鼻子=straight nose');
    expect(library).not.toContain('short red hair');
    expect(library).toContain('剧情优先，不属于固定外貌');
    expect(library).toContain('holding a book');
    for (const mode of ['tag', 'nl'] as const) {
      const { text } = applyCharRefs('@小雪, seated, crying', [e], mode);
      expect(text).toContain('long black hair');
      expect(text).not.toContain('short red hair');
      expect(text).toContain('oval face');
      expect(text).toContain('thin lips');
      expect(text).toContain('seated, crying');
      expect(text).not.toMatch(/standing|faint smile|holding a book/);
    }
  });

  it('preserves precise converted features but rejects scene preference keys as identity', () => {
    const result = parseConvertedTags(JSON.stringify({ 小雪: {
      hair: 'long black hair', eyes: 'brown eyes, almond-shaped eyes',
      face: 'oval face', eyebrows: 'thin arched eyebrows', nose: 'straight nose',
      mouth: 'thin lips', ears: 'pointy ears', accessories: 'silver hairpin',
      expression: 'smile', preferences: { pose: 'sitting' },
    } }));
    expect(result['小雪']).toMatchObject({ face: 'oval face', mouth: 'thin lips', accessories: 'silver hairpin' });
    expect(result['小雪']).not.toHaveProperty('expression');
    expect(result['小雪']).not.toHaveProperty('preferences');
  });

  const entries = [
    entry('小雪', { sex: '1girl', hair: 'long black hair', eyes: 'red eyes' }),
    entry('张三', { sex: '1boy' }),
  ];

  it('replaces @name placeholders with the joined tag string', () => {
    const { text, unknown } = applyCharRefs('@小雪, white dress, sitting', entries);
    expect(text).toBe('1girl, long black hair, red eyes, white dress, sitting');
    expect(unknown).toEqual([]);
  });

  it('handles multiple placeholders and mixed content', () => {
    const { text } = applyCharRefs('@张三 and @小雪, classroom', entries);
    expect(text).toBe('1boy and 1girl, long black hair, red eyes, classroom');
  });

  it('strips unknown names and tidies separators', () => {
    const { text, unknown } = applyCharRefs('@路人甲, @小雪, smile', entries);
    expect(unknown).toEqual(['路人甲']);
    expect(text).toBe('1girl, long black hair, red eyes, smile');
  });

  it('handles placeholder at both ends and collapses leftovers', () => {
    const { text } = applyCharRefs('@路人甲, @小雪', entries);
    expect(text).toBe('1girl, long black hair, red eyes');
    const { text: t2 } = applyCharRefs('@小雪, @路人甲', entries);
    expect(t2).toBe('1girl, long black hair, red eyes');
  });

  it('replaces nl placeholders with the tag string when no nl sentence exists', () => {
    const { text } = applyCharRefs('@小雪 in a white dress', entries);
    expect(text).toBe('1girl, long black hair, red eyes in a white dress');
  });

  it('prefers the nl sentence for nl replacement when present', () => {
    const e = entry('小雪', { sex: '1girl' });
    e.nl = 'a petite girl with long black hair';
    const { text } = applyCharRefs('@小雪 sits by the window', [e], 'nl');
    expect(text).toBe('a petite girl with long black hair sits by the window');
  });

  it('nl mode falls back to the tag string when no nl sentence', () => {
    const { text } = applyCharRefs('@小雪 sits by the window', entries, 'nl');
    expect(text).toBe('1girl, long black hair, red eyes sits by the window');
  });
});

describe('parseConvertedTags', () => {
  it('parses structured per-character fields', () => {
    const raw = '{"阿黛尔":{"sex":"1girl","hair":"short silver hair","eyes":""}}';
    expect(parseConvertedTags(raw)).toEqual({
      阿黛尔: { sex: '1girl', hair: 'short silver hair' },
    });
  });

  it('tolerates code fences and surrounding prose, drops empty records', () => {
    const raw = '好的:\n```json\n{"阿黛尔":{"hair":"silver"},"空":{"":"  "}}\n```';
    expect(parseConvertedTags(raw)).toEqual({ 阿黛尔: { hair: 'silver' } });
  });

  it('sanitizes values with newlines or bbi tags, rejects non-object shapes', () => {
    const raw = '{"阿黛尔":{"hair":"long\\nblack"},"坏":{"eyes":"x<bbi_image>y"},"串":{"hair":"ok"}}';
    expect(parseConvertedTags(raw)).toEqual({ 串: { hair: 'ok' }, 阿黛尔: { hair: 'long black' } });
    expect(parseConvertedTags('{"阿黛尔":"plain string"}')).toEqual({});
    expect(parseConvertedTags('no json')).toEqual({});
  });
});

describe('positioned character state', () => {
  it('uses a newly documented fixed feature throughout the floor without moving a permanent change earlier', () => {
    const base = [entry('小雪', { hair: 'black hair' }, 'manual')];
    const fill = createCharTagSetOp('小雪', 'nose', 'straight nose', '角色卡：鼻梁挺直', 100, true)!;
    const dye = createCharTagSetOp('小雪', 'hair', 'red hair', '此处染发')!;
    const ops = [{ op: fill, sourceLine: 4 }, { op: dye, sourceLine: 5 }];
    expect(applyPositionedCharRefs('@小雪', base, ops, 0).text).toBe('black hair, straight nose');
    expect(applyPositionedCharRefs('@小雪', base, ops, 5).text).toBe('red hair, straight nose');
  });
  it('renders the library without firing any request', () => {
    // 建档已交给主请求:这层只做本地渲染,不再发外貌转换请求
    const entries = [entry('小雪', { sex: '1girl', hair: 'long black hair', eyes: 'blue eyes' })];
    const resolved = resolveCharAnchors(entries);
    expect(resolved.entries).toBe(entries);
    expect(resolved.text).toContain('- 小雪: 性别=1girl');
    expect(resolveCharAnchors([]).text).toBeNull();
  });

  it('uses the old profile before a permanent change and the new profile after it', () => {
    const base = [entry('小雪', { sex: '1girl', hair: 'long black hair', eyes: 'blue eyes' })];
    const dyeHair = createCharTagSetOp('小雪', 'hair', 'long red hair', '染发')!;
    const ops = [{ op: dyeHair, sourceLine: 2 }];

    expect(applyPositionedCharRefs('@小雪, smiling', base, ops, 0).text).toBe(
      '1girl, long black hair, blue eyes, smiling',
    );
    expect(applyPositionedCharRefs('@小雪, smiling', base, ops, 2).text).toBe(
      '1girl, long red hair, blue eyes, smiling',
    );
  });

  it('makes a same-response new profile available across the whole floor', () => {
    // 新角色的固定外貌是本楼全程成立的事实,不是「从某处开始」的变化:
    // 按位置门控会让建档位置之前的图片查不到条目,@占位符被整个剥掉 = 角色没有外貌。
    const profile = createCharTagNewOp({
      name: '阿黛尔',
      fields: { ...emptyCharFields(), sex: '1girl', hair: 'short silver hair', eyes: 'red eyes' },
      raw: '',
      nl: '',
      source: 'ai',
      desc: '',
    })!;
    const ops = [{ op: profile, sourceLine: 2 }];
    const expected = '1girl, short silver hair, red eyes, standing';

    expect(applyPositionedCharRefs('@阿黛尔, standing', [], ops, 0)).toEqual({
      text: expected,
      unknown: [],
    });
    expect(applyPositionedCharRefs('@阿黛尔, standing', [], ops, 2).text).toBe(expected);
  });

  it('ignores AI changes targeting locked (global) names', () => {
    const base = [entry('玩家', { sex: '1boy', hair: 'short black hair' })];
    const dye = createCharTagSetOp('玩家', 'hair', 'long red hair', '染发')!;
    const ops = [{ op: dye, sourceLine: 0 }];
    const locked = new Set(['玩家']);
    // 锁定:set 被丢弃,始终用库中值
    expect(applyPositionedCharRefs('@玩家, standing', base, ops, 5, 'tag', locked).text).toBe(
      '1boy, short black hair, standing',
    );
    // 不锁定:照旧按位置生效
    expect(applyPositionedCharRefs('@玩家, standing', base, ops, 5).text).toBe(
      '1boy, long red hair, standing',
    );
  });
});
