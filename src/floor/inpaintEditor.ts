import { h, render } from 'vue';
import InpaintEditor from './InpaintEditor.vue';
import { inpaintImage } from '@/backends/comfyInpaint';
import { normalizeInpaintTuning, validateInpaintTuning, type InpaintTuning } from '@/backends/inpaintTuning';
import { randomSeed, type ComfyImageResult } from '@/backends/comfyui';
import { activeComfyPreset, effectiveComfyConn, settings } from '@/state/settings';
import { parseImageTagContent, matchesImageTagLayout } from '@/st/imageTagRegex';
import { getContext } from '@/st/context';
import { isGenerationFloorLocked, trackGenerationOperation } from './genState';
import { saveImageResult, type BbiImageEntry } from './storage';
import { hydrateMessage } from './hydrate';
import type { PromptEditorAt } from './promptEditor';
import { beginImage, finishImage, failImage, safeHistory } from '@/state/history';
import { composeInpaintDescription } from '@/autoTag/inpaintPrompt';
import { composeComfyPositive, normalizeComfyFixedPrompts } from '@/backends/comfyFixedPrompts';

let active=false;
export function openInpaintEditor(options:{at:PromptEditorAt;entry:BbiImageEntry}):void{
  if(active){toastr.info('请先完成已打开的局部重绘','长夜的绘图器');return;}
  const root=document.getElementById('bbi-app-host')?.shadowRoot;
  if(!root)return;
  const at=options.at, originalMessage=getContext()?.chat[at.messageId];
  const check=()=>{
    const ctx=getContext(), msg=ctx?.chat[at.messageId];
    if(!ctx||!msg||ctx.getCurrentChatId()!==at.chatId||msg!==originalMessage||(msg.swipe_id??0)!==at.swipeId||!matchesImageTagLayout(msg.mes,at.tagLayout))
      throw new Error('聊天、楼层或图片位置已变化，请回到原图后重新打开局部重绘');
    if(isGenerationFloorLocked(at.chatId,at.messageId))throw new Error('本楼图片位置正在调整，请稍后重试');
  };
  const presets=settings.comfyui.workflows.map(p=>({id:p.id,name:p.name,conn:JSON.parse(JSON.stringify(effectiveComfyConn(p)))}));
  const selected=presets.find(p=>p.id===options.entry.workflowId)?.id??activeComfyPreset().id;
  const content=parseImageTagContent(options.entry.prompt);
  let resultSeed=0,closed=false;
  const container=document.createElement('div');root.appendChild(container);active=true;
  const close=()=>{if(closed)return;closed=true;render(null,container);container.remove();active=false;};
  const run=async (args:{workflow:string;mask:Blob;instruction:string;seed:number;context:number;tuning?:InpaintTuning}, signal:AbortSignal)=>{
    check();const selectedPreset=presets.find(p=>p.id===args.workflow);if(!selectedPreset)throw new Error('请选择有效的工作流');
    resultSeed=args.seed<0?randomSeed():args.seed;
    const release=trackGenerationOperation(at.chatId,at.messageId);
    const id=safeHistory(()=>beginImage({backend:'comfyui',model:`局部重绘 · ${selectedPreset.name}`,prompt:args.instruction,nl:'',negative:content.negative,characters:[],seed:resultSeed,size:content.size,floor:at.messageId,seq:at.seq}));
    try{
      const result=await inpaintImage(selectedPreset.conn,{source:options.entry.path,mask:args.mask,instruction:args.instruction,preparedPrompt:true,negative:content.negative,seed:resultSeed,context:args.context,tuning:args.tuning},signal);
      if(signal.aborted){result.revoke();throw new DOMException('已停止','AbortError');}
      if(id!==null)safeHistory(()=>finishImage(id));return result;
    }catch(e){if(id!==null)safeHistory(()=>failImage(id,e instanceof Error?e.message:String(e),signal.aborted));throw e;}
    finally{release();}
  };
  const save=async(result:ComfyImageResult)=>{
    check();const release=trackGenerationOperation(at.chatId,at.messageId);
    try{await saveImageResult(at.messageId,at.swipeId,at.seq,at.rawTag,resultSeed,result);
      const ctx=getContext();if(ctx?.getCurrentChatId()===at.chatId)hydrateMessage(at.messageId,ctx);
    }finally{release();}
  };
  render(h(InpaintEditor,{source:options.entry.path,workflowId:selected,workflowOptions:presets.map(p=>({value:p.id,label:p.name})),
    promptModes:Object.fromEntries(presets.map(p=>[p.id,p.conn.promptMode??'anima'])),
    compose:async(id:string,instruction:string,signal:AbortSignal)=>{
      check();const preset=presets.find(p=>p.id===id);if(!preset)throw new Error('请选择有效的工作流');
      const text=await composeInpaintDescription({instruction,original:[content.tag,content.nl].filter(Boolean).join('\n\n'),promptMode:preset.conn.promptMode},signal);
      signal.throwIfAborted();check();return composeComfyPositive(text,normalizeComfyFixedPrompts(preset.conn.fixedPrompts));
    },
    profiles:Object.fromEntries(presets.map(p=>[p.id,normalizeInpaintTuning(settings.inpaintProfiles?.[p.id])])),
    saveDefaults:(id:string,tuning:InpaintTuning)=>{validateInpaintTuning(tuning);settings.inpaintProfiles={...settings.inpaintProfiles,[id]:{...tuning}};},
    missingWorkflow:!options.entry.workflowId,run,save,onClose:close}),container);
}
