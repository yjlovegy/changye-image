<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue';
import { inspectWorkflowLoras, updateWorkflowLoras } from '@/backends/comfyLoras';
import { appendFavoriteTags, type ComfyLoraFavorite } from '@/backends/comfyLoraFavorites';
import ComfyLoraFavorites from './ComfyLoraFavorites.vue';
import BbiTextarea from '@/components/BbiTextarea.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';

const props = defineProps<{ workflowId: string; workflow: string; backup: string; favorites: ComfyLoraFavorite[] }>();
const emit = defineEmits<{
  (event: 'update:workflow', value: string): void;
  (event: 'update:backup', value: string): void;
  (event: 'update:favorites', value: ComfyLoraFavorite[]): void;
}>();
const drafts = reactive<Record<string, string>>({});
const message = ref('');
const error = ref('');
const restoreOpen = ref(false);
const targetId = ref('');
const favoriteUseMessage = ref('');
const favoriteUseError = ref('');
const state = computed(() => {
  if (!props.workflow.trim()) return { groups: [], error: '' };
  try { return { groups: inspectWorkflowLoras(props.workflow), error: '' }; }
  catch (reason) { return { groups: [], error: reason instanceof Error ? reason.message : String(reason) }; }
});
const targets = computed(() => state.value.groups.filter(group => group.editable));
let previousTags: Record<string, string> = {};
watch([() => props.workflowId, () => props.workflow], (value, previous) => {
  const switching = value[0] !== previous?.[0];
  const ids = new Set(state.value.groups.map(group=>group.nodeId));
  for (const key of Object.keys(drafts)) if (switching || !ids.has(key)) delete drafts[key];
  for (const group of state.value.groups) {
    if (switching || drafts[group.nodeId] === undefined || drafts[group.nodeId] === previousTags[group.nodeId]) drafts[group.nodeId] = group.tags;
  }
  previousTags = Object.fromEntries(state.value.groups.map(group=>[group.nodeId,group.tags]));
  error.value = '';
  message.value = '';
  favoriteUseMessage.value = '';
  favoriteUseError.value = '';
  restoreOpen.value = false;
  if (value[0] !== previous?.[0] || !targets.value.some(group => group.nodeId === targetId.value)) {
    targetId.value = targets.value[0]?.nodeId ?? '';
  }
}, { immediate: true, flush: 'sync' });
const dirty = computed(() => state.value.groups.some(group => group.editable && drafts[group.nodeId] !== group.tags));

watch(dirty, value => { if (value) message.value = ''; });

function useFavorite(tags: string[]) {
  favoriteUseError.value = ''; favoriteUseMessage.value = '';
  try {
    const target = targets.value.find(group => group.nodeId === targetId.value);
    if (!target) throw new Error('当前工作流没有可编辑的 Lora堆。');
    const result = appendFavoriteTags(drafts[target.nodeId] ?? '', tags);
    drafts[target.nodeId] = result.text;
    favoriteUseMessage.value = '已加入 ' + result.added + ' 项' + (result.skipped ? '，跳过 ' + result.skipped + ' 项已有 LoRA' : '') + '；点击“同步LoRA到工作流”后生效。';
  } catch (reason) { favoriteUseError.value = reason instanceof Error ? reason.message : String(reason); }
}

async function syncLoras() {
  error.value = '';
  message.value = '';
  const original = props.workflow;
  try {
    let next = original;
    for (const group of state.value.groups) {
      if (group.editable && drafts[group.nodeId] !== group.tags) {
        next = updateWorkflowLoras(next, group.nodeId, drafts[group.nodeId] ?? '');
      }
    }
    if (next === original) return;
    // 所有组先在本地副本上验证完；任何一组失败都不写工作流或覆盖备份。
    emit('update:backup', original);
    emit('update:workflow', next);
    await nextTick();
    message.value = '同步成功';
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason);
  }
}
function prepare(workflow: string) {
  if (state.value.error) throw new Error(state.value.error);
  let next = workflow;
  for (const group of state.value.groups) {
    if (group.editable && drafts[group.nodeId] !== group.tags) next = updateWorkflowLoras(next, group.nodeId, drafts[group.nodeId] ?? '');
  }
  return next;
}
defineExpose({ dirty, prepare });
function restoreWorkflow() {
  if (!props.backup) return;
  emit('update:workflow', props.backup);
  emit('update:backup', '');
  restoreOpen.value = false;
  error.value = '';
  message.value = '已恢复上次 LoRA 同步前的工作流。';
}
</script>

<template>
  <section class="lora-controls" aria-label="LoRA 标签控制">
    <div class="lora-head">
      <h3 class="bbi-field-label">LoRA 标签控制</h3>
      <button type="button" class="bbi-btn bbi-btn-sm" :disabled="!backup" @click="restoreOpen = true">恢复同步前工作流</button>
    </div>
    <p class="bbi-field-hint">同步后可临时试图；点击上方「保存当前工作流」才会覆盖已保存配置。</p>
    <p v-if="state.error" class="lora-error" role="alert">{{ state.error }}</p>
    <p v-else-if="!state.groups.length" class="bbi-field-hint">当前工作流没有可识别的 LoRA 组。本控制支持 LoraManager 与 rgthree Power LoRA 列表节点；其它节点保留在 JSON 中编辑。</p>
    <fieldset v-for="group in state.groups" :key="group.nodeId" class="lora-group">
      <legend>{{ state.groups.length === 1 ? 'Lora堆' : group.label }}<label v-if="targets.length > 1 && group.editable" class="lora-radio"><input v-model="targetId" type="radio" :value="group.nodeId" name="bbi-lora-target" /> 将收藏加入此组</label></legend>
      <p class="bbi-field-hint">已启用 {{ group.count }} 项<span v-if="group.disabledCount"> · 未启用 {{ group.disabledCount }} 项</span></p>
      <BbiTextarea v-if="group.editable" v-model="drafts[group.nodeId]" :rows="3" :max-rows="12" mono :aria-label="'LoRA 标签 ' + group.nodeId" placeholder="&lt;lora:rendering_detailer_base10-000400:0.70&gt;" />
      <p v-else class="bbi-field-hint">{{ group.reason || '该节点暂不支持标签控制，请在 JSON 中编辑。' }}</p>
      <p v-for="warning in group.warnings" :key="warning" class="bbi-field-hint">{{ warning }}</p>
    </fieldset>
    <div class="lora-actions">
      <button type="button" class="bbi-btn bbi-btn-primary" :disabled="!dirty || !!state.error" @click="syncLoras">同步LoRA到工作流</button>
      <span v-if="message" class="lora-success" role="status">{{ message }}</span>
      <span v-if="dirty" class="bbi-field-hint">有修改尚未同步</span>
    </div>
    <p v-if="error" class="lora-error" role="alert">{{ error }}</p>
<ComfyLoraFavorites :model-value="favorites" :can-add="!!targetId && !state.error" @update:model-value="emit('update:favorites', $event)" @use="useFavorite">
      <p v-if="favoriteUseMessage" class="bbi-field-hint" role="status">{{ favoriteUseMessage }}</p>
      <p v-if="favoriteUseError" class="lora-error" role="alert">{{ favoriteUseError }}</p>
    </ComfyLoraFavorites>
    <ConfirmDialog v-model:open="restoreOpen" title="恢复同步前工作流" confirm-text="恢复" @confirm="restoreWorkflow">
      恢复上次 LoRA 同步前的整份工作流 JSON；同步后手动修改的 JSON 也会被覆盖。固定提示词设置保留。
    </ConfirmDialog>
  </section>
</template>

<style scoped>
.lora-controls { margin: 18px 0; padding: 16px; border: 1px solid var(--bbi-line); border-radius: var(--bbi-radius-sm); min-width: 0; }
.lora-head, .lora-actions { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.lora-actions { justify-content: flex-end; margin-top:14px; }.lora-actions .bbi-btn { min-height:38px; padding:8px 16px; }.lora-success { color: #27833d; font-size: 13px; }.lora-radio { font-size: 12px; margin-left: 12px; }
.lora-head h3 { margin: 0; }
.lora-group { margin: 14px 0; padding: 12px; border: 1px solid var(--bbi-line); border-radius: var(--bbi-radius-sm); min-width: 0; }
.lora-group legend { padding: 0 6px; font-size: 13px; color: var(--bbi-ink); overflow-wrap: anywhere; }
.lora-error { color: var(--bbi-danger, #b3261e); overflow-wrap: anywhere; font-size: 13px; }
.lora-target { display: grid; gap: 6px; min-width: 0; }
.lora-group summary { cursor: pointer; font-size: 13px; overflow-wrap: anywhere; }
@media (max-width: 520px) { .lora-controls { padding: 10px; } .lora-group { padding: 8px; } }
</style>
