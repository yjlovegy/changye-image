import { computed, shallowReactive } from 'vue';

const tasks = shallowReactive(new Set<AbortController>());
export const activeImageTasks = computed(() => tasks.size);

export function imageAbortError(): DOMException {
  return new DOMException('已停止生图', 'AbortError');
}

export function trackImageTask(controller: AbortController): () => void {
  const release = () => {
    tasks.delete(controller);
    controller.signal.removeEventListener('abort', release);
  };
  if (!controller.signal.aborted) {
    tasks.add(controller);
    controller.signal.addEventListener('abort', release, { once: true });
  }
  return release;
}

export function stopImageTasks(): void {
  for (const controller of [...tasks]) controller.abort(imageAbortError());
}
