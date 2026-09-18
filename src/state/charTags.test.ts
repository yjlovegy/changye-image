import { describe, expect, it } from 'vitest';

import {
  BBI_CHAR_EXTRA_KEY,
  applyCharTagOps,
  buildEntryTag,
  computeLockedCharTagNames,
  createCharTagNewOp,
  createCharTagSetOp,
  deriveCharTags,
  emptyCharFields,
  mergeCharTagSeed,
  normalizeCharTagStore,
  readCharTagFloorDelta,
  type CharTagAutoOp,
} from '@/state/charTags';
import type { STMessage } from '@/st/context';

function floorMessage(ops: CharTagAutoOp[], swipe = 0, storedSwipe = swipe): STMessage {
  return {
    name: 'Char',
    is_user: false,
    is_system: false,
    mes: '正文',
    swipes: ['正文', '另一页'],
    swipe_id: swipe,
    extra: {
      [BBI_CHAR_EXTRA_KEY]: { v: 1, swipe: storedSwipe, ops },
    },
  };
}

describe('evidence-backed fill-only character changes', () => {
  it('fills stable eye shape independently of an existing eye color and keeps it fixed on replay', () => {
    const base = normalizeCharTagStore({ entries: [{
      name: 'Lin', fields: { eyes: 'brown eyes' }, source: 'manual', desc: 'Existing profile',
      nl: 'Lin has brown eyes and a small dimple.',
    }] });
    const color = createCharTagSetOp('Lin', 'eyes', 'blue eyes', 'fill', 100, true)!;
    const shape = createCharTagSetOp('Lin', 'eyeShape', 'almond-shaped eyes, defined upper eyelids', 'stable appearance', 100, true)!;
    const message = floorMessage([color, shape]);
    expect(readCharTagFloorDelta(message)?.ops[1]).toMatchObject({ field: 'eyeShape', fillOnly: true });
    const [completed] = deriveCharTags(base, [message]);
    expect(completed.fields.eyes).toBe('brown eyes');
    expect(completed.fields.eyeShape).toBe('almond-shaped eyes, defined upper eyelids');
    expect(completed.nl).toBe('Lin has brown eyes and a small dimple.');
    expect(completed.source).toBe('manual');
    expect(completed.desc).toBe('Existing profile');
    expect(completed.history.map(record => record.field)).toEqual(['eyeShape']);
    const changed = createCharTagSetOp('Lin', 'eyeShape', 'round eyes', 'second fill', 101, true)!;
    expect(applyCharTagOps([completed], [changed], 1)).toEqual([completed]);
    expect(deriveCharTags(base, [message])).toEqual([completed]);
    expect(deriveCharTags(base, [])[0].fields.eyeShape).toBe('');
  });

  it('preserves an existing natural-language description when only filling an empty fixed field', () => {
    const base = normalizeCharTagStore({ entries: [{
      name: '小雪', fields: { hair: 'black hair' }, source: 'manual',
      nl: 'She has black hair and a straight nose.',
    }] });
    const fill = createCharTagSetOp('小雪', 'nose', 'straight nose', '角色卡：鼻梁挺直', 100, true)!;
    const [completed] = applyCharTagOps(base, [fill], 0);
    expect(completed.fields.nose).toBe('straight nose');
    expect(completed.nl).toBe('She has black hair and a straight nose.');
    expect(completed.history.map(record => record.field)).toEqual(['nose']);
    const dye = createCharTagSetOp('小雪', 'hair', 'red hair', '永久染发', 101)!;
    expect(applyCharTagOps([completed], [dye], 0)[0].nl).toBe('');
  });

  it('round-trips fillOnly and fills missing features without replacing manual values or provenance', () => {
    const base = normalizeCharTagStore({ entries: [{
      name: '小雪', fields: { hair: 'black hair', eyes: 'brown eyes' }, source: 'manual', desc: '手填人设',
    }] });
    const hair = createCharTagSetOp('小雪', 'hair', 'red hair', '补资料', 100, true)!;
    const nose = createCharTagSetOp('小雪', 'nose', 'straight nose', '角色卡：鼻梁挺直', 100, true)!;
    const message = floorMessage([hair, nose]);
    expect(readCharTagFloorDelta(message)?.ops.every(op => op.kind === 'set' && op.fillOnly)).toBe(true);
    const [completed] = deriveCharTags(base, [message]);
    expect(completed.fields).toMatchObject({ hair: 'black hair', eyes: 'brown eyes', nose: 'straight nose' });
    expect(completed.source).toBe('manual');
    expect(completed.desc).toBe('手填人设');
    expect(completed.history.map(record => record.field)).toEqual(['nose']);
  });

  it('does not mutate locked profiles or implicitly convert a legacy raw profile', () => {
    const structured = normalizeCharTagStore({ entries: [{ name: '小雪', fields: { hair: 'black hair' } }] });
    const legacy = normalizeCharTagStore({ entries: [{ name: '小雪', raw: 'black hair, blue eyes' }] });
    const fill = createCharTagSetOp('小雪', 'nose', 'straight nose', '角色卡', 100, true)!;
    expect(applyCharTagOps(structured, [fill], 0, new Set(['小雪']))[0].fields.nose).toBe('');
    const unchanged = applyCharTagOps(legacy, [fill], 0)[0];
    expect(unchanged.raw).toBe('black hair, blue eyes');
    expect(unchanged.fields.nose).toBe('');
  });

  it('allows a partial profile with a supported feature while leaving unspecified colors empty', () => {
    const op = createCharTagNewOp({
      name: '小雪', fields: { ...emptyCharFields(), nose: 'straight nose' }, raw: '', nl: '', source: 'ai', desc: '',
    });
    expect(op?.fields.nose).toBe('straight nose');
    expect(op?.fields.hair).toBe('');
    expect(op?.fields.eyes).toBe('');
  });
});

describe('char tags store normalize', () => {
  it('adds an empty eyeShape to old entries without moving or changing legacy eyes/raw/nl', () => {
    const eyes = 'blue eyes, almond-shaped eyes, long eyelashes';
    const raw = 'blue eyes, long eyelashes';
    const nl = 'Lin has blue almond-shaped eyes and long eyelashes.';
    const [entry] = normalizeCharTagStore({ version: 3, entries: [{ name: 'Lin', fields: { eyes }, raw, nl }] });
    expect(entry.fields.eyeShape).toBe('');
    expect(entry.fields.eyes).toBe(eyes);
    expect(entry.raw).toBe(raw);
    expect(entry.nl).toBe(nl);
    expect(buildEntryTag(entry)).toBe(eyes);
  });

  it('normalizes eyeShape through profile and history serialization and includes it after eyes', () => {
    const [entry] = normalizeCharTagStore({ version: 3, entries: [{
      name: 'Lin', fields: { eyes: 'brown eyes', eyeShape: ' almond-shaped eyes, long eyelashes ', eyebrows: 'arched eyebrows' },
      history: [{ field: 'eyeShape', from: '', to: 'almond-shaped eyes, long eyelashes', reason: 'stable appearance', floor: 1, at: 10 }],
    }] });
    expect(entry.fields.eyeShape).toBe('almond-shaped eyes, long eyelashes');
    expect(entry.history[0].field).toBe('eyeShape');
    expect(buildEntryTag(entry)).toBe('brown eyes, almond-shaped eyes, long eyelashes, arched eyebrows');
    expect(normalizeCharTagStore(JSON.parse(JSON.stringify({ version: 3, entries: [entry] })))).toEqual([entry]);
    expect(normalizeCharTagStore({ entries: [{ name: 'Lin', fields: { eyes: 'brown eyes', eyeShape: 42 } }] })[0].fields.eyeShape).toBe('');
  });

  it('keeps valid structured entries and normalizes fields', () => {
    const entries = normalizeCharTagStore({
      version: 2,
      entries: [
        {
          name: '阿黛尔',
          fields: { sex: '1girl', hair: ' short silver hair ' },
          source: 'book',
          desc: '银色短发',
        },
        { name: ' 铁匠老周 ', fields: { sex: '1boy' }, source: 'manual' },
      ],
    });
    expect(entries).toEqual([
      {
        name: '阿黛尔',
        fields: { ...emptyCharFields(), sex: '1girl', hair: 'short silver hair' },
        raw: '',
        nl: '',
        source: 'book',
        desc: '银色短发',
        history: [],
      },
      {
        name: '铁匠老周',
        fields: { ...emptyCharFields(), sex: '1boy' },
        raw: '',
        nl: '',
        source: 'manual',
        desc: '',
        history: [],
      },
    ]);
  });

  it('migrates v1 legacy tags string into raw mode', () => {
    const entries = normalizeCharTagStore({
      version: 1,
      entries: [{ name: '旧角色', tags: '1girl, red eyes', source: 'book', desc: '红瞳' }],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].raw).toBe('1girl, red eyes');
    expect(entries[0].fields).toEqual(emptyCharFields());
    expect(entries[0].preferences).toBeUndefined();
    expect(entries[0].source).toBe('book');
    expect(entries[0].desc).toBe('红瞳');
  });

  it('drops entries without any usable content', () => {
    const entries = normalizeCharTagStore({
      version: 2,
      entries: [
        { name: '', fields: { sex: '1girl' } },
        { name: '空的', fields: {} },
        { name: '空白', fields: { hair: '   ' }, raw: ' ' },
        'not-an-object',
      ],
    });
    expect(entries).toEqual([]);
  });

  it('unknown source falls back to manual; history records are sanitized', () => {
    const entries = normalizeCharTagStore({
      version: 2,
      entries: [
        {
          name: '路人',
          fields: { sex: '1girl' },
          source: 'weird',
          history: [
            { field: 'hair', from: 'long', to: 'short', reason: '剪发', floor: 42, at: 1 },
            { field: 'bogus', from: 'x', to: 'y' },
            'junk',
          ],
        },
      ],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].source).toBe('manual');
    expect(entries[0].history).toEqual([
      { field: 'hair', from: 'long', to: 'short', reason: '剪发', floor: 42, at: 1 },
    ]);
  });

  it('dedupes by name, keeping the first occurrence', () => {
    const entries = normalizeCharTagStore({
      version: 2,
      entries: [
        { name: '阿黛尔', fields: { sex: 'a' }, source: 'book', desc: 'd1' },
        { name: '阿黛尔', fields: { sex: 'b' }, source: 'manual' },
      ],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].fields.sex).toBe('a');
  });

  it('returns empty for malformed stores', () => {
    expect(normalizeCharTagStore(null)).toEqual([]);
    expect(normalizeCharTagStore({ version: 2 })).toEqual([]);
    expect(normalizeCharTagStore('junk')).toEqual([]);
  });

  it('retains precise fixed traits and only recognized user preferences after a storage round trip', () => {
    const [entry] = normalizeCharTagStore({ version: 3, entries: [{
      name: '小雪',
      fields: {
        sex: '1girl', age: 'adult', face: ' oval face ', eyes: 'blue eyes, almond-shaped eyes',
        eyebrows: 'arched eyebrows', nose: 'straight nose', mouth: 'thin lips', ears: 'pointy ears',
        height: 'tall', skin: 'freckles', accessories: 'round glasses',
      },
      preferences: { expression: ' soft smile ', gaze: 'looking away', action: 123, pose: '', unknown: 'drop' },
      history: [{ field: 'face', from: '', to: 'oval face', reason: '补充', floor: 2, at: 1 }],
    }] });
    expect(entry.fields).toMatchObject({
      age: 'adult', face: 'oval face', eyebrows: 'arched eyebrows', nose: 'straight nose',
      mouth: 'thin lips', ears: 'pointy ears', height: 'tall', accessories: 'round glasses',
    });
    expect(entry.preferences).toEqual({ expression: 'soft smile', gaze: 'looking away' });
    expect(entry.history[0].field).toBe('face');
    const roundTripped = normalizeCharTagStore(JSON.parse(JSON.stringify({ version: 3, entries: [entry] })));
    expect(roundTripped).toEqual([entry]);
    expect(buildEntryTag(entry)).toContain('oval face');
    expect(buildEntryTag(entry)).not.toContain('soft smile');
    expect(buildEntryTag(entry)).not.toContain('looking away');
  });

  it('keeps structured profiles authoritative without reviving an inactive legacy raw string', () => {
    const [entry] = normalizeCharTagStore({ version: 3, entries: [{
      name: '小雪',
      fields: { sex: '1girl', hair: 'short red hair', face: 'oval face', eyes: 'green eyes' },
      raw: '1girl, long black hair, blue eyes',
    }] });
    expect(buildEntryTag(entry)).toBe('1girl, short red hair, oval face, green eyes');
    expect(entry.raw).toBe('1girl, long black hair, blue eyes');
    expect(buildEntryTag({ fields: emptyCharFields(), raw: ' 1girl,  long black hair ' })).toBe(
      '1girl,  long black hair',
    );
  });
});

describe('floor-owned character changes', () => {
  it('removes a character when its creation floor is deleted', () => {
    const create = createCharTagNewOp({
      name: '小雪',
      fields: { ...emptyCharFields(), sex: '1girl', hair: 'long black hair' },
      raw: '',
      nl: '',
      source: 'ai',
      desc: '',
    })!;
    const cutHair = createCharTagSetOp('小雪', 'hair', 'short black hair', '剪发')!;
    const chat = [floorMessage([create]), floorMessage([cutHair])];

    expect(deriveCharTags([], chat)[0].fields.hair).toBe('short black hair');
    chat.splice(0, 1);
    expect(deriveCharTags([], chat)).toEqual([]);
  });

  it('reverts a field when only the later change floor is deleted', () => {
    const create = createCharTagNewOp({
      name: '小雪',
      fields: { ...emptyCharFields(), hair: 'long black hair' },
      raw: '',
      nl: '',
      source: 'book',
      desc: '黑色长发',
    })!;
    const cutHair = createCharTagSetOp('小雪', 'hair', 'short black hair', '剪发')!;
    const chat = [floorMessage([create]), floorMessage([cutHair])];

    chat.pop();
    const [entry] = deriveCharTags([], chat);
    expect(entry.fields.hair).toBe('long black hair');
    expect(entry.history).toHaveLength(1);
    expect(entry.history[0].floor).toBe(0);
  });

  it('ignores changes copied from another swipe', () => {
    const create = createCharTagNewOp({
      name: '旧页角色',
      fields: { ...emptyCharFields(), sex: '1girl' },
      raw: '',
      nl: '',
      source: 'ai',
      desc: '',
    })!;
    expect(deriveCharTags([], [floorMessage([create], 1, 0)])).toEqual([]);
  });

  it('rejects AI preference injection while preserving the user preferences through replay', () => {
    const [base] = normalizeCharTagStore({ entries: [{
      name: '小雪', fields: { hair: 'black hair' }, preferences: { pose: 'standing', expression: 'smile' },
    }] });
    const forgedSet = { kind: 'set', name: '小雪', field: 'pose', value: 'sitting', reason: 'AI', at: 1 };
    const appearance = createCharTagSetOp('小雪', 'nose', 'straight nose')!;
    expect(createCharTagSetOp('小雪', 'pose' as never, 'sitting')).toBeNull();
    const result = deriveCharTags([base], [floorMessage([forgedSet as CharTagAutoOp, appearance])]);
    expect(result[0].preferences).toEqual({ pose: 'standing', expression: 'smile' });
    expect(result[0].fields.nose).toBe('straight nose');
    expect(result[0].preferences).not.toBe(base.preferences);
    result[0].preferences!.pose = 'kneeling';
    expect(base.preferences?.pose).toBe('standing');

    const newInput = {
      ...base, name: '新角色', preferences: { pose: 'sitting' }, source: 'ai' as const,
    };
    const newOp = createCharTagNewOp(newInput)!;
    expect('preferences' in newOp).toBe(false);
    const forgedNew = { ...newOp, preferences: { pose: 'sitting' } };
    expect(deriveCharTags([], [floorMessage([forgedNew])])[0].preferences).toBeUndefined();
    expect(applyCharTagOps([base], [forgedSet as CharTagAutoOp], 1)[0].preferences?.pose).toBe('standing');
  });

  it('keeps legacy raw profiles intact when AI reports a single structured field change', () => {
    const [base] = normalizeCharTagStore({ entries: [{
      name: '小雪', raw: '1girl, long black hair, blue eyes', nl: 'A girl with long black hair and blue eyes.',
    }] });
    const hair = createCharTagSetOp('小雪', 'hair', 'short red hair', '剪发染发')!;
    const face = createCharTagSetOp('小雪', 'face', 'oval face')!;
    const updated = deriveCharTags([base], [floorMessage([hair, face])])[0];
    expect(updated).toEqual(base);
    expect(buildEntryTag(updated)).toBe(base.raw);

    const raw = createCharTagSetOp('小雪', 'raw', '1girl, short red hair, blue eyes')!;
    const nl = createCharTagSetOp('小雪', 'nl', 'A girl with short red hair and blue eyes.')!;
    const replaced = deriveCharTags([base], [floorMessage([raw, nl])])[0];
    expect(buildEntryTag(replaced)).toBe(raw.value);
    expect(replaced.nl).toBe(nl.value);
    expect(replaced.fields).toEqual(emptyCharFields());
  });

  it('lets AI add structured detail to field profiles and clears a stale natural-language description', () => {
    const [base] = normalizeCharTagStore({ entries: [{
      name: '小雪', fields: { sex: '1girl', hair: 'long black hair' }, nl: 'A girl with long black hair.',
    }] });
    const face = createCharTagSetOp('小雪', 'face', 'oval face')!;
    const updated = deriveCharTags([base], [floorMessage([face])])[0];
    expect(buildEntryTag(updated)).toBe('1girl, long black hair, oval face');
    expect(updated.nl).toBe('');
    expect(updated.history).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'nl', from: base.nl, to: '' }),
    ]));
    const nl = createCharTagSetOp('小雪', 'nl', 'A girl with long black hair and an oval face.')!;
    expect(deriveCharTags([base], [floorMessage([face, nl])])[0].nl).toBe(nl.value);
    expect(deriveCharTags([base], [floorMessage([face])], 0)[0].nl).toBe(base.nl);
  });
});

describe('global library merge & lock', () => {
  const globalEntry = (name: string, fields: Record<string, string>) => ({
    name,
    fields: { ...emptyCharFields(), ...fields },
    raw: '',
    nl: '',
    source: 'manual' as const,
    desc: '',
    history: [],
  });

  it('mergeCharTagSeed: 本聊天同名条目优先,全局只补同名空缺', () => {
    const chat = [globalEntry('小雪', { hair: 'short red hair' })];
    const global = [globalEntry('小雪', { hair: 'long black hair' }), globalEntry('玩家', { sex: '1boy' })];
    const merged = mergeCharTagSeed(chat, global);
    expect(merged).toHaveLength(2);
    expect(merged.find(e => e.name === '小雪')?.fields.hair).toBe('short red hair');
    expect(merged.find(e => e.name === '玩家')?.fields.sex).toBe('1boy');
    // 无全局时原样返回(零开销路径)
    expect(mergeCharTagSeed(chat, [])).toBe(chat);
  });

  it('computeLockedCharTagNames: 只有「全局独有」的名字被锁定;本聊天同名即解锁', () => {
    const global = [globalEntry('玩家', { sex: '1boy' }), globalEntry('小雪', { sex: '1girl' })];
    expect([...computeLockedCharTagNames([], global)].sort()).toEqual(['小雪', '玩家']);
    expect([...computeLockedCharTagNames([globalEntry('小雪', { sex: '1girl' })], global)]).toEqual(['玩家']);
    expect(computeLockedCharTagNames([], []).size).toBe(0);
  });

  it('applyCharTagOps: 锁定名的 new 与 set 一律丢弃', () => {
    const locked = new Set(['玩家']);
    const create = createCharTagNewOp({
      name: '玩家',
      fields: { ...emptyCharFields(), sex: '1boy', hair: 'short black hair' },
      raw: '',
      nl: '',
      source: 'ai',
      desc: '',
    })!;
    const dye = createCharTagSetOp('玩家', 'hair', 'long red hair', '染发')!;
    const base = [globalEntry('玩家', { sex: '1boy', hair: 'short black hair' })];
    const out = applyCharTagOps(base, [create, dye], 3, locked);
    expect(out[0].fields.hair).toBe('short black hair');
    expect(out[0].history).toEqual([]);
    // 不传 locked 时旧行为不变
    const out2 = applyCharTagOps(base, [dye], 3);
    expect(out2[0].fields.hair).toBe('long red hair');
  });

  it('deriveCharTags: 旧消息里针对锁定角色的楼层 ops 重放时失效', () => {
    const dye = createCharTagSetOp('玩家', 'hair', 'long red hair', '染发')!;
    const chat = [floorMessage([dye])];
    const base = [globalEntry('玩家', { sex: '1boy', hair: 'short black hair' })];
    expect(deriveCharTags(base, chat, chat.length, new Set(['玩家']))[0].fields.hair).toBe('short black hair');
    expect(deriveCharTags(base, chat)[0].fields.hair).toBe('long red hair');
  });
});
