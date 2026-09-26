import { reactive, shallowReactive } from 'vue';

/** Runtime-only edits. This map is never part of extension_settings or settings exports. */
export function createWorkflowDrafts<T extends { id: string }>() {
  const entries = shallowReactive(new Map<string, { base: string; value: T }>());
  const clone = (value: T): T => JSON.parse(JSON.stringify(value));
  return {
    edit(saved: T): T {
      const existing = entries.get(saved.id);
      if (existing) return existing.value as T;
      entries.set(saved.id, { base: JSON.stringify(saved), value: reactive(clone(saved)) as T });
      return entries.get(saved.id)!.value as T;
    },
    current(saved: T): T { return (entries.get(saved.id)?.value as T | undefined) ?? saved; },
    dirty(id: string): boolean {
      const item = entries.get(id);
      return !!item && JSON.stringify(item.value) !== item.base;
    },
    commit(saved: T): T {
      const item = entries.get(saved.id);
      if (!item) return clone(saved);
      if (JSON.stringify(saved) !== item.base) throw new Error('已保存的工作流已被其他操作修改，请先放弃临时修改后重新编辑');
      const next = clone(item.value as T);
      entries.set(saved.id, { base: JSON.stringify(next), value: item.value });
      return next;
    },
    discard(id: string) { entries.delete(id); },
    values(): T[] { return [...entries.values()].map(item => item.value as T); },
  };
}
