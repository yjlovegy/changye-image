/**
 * 「写入 tag 后自动生成图片」握手(autoTag.autoGenerate,默认开)。
 *
 * 时序:runner 写入 tag 前为每个新槽位挂上标记 → applyMessageText 内部触发
 * MESSAGE_EDITED / MESSAGE_UPDATED → 楼层重渲染、卡片水合挂载 →
 * 卡片 onMounted 消费本槽位标记并自动开始生成。
 *
 * 标记一次性:消费即删,重水合不会重复触发;楼层懒渲染(群聊等)时标记暂存,
 * 等楼层真正渲染再消费;切聊天/删楼时整体清空,避免污染其它聊天或旧槽位。
 *
 * 两种模式(mode):
 * - 'auto':自动流程(runner 写完 tag)。仅在「这条提示词还没有图」时才开跑,
 *   已有结果/在途任务时让位给用户手动操作。
 * - 'force':用户明确点了「应用并重新生成」(提示词编辑弹窗)。无条件开跑 ——
 *   来回改回旧提示词时该桶可能已有历史(phase=ready),但用户要的就是新图。
 */

/** 标记模式:见文件头注释。 */
export type AutoGenerateMode = 'auto' | 'force';

/** 卡片展示相位(与 Card.vue 的 Phase 同构;这里只列判定用得到的)。 */
export type AutoGeneratePhase = 'pending' | 'queued' | 'generating' | 'ready' | 'stale' | 'error';

const flags = new Map<string, { mode: AutoGenerateMode; isCurrent?: () => boolean }>();

function key(chatId: string, messageId: number, swipeId: number, seq: number): string {
  return `${chatId}|${messageId}|${swipeId}|${seq}`;
}

export function markForAutoGenerate(
  chatId: string,
  messageId: number,
  swipeId: number,
  seq: number,
  mode: AutoGenerateMode = 'auto',
  /** 实际消费前再核对请求配置，异步刷新期间改了工作流就停止。 */
  isCurrent?: () => boolean,
): void {
  flags.set(key(chatId, messageId, swipeId, seq), { mode, isCurrent });
}

/** 消费本槽位的自动生成标记:有则删除并返回其模式(只触发一次),无则 null。 */
export function consumeAutoGenerate(
  chatId: string,
  messageId: number,
  swipeId: number,
  seq: number,
): AutoGenerateMode | null {
  const k = key(chatId, messageId, swipeId, seq);
  const flag = flags.get(k);
  if (flag === undefined) return null;
  flags.delete(k);
  try {
    if (flag.isCurrent && !flag.isCurrent()) return null;
  } catch {
    return null;
  }
  return flag.mode;
}

/**
 * 该不该真的开跑。**刻意做成纯函数**:Card.vue 没有单测(仓里没装 jsdom /
 * @vue/test-utils,vitest 跑在 node 环境),判定留在组件里就锁不住。
 *
 * 'auto' 放过 pending 与 **stale**:stale 的含义正是「tag 变了、当前提示词还没有图」,
 * 这恰恰是该自动出图的时刻。曾经这里只放 pending,导致楼层「重新生成 tag」在已出过图的
 * 楼层上静默失效(新 tag 写进去了、卡片却停在旧图不动);多 tag 楼层更怪 —— 有旧图的
 * 槽位被拦、纯新增的槽位照跑,看起来「一半在生成一半不动」。
 *
 * ready / queued / generating / error 仍然不放:已有本提示词的结果、已有在途任务,
 * 或上一轮刚失败(重试交给用户点,免得错误配置下自动重试打满后端)。
 */
export function shouldAutoGenerate(mode: AutoGenerateMode, phase: AutoGeneratePhase): boolean {
  if (mode === 'force') return true;
  return phase === 'pending' || phase === 'stale';
}

/** 撤销某楼层的全部标记(写回正文失败时调用)。 */
export function clearAutoGenerateForFloor(chatId: string, messageId: number): void {
  const prefix = `${chatId}|${messageId}|`;
  for (const k of [...flags.keys()]) {
    if (k.startsWith(prefix)) flags.delete(k);
  }
}

/** 尚未水合消费的标记也是待生成任务；中间插图前应等待它完成，不能悄悄挪到别图。 */
export function hasPendingAutoGenerateForFloor(chatId: string, messageId: number): boolean {
  const prefix = `${chatId}|${messageId}|`;
  return [...flags.keys()].some(key => key.startsWith(prefix));
}

/** 清空全部标记(切聊天 / 删楼后的全量重建时调用)。 */
export function clearAutoGenerateFlags(): void {
  flags.clear();
}
