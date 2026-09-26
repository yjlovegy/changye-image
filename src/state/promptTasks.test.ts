import { afterEach, expect, it, vi } from 'vitest';
import { abortable, activePromptTasks, stopPromptTasks, trackPromptTask } from './promptTasks';
afterEach(stopPromptTasks);
it('stops all active tasks and allows independent cleanup and future requests', () => {
  const a = new AbortController(), b = new AbortController();
  const release = trackPromptTask(a);
  trackPromptTask(b);
  expect(activePromptTasks.value).toBe(2);
  stopPromptTasks();
  expect(a.signal.reason).toBe('user-stop');
  expect(b.signal.aborted).toBe(true);
  expect(activePromptTasks.value).toBe(0);
  const c = new AbortController();
  trackPromptTask(c); release();
  expect(activePromptTasks.value).toBe(1);
});
it('rejects immediately and discards a late host response', async () => {
  let resolve!: (s:string)=>void;
  const controller = new AbortController();
  const result = abortable(() => new Promise<string>(r => { resolve=r; }), controller.signal);
  await Promise.resolve();
  controller.abort();
  await expect(result).rejects.toMatchObject({name:'AbortError'});
  resolve('late reply');
  await expect(result).rejects.toMatchObject({name:'AbortError'});
});
it('does not dispatch pre-cancelled tasks', async () => {
  const c=new AbortController(); c.abort();
  const task=vi.fn(async ()=>'reply');
  await expect(abortable(task,c.signal)).rejects.toMatchObject({name:'AbortError'});
  expect(task).not.toHaveBeenCalled();
});
