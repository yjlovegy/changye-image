<script setup lang="ts">
import { computed, ref } from 'vue';
import { validResolution } from '@/backends/resolution';
import BbiSelect from '@/components/BbiSelect.vue';
const props = defineProps<{ width: number; height: number; sizes: { width: number; height: number }[]; scope: string; disabled?: boolean }>();
const emit = defineEmits<{ (e: 'change', width: number, height: number): void; (e: 'save', width: number, height: number): void; (e: 'remove', width: number, height: number): void }>();
const notice = ref('');
const custom = ref(false);
const key = (w: number,h: number) => `${w}×${h}`;
const selected = computed(() => !custom.value && props.sizes.some(s => s.width === props.width && s.height === props.height) ? key(props.width,props.height) : 'custom');
const options = computed(() => [{ value: 'custom', label: '自定义尺寸' }, ...props.sizes.map(s => ({ value: key(s.width,s.height), label: `${s.width} × ${s.height}` }))]);
const valid = computed(() => validResolution({width:props.width,height:props.height}));
function select(value: string) { custom.value = value === 'custom'; if (custom.value) { notice.value = '在下方输入宽度和高度'; return; } const [w,h] = value.split('×').map(Number); emit('change',w,h); notice.value=''; }
function change(which: 'width'|'height', event: Event) { emit('change',which === 'width' ? Number((event.target as HTMLInputElement).value) : props.width,which === 'height' ? Number((event.target as HTMLInputElement).value) : props.height); notice.value=''; }
function save() { if (!valid.value) return; const existed = props.sizes.some(s=>s.width===props.width&&s.height===props.height); emit('save',props.width,props.height); custom.value=false; notice.value=existed ? '该尺寸已在收藏中' : '已保存尺寸'; }
function remove() { emit('remove',props.width,props.height); notice.value='已从收藏移除，当前宽高保留'; }
</script>
<template>
  <fieldset class="resolution-fields" :disabled="disabled">
    <div class="preview-field"><span class="bbi-field-label">已保存尺寸</span><div class="size-select-row"><BbiSelect :model-value="selected" :options="options" :aria-label="scope + '已保存尺寸'" @update:model-value="select" /><button type="button" class="bbi-btn" :disabled="selected === 'custom'" @click="remove">删除尺寸</button></div></div>
    <div class="dimension-row">
      <div class="preview-field"><span class="bbi-field-label">宽度（px）</span><input class="bbi-input" type="number" min="64" max="4096" step="1" :value="width || ''" :aria-label="scope + '宽度'" @input="change('width',$event)" /></div>
      <span class="times" aria-hidden="true">×</span>
      <div class="preview-field"><span class="bbi-field-label">高度（px）</span><input class="bbi-input" type="number" min="64" max="4096" step="1" :value="height || ''" :aria-label="scope + '高度'" @input="change('height',$event)" /></div>
      <button type="button" class="bbi-btn" @click="emit('change',height,width)">交换宽高</button>
      <button type="button" class="bbi-btn" :disabled="!valid" @click="save">保存尺寸</button>
    </div>
    <p v-if="!valid" class="feedback error" role="alert">宽度和高度必须是 64–4096 范围内的整数。</p>
    <p v-else-if="notice" class="feedback" role="status">{{ notice }}</p>
  </fieldset>
</template>
<style scoped>
.resolution-fields{border:0;padding:0;margin:0;display:grid;gap:16px;min-width:0}.preview-field{display:grid;gap:8px;min-width:0}.bbi-field-label{margin:0}.size-select-row{display:flex;align-items:center;gap:10px;min-width:0}.size-select-row>:first-child{flex:1;min-width:0;width:0}.dimension-row{display:grid;grid-template-columns:minmax(0,1fr) 12px minmax(0,1fr) auto auto;align-items:end;gap:12px}.times{display:flex;align-items:center;justify-content:center;height:38px;color:var(--bbi-ink-muted)}.bbi-input{width:100%;min-width:0;height:38px}.bbi-btn{min-height:38px;justify-content:center;text-align:center}.feedback{margin:0;font-size:12px;color:var(--bbi-accent)}.error{color:var(--bbi-danger)}
@media(max-width:620px){.dimension-row{grid-template-columns:minmax(0,1fr) 12px minmax(0,1fr);gap:10px}.dimension-row>.bbi-btn:nth-last-child(2){grid-column:1 / 2}.dimension-row>.bbi-btn:last-child{grid-column:3 / 4}}
</style>
