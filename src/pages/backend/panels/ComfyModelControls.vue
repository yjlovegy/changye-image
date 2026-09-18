<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { inspectWorkflowFields, updateWorkflowFields } from '@/backends/comfyWorkflowControls';
import { fetchComfyModelLists, type ComfyModelLists } from '@/backends/comfyObjectInfo';
import BbiCombo from '@/components/BbiCombo.vue';
const props = defineProps<{ workflow: string; url: string }>();
const emit = defineEmits<{ (event: 'update:workflow', value: string): void }>();
const draft = ref<Record<string, string | number>>({});
const baseline = ref('');
const saved = ref(false), error = ref(''), listError = ref(''), loading = ref(false);
const lists = ref<ComfyModelLists | null>(null);
let fetchSequence = 0;
const state = computed(() => {
  if (!props.workflow.trim()) return { fields: [], warnings: [], error: '' };
  try { return { ...inspectWorkflowFields(props.workflow), error: '' }; }
  catch (e) { return { fields: [], warnings: [], error: String(e instanceof Error ? e.message : e) }; }
});
const source = computed(() => Object.fromEntries(state.value.fields.map(f => [f.id, f.value])));
const orderedFields = computed(() => {
  const rank = (options?: string) => ['unets','ggufs','checkpoints'].includes(options || '') ? 0
    : ['clips','encoderTypes','dualEncoderTypes'].includes(options || '') ? 1 : options === 'vaes' ? 2 : 3;
  return [...state.value.fields].sort((a,b) => rank(a.options) - rank(b.options));
});
const dirty = computed(() => JSON.stringify(draft.value) !== JSON.stringify(source.value));
watch(source, value => {
  const serialized = JSON.stringify(value);
  if (serialized === baseline.value) return; // unrelated LoRA/JSON edits retain the parameter draft
  draft.value = { ...value }; baseline.value = serialized; saved.value = false; error.value = '';
}, { immediate: true, flush: 'sync' });
watch(draft, () => { saved.value = false; error.value = ''; }, { deep: true, flush: 'sync' });
async function refresh(force = true) {
  const seq = ++fetchSequence, url = props.url;
  if (!url.trim()) return;
  loading.value = true; listError.value = '';
  try {
    const next = await fetchComfyModelLists(url, { force });
    if (seq !== fetchSequence) return;
    lists.value = next;
    if (next.mode === 'server') listError.value = '转发连接未提供的模型列表，可直接填写文件名。';
  } catch (e) { if (seq === fetchSequence) listError.value = `列表读取失败：${e instanceof Error ? e.message : String(e)}；可手动填写。`; }
  finally { if (seq === fetchSequence) loading.value = false; }
}
watch(() => props.url, () => { ++fetchSequence; lists.value = null; loading.value = false; listError.value = ''; void refresh(false); }, { immediate: true });
onBeforeUnmount(() => { ++fetchSequence; });
async function save() {
  try {
    const next = updateWorkflowFields(props.workflow, draft.value);
    emit('update:workflow', next); await nextTick(); saved.value = true; error.value = '';
  } catch (e) { error.value = e instanceof Error ? e.message : String(e); }
}
</script>
<template>
  <section class="model-controls" aria-label="模型与采样">
    <div class="control-head"><h3 class="bbi-field-label">模型与采样</h3><button type="button" class="bbi-btn bbi-btn-sm" :disabled="loading || !url.trim()" @click="refresh()">{{ loading ? '读取中…' : '刷新列表' }}</button></div>
    <div class="control-fields">
      <div v-for="field in orderedFields" :key="field.id" class="control-field" :class="[field.options, { 'main-model': ['unets','ggufs','checkpoints'].includes(field.options || ''), 'numeric-field': !field.options }]">
        <span class="bbi-field-label">{{ field.label }}</span>
        <BbiCombo v-if="field.options" :model-value="String(draft[field.id] ?? '')" @update:model-value="draft[field.id] = $event" :options="lists?.[field.options] ?? []" :aria-label="field.label" placeholder="选择或填写文件名 / 参数" />
        <input v-else v-model="draft[field.id]" type="number" class="bbi-input" :aria-label="field.label" :min="field.min" :max="field.max" :step="field.step" />
      </div>
    </div>
    <p v-if="!state.fields.length && !state.error" class="bbi-field-hint">导入工作流后显示可编辑的模型和采样参数。</p>
    <p v-for="warning in state.warnings" :key="warning" class="bbi-field-hint">{{ warning }}</p>
    <p v-if="listError" class="bbi-field-hint" role="status">{{ listError }}</p>
    <p v-if="state.error || error" class="control-error" role="alert">{{ state.error || error }}</p>
    <div class="control-actions"><span v-if="saved" class="control-success" role="status">✓ 已保存</span><button type="button" class="bbi-btn bbi-btn-primary" :disabled="!dirty || !state.fields.length || !!state.error" @click="save">保存模型与采样设置</button></div>
  </section>
</template>
<style scoped>
.model-controls { margin: 18px 0; padding: 16px; border: 1px solid var(--bbi-line); border-radius: var(--bbi-radius-sm); }
.control-head, .control-actions { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.control-head h3 { margin: 0; }.control-actions { justify-content: flex-end; margin-top: 14px; }
.control-fields { display: grid; grid-template-columns: repeat(6,minmax(0,1fr)); gap: 14px; margin-top: 14px; }
.control-field { grid-column: span 3; display: grid; gap: 7px; min-width: 0; }.numeric-field { grid-column: span 2; }.main-model { grid-column: 1 / -1; }
.control-field.clips { grid-column: span 4; }.control-field.encoderTypes,.control-field.dualEncoderTypes { grid-column: span 2; }.control-field.vaes { grid-column: 1 / -1; }
.control-field.samplers { grid-column: 1 / span 2; }.control-field.schedulers { grid-column: 3 / -1; }
.control-error { color: var(--bbi-danger,#b3261e); font-size: 13px; overflow-wrap: anywhere; }.control-success { color: #27833d; font-size: 13px; }
@media(max-width:620px) { .control-fields { grid-template-columns: minmax(0,1fr); }.control-fields > .control-field { grid-column: 1 / -1; }.model-controls { padding: 10px; } }
</style>
