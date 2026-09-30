import type { ComfyWorkflowPreset } from '@/state/settings';
import { validateWorkflowJson } from './comfyWorkflowControls';
import { normalizeComfyPost } from './comfyPostSettings';
import { normalizeAutoRepair } from './comfyInpaintGraph';
import { normalizeComfyFixedPrompts } from './comfyFixedPrompts';
import { normalizePromptMode } from '@/promptMode';
import { parseSize } from './size';

/** ComfyUI ignores node _meta. Keep an ordinary API graph while carrying extension options. */
export function exportWorkflowFile(preset:ComfyWorkflowPreset):string{
  const graph=JSON.parse(validateWorkflowJson(preset.workflow));
  const first=Object.values(graph)[0] as Record<string,unknown>;
  first._meta={...(first._meta as object??{}),changye:{version:1,
    name:preset.name,promptMode:preset.promptMode,negativeEnabled:preset.negativeEnabled!==false,
    generateNegative:preset.generateNegative!==false,defaultSize:preset.defaultSize,
    portraitSize:preset.portraitSize,landscapeSize:preset.landscapeSize,
    fixedPrompts:normalizeComfyFixedPrompts(preset.fixedPrompts),autoRepair:normalizeAutoRepair(preset.autoRepair),
    postProcessing:normalizeComfyPost(preset.postProcessing)}};
  return JSON.stringify(graph,null,2);
}
export function readWorkflowFileOptions(workflow:string):Partial<ComfyWorkflowPreset>{
  const graph=JSON.parse(workflow);
  const raw=(Object.values(graph) as any[]).find(n=>n?._meta?.changye)?._meta.changye;
  if(!raw)return {};
  if(raw.version!==1)throw new Error('此工作流配置版本暂不支持，请更新绘图器');
  const patch:Partial<ComfyWorkflowPreset>={postProcessing:normalizeComfyPost(raw.postProcessing),autoRepair:normalizeAutoRepair(raw.autoRepair),promptMode:normalizePromptMode(raw.promptMode),negativeEnabled:raw.negativeEnabled!==false,generateNegative:raw.generateNegative!==false,fixedPrompts:normalizeComfyFixedPrompts(raw.fixedPrompts)};
  if(typeof raw.name==='string'&&raw.name.trim())patch.name=raw.name.trim();
  for(const key of ['defaultSize','portraitSize','landscapeSize'] as const)if(typeof raw[key]==='string'&&parseSize(raw[key]))patch[key]=raw[key];
  return patch;
}
