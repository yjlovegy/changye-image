<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { validateWorkflowJson } from '@/backends/comfyWorkflowControls';
import { getWorkflowPlaceholders } from '@/backends/comfyui';
import BbiTextarea from '@/components/BbiTextarea.vue';
const props = defineProps<{ modelValue: string; name: string; configuring: boolean }>();
const emit = defineEmits<{ (event: 'update:modelValue', value: string): void; (event: 'assist'): void }>();
const draft = ref(props.modelValue), baseline = ref(props.modelValue), open = ref(!props.modelValue.trim());
const error = ref(''), saved = ref(!!props.modelValue.trim()), importing = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);
let importSequence = 0;
const downloads = new Map<string, ReturnType<typeof setTimeout>>();
const dirty = computed(() => draft.value !== baseline.value);
const stale = computed(() => baseline.value !== props.modelValue);
const status = computed(() => {
  try { validateWorkflowJson(draft.value); return getWorkflowPlaceholders(draft.value).some(x => x === 'prompt' || x === 'nl') ? '格式有效' : '格式有效 · 待配置提示词占位符'; }
  catch { return draft.value.trim() ? 'JSON 无效' : '未填写'; }
});
watch(() => props.modelValue, value => {
  if (!dirty.value) { draft.value = value; baseline.value = value; saved.value = !!value.trim(); error.value = ''; }
}, { flush: 'sync' });
watch(draft, () => { error.value = ''; }, { flush: 'sync' });
function reloadSaved() { draft.value = props.modelValue; baseline.value = props.modelValue; error.value = ''; }
async function save() {
  try {
    if (stale.value) throw new Error('其他设置已更新工作流，请载入最新工作流后再编辑，避免覆盖这些修改。');
    const next = validateWorkflowJson(draft.value);
    emit('update:modelValue', next);
    await nextTick();
    draft.value = props.modelValue; baseline.value = props.modelValue; saved.value = true; error.value = ''; open.value = false;
  } catch (e) { error.value = e instanceof Error ? e.message : String(e); }
}
function prepare() {
  if (importing.value) throw new Error('工作流文件还在读取，请稍后保存');
  if (dirty.value && stale.value) throw new Error('JSON 草稿与其他修改冲突，请先载入最新工作流');
  return dirty.value ? validateWorkflowJson(draft.value) : props.modelValue;
}
defineExpose({ dirty, prepare, importing });
async function upload(event: Event) {
  const input = event.target as HTMLInputElement, file = input.files?.[0]; input.value = '';
  if (!file) return;
  const seq = ++importSequence, before = draft.value; importing.value = true;
  try {
    const text = await file.text();
    if (seq !== importSequence) return;
    if (draft.value !== before) throw new Error('读取文件时编辑内容已变化，请重新上传。');
    draft.value = validateWorkflowJson(text); open.value = true; error.value = '';
  } catch (e) { if (seq === importSequence) error.value = e instanceof Error ? e.message : String(e); }
  finally { if (seq === importSequence) importing.value = false; }
}
function download() {
  try {
    const json = validateWorkflowJson(props.modelValue);
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url;
    link.download = `${props.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'workflow'}.json`;
    document.body.appendChild(link); link.click(); link.remove();
    downloads.set(url, setTimeout(() => { URL.revokeObjectURL(url); downloads.delete(url); }, 1000));
  } catch (e) { error.value = e instanceof Error ? e.message : String(e); }
}
onBeforeUnmount(() => { ++importSequence; for (const [url, timer] of downloads) { clearTimeout(timer); URL.revokeObjectURL(url); } });
</script>
<template>
  <section class="json-editor" aria-label="工作流 JSON">
    <button type="button" class="json-heading" :aria-expanded="open" @click="open = !open">
      <span>工作流 JSON</span><span class="json-toggle">{{ open ? '收起' : '展开' }}</span>
    </button>
    <div class="json-status"><span class="bbi-field-hint">{{ status }} · 点击保存后自动折叠。</span><span v-if="!dirty && saved" class="json-success">✓ 已载入</span><span v-else class="json-small">{{ dirty ? '尚未应用' : '' }}</span></div>
    <div v-show="open" class="json-body">
      <div class="json-toolbar">
        <button type="button" class="bbi-btn" :disabled="importing" @click="fileInput?.click()">{{ importing ? '读取中…' : '上传 JSON' }}</button>
        <input ref="fileInput" type="file" accept=".json,application/json" hidden aria-label="上传工作流 JSON 文件" @change="upload" />
        <button type="button" class="bbi-btn" :disabled="!modelValue.trim()" title="下载当前已应用的工作流（含临时修改）" @click="download">下载 JSON</button>
        <button type="button" class="bbi-btn" :disabled="configuring || dirty || !modelValue.trim()" title="先点击“保存工作流”；AI 配置会将节点和模型名发送到已配置的副 API" @click="emit('assist')">{{ configuring ? '分析中…' : 'AI 自动配置' }}</button>
        <button type="button" class="bbi-btn json-save" :disabled="importing || stale" @click="save">保存工作流</button>
      </div>
      <BbiTextarea v-model="draft" :rows="8" :max-rows="24" mono aria-label="工作流 JSON 内容" placeholder="直接粘贴 API 格式的工作流 JSON" />
      <p v-if="stale" class="json-error" role="alert">工作流已被其他设置更新。<button type="button" class="bbi-btn bbi-btn-sm" @click="reloadSaved">放弃草稿并载入最新工作流</button></p>
      <p v-if="error" class="json-error" role="alert">{{ error }}</p>
    </div>
  </section>
</template>
<style scoped>
.json-editor { border: 1px solid var(--bbi-line); border-radius: var(--bbi-radius-sm); margin: 18px 0; min-width: 0; }
.json-heading { display: flex; align-items: center; gap: 12px; width: 100%; padding: 16px; color: var(--bbi-ink); font: inherit; font-weight: 650; background: none; border: 0; text-align: left; cursor: pointer; }
.json-toggle { margin-left: auto; white-space: nowrap; }.json-small,.json-success { font-size: 12px; }.json-success { color: #27833d; }
.json-body { padding: 0 16px 16px; }.json-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 12px 0; }.json-save { margin-left: auto; }.json-toolbar .bbi-btn { min-height: 38px; min-width: 112px; padding: 8px 16px; font-size: 13px; }.json-status { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; padding: 0 16px 12px; }.json-status .bbi-field-hint { margin: 0; }
.json-error { color: var(--bbi-danger,#b3261e); overflow-wrap: anywhere; font-size: 13px; }
@media(max-width:520px) { .json-heading { padding: 10px; flex-wrap: wrap; }.json-body { padding: 0 10px 10px; } }
</style>
