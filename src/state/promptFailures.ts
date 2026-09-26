import { shallowReactive } from 'vue';
export interface PromptFailure { id: number; source: string; reason: string; retry: () => Promise<void> }
export const promptFailures = shallowReactive<PromptFailure[]>([]);
let nextId = 0;
export function reportPromptFailure(source: string, error: unknown, retry: () => Promise<void>): void {
  promptFailures.unshift({ id: ++nextId, source, reason: error instanceof Error ? error.message : String(error), retry });
  promptFailures.splice(3);
}
export function dismissPromptFailure(id: number): void {
  const index = promptFailures.findIndex(item => item.id === id);
  if (index >= 0) promptFailures.splice(index, 1);
}
