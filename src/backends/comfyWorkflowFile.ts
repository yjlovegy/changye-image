import type { ComfyWorkflowPreset } from '@/state/settings';
import { validateWorkflowJson } from './comfyWorkflowControls';
import { normalizeComfyPost } from './comfyPostSettings';
import { normalizeAutoRepair } from './comfyInpaintGraph';
import { normalizeComfyFixedPrompts } from './comfyFixedPrompts';
import { normalizePromptMode } from '@/promptMode';
import { parseSize } from './size';
import { normalizeSimpleConfig } from './comfyTemplates';

export function workflowExportName(name:string):string {
  const safe=name.trim().replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/[. ]+$/g,'').slice(0,120) || '未命名工作流';
  return `长夜绘图器-${safe}.json`;
}

/** Drop previous export metadata so repeated exports and LoRA backups do not nest. */
export function stripWorkflowFileOptions(workflow:string):string {
  const graph=JSON.parse(workflow);
  for(const node of Object.values(graph) as any[]) if(node?._meta) delete node._meta.changye;
  return JSON.stringify(graph,null,2);
}

function metadata(workflow:string) {
  const graph=JSON.parse(workflow);
  return (Object.values(graph) as any[]).find(n=>n?._meta?.changye)?._meta.changye;
}

export function readWorkflowFileExample(workflow:string):string|null|undefined {
  const raw=metadata(workflow);
  if(!raw || !Object.hasOwn(raw,'exampleImageData'))return undefined;
  if(raw.exampleImageData===null)return null;
  const data=raw.exampleImageData;
  if(typeof data!=='string' || data.length>28_000_000 || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(data))throw new Error('工作流示例图数据无效');
  return data;
}

/** ComfyUI ignores node _meta. Keep an ordinary API graph while carrying extension options. */
export function exportWorkflowFile(preset:ComfyWorkflowPreset,exampleImageData?:string|null):string{
  const graph=JSON.parse(stripWorkflowFileOptions(validateWorkflowJson(preset.workflow)));
  const first=Object.values(graph)[0] as Record<string,unknown>;
  first._meta={...(first._meta as object??{}),changye:{version:2,
    name:preset.name,promptMode:preset.promptMode,negativeEnabled:preset.negativeEnabled!==false,
    generateNegative:preset.generateNegative!==false,defaultSize:preset.defaultSize,
    portraitSize:preset.portraitSize,landscapeSize:preset.landscapeSize,
    fixedPrompts:normalizeComfyFixedPrompts(preset.fixedPrompts),autoRepair:normalizeAutoRepair(preset.autoRepair),
    postProcessing:normalizeComfyPost(preset.postProcessing),
    mode:'custom',naturalLanguage:preset.naturalLanguage,simple:normalizeSimpleConfig(preset.simple),
    loraWorkflowBackup:preset.loraWorkflowBackup ? stripWorkflowFileOptions(preset.loraWorkflowBackup) : '',
    legacyCustomWorkflow:preset.legacyCustomWorkflow ? stripWorkflowFileOptions(preset.legacyCustomWorkflow) : '',
    ...(exampleImageData!==undefined?{exampleImageData}:{})}};
  return JSON.stringify(graph,null,2);
}
export function readWorkflowFileOptions(workflow:string):Partial<ComfyWorkflowPreset>{
  const raw=metadata(workflow);
  if(!raw)return {};
  if(raw.version!==1 && raw.version!==2)throw new Error('此工作流配置版本暂不支持，请更新绘图器');
  const patch:Partial<ComfyWorkflowPreset>={postProcessing:normalizeComfyPost(raw.postProcessing),autoRepair:normalizeAutoRepair(raw.autoRepair),promptMode:normalizePromptMode(raw.promptMode),negativeEnabled:raw.negativeEnabled!==false,generateNegative:raw.generateNegative!==false,fixedPrompts:normalizeComfyFixedPrompts(raw.fixedPrompts)};
  if(typeof raw.name==='string'&&raw.name.trim())patch.name=raw.name.trim();
  for(const key of ['defaultSize','portraitSize','landscapeSize'] as const)if(typeof raw[key]==='string'&&parseSize(raw[key]))patch[key]=raw[key];
  if(raw.version===2){
    patch.mode='custom';patch.naturalLanguage=raw.naturalLanguage===true;patch.simple=normalizeSimpleConfig(raw.simple);
    for(const key of ['loraWorkflowBackup','legacyCustomWorkflow'] as const){
      if(typeof raw[key]!=='string')throw new Error('工作流备份配置无效');
      patch[key]=raw[key].trim()?stripWorkflowFileOptions(validateWorkflowJson(raw[key])):'';
    }
    readWorkflowFileExample(workflow);
  }
  return patch;
}
