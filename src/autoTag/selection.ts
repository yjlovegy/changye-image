import { prepareTargetText, type PreparedTargetText } from '@/autoTag/clean';
import { parseImageTags, serializeImageTag, type ImageTagContent } from '@/st/imageTagRegex';
import { applyCharTagOps, type CharTagEntry, type CharTagFloorDelta } from '@/state/charTags';
import type { STContext, STMessage } from '@/st/context';

/** 右键打开时捕获，点击菜单和异步写回时都验证同一份快照。 */
export interface SelectionImageSnapshot {
  chatId: string;
  swipeId: number | null;
  source: string;
  message: STMessage;
  /** 选区之后的安全插图位置（必要时顺延到格式末尾）；未可靠定位时不允许发起生图。 */
  insertionOffset?: number;
}

export const MAX_SELECTION_IMAGE_TEXT_LENGTH = 12_000;

export function selectionSwipeId(message: STMessage): number | null {
  return Array.isArray(message.swipes) ? message.swipe_id ?? 0 : null;
}

export function selectionSnapshotMatches(
  context: STContext | undefined | null,
  floor: number,
  snapshot: SelectionImageSnapshot,
): boolean {
  if (!context || context.getCurrentChatId?.() !== snapshot.chatId) return false;
  const message = context.chat[floor];
  if (!message || message.mes !== snapshot.source || selectionSwipeId(message) !== snapshot.swipeId) return false;
  return message === snapshot.message || Boolean(
    snapshot.message.send_date
    && message.send_date === snapshot.message.send_date
    && message.name === snapshot.message.name,
  );
}

/** 只给选中文段分配位置编号，整楼只作为上下文，不能成为本次选图目标。 */
export function prepareSelectionImageText(text: string, stripTags: string[]): PreparedTargetText {
  const selected = text.trim();
  if (!selected) throw new Error('请先选中一段剧情正文');
  if (selected.length > MAX_SELECTION_IMAGE_TEXT_LENGTH) {
    throw new Error(`选中文字过长，请缩小到 ${MAX_SELECTION_IMAGE_TEXT_LENGTH} 字以内`);
  }
  const prepared = prepareTargetText(selected, [...stripTags, 'bbi_image']);
  if (!prepared.segments.length) throw new Error('选区清洗后没有可绘制的正文，请重新选择剧情文字');
  return prepared;
}

/** 楼前状态 + 本楼首次建档；没有位置数据的本楼 set 不能倒灌到较早选区。 */
export function prepareSelectionCharState(
  entriesBefore: CharTagEntry[],
  delta: CharTagFloorDelta | null,
  swipeId: number | null,
  locked: ReadonlySet<string>,
): { entries: CharTagEntry[]; changedNames: Set<string> } {
  const ops = delta?.swipe === (swipeId ?? 0) ? delta.ops : [];
  return {
    entries: applyCharTagOps(entriesBefore, ops.filter(op => op.kind === 'new' || op.fillOnly), -1, locked),
    changedNames: new Set(ops.filter(op => op.kind === 'set' && !op.fillOnly && !locked.has(op.name)).map(op => op.name)),
  };
}

/** 纯解析预检；探针只在内存中检查，不会返回给 UI 或写入正文。 */
export function canInsertSelectionImage(currentText: string, insertionOffset: number | undefined): boolean {
  return insertSelectionImage(currentText, currentText, {
    tag: 'bbi insertion probe', nl: '', negative: '', characters: [], size: 'portrait',
  }, insertionOffset) !== null;
}

/** 插在预先定位的安全边界；返回新槽位序号，供调用方同步迁移原图关联。 */
export function insertSelectionImage(
  currentText: string,
  expectedText: string,
  image: ImageTagContent,
  insertionOffset: number | undefined,
): { text: string; seq: number } | null {
  if (currentText !== expectedText) return null;
  if (typeof insertionOffset !== 'number' || !Number.isInteger(insertionOffset)
    || insertionOffset <= 0 || insertionOffset > currentText.length) return null;
  // 不能在 CRLF 或 UTF-16 代理对中间插入。
  if (currentText[insertionOffset - 1] === '\r' && currentText[insertionOffset] === '\n') return null;
  if (/[\uD800-\uDBFF]/.test(currentText[insertionOffset - 1])
    && /[\uDC00-\uDFFF]/.test(currentText[insertionOffset] ?? '')) return null;
  const newline = currentText.includes('\r\n') ? '\r\n' : '\n';
  const before = currentText.slice(0, insertionOffset);
  const after = currentText.slice(insertionOffset);
  const leading = /[\r\n]$/.test(before) ? '' : newline;
  const trailing = !after || /^[\r\n]/.test(after) ? '' : newline;
  const tag = serializeImageTag(image);
  const next = `${before}${leading}${tag}${trailing}${after}`;
  const seq = parseImageTags(before).length;
  const expectedTags = parseImageTags(currentText);
  expectedTags.splice(seq, 0, tag);
  const nextTags = parseImageTags(next);
  // 孤立开标签可能吞掉新图；不仅数量，既有每条 tag 和新增 tag 的原文也必须完全相同。
  if (nextTags.length !== expectedTags.length || nextTags.some((value, index) => value !== expectedTags[index])) return null;
  return { text: next, seq };
}
