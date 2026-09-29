<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import Icon from '@/components/Icon.vue';
import BbiSelect from '@/components/BbiSelect.vue';
import ModalMask from '@/components/ModalMask.vue';
import InpaintComparison from './InpaintComparison.vue';
import { confirmDialog } from '@/components/confirm';
import type { ComfyImageResult } from '@/backends/comfyui';
import { imageAbortError, trackImageTask } from '@/state/imageTasks';
import { trackPromptTask } from '@/state/promptTasks';
import { normalizeInpaintTuning, validateInpaintTuning, applyInpaintPreset, type InpaintTuning, type InpaintMode } from '@/backends/inpaintTuning';
import { maskBounds } from '@/backends/inpaintComposite';
import { inpaintReferenceRect, type InpaintRect } from '@/backends/inpaintReference';
const props=defineProps<{
 source:string;workflowId:string;workflowOptions:{value:string;label:string}[];missingWorkflow?:boolean;
 profiles?:Record<string,InpaintTuning>;saveDefaults?:(id:string,tuning:InpaintTuning)=>void;
 promptModes?:Record<string,string>;
 compose?:(workflow:string,instruction:string,signal:AbortSignal)=>Promise<string>;
 run:(args:{workflow:string;mask:Blob;instruction:string;seed:number;context:number;tuning:InpaintTuning},signal:AbortSignal)=>Promise<ComfyImageResult>;
 save:(result:ComfyImageResult)=>Promise<void>;
}>();
const emit=defineEmits<{(e:'close'):void}>();
type Stroke={points:{x:number,y:number}[];size:number;erase:boolean};
const workflow=ref(props.workflowId),instruction=ref(''),seed=ref(-1);
const description=ref(''),draftStale=ref(false),composing=ref(false),draftEdited=ref(false);
const natural=computed(()=>props.promptModes?.[workflow.value]==='krea2');
watch([workflow,instruction],()=>{if(description.value.trim())draftStale.value=true;});
function editDescription(){draftStale.value=false;draftEdited.value=true;notice.value='';}
const localProfiles={...props.profiles};
const tuning=ref(normalizeInpaintTuning(localProfiles[workflow.value])),stepInput=ref(''),cfgInput=ref('');
function loadTuning(){tuning.value=normalizeInpaintTuning(localProfiles[workflow.value]);stepInput.value=tuning.value.steps?.toString()??'';cfgInput.value=tuning.value.cfg?.toString()??'';}
loadTuning();watch(workflow,loadTuning);
function selectMode(value:string){tuning.value=applyInpaintPreset(tuning.value,value as InpaintMode);}
const referenceChoice=computed({get:()=>tuning.value.reference==='full'?'full':String(tuning.value.context),set:(value:string)=>{tuning.value.reference=value==='full'?'full':'region';if(value!=='full')tuning.value.context=Number(value);}});
function collectTuning():InpaintTuning{const value={...tuning.value,steps:String(stepInput.value).trim()?Number(stepInput.value):null,cfg:String(cfgInput.value).trim()?Number(cfgInput.value):null};validateInpaintTuning(value);return value;}
function saveDefaults(){try{const value=collectTuning();props.saveDefaults?.(workflow.value,value);localProfiles[workflow.value]=value;notice.value='已保存重绘默认值';}catch(e){notice.value=e instanceof Error?e.message:String(e);}}
const width=ref(0),height=ref(0),tool=ref('brush'),brushSize=ref(44),zoom=ref(100),maskVisible=ref(true);
const referenceVisible=ref(true),showCrop=ref(false),bounds=ref<InpaintRect|null>(null);
const referenceRect=computed(()=>bounds.value?inpaintReferenceRect(bounds.value,width.value,height.value,tuning.value.context,tuning.value.reference==='full'):null);
const displayRect=computed(()=>showCrop.value&&referenceRect.value?referenceRect.value:{x:0,y:0,width:width.value||1080,height:height.value||1920});
const strokes=ref<Stroke[]>([]),redoStrokes=ref<Stroke[]>([]),notice=ref(''),busy=ref(false),saving=ref(false);
const result=ref<ComfyImageResult|null>(null),showResult=ref(false),panel=ref<HTMLElement>(),canvas=ref<SVGSVGElement>();
const ready=computed(()=>width.value>0&&height.value>0),hasMask=computed(()=>!!bounds.value);
const disabled=computed(()=>busy.value||saving.value||composing.value);
let activeStroke:Stroke|null=null,controller:AbortController|undefined,composeController:AbortController|undefined,closed=false,asking=false;
function loaded(e:Event){const image=e.target as HTMLImageElement;width.value=image.naturalWidth;height.value=image.naturalHeight;if(width.value*height.value>32_000_000)notice.value='图片超过 3200 万像素，请先缩小后重绘';}
function point(e:PointerEvent){const r=canvas.value!.getBoundingClientRect();return {x:(e.clientX-r.left)/r.width*width.value,y:(e.clientY-r.top)/r.height*height.value};}
function start(e:PointerEvent){if(disabled.value||showCrop.value||!ready.value||width.value*height.value>32_000_000||e.button!==0)return;canvas.value!.setPointerCapture(e.pointerId);maskVisible.value=true;
 const p=point(e);strokes.value.push({points:[p,p],size:brushSize.value*width.value/canvas.value!.getBoundingClientRect().width,erase:tool.value==='eraser'});activeStroke=strokes.value.at(-1)!;redoStrokes.value=[];notice.value='';}
function move(e:PointerEvent){if(activeStroke)activeStroke.points.push(point(e));}
function end(){if(activeStroke){activeStroke=null;updateBounds();}}
function undo(){const s=strokes.value.pop();if(s)redoStrokes.value.push(s);updateBounds();}
function redo(){const s=redoStrokes.value.pop();if(s)strokes.value.push(s);updateBounds();}
function clear(){strokes.value=[];redoStrokes.value=[];bounds.value=null;showCrop.value=false;}
function maskCanvas():HTMLCanvasElement{
 if(!ready.value||width.value*height.value>32_000_000)throw new Error('图片尚未载入或尺寸过大');
 const c=document.createElement('canvas');c.width=width.value;c.height=height.value;const ctx=c.getContext('2d')!;
 ctx.fillStyle='#000';ctx.fillRect(0,0,c.width,c.height);ctx.lineCap='round';ctx.lineJoin='round';
 for(const s of strokes.value){ctx.strokeStyle=s.erase?'#000':'#fff';ctx.lineWidth=s.size;ctx.beginPath();s.points.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));ctx.stroke();
  if(s.points.every(p=>p.x===s.points[0].x&&p.y===s.points[0].y)){ctx.fillStyle=ctx.strokeStyle;ctx.beginPath();ctx.arc(s.points[0].x,s.points[0].y,s.size/2,0,Math.PI*2);ctx.fill();}}
 return c;
}
function updateBounds(){try{const c=maskCanvas();bounds.value=maskBounds(c.getContext('2d')!.getImageData(0,0,c.width,c.height));}catch{bounds.value=null;}if(!bounds.value)showCrop.value=false;}
async function maskBlob():Promise<Blob>{const c=maskCanvas();return new Promise((resolve,reject)=>c.toBlob(b=>b?resolve(b):reject(new Error('无法生成选区图片')),'image/png'));}
async function compose(){
 if(disabled.value)return;
 if(!instruction.value.trim()){notice.value='请先填写修改要求';return;}
 if(!props.compose){notice.value='无法整理画面描述，请直接填写';return;}
 if(description.value.trim()&&draftEdited.value){asking=true;const ok=await confirmDialog({title:'重新整理画面描述',text:'将替换当前手动编辑的画面描述。',confirmText:'重新整理',cancelText:'保留草稿'});asking=false;if(!ok||closed)return;}
 composing.value=true;notice.value='';composeController=new AbortController();const current=composeController;
 const untrack=trackPromptTask(current);
 try{const next=await props.compose(workflow.value,instruction.value.trim(),current.signal);if(closed||current.signal.aborted)return;
  description.value=next;draftStale.value=false;draftEdited.value=false;
 }catch(e){notice.value=current.signal.aborted?'已停止整理，原草稿已保留':e instanceof Error?e.message:String(e);}
 finally{untrack();if(composeController===current){composeController=undefined;composing.value=false;}}
}
async function generate(){
 if(disabled.value)return;
 if(!hasMask.value){notice.value='请先涂选要修改的区域';return;}
 if(!description.value.trim()){notice.value='请先整理或直接填写画面描述';return;}
 if(draftStale.value){notice.value='修改要求或工作流已变化，请重新整理，或编辑画面描述后再重绘';return;}
 if(!Number.isSafeInteger(seed.value)||seed.value< -1){notice.value='随机种子应为 −1 或非负整数';return;}
 let options:InpaintTuning;try{options=collectTuning();}catch(e){notice.value=e instanceof Error?e.message:String(e);return;}
 busy.value=true;notice.value='';controller=new AbortController();const current=controller;
 const untrack=trackImageTask(current);
 try{const mask=await maskBlob();if(current.signal.aborted)throw imageAbortError();
  const next=await props.run({workflow:workflow.value,mask,instruction:description.value.trim(),seed:seed.value,context:options.context,tuning:options},current.signal);
  if(closed||current.signal.aborted){next.revoke();return;}result.value?.revoke();result.value=next;showResult.value=true;
 }catch(e){notice.value=current.signal.aborted?'已停止，选区与修改要求已保留':e instanceof Error?e.message:String(e);}
 finally{untrack();if(controller===current){busy.value=false;controller=undefined;}}
}
async function save(){if(!result.value||disabled.value)return;saving.value=true;notice.value='';try{await props.save(result.value);emit('close');}catch(e){notice.value=e instanceof Error?e.message:String(e);}finally{saving.value=false;}}
async function close(){if(saving.value||asking)return;if(busy.value||composing.value||strokes.value.length||instruction.value.trim()||description.value.trim()||result.value){asking=true;
  const ok=await confirmDialog({title:'关闭局部重绘',text:busy.value||composing.value?'将停止本次请求，原图保留。':'选区、画面描述和未保存结果将被丢弃，原图保留。',confirmText:'关闭',cancelText:'继续编辑'});asking=false;if(!ok)return;}
 controller?.abort();composeController?.abort();emit('close');}
function keydown(e:KeyboardEvent){if(asking)return;if(e.key==='Escape'){e.stopPropagation();e.preventDefault();void close();}
 if(e.key==='Tab'){const root=panel.value;const items=[...root?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),summary,[tabindex="0"]')??[]].filter(el=>el.offsetParent!==null);
  const focused=(root?.getRootNode() as ShadowRoot)?.activeElement;if(e.shiftKey&&focused===items[0]){e.preventDefault();items.at(-1)?.focus();}else if(!e.shiftKey&&focused===items.at(-1)){e.preventDefault();items[0]?.focus();}}}
onMounted(()=>panel.value?.querySelector<HTMLButtonElement>('.editor-head button')?.focus({preventScroll:true}));
onBeforeUnmount(()=>{closed=true;controller?.abort();composeController?.abort();result.value?.revoke();});
</script>
<template>
 <ModalMask :open="true" @close="close"><section ref="panel" class="inpaint-editor" role="dialog" aria-modal="true" aria-label="手动局部重绘" @keydown="keydown">
  <header class="editor-head"><div><h2><Icon name="prompt" :size="22"/>手动局部重绘</h2><p>涂选修改区域，确认画面描述后重绘。</p></div><button class="icon-button" title="关闭" aria-label="关闭局部重绘" :disabled="saving" @click="close"><Icon name="close" :size="22"/></button></header>
  <div v-if="!showResult" class="editor-layout">
   <section class="canvas-column" aria-label="选区编辑器"><div class="brush-toolbar">
    <button class="icon-button" :class="{selected:tool==='brush'}" :aria-pressed="tool==='brush'" title="画笔" aria-label="画笔" :disabled="disabled||showCrop" @click="tool='brush'"><Icon name="edit"/></button>
    <button class="icon-button" :class="{selected:tool==='eraser'}" :aria-pressed="tool==='eraser'" title="橡皮擦" aria-label="橡皮擦" :disabled="disabled||showCrop" @click="tool='eraser'"><svg viewBox="0 0 24 24"><path d="m4 14 10-10 7 7-10 10H8l-4-4zM9 9l7 7M11 21h10"/></svg></button>
    <button class="icon-button" title="撤销" aria-label="撤销" :disabled="disabled||!strokes.length" @click="undo">↶</button><button class="icon-button" title="重做" aria-label="重做" :disabled="disabled||!redoStrokes.length" @click="redo">↷</button><button class="icon-button" title="清空选区" aria-label="清空选区" :disabled="disabled||!strokes.length" @click="clear"><Icon name="trash"/></button>
    <label class="brush-control">笔刷<input v-model.number="brushSize" aria-label="笔刷大小" type="range" min="8" max="100" :disabled="disabled||showCrop"><output>{{brushSize}}</output></label>
   </div><div class="canvas-viewport"><div class="canvas-frame" :style="{height:'calc(var(--canvas-height, 480px) * '+zoom/100+')',aspectRatio:`${displayRect.width}/${displayRect.height}`}">
    <img class="source-loader" :src="source" alt="待重绘的当前图片" draggable="false" @load="loaded" @error="notice='无法读取原图，请确认图片文件仍然存在'"/>
    <svg ref="canvas" class="mask-canvas" :class="{cropped:showCrop}" :viewBox="`${displayRect.x} ${displayRect.y} ${displayRect.width} ${displayRect.height}`" aria-label="拖动画笔涂选修改区域" @pointerdown="start" @pointermove="move" @pointerup="end" @pointercancel="end" @lostpointercapture="end">
     <image :href="source" :width="width" :height="height"/>
     <defs><mask id="cy-inpaint-mask"><rect :width="width" :height="height" fill="black"/><g v-for="(s,i) in strokes" :key="i"><polyline :points="s.points.map(p=>`${p.x},${p.y}`).join(' ')" :stroke="s.erase?'black':'white'" :stroke-width="s.size" stroke-linecap="round" stroke-linejoin="round" fill="none"/><circle v-if="s.points.every(p=>p.x===s.points[0].x&amp;&amp;p.y===s.points[0].y)" :cx="s.points[0].x" :cy="s.points[0].y" :r="s.size/2" :fill="s.erase?'black':'white'"/></g></mask></defs>
     <rect v-show="maskVisible" :width="width" :height="height" fill="#f6bd4f" opacity=".62" mask="url(#cy-inpaint-mask)"/>
     <rect v-if="referenceVisible&amp;&amp;referenceRect&amp;&amp;!showCrop" :x="referenceRect.x" :y="referenceRect.y" :width="referenceRect.width" :height="referenceRect.height" fill="#569ee8" fill-opacity=".06" stroke="#83c4ff" stroke-width="2" stroke-dasharray="7 4" vector-effect="non-scaling-stroke"/>
    </svg>
   </div></div>
   <div class="canvas-footer"><div class="legend"><label><input v-model="maskVisible" type="checkbox"><i class="yellow"/>修改区</label><label><input v-model="referenceVisible" type="checkbox"><i class="blue"/>参考范围</label></div><div><button class="icon-button" aria-label="缩小" :disabled="zoom<=100" @click="zoom=Math.max(100,zoom-25)">−</button><span>{{zoom}}%</span><button class="icon-button" aria-label="放大" :disabled="zoom>=250" @click="zoom=Math.min(250,zoom+25)">＋</button><button class="text-button" @click="zoom=100">适应</button></div></div>
   <div class="reference-controls"><div class="reference-heading"><div><strong>参考范围</strong><p class="muted">最终仅替换黄色选区</p></div><button class="text-button" :disabled="!hasMask" @click="showCrop=!showCrop;zoom=100">{{showCrop?'返回整图':'查看参考裁图'}}</button></div><BbiSelect v-model="referenceChoice" :options="[{value:'1.2',label:'较小 · 1.2 倍'},{value:'1.5',label:'紧凑 · 1.5 倍'},{value:'2',label:'较大 · 2 倍'},{value:'3',label:'更大 · 3 倍'},{value:'full',label:'整图参考'}]" aria-label="参考范围" :disabled="disabled"/></div>
   </section>
   <aside class="settings-column">
    <div class="field"><span class="field-label">重绘工作流</span><BbiSelect v-model="workflow" :options="workflowOptions" aria-label="重绘工作流" :disabled="disabled"/><p v-if="missingWorkflow" class="muted">旧图没有工作流记录，请确认所选工作流。</p></div>
    <div class="field"><span class="field-label">修改类型</span><div class="mode-buttons"><button v-for="(name,key) in {touchup:'换颜色',repair:'修结构',replace:'替换内容'}" :key="key" :aria-pressed="tuning.mode===key" :class="{selected:tuning.mode===key}" :disabled="disabled" @click="selectMode(key)">{{name}}</button></div></div>
    <div class="field"><label for="cy-inpaint-instruction">修改要求</label><textarea id="cy-inpaint-instruction" v-model="instruction" :disabled="disabled" rows="2" placeholder="例如：将内搭改成深蓝色，保留外套和原来的姿势。"/></div>
    <div class="compose-row"><span class="muted">{{natural?'Krea2 · 英文自然语言':'Anima · TAG + 英文描述'}}</span><button v-if="composing" class="bbi-btn" @click="composeController?.abort()">停止整理</button><button v-else class="bbi-btn" :disabled="disabled||!instruction.trim()" @click="compose"><Icon name="prompt" :size="16"/>整理画面描述</button></div>
    <div class="draft-box"><div class="draft-heading"><label for="cy-inpaint-description">画面描述 <small>可编辑</small></label><span :class="{stale:draftStale}">{{draftStale?'要求已变化':draftEdited?'已手动编辑':description?'已整理':''}}</span></div><textarea id="cy-inpaint-description" v-model="description" :disabled="disabled" @input="editDescription" rows="6" placeholder="在这里确认选区修改完成后的画面描述，也可直接填写英文提示词。" spellcheck="false"/></div>
    <div class="parameter-heading"><strong>重绘参数</strong><button class="text-button" :disabled="disabled" @click="selectMode(tuning.mode)">恢复此类型预设</button></div>
    <div class="quick-grid"><div class="field"><label for="cy-inpaint-strength">强度</label><input id="cy-inpaint-strength" v-model.number="tuning.denoise" type="number" min="0.05" max="1" step="0.05" :disabled="disabled"></div><div class="field"><span class="field-label">分辨率</span><BbiSelect v-model="tuning.resolution" :options="[{value:'auto',label:'自动'},{value:'768',label:'768'},{value:'1024',label:'1024'},{value:'1536',label:'1536'}]" aria-label="重绘分辨率" :disabled="disabled"/></div><div class="field"><label for="cy-inpaint-thinking">细化次数</label><input id="cy-inpaint-thinking" v-model.number="tuning.thinkingSteps" type="number" min="1" max="10" step="1" :disabled="disabled"></div></div>
    <div class="field"><span class="field-label">优先方式</span><BbiSelect v-model="tuning.promptMode" :options="[{value:'Image First',label:'保留原图结构与风格'},{value:'Prompt First',label:'优先满足修改要求'}]" aria-label="重绘优先方式" :disabled="disabled"/></div>
    <details class="advanced"><summary>更多参数</summary>
     <div class="parameter-grid"><div class="field"><label for="cy-inpaint-steps">采样步数</label><input id="cy-inpaint-steps" v-model="stepInput" placeholder="跟随工作流" type="number" min="1" max="100" step="1" :disabled="disabled"></div><div class="field"><label for="cy-inpaint-cfg">CFG</label><input id="cy-inpaint-cfg" v-model="cfgInput" placeholder="跟随工作流" type="number" min="0" max="30" step="0.1" :disabled="disabled"></div></div>
     <div class="parameter-grid"><div class="field"><label for="cy-inpaint-feather">边缘柔化（px）</label><input id="cy-inpaint-feather" v-model.number="tuning.feather" type="number" min="0" max="32" step="1" :disabled="disabled"></div><div class="field"><label for="cy-inpaint-seed">随机种子</label><input id="cy-inpaint-seed" v-model.number="seed" type="number" min="-1" step="1" :disabled="disabled"><p class="muted">−1 表示每次随机。</p></div></div>
    </details>
    <button v-if="props.saveDefaults" class="bbi-btn defaults-button" :disabled="disabled" @click="saveDefaults">保存重绘默认值</button>
   </aside>
  </div>
  <InpaintComparison v-else-if="result" :source="source" :result="result.url"/>
  <p v-if="notice" class="editor-notice" role="status">{{notice}}</p>
  <footer class="editor-footer"><span role="status" class="muted">{{saving?'正在保存…':composing?'正在整理画面描述…':busy?'正在局部重绘…':showResult?'另存为新版本，原图保留。':hasMask?'原图保留 · 仅修改选区':'请先涂选修改区域'}}</span><div class="actions"><template v-if="showResult"><button class="bbi-btn" :disabled="disabled" @click="showResult=false;notice=''">继续调整</button><button class="bbi-btn bbi-btn-primary" :disabled="disabled" @click="save">保存为新版本</button></template><template v-else><button class="bbi-btn" :disabled="saving" @click="close">取消</button><button v-if="busy" class="bbi-btn" @click="controller?.abort()">停止重绘</button><button v-else class="bbi-btn bbi-btn-primary" :disabled="!ready||disabled" @click="generate"><Icon name="prompt"/>开始重绘</button></template></div></footer>
 </section></ModalMask>
</template>

<style scoped>
.editor-head,.editor-layout{flex-shrink:0}
.strength-row{display:flex;align-items:center;gap:14px}.strength-row input{flex:1;min-width:0;accent-color:var(--bbi-accent)}.strength-row output{font-variant-numeric:tabular-nums;min-width:3em;text-align:right}.parameter-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}.parameter-grid .field{min-width:0}.defaults-button{width:100%;margin-top:18px;display:flex}
.inpaint-editor{width:min(1190px,calc(100vw - 40px));max-height:calc(100dvh - 40px);overflow:auto;display:flex;flex-direction:column;background:var(--bbi-surface);color:var(--bbi-ink);border:1px solid var(--bbi-line);border-radius:16px;box-shadow:0 24px 90px #10172e4a;font:15px/1.6 var(--bbi-font-sans)}.inpaint-editor *{box-sizing:border-box}.editor-head{padding:20px 24px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--bbi-line);gap:15px}.editor-head h2{display:flex;align-items:center;gap:9px;font-size:20px;margin:0}.editor-head p{margin:3px 0 0;font-size:13px;color:var(--bbi-ink-muted)}.icon-button{width:36px;height:36px;flex-shrink:0;border:0;border-radius:7px;background:transparent;color:inherit;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;font:20px var(--bbi-font-sans)}.icon-button svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}.icon-button:hover{background:var(--bbi-surface-2)}.icon-button.selected{color:var(--bbi-accent);background:var(--bbi-accent-soft)}.icon-button:disabled{opacity:.35;cursor:not-allowed}.editor-layout{display:grid;grid-template-columns:minmax(0,1fr) 346px;min-height:0}.canvas-column{min-width:0;border-right:1px solid var(--bbi-line);background:var(--bbi-bg)}.brush-toolbar{display:flex;align-items:center;gap:5px;flex-wrap:wrap;padding:10px 16px;border-bottom:1px solid var(--bbi-line);background:var(--bbi-surface)}.brush-control{display:flex;align-items:center;gap:9px;margin-left:8px;font-size:12px;color:var(--bbi-ink-muted)}.brush-control input{width:95px;accent-color:var(--bbi-accent)}.canvas-viewport{height:506px;padding:13px;overflow:auto;background-image:radial-gradient(#93918c22 1px,transparent 1px);background-size:16px 16px}.canvas-frame{position:relative;margin:auto;box-shadow:0 4px 15px #1113}.canvas-frame img{width:100%;height:100%;display:block;pointer-events:none}.mask-canvas{position:absolute;inset:0;width:100%;height:100%;touch-action:none;cursor:crosshair}.canvas-footer{padding:8px 16px;display:flex;justify-content:space-between;align-items:center;border-top:1px solid var(--bbi-line);background:var(--bbi-surface);font-size:12px;color:var(--bbi-ink-muted)}.canvas-footer label,.canvas-footer>div{display:flex;align-items:center;gap:8px}input[type=checkbox]{accent-color:var(--bbi-accent);width:16px;height:16px}.text-button{background:transparent;border:0;color:var(--bbi-accent);padding:5px 7px;cursor:pointer;font:inherit}.settings-column{padding:22px;min-width:0;max-height:630px;overflow:auto}.source-chip{display:flex;align-items:center;gap:11px;padding:12px;background:var(--bbi-bg);border-radius:10px;margin-bottom:22px}.source-chip strong{display:block;font-size:13px}.source-chip span{display:block;font-size:11px;color:var(--bbi-ink-muted);margin-top:3px}.field{margin-bottom:20px}.field>label,.field-label{display:block;font-size:14px;font-weight:600;margin-bottom:9px}.field :deep(.bbi-select-box){width:100%}textarea,input[type=number]{font:inherit;border:1px solid var(--bbi-line-strong);color:inherit;background:var(--bbi-surface);border-radius:9px;padding:10px 12px;width:100%;min-height:44px;outline:none}textarea{resize:vertical;line-height:1.8;font-size:14px}button:focus-visible,input:focus-visible,textarea:focus-visible,summary:focus-visible{outline:2px solid var(--bbi-accent);outline-offset:3px}.muted{color:var(--bbi-ink-muted);font-size:12px;margin:6px 0}.advanced{margin-top:23px;border-top:1px solid var(--bbi-line);padding-top:15px;font-size:13px}.advanced summary{cursor:pointer}.advanced .field{margin-top:17px}.editor-footer{padding:17px 24px;display:flex;align-items:center;justify-content:space-between;gap:15px;border-top:1px solid var(--bbi-line);background:var(--bbi-surface);position:sticky;bottom:0;z-index:1;flex-shrink:0}.actions{display:flex;gap:10px}.bbi-btn{justify-content:center;align-items:center;white-space:nowrap;gap:8px;line-height:1.3;min-height:42px}.editor-notice{padding:10px 24px;margin:0;font-size:13px;color:var(--bbi-accent);background:var(--bbi-accent-soft);overflow-wrap:anywhere}
@media(max-width:800px){.editor-layout{grid-template-columns:minmax(0,1fr) 290px}.settings-column{padding:16px}.brush-toolbar{padding:8px}.brush-control{margin-left:0}.brush-control input{width:65px}}
@media(max-width:620px){.inpaint-editor{width:calc(100vw - 16px);max-height:calc(100dvh - 16px)}.editor-layout{grid-template-columns:1fr}.canvas-column{border-right:0}.canvas-viewport{height:365px}.canvas-frame{--canvas-height:338px}.editor-head{padding:14px}.editor-head h2{font-size:18px}.editor-head p{font-size:11px}.settings-column{max-height:none}.editor-footer{padding:12px;flex-wrap:wrap}.actions{margin-left:auto}.bbi-btn{min-height:39px;font-size:13px}}

.editor-layout{grid-template-columns:minmax(0,1.08fr) minmax(0,1fr)}.settings-column{max-height:none;padding:22px 26px}.field{margin-bottom:16px}.canvas-column{display:flex;flex-direction:column}.canvas-viewport{flex:1;min-height:506px;display:grid;align-items:center}.source-loader{visibility:hidden}.mask-canvas.cropped{cursor:default}.reference-controls{padding:16px 20px;background:var(--bbi-surface);border-top:1px solid var(--bbi-line)}.reference-heading{display:flex;justify-content:space-between;align-items:center;font-size:13px;margin-bottom:8px}.reference-heading p{margin:0}.reference-controls :deep(.bbi-select-box){width:100%}.legend{display:flex;gap:10px;flex-wrap:wrap}.legend label{gap:4px}.legend i{width:8px;height:8px;border-radius:2px}.yellow{background:#d9a02f}.blue{background:#539ad8}.canvas-footer{flex-wrap:wrap;gap:6px}.mode-buttons{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));padding:4px;gap:4px;background:var(--bbi-surface-2);border-radius:10px}.mode-buttons button{min-height:37px;font:inherit;font-size:13px;border:0;border-radius:8px;background:none;color:var(--bbi-ink-soft);cursor:pointer}.mode-buttons .selected{background:var(--bbi-surface);color:var(--bbi-accent);box-shadow:0 2px 6px #0001}.compose-row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 0 14px}.compose-row .bbi-btn{font-size:13px;min-height:36px}.draft-box{border:1px solid var(--bbi-line);border-radius:10px;background:var(--bbi-bg);padding:12px}.draft-heading{display:flex;justify-content:space-between;align-items:center;gap:6px;margin-bottom:8px;font-size:13px}.draft-heading label{font-weight:600}.draft-heading small,.draft-heading span{font-weight:400;font-size:11px;color:var(--bbi-ink-muted)}.draft-heading .stale{color:var(--bbi-accent)}.draft-box textarea{font-size:13px;line-height:1.7}.parameter-heading{display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:13px;margin:18px 0 10px}.parameter-heading button{font-size:12px}.quick-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.quick-grid .field{min-width:0}.quick-grid .field>label,.quick-grid .field-label{font-size:12px}.advanced{margin-top:12px}.text-button:disabled{opacity:.4;cursor:default}
@media(max-width:900px){.editor-layout{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}.settings-column{padding:18px}.brush-control input{width:65px}.compose-row{flex-wrap:wrap}}
@media(max-width:700px){.editor-layout{grid-template-columns:1fr}.canvas-column{border-right:0}.canvas-viewport{height:365px;min-height:365px}.canvas-frame{--canvas-height:338px}.settings-column{padding:16px}.editor-footer{flex-wrap:wrap;padding:12px}.actions{margin-left:auto}}
</style>
