<script setup lang="ts">
import {computed,ref,onBeforeUnmount} from 'vue';
import Collapsible from '@/components/Collapsible.vue';
import {normalizeComfyPost,validateComfyPost} from '@/backends/comfyPostSettings';
import {checkPostSupport,upscaleModels} from '@/backends/comfyPost';
import {effectiveComfyConn,type ComfyWorkflowPreset} from '@/state/settings';
const props=defineProps<{preset:ComfyWorkflowPreset}>();
const draft=ref(normalizeComfyPost(props.preset.postProcessing));
const dirty=computed(()=>JSON.stringify(draft.value)!==JSON.stringify(normalizeComfyPost(props.preset.postProcessing)));
const draftSignature=computed(()=>JSON.stringify(draft.value));
const disclosure=ref<InstanceType<typeof Collapsible>>();
const models=ref<string[]>([]),busy=ref(false),status=ref('');
let controller:AbortController|undefined;
const modelOptions=computed(()=>[...new Set([draft.value.upscale.model,...models.value].filter(Boolean))]);
async function refresh(){
 controller?.abort();controller=new AbortController();busy.value=true;status.value='';
 try{models.value=await upscaleModels(effectiveComfyConn(props.preset).url,AbortSignal.any([controller.signal,AbortSignal.timeout(15000)]));status.value=models.value.length?'模型列表已更新':'未找到放大模型';}
 catch(e){if(!controller.signal.aborted)status.value=e instanceof Error?e.message:String(e);}
 finally{busy.value=false;}
}
function prepareDraft(){validateComfyPost(draft.value);return normalizeComfyPost(draft.value);}
async function prepare(workflow=props.preset.workflow){const p=prepareDraft();await checkPostSupport({...effectiveComfyConn(props.preset),workflow},p);return p;}
function expand(){disclosure.value?.expand();}
defineExpose({dirty,prepareDraft,prepare,draftSignature,expand});
onBeforeUnmount(()=>controller?.abort());
const sections=[['upscale','高清放大'],['hires','高分辨率修复'],['detail','局部细节处理'],['sharpen','锐化'],['color','后期调色']] as const;
</script>
<template>
 <Collapsible ref="disclosure" class="post-process" title="高清与后期" :open="false">
  <label class="post-scale">输出倍率<select v-model.number="draft.scale" :disabled="!draft.upscale.enabled && !draft.hires.enabled" class="bbi-input" aria-label="输出倍率"><option :value="1">原尺寸</option><option :value="1.5">1.5 倍</option><option :value="2">2 倍</option><option :value="3">3 倍</option><option :value="4">4 倍</option></select></label>
  <section v-for="[key,label] in sections" :key="key" class="post-stage">
   <header><strong>{{label}}</strong><button type="button" class="post-toggle" role="switch" :aria-label="label" :aria-checked="draft[key].enabled" :class="{'is-on':draft[key].enabled}" @click="draft[key].enabled=!draft[key].enabled"/></header>
   <div v-if="draft[key].enabled" class="post-fields">
    <template v-if="key==='upscale'"><label class="post-wide">放大模型<select v-model="draft.upscale.model" class="bbi-input" aria-label="放大模型"><option v-for="model in modelOptions" :key="model" :value="model">{{model}}</option></select></label><button class="bbi-btn" type="button" :disabled="busy" @click="refresh">{{busy?'读取中…':'刷新模型'}}</button><p v-if="status" role="status">{{status}}</p></template>
    <template v-if="key==='hires'"><label>重绘强度<input v-model.number="draft.hires.denoise" class="bbi-input" aria-label="高清重绘强度" type="number" min="0.05" max="0.6" step="0.05"></label><label>采样步数<input v-model.number="draft.hires.steps" class="bbi-input" aria-label="高清采样步数" type="number" min="0" max="60" step="1"></label><span class="bbi-field-hint">步数为 0 时，跟随当前工作流。</span></template>
    <template v-if="key==='detail'"><div class="post-parts"><label><input v-model="draft.detail.face" type="checkbox">脸部</label><label><input v-model="draft.detail.eyes" type="checkbox">眼睛</label></div><label>细节强度<input v-model.number="draft.detail.denoise" class="bbi-input" aria-label="细节强度" type="number" min="0.05" max="0.7" step="0.05"></label><label>局部处理尺寸<select v-model.number="draft.detail.resolution" class="bbi-input" aria-label="局部处理尺寸"><option v-for="n in [512,768,1024,1536]" :key="n" :value="n">{{n}} px</option></select></label></template>
    <template v-if="key==='sharpen'"><label>锐化强度<input v-model.number="draft.sharpen.strength" class="bbi-input" aria-label="锐化强度" type="number" min="0" max="0.5" step="0.01"></label></template>
    <template v-if="key==='color'"><label>亮度<input v-model.number="draft.color.brightness" class="bbi-input" aria-label="后期亮度" type="number" min="0.5" max="1.5" step="0.05"></label><label>对比度<input v-model.number="draft.color.contrast" class="bbi-input" aria-label="后期对比度" type="number" min="0.5" max="1.5" step="0.05"></label><label>饱和度<input v-model.number="draft.color.saturation" class="bbi-input" aria-label="后期饱和度" type="number" min="0" max="2" step="0.05"></label></template>
   </div>
  </section>
 </Collapsible>
</template>
<style scoped>
.post-process{margin:18px 0}.post-scale{display:flex;align-items:center;gap:20px;font-weight:600}.post-scale select{max-width:180px}.post-stage{padding:18px 0;border-top:1px solid var(--bbi-line);margin-top:16px}.post-stage header{display:flex;justify-content:space-between;align-items:center;gap:16px}.post-fields{display:flex;flex-wrap:wrap;align-items:end;gap:16px;margin-top:18px}.post-fields>label{display:grid;gap:8px;flex:1 1 160px;min-width:0}.post-fields>label.post-wide{flex-basis:70%}.post-fields .bbi-input{width:100%;min-width:0}.post-fields>span,.post-fields>p{flex-basis:100%;margin:0;overflow-wrap:anywhere}.post-parts{display:flex;gap:24px;flex-basis:100%}.post-parts label{display:flex;gap:8px;align-items:center}.post-toggle{width:44px;height:25px;border:1px solid var(--bbi-line-strong);border-radius:20px;background:var(--bbi-surface-2);padding:3px;cursor:pointer;display:flex;align-items:center;flex-shrink:0}.post-toggle::after{content:'';width:17px;height:17px;border-radius:50%;background:var(--bbi-ink-muted)}.post-toggle.is-on{background:var(--bbi-accent)}.post-toggle.is-on::after{background:white;transform:translateX(18px)}.post-toggle:focus-visible{outline:2px solid var(--bbi-accent);outline-offset:3px}
</style>
