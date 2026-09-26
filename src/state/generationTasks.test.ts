import { afterEach, expect, it } from 'vitest';
import { activeGenerationTasks, stopGenerationTasks } from './generationTasks';
import { activeImageTasks, trackImageTask } from './imageTasks';
import { trackPromptTask } from './promptTasks';
import { consumeAutoGenerate, markForAutoGenerate } from '@/floor/autoGenerate';

afterEach(stopGenerationTasks);

it('stops prompt and image tasks and clears the handoff to automatic image generation', () => {
  const prompt = new AbortController(), image = new AbortController();
  trackPromptTask(prompt);
  const release = trackImageTask(image);
  markForAutoGenerate('chat', 1, 0, 0);
  expect(activeGenerationTasks.value).toBe(3);
  stopGenerationTasks();
  expect(prompt.signal.aborted).toBe(true);
  expect(image.signal.reason).toMatchObject({ name: 'AbortError' });
  expect(consumeAutoGenerate('chat', 1, 0, 0)).toBeNull();
  expect(activeGenerationTasks.value).toBe(0);
  const next = new AbortController();
  trackImageTask(next);
  release();
  expect(next.signal.aborted).toBe(false);
  expect(activeImageTasks.value).toBe(1);
});

it('does not stop completed or unrelated operations', () => {
  const done = new AbortController(), unrelated = new AbortController();
  trackImageTask(done)();
  stopGenerationTasks();
  expect(done.signal.aborted).toBe(false);
  expect(unrelated.signal.aborted).toBe(false);
});

it('does not retain tasks cancelled before registration', () => {
  const task = new AbortController();
  task.abort();
  trackImageTask(task);
  expect(activeGenerationTasks.value).toBe(0);
});
