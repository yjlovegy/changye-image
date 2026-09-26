<script setup lang="ts">
import { computed, ref } from 'vue';
import Collapsible from '@/components/Collapsible.vue';
import { normalizeAutoRepair } from '@/backends/comfyInpaintGraph';
import { checkInpaintSupport } from '@/backends/comfyInpaint';
import { effectiveComfyConn, type ComfyWorkflowPreset } from '@/state/settings';
const props=defineProps<{preset:ComfyWorkflowPreset}>();
const draft=ref(normalizeAutoRepair(props.preset.autoRepair));
const busy=ref(false), status=ref('');
const dirty=computed(()=>JSON.stringify(draft.value)!==JSON.stringify(normalizeAutoRepair(props.preset.autoRepair)));
async function prepare(workflow = props.preset.workflow){
 if(busy.value)throw new Error('自动修复依赖正在检查，请稍后');
 if(draft.value.enabled&&!draft.value.hands&&!draft.value.feet)throw new Error('请至少选择手部或脚部');
 if(dirty.value&&draft.value.enabled)await checkInpaintSupport({...effectiveComfyConn(props.preset),workflow},true);
 return {...draft.value};
}
defineExpose({ dirty, prepare });
async function save(){
 if(busy.value)return;
 if(draft.value.enabled&&!draft.value.hands&&!draft.value.feet){status.value='请至少选择手部或脚部';return;}
 busy.value=true;status.value='';
 try{if(draft.value.enabled)await checkInpaintSupport(effectiveComfyConn(props.preset),true);props.preset.autoRepair={...draft.value};status.value='已更新，待保存当前工作流';}
 catch(e){status.value=e instanceof Error?e.message:String(e);}finally{busy.value=false;}
}
</script>
<template>
 <Collapsible class="repair" title="出图后自动修复" :open="false">
  <div class="repair-row"><span class="bbi-field-label">自动修复</span><button class="bbi-toggle" type="button" role="switch" :aria-checked="draft.enabled" aria-label="自动修复" :class="{'is-on':draft.enabled}" :disabled="busy" @click="draft.enabled=!draft.enabled;status=''"/></div>
  <p class="bbi-field-hint">每次出图后，对检测到的指定部位进行一次局部重绘。</p>
  <div class="parts"><label><input v-model="draft.hands" type="checkbox" :disabled="!draft.enabled||busy">手部</label><label><input v-model="draft.feet" type="checkbox" :disabled="!draft.enabled||busy">脚部</label></div>
  <p class="bbi-field-hint">保留修复前的原图，修复结果另存为一个版本。识别部位不等于判断画错，可与原图对比。</p>
  <footer><span role="status" class="bbi-field-hint">{{status}}</span><button class="bbi-btn" :disabled="busy" @click="save">{{busy?'检查依赖…':'保存修复设置'}}</button></footer>
 </Collapsible>
</template>
<style scoped>
.bbi-toggle{width:44px;height:25px;border:1px solid var(--bbi-line-strong);border-radius:20px;background:var(--bbi-surface-2);padding:3px;cursor:pointer;display:flex;align-items:center}.bbi-toggle::after{content:'';width:17px;height:17px;border-radius:50%;background:var(--bbi-ink-muted);transition:transform .15s}.bbi-toggle.is-on{background:var(--bbi-accent)}.bbi-toggle.is-on::after{background:white;transform:translateX(18px)}.bbi-toggle:focus-visible{outline:2px solid var(--bbi-accent);outline-offset:3px}
.repair{margin:18px 0}.repair-row,footer{display:flex;align-items:center;justify-content:space-between;gap:14px}.parts{display:flex;gap:30px;margin:20px 0}.parts label{display:flex;align-items:center;gap:8px}.parts input{accent-color:var(--bbi-accent);width:16px;height:16px}footer{margin-top:18px}.bbi-btn{flex-shrink:0;justify-content:center}footer span{overflow-wrap:anywhere}
</style>
