import { computed, shallowReactive } from 'vue';

const tasks = shallowReactive(new Set<AbortController>());
export const activePromptTasks = computed(() => tasks.size);
export function trackPromptTask(controller: AbortController): () => void {
  const release = () => { tasks.delete(controller); controller.signal.removeEventListener('abort', release); };
  if (!controller.signal.aborted) {
    tasks.add(controller);
    controller.signal.addEventListener('abort', release, { once: true });
  }
  return release;
}
export function stopPromptTasks(): void {
  for (const controller of [...tasks]) controller.abort('user-stop');
}

/** The host's generateRaw has no per-request abort parameter. Discard late results without stopping chat. */
export function abortable<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return task();
  if (signal.aborted) return Promise.reject(new DOMException('已停止提示词生成', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException('已停止提示词生成', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => {
      if (signal.aborted) throw new DOMException('已停止提示词生成', 'AbortError');
      return task();
    }).then(value => { if (!signal.aborted) resolve(value); }, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}
