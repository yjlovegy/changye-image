import { describe, expect, it } from 'vitest';
import { appendSelectionCharacterDelta, filterSelectionCharacterOps } from '@/autoTag/selectionCharacters';
import { applyCharTagOps, createCharTagNewOp, createCharTagSetOp, emptyCharFields, type CharTagEntry } from '@/state/charTags';
import type { PositionedCharOp } from '@/autoTag/charAnchors';

const entry = (name: string): CharTagEntry => ({ name, fields: { ...emptyCharFields(), hair: 'brown hair', face: 'oval face' }, raw: '', nl: '', source: 'manual', desc: '', history: [] });
const positioned = (op: NonNullable<ReturnType<typeof createCharTagSetOp>> | NonNullable<ReturnType<typeof createCharTagNewOp>>): PositionedCharOp => ({ op, sourceLine: 0 });
const fill = (name: string, field: Parameters<typeof createCharTagSetOp>[1], value: string) => positioned(createCharTagSetOp(name, field, value, '与已知外貌相容', 100, true)!);

describe('selection character completion', () => {
  it('only fills genuinely empty structured fields, preserves prior values, and keeps the first accepted design', () => {
    const baseline = entry('画家');
    const ops = filterSelectionCharacterOps([
      fill('画家', 'face', 'round face'), fill('画家', 'nose', 'straight nose'),
      fill('画家', 'nose', 'upturned nose'), fill('画家', 'eyeShape', 'almond-shaped eyes'),
      positioned(createCharTagSetOp('画家', 'hair', 'red hair', '永久变化')!),
      fill('画家', 'raw', 'replacement text'), fill('画家', 'nl', 'Replacement sentence.'),
    ], [baseline], new Set(), new Set());
    expect(ops.map(item => item.op.kind === 'set' ? item.op.field : 'new')).toEqual(['nose', 'eyeShape']);
    expect(ops.every(item => item.op.reason === '与已知外貌相容')).toBe(true);
    const [updated] = applyCharTagOps([baseline], ops.map(item => item.op), 0);
    expect(updated.fields).toMatchObject({ face: 'oval face', hair: 'brown hair', nose: 'straight nose', eyeShape: 'almond-shaped eyes' });
    expect(baseline.fields.nose).toBe('');
  });

  it('accepts one new structured profile but never replaces an existing name or updates unknown and raw-only profiles', () => {
    const baseline = entry('画家');
    const raw = { ...entry('旧档'), fields: emptyCharFields(), raw: 'brown hair, oval face' };
    const create = (name: string) => positioned(createCharTagNewOp({ ...entry(name), fields: { ...emptyCharFields(), face: 'angular face' }, source: 'ai' }, '五官补全设计', 100)!);
    const ops = filterSelectionCharacterOps([
      create('画家'), create('摄影师'), create('摄影师'), fill('不存在', 'nose', 'straight nose'), fill('旧档', 'nose', 'straight nose'),
    ], [baseline, raw], new Set(), new Set());
    expect(ops).toHaveLength(1);
    expect(ops[0].op).toMatchObject({ kind: 'new', name: '摄影师', reason: '五官补全设计' });
  });

  it('blocks every operation for locked and same-floor permanently changed characters', () => {
    const locked = entry('锁定角色');
    const changed = entry('已变化角色');
    const candidates = [fill(locked.name, 'mouth', 'thin lips'), fill(changed.name, 'nose', 'straight nose'),
      positioned(createCharTagNewOp({ ...locked, source: 'ai' })!), positioned(createCharTagNewOp({ ...changed, source: 'ai' })!)];
    expect(filterSelectionCharacterOps(candidates, [locked, changed], new Set([locked.name]), new Set([changed.name]))).toEqual([]);
  });

  it('preserves source and design reasons and supplies a neutral default only when the reason is empty', () => {
    const baseline = entry('画家');
    const candidates = [
      positioned(createCharTagSetOp('画家', 'nose', 'straight nose', '角色卡明确：鼻梁挺直', 100, true)!),
      positioned(createCharTagSetOp('画家', 'eyeShape', 'almond-shaped eyes', '五官补全设计', 101, true)!),
      positioned(createCharTagSetOp('画家', 'mouth', 'thin lips', ' ', 102, true)!),
    ];
    const ops = filterSelectionCharacterOps(candidates, [baseline], new Set(), new Set());
    expect(ops.map(item => item.op.reason)).toEqual(['角色卡明确：鼻梁挺直', '五官补全设计', '选段外貌补全']);
  });

  it('appends accepted designs after all existing operations without mutating the previous delta', () => {
    const previous = { v: 1 as const, swipe: 0, ops: [createCharTagSetOp('另一角色', 'hair', 'silver hair', '原操作', 1)!] };
    const additions = [fill('画家', 'nose', 'straight nose')];
    const result = appendSelectionCharacterDelta(previous, additions, null)!;
    expect(result.ops).toEqual([...previous.ops, additions[0].op]);
    expect(result.ops[0]).toBe(previous.ops[0]);
    expect(previous.ops).toHaveLength(1);
    expect(appendSelectionCharacterDelta(previous, [], 0)).toBe(previous);
    expect(() => appendSelectionCharacterDelta({ ...previous, swipe: 1 }, additions, 0)).toThrow('另一条 swipe');
  });
});
