<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import ResolutionControls from '@/components/ResolutionControls.vue';
import { resolutionText, validResolution, workflowResolution } from '@/backends/resolution';
import { settings, type ComfyWorkflowPreset } from '@/state/settings';
import { saveResolutionFavorite, removeResolutionFavorite } from '@/state/resolutions';
const props = defineProps<{ preset: ComfyWorkflowPreset }>();
const draft = ref(workflowResolution(props.preset));
const saved = ref(false);
const current = computed(() => workflowResolution(props.preset));
const stored = computed(() => workflowResolution(settings.comfyui.workflows.find(p => p.id === props.preset.id) ?? props.preset));
watch(() => [props.preset.id, props.preset.defaultSize], () => { draft.value = {...current.value}; saved.value = false; }, { flush: 'sync' });
function change(width: number, height: number) { draft.value = {width,height}; saved.value = false; }
const dirty = computed(() => draft.value.width !== current.value.width || draft.value.height !== current.value.height);
function prepare() { if (!validResolution(draft.value)) throw new Error('默认尺寸无效，请检查宽高'); return resolutionText(draft.value); }
const draftSignature = computed(() => JSON.stringify(draft.value));
defineExpose({ dirty, prepare, draftSignature });
</script>
<template>
  <section class="workflow-resolution" aria-label="默认生成尺寸">
    <div class="resolution-head"><h3 class="bbi-field-label">默认生成尺寸</h3><span>当前默认：{{stored.width}} × {{stored.height}}</span></div>
    <ResolutionControls scope="工作流" :width="draft.width" :height="draft.height" :sizes="settings.comfyui.resolutionFavorites" @change="change" @save="saveResolutionFavorite" @remove="removeResolutionFavorite" />
  </section>
</template>
<style scoped>
.workflow-resolution{margin:18px 0;padding:16px;border:1px solid var(--bbi-line);border-radius:var(--bbi-radius-sm)}.resolution-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:16px}.resolution-head h3{margin:0}.resolution-head>span{font-size:12px;color:var(--bbi-ink-muted)}.resolution-actions{display:flex;justify-content:flex-end;align-items:center;gap:12px;margin-top:16px;flex-wrap:wrap}.resolution-actions>span{color:var(--bbi-accent);font-size:12px}
@media(max-width:620px){.workflow-resolution{padding:10px}}
</style>
