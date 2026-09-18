<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { validateLoraFavorites, type ComfyLoraFavorite } from '@/backends/comfyLoraFavorites';
import BbiTextarea from '@/components/BbiTextarea.vue';
const props = defineProps<{ modelValue: ComfyLoraFavorite[]; canAdd: boolean }>();
const emit = defineEmits<{ (event: 'update:modelValue', value: ComfyLoraFavorite[]): void; (event: 'use', tags: string[]): void }>();
let sequence = 0;
const rows = ref<(ComfyLoraFavorite & { id: number; selected: boolean })[]>([]);
const tag = ref(''), note = ref(''), error = ref(''), message = ref('');
const values = computed(() => rows.value.map(({ tag, note }) => ({ tag, note })));
watch(() => props.modelValue, value => {
  if (JSON.stringify(value) === JSON.stringify(values.value)) return;
  rows.value = value.map((row, index) => ({ ...row, id: ++sequence, selected: rows.value[index]?.selected ?? false }));
}, { immediate: true, deep: true });
const selected = computed(() => rows.value.filter(row => row.selected));
const allSelected = computed(() => rows.value.length > 0 && selected.value.length === rows.value.length);
watch(values, () => { message.value = ''; error.value = ''; }, { deep: true, flush: 'sync' });
async function persist(next: typeof rows.value, notice = '已自动保存') {
  const validated = validateLoraFavorites(next);
  rows.value = next.map((row, index) => ({ ...row, ...validated[index]! }));
  emit('update:modelValue', validated);
  await nextTick(); message.value = notice; error.value = '';
}
async function add() {
  try {
    const item = validateLoraFavorites([{ tag: tag.value, note: note.value }])[0]!;
    if (validateLoraFavorites(values.value).some(row => row.tag === item.tag)) throw new Error('该标签已在收藏库中，可直接修改已有备注。');
    await persist([...rows.value, { ...item, id: ++sequence, selected: false }], '已加入收藏');
    tag.value = ''; note.value = '';
  } catch (e) { error.value = e instanceof Error ? e.message : String(e); }
}
async function saveEdits() {
  if (JSON.stringify(values.value) === JSON.stringify(props.modelValue)) return;
  try { await persist(rows.value); }
  catch (e) { error.value = e instanceof Error ? e.message : String(e); }
}
async function remove(index: number) {
  try { await persist(rows.value.filter((_, i) => i !== index)); }
  catch (e) { error.value = e instanceof Error ? e.message : String(e); }
}
function useSelected() {
  try { emit('use', validateLoraFavorites(selected.value).map(row => row.tag)); error.value = ''; }
  catch (e) { error.value = e instanceof Error ? e.message : String(e); }
}
</script>
<template>
  <section class="favorites" aria-label="常用 LoRA 标签库">
    <h3 class="bbi-field-label">常用 LoRA 标签库</h3>
    <div class="favorite-table">
      <table>
        <thead><tr><th class="selection"><input type="checkbox" class="bbi-checkbox" aria-label="全选收藏" :checked="allSelected" :indeterminate="selected.length > 0 && !allSelected" @change="rows.forEach(row => row.selected = ($event.target as HTMLInputElement).checked)" /></th><th>标签</th><th>备注</th><th class="row-action"></th></tr></thead>
        <tbody>
          <tr v-for="(row, index) in rows" :key="row.id">
            <td><input v-model="row.selected" type="checkbox" class="bbi-checkbox" :aria-label="'选择收藏 ' + (index + 1)" /></td>
            <td><BbiTextarea v-model="row.tag" @blur="saveEdits" mono :rows="1" :max-rows="4" class="table-input" :aria-label="'收藏标签 ' + (index + 1)" /></td>
            <td><BbiTextarea v-model="row.note" @blur="saveEdits" :rows="1" :max-rows="4" class="table-input" :aria-label="'收藏备注 ' + (index + 1)" /></td>
            <td><button type="button" class="delete-button" :aria-label="'删除收藏 ' + (index + 1)" @click="remove(index)">删除</button></td>
          </tr>
          <tr v-if="!rows.length"><td colspan="4" class="empty">暂无收藏</td></tr>
        </tbody>
      </table>
    </div>
    <div class="favorite-actions"><span class="bbi-field-hint">已选 {{ selected.length }} 项</span><button type="button" class="bbi-btn favorite-use" :disabled="!canAdd || !selected.length" @click="useSelected">加入LoRA堆</button></div>
    <slot />
    <div class="favorite-form">
      <div class="favorite-field"><span class="bbi-field-label">标签</span><BbiTextarea v-model="tag" mono aria-label="新收藏标签" placeholder="&lt;lora:名称:权重&gt;" /></div>
      <div class="favorite-field"><span class="bbi-field-label">备注</span><BbiTextarea v-model="note" aria-label="新收藏备注" placeholder="填写用途或适用场景" /></div>
      <div class="form-actions"><span v-if="message" class="success" role="status">✓ {{ message }}</span><button type="button" class="bbi-btn favorite-add" @click="add">加入收藏</button></div>
    </div>
    <p v-if="error" class="favorites-error" role="alert">{{ error }}</p>
  </section>
</template>
<style scoped>
.favorites { margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--bbi-line); min-width: 0; }.favorites h3 { margin: 0 0 16px; }
.favorite-table { overflow-x: auto; }table { width: 100%; table-layout: fixed; border-collapse: collapse; }th,td { padding: 8px 5px; border-bottom: 1px solid var(--bbi-line); text-align: left; font-size: 13px; vertical-align: middle; }th { background: var(--bbi-bg); }.selection { width: 30px; }.row-action { width: 42px; }
.table-input { border-color: transparent; background: transparent; padding: 4px; }.table-input:focus { border-color: var(--bbi-accent); }.delete-button { background: none; border: 0; color: var(--bbi-muted); cursor: pointer; padding: 0; white-space: nowrap; font: inherit; }.empty { text-align: center; color: var(--bbi-muted); }
.favorite-actions > .bbi-field-hint { margin: 0; }
.favorite-actions { display: flex; align-items: center; justify-content: flex-end; gap: 10px; flex-wrap: wrap; margin: 12px 0; }.favorite-form { display: grid; grid-template-columns: minmax(0,1.3fr) minmax(0,1fr); gap: 12px; border: 1px solid var(--bbi-line); padding: 14px; border-radius: var(--bbi-radius-sm); }.favorite-form .favorite-field { display: grid; gap: 6px; min-width: 0; }.form-actions { grid-column: 1 / -1; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; }.favorite-add { margin-left: auto; }.favorite-add,.favorite-use { min-height: 38px; min-width: 112px; padding: 8px 16px; font-size: 13px; }
.success { color: #27833d; font-size: 13px; }.favorites-error { color: var(--bbi-danger,#b3261e); font-size: 13px; overflow-wrap: anywhere; }
@media(max-width:520px) { .favorite-form { grid-template-columns: minmax(0,1fr); padding: 10px; }th,td { padding: 5px 2px; }.row-action { width: 36px; } }
</style>
