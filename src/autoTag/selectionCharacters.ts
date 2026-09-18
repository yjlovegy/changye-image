import type { PositionedCharOp } from '@/autoTag/charAnchors';
import {
  CHAR_TAG_FIELDS, applyCharTagOps,
  type CharTagEntry, type CharTagFloorDelta,
} from '@/state/charTags';

/** 选段可保存的范围比自动整楼规划小：首次建档和空字段设计，不追写永久变化。 */
export function filterSelectionCharacterOps(
  candidates: PositionedCharOp[],
  entries: CharTagEntry[],
  locked: ReadonlySet<string>,
  changedNames: ReadonlySet<string>,
): PositionedCharOp[] {
  const accepted: PositionedCharOp[] = [];
  let current = entries;
  for (const item of candidates) {
    const op = item.op;
    if (locked.has(op.name) || changedNames.has(op.name)) continue;
    const existing = current.find(entry => entry.name === op.name);
    if (op.kind === 'new') {
      if (existing || op.raw.trim() || !CHAR_TAG_FIELDS.some(field => op.fields[field]?.trim())) continue;
    } else {
      if (!op.fillOnly || !CHAR_TAG_FIELDS.includes(op.field as typeof CHAR_TAG_FIELDS[number])
        || !existing || existing.fields[op.field as typeof CHAR_TAG_FIELDS[number]]?.trim()) continue;
    }
    const reason = op.reason.trim() || '选段外貌补全';
    const nextOp = { ...op, reason };
    const next = applyCharTagOps(current, [nextOp], -1, locked);
    const updated = next.find(entry => entry.name === op.name);
    // 旧整串档案的单字段更新被存储层禁止；不保存实际不会生效的补全记录。
    if (!updated || (op.kind === 'set' && updated.fields[op.field as typeof CHAR_TAG_FIELDS[number]] !== op.value)) continue;
    accepted.push({ sourceLine: item.sourceLine, op: nextOp });
    current = next;
  }
  return accepted;
}

/** 同 swipe 原操作按原顺序保留，新增设计排在其后；不能把另一 swipe 的状态带进本图。 */
export function appendSelectionCharacterDelta(
  previous: CharTagFloorDelta | null,
  additions: PositionedCharOp[],
  swipeId: number | null,
): CharTagFloorDelta | null {
  if (!additions.length) return previous;
  const swipe = swipeId ?? 0;
  if (previous && previous.swipe !== swipe && previous.ops.length) {
    throw new Error('本楼角色记录属于另一条 swipe，无法安全追加五官设计；本次未保存，请重新打开当前回复');
  }
  return { v: 1, swipe, ops: [...(previous?.swipe === swipe ? previous.ops : []), ...additions.map(item => item.op)] };
}
