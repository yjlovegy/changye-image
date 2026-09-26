<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import Icon from '@/components/Icon.vue';
import BbiSelect from '@/components/BbiSelect.vue';
import ModalMask from '@/components/ModalMask.vue';
import { confirmDialog } from '@/components/confirm';
import type { ComfyImageResult } from '@/backends/comfyui';
import { imageAbortError, trackImageTask } from '@/state/imageTasks';
const props=defineProps<{
 source:string;workflowId:string;workflowOptions:{value:string;label:string}[];missingWorkflow?:boolean;
 run:(args:{workflow:string;mask:Blob;instruction:string;seed:number;context:number},signal:AbortSignal)=>Promise<ComfyImageResult>;
 save:(result:ComfyImageResult)=>Promise<void>;
}>();
const emit=defineEmits<{(e:'close'):void}>();
type Stroke={points:{x:number,y:number}[];size:number;erase:boolean};
const workflow=ref(props.workflowId),instruction=ref(''),seed=ref(-1),context=ref('1.5');
const width=ref(0),height=ref(0),tool=ref('brush'),brushSize=ref(44),zoom=ref(100),maskVisible=ref(true);
const strokes=ref<Stroke[]>([]),redoStrokes=ref<Stroke[]>([]),notice=ref(''),busy=ref(false),saving=ref(false);
const result=ref<ComfyImageResult|null>(null),showResult=ref(false),panel=ref<HTMLElement>(),canvas=ref<SVGSVGElement>();
const ready=computed(()=>width.value>0&&height.value>0),hasMask=computed(()=>strokes.value.some(s=>!s.erase));
const disabled=computed(()=>busy.value||saving.value);
let activeStroke:Stroke|null=null,controller:AbortController|undefined,closed=false,asking=false;
function loaded(e:Event){const image=e.target as HTMLImageElement;width.value=image.naturalWidth;height.value=image.naturalHeight;if(width.value*height.value>32_000_000)notice.value='图片超过 3200 万像素，请先缩小后重绘';}
function point(e:PointerEvent){const r=canvas.value!.getBoundingClientRect();return {x:(e.clientX-r.left)/r.width*width.value,y:(e.clientY-r.top)/r.height*height.value};}
function start(e:PointerEvent){if(disabled.value||!ready.value||e.button!==0)return;canvas.value!.setPointerCapture(e.pointerId);maskVisible.value=true;
 const p=point(e);strokes.value.push({points:[p,p],size:brushSize.value*width.value/canvas.value!.getBoundingClientRect().width,erase:tool.value==='eraser'});activeStroke=strokes.value.at(-1)!;redoStrokes.value=[];notice.value='';}
function move(e:PointerEvent){if(activeStroke)activeStroke.points.push(point(e));}
function end(){activeStroke=null;}
function undo(){const s=strokes.value.pop();if(s)redoStrokes.value.push(s);}
function redo(){const s=redoStrokes.value.pop();if(s)strokes.value.push(s);}
function clear(){strokes.value=[];redoStrokes.value=[];}
async function maskBlob():Promise<Blob>{
 if(!ready.value||width.value*height.value>32_000_000)throw new Error('图片尚未载入或尺寸过大');
 const c=document.createElement('canvas');c.width=width.value;c.height=height.value;const ctx=c.getContext('2d')!;
 ctx.fillStyle='#000';ctx.fillRect(0,0,c.width,c.height);ctx.lineCap='round';ctx.lineJoin='round';
 for(const s of strokes.value){ctx.strokeStyle=s.erase?'#000':'#fff';ctx.lineWidth=s.size;ctx.beginPath();s.points.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));ctx.stroke();
  if(s.points.every(p=>p.x===s.points[0].x&&p.y===s.points[0].y)){ctx.fillStyle=ctx.strokeStyle;ctx.beginPath();ctx.arc(s.points[0].x,s.points[0].y,s.size/2,0,Math.PI*2);ctx.fill();}}
 return new Promise((resolve,reject)=>c.toBlob(b=>b?resolve(b):reject(new Error('无法生成选区图片')),'image/png'));
}
async function generate(){
 if(disabled.value)return;
 if(!hasMask.value){notice.value='请先涂选要修改的区域';return;}
 if(!instruction.value.trim()){notice.value='请填写修改要求';return;}
 if(!Number.isSafeInteger(seed.value)||seed.value< -1){notice.value='随机种子应为 −1 或非负整数';return;}
 busy.value=true;notice.value='';controller=new AbortController();const current=controller;
 const untrack=trackImageTask(current);
 try{const mask=await maskBlob();if(current.signal.aborted)throw imageAbortError();
  const next=await props.run({workflow:workflow.value,mask,instruction:instruction.value.trim(),seed:seed.value,context:Number(context.value)},current.signal);
  if(closed||current.signal.aborted){next.revoke();return;}result.value?.revoke();result.value=next;showResult.value=true;
 }catch(e){notice.value=current.signal.aborted?'已停止，选区与修改要求已保留':e instanceof Error?e.message:String(e);}
 finally{untrack();if(controller===current){busy.value=false;controller=undefined;}}
}
async function save(){if(!result.value||disabled.value)return;saving.value=true;notice.value='';try{await props.save(result.value);emit('close');}catch(e){notice.value=e instanceof Error?e.message:String(e);}finally{saving.value=false;}}
async function close(){if(saving.value||asking)return;if(busy.value||strokes.value.length||instruction.value.trim()||result.value){asking=true;
  const ok=await confirmDialog({title:'关闭局部重绘',text:busy.value?'将停止本次重绘，原图保留。':'选区、修改要求和未保存结果将被丢弃，原图保留。',confirmText:'关闭',cancelText:'继续编辑'});asking=false;if(!ok)return;}
 controller?.abort();emit('close');}
function keydown(e:KeyboardEvent){if(asking)return;if(e.key==='Escape'){e.stopPropagation();e.preventDefault();void close();}
 if(e.key==='Tab'){const root=panel.value;const items=[...root?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),summary')??[]].filter(el=>el.offsetParent!==null);
  const focused=(root?.getRootNode() as ShadowRoot)?.activeElement;if(e.shiftKey&&focused===items[0]){e.preventDefault();items.at(-1)?.focus();}else if(!e.shiftKey&&focused===items.at(-1)){e.preventDefault();items[0]?.focus();}}}
onMounted(()=>panel.value?.querySelector<HTMLButtonElement>('.editor-head button')?.focus({preventScroll:true}));
onBeforeUnmount(()=>{closed=true;controller?.abort();result.value?.revoke();});
</script>
<template>
 <ModalMask :open="true" @close="close"><section ref="panel" class="inpaint-editor" role="dialog" aria-modal="true" aria-label="手动局部重绘" @keydown="keydown">
  <header class="editor-head"><div><h2><Icon name="prompt" :size="22"/>手动局部重绘</h2><p>涂选想要修改的地方，再描述目标画面。</p></div><button class="icon-button" title="关闭" aria-label="关闭局部重绘" :disabled="saving" @click="close"><Icon name="close" :size="22"/></button></header>
  <div v-if="!showResult" class="editor-layout">
   <section class="canvas-column" aria-label="选区编辑器"><div class="brush-toolbar">
    <button class="icon-button" :class="{selected:tool==='brush'}" :aria-pressed="tool==='brush'" title="画笔" aria-label="画笔" :disabled="disabled" @click="tool='brush'"><Icon name="edit"/></button>
    <button class="icon-button" :class="{selected:tool==='eraser'}" :aria-pressed="tool==='eraser'" title="橡皮擦" aria-label="橡皮擦" :disabled="disabled" @click="tool='eraser'"><svg viewBox="0 0 24 24"><path d="m4 14 10-10 7 7-10 10H8l-4-4zM9 9l7 7M11 21h10"/></svg></button>
    <button class="icon-button" title="撤销" aria-label="撤销" :disabled="disabled||!strokes.length" @click="undo">↶</button><button class="icon-button" title="重做" aria-label="重做" :disabled="disabled||!redoStrokes.length" @click="redo">↷</button><button class="icon-button" title="清空选区" aria-label="清空选区" :disabled="disabled||!strokes.length" @click="clear"><Icon name="trash"/></button>
    <label class="brush-control">笔刷<input v-model.number="brushSize" type="range" min="8" max="100" :disabled="disabled"><output>{{brushSize}}</output></label>
   </div><div class="canvas-viewport"><div class="canvas-frame" :style="{height:'calc(var(--canvas-height, 480px) * '+zoom/100+')',aspectRatio:ready?`${width}/${height}`:'9/16'}">
    <img :src="source" alt="待重绘的当前图片" draggable="false" @load="loaded" @error="notice='无法读取原图，请确认图片文件仍然存在'"/>
    <svg ref="canvas" class="mask-canvas" :viewBox="`0 0 ${width||1080} ${height||1920}`" aria-label="拖动画笔涂选修改区域" @pointerdown="start" @pointermove="move" @pointerup="end" @pointercancel="end" @lostpointercapture="end"><defs><mask id="cy-inpaint-mask"><rect :width="width" :height="height" fill="black"/><polyline v-for="(s,i) in strokes" :key="i" :points="s.points.map(p=>`${p.x},${p.y}`).join(' ')" :stroke="s.erase?'black':'white'" :stroke-width="s.size" stroke-linecap="round" stroke-linejoin="round" fill="none"/></mask></defs><rect v-show="maskVisible" :width="width" :height="height" fill="#f6bd4f" opacity=".62" mask="url(#cy-inpaint-mask)"/></svg>
   </div></div><div class="canvas-footer"><label><input v-model="maskVisible" type="checkbox">显示选区</label><div><button class="icon-button" aria-label="缩小" :disabled="zoom<=100" @click="zoom=Math.max(100,zoom-25)">−</button><span>{{zoom}}%</span><button class="icon-button" aria-label="放大" :disabled="zoom>=250" @click="zoom=Math.min(250,zoom+25)">＋</button><button class="text-button" @click="zoom=100">适应</button></div></div></section>
   <aside class="settings-column"><div class="source-chip"><Icon name="generate"/><div><strong>已载入当前图片</strong><span>{{ready?`${width} × ${height}`:'读取中…'}} · 原图保留</span></div></div>
    <div class="field"><span class="field-label">重绘工作流</span><BbiSelect v-model="workflow" :options="workflowOptions" aria-label="重绘工作流" :disabled="disabled"/><p class="muted">{{missingWorkflow?'旧图没有工作流记录，请确认所选工作流。':'沿用本图所属工作流的现有设置。'}}</p></div>
    <div class="field"><label for="cy-inpaint-instruction">修改要求</label><textarea id="cy-inpaint-instruction" v-model="instruction" :disabled="disabled" rows="5" placeholder="例如：将外袍改成深蓝色，保留金色花纹。"/></div><p class="muted">衣服、头发、物品、背景或细节，都可以涂选修改。</p>
    <details class="advanced"><summary>高级设置</summary><div class="field"><label for="cy-inpaint-seed">随机种子</label><input id="cy-inpaint-seed" v-model.number="seed" type="number" min="-1" step="1" :disabled="disabled"><p class="muted">−1 表示每次随机。</p></div><div class="field"><span class="field-label">选区周围保留范围</span><BbiSelect v-model="context" :options="[{value:'1.5',label:'自动'},{value:'1.2',label:'较小'},{value:'2',label:'较大'}]" aria-label="选区周围保留范围" :disabled="disabled"/></div></details>
   </aside>
  </div>
  <div v-else class="result-body"><h3>重绘结果</h3><div class="result-grid"><figure><figcaption>原图</figcaption><img :src="source" alt="重绘前的原图"/></figure><figure><figcaption>重绘后</figcaption><img :src="result?.url" alt="局部重绘结果"/></figure></div></div>
  <p v-if="notice" class="editor-notice" role="status">{{notice}}</p>
  <footer class="editor-footer"><span role="status" class="muted">{{saving?'正在保存…':busy?'正在局部重绘…':showResult?'另存为新版本，原图保留。':hasMask?'已选中修改区域':'请先涂选修改区域'}}</span><div class="actions"><template v-if="showResult"><button class="bbi-btn" :disabled="disabled" @click="showResult=false;notice=''">继续调整</button><button class="bbi-btn bbi-btn-primary" :disabled="disabled" @click="save">保存为新版本</button></template><template v-else><button class="bbi-btn" :disabled="saving" @click="close">取消</button><button v-if="busy" class="bbi-btn" @click="controller?.abort()">停止重绘</button><button v-else class="bbi-btn bbi-btn-primary" :disabled="!ready||saving" @click="generate"><Icon name="prompt"/>开始重绘</button></template></div></footer>
 </section></ModalMask>
</template>

<style scoped>
.inpaint-editor{width:min(1190px,calc(100vw - 40px));max-height:calc(100dvh - 40px);overflow:auto;display:flex;flex-direction:column;background:var(--bbi-surface);color:var(--bbi-ink);border:1px solid var(--bbi-line);border-radius:16px;box-shadow:0 24px 90px #10172e4a;font:15px/1.6 var(--bbi-font-sans)}.inpaint-editor *{box-sizing:border-box}.editor-head{padding:20px 24px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--bbi-line);gap:15px}.editor-head h2{display:flex;align-items:center;gap:9px;font-size:20px;margin:0}.editor-head p{margin:3px 0 0;font-size:13px;color:var(--bbi-ink-muted)}.icon-button{width:36px;height:36px;flex-shrink:0;border:0;border-radius:7px;background:transparent;color:inherit;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;font:20px var(--bbi-font-sans)}.icon-button svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}.icon-button:hover{background:var(--bbi-surface-2)}.icon-button.selected{color:var(--bbi-accent);background:var(--bbi-accent-soft)}.icon-button:disabled{opacity:.35;cursor:not-allowed}.editor-layout{display:grid;grid-template-columns:minmax(0,1fr) 346px;min-height:0}.canvas-column{min-width:0;border-right:1px solid var(--bbi-line);background:var(--bbi-bg)}.brush-toolbar{display:flex;align-items:center;gap:5px;flex-wrap:wrap;padding:10px 16px;border-bottom:1px solid var(--bbi-line);background:var(--bbi-surface)}.brush-control{display:flex;align-items:center;gap:9px;margin-left:8px;font-size:12px;color:var(--bbi-ink-muted)}.brush-control input{width:95px;accent-color:var(--bbi-accent)}.canvas-viewport{height:506px;padding:13px;overflow:auto;background-image:radial-gradient(#93918c22 1px,transparent 1px);background-size:16px 16px}.canvas-frame{position:relative;margin:auto;box-shadow:0 4px 15px #1113}.canvas-frame img{width:100%;height:100%;display:block;pointer-events:none}.mask-canvas{position:absolute;inset:0;width:100%;height:100%;touch-action:none;cursor:crosshair}.canvas-footer{padding:8px 16px;display:flex;justify-content:space-between;align-items:center;border-top:1px solid var(--bbi-line);background:var(--bbi-surface);font-size:12px;color:var(--bbi-ink-muted)}.canvas-footer label,.canvas-footer>div{display:flex;align-items:center;gap:8px}input[type=checkbox]{accent-color:var(--bbi-accent);width:16px;height:16px}.text-button{background:transparent;border:0;color:var(--bbi-accent);padding:5px 7px;cursor:pointer;font:inherit}.settings-column{padding:22px;min-width:0;max-height:630px;overflow:auto}.source-chip{display:flex;align-items:center;gap:11px;padding:12px;background:var(--bbi-bg);border-radius:10px;margin-bottom:22px}.source-chip strong{display:block;font-size:13px}.source-chip span{display:block;font-size:11px;color:var(--bbi-ink-muted);margin-top:3px}.field{margin-bottom:20px}.field>label,.field-label{display:block;font-size:14px;font-weight:600;margin-bottom:9px}.field :deep(.bbi-select-box){width:100%}textarea,input[type=number]{font:inherit;border:1px solid var(--bbi-line-strong);color:inherit;background:var(--bbi-surface);border-radius:9px;padding:10px 12px;width:100%;min-height:44px;outline:none}textarea{resize:vertical;line-height:1.8;font-size:14px}button:focus-visible,input:focus-visible,textarea:focus-visible,summary:focus-visible{outline:2px solid var(--bbi-accent);outline-offset:3px}.muted{color:var(--bbi-ink-muted);font-size:12px;margin:6px 0}.advanced{margin-top:23px;border-top:1px solid var(--bbi-line);padding-top:15px;font-size:13px}.advanced summary{cursor:pointer}.advanced .field{margin-top:17px}.editor-footer{padding:17px 24px;display:flex;align-items:center;justify-content:space-between;gap:15px;border-top:1px solid var(--bbi-line);background:var(--bbi-surface);position:sticky;bottom:0;z-index:1;flex-shrink:0}.actions{display:flex;gap:10px}.bbi-btn{justify-content:center;align-items:center;white-space:nowrap;gap:8px;line-height:1.3;min-height:42px}.editor-notice{padding:10px 24px;margin:0;font-size:13px;color:var(--bbi-accent);background:var(--bbi-accent-soft);overflow-wrap:anywhere}.result-body{padding:20px 24px;background:var(--bbi-bg)}.result-body h3{margin:0 0 15px}.result-grid{display:grid;grid-template-columns:1fr 1fr;gap:24px}.result-grid figure{min-width:0;text-align:center;margin:0}.result-grid figcaption{font-size:14px;margin-bottom:10px}.result-grid img{max-width:100%;height:430px;object-fit:contain;border-radius:8px}
@media(max-width:800px){.editor-layout{grid-template-columns:minmax(0,1fr) 290px}.settings-column{padding:16px}.brush-toolbar{padding:8px}.brush-control{margin-left:0}.brush-control input{width:65px}}
@media(max-width:620px){.inpaint-editor{width:calc(100vw - 16px);max-height:calc(100dvh - 16px)}.editor-layout{grid-template-columns:1fr}.canvas-column{border-right:0}.canvas-viewport{height:365px}.canvas-frame{--canvas-height:338px}.editor-head{padding:14px}.editor-head h2{font-size:18px}.editor-head p{font-size:11px}.settings-column{max-height:none}.editor-footer{padding:12px;flex-wrap:wrap}.actions{margin-left:auto}.bbi-btn{min-height:39px;font-size:13px}.result-grid{gap:10px}.result-grid img{height:280px}}
</style>
