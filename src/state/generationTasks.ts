import { computed } from 'vue';
import { clearAutoGenerateFlags, pendingAutoGenerateCount } from '@/floor/autoGenerate';
import { activeImageTasks, stopImageTasks } from './imageTasks';
import { activePromptTasks, stopPromptTasks } from './promptTasks';

export const activeGenerationTasks = computed(() =>
  activePromptTasks.value + activeImageTasks.value + pendingAutoGenerateCount.value,
);

export function stopGenerationTasks(): void {
  clearAutoGenerateFlags();
  stopPromptTasks();
  stopImageTasks();
}
