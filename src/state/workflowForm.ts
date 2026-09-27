import type { ComfyWorkflowPreset } from './settings';
import type { PromptMode } from '@/promptMode';
import type { AutoRepairSettings } from '@/backends/comfyInpaintGraph';

export interface WorkflowFormEditors {
  json?: { dirty: boolean; prepare(): string };
  model?: { dirty: boolean; prepare(workflow: string): { workflow: string; promptMode: PromptMode } };
  lora?: { dirty: boolean; prepare(workflow: string): string };
  size?: { prepare(): string };
  repair?: { prepareDraft(): AutoRepairSettings };
}

/** Validate every editor before returning a patch. Never partially mutate a workflow. */
export function prepareWorkflowForm(target: ComfyWorkflowPreset, editors: WorkflowFormEditors, applyJson: boolean) {
  if (editors.json?.dirty) {
    if (!applyJson) throw new Error('JSON 尚未应用');
    if (editors.model?.dirty || editors.lora?.dirty) throw new Error('JSON 与模型或 LoRA 同时有未应用修改，请先处理 JSON，再修改对应控件，避免互相覆盖');
  }
  let workflow = applyJson ? editors.json?.prepare() ?? target.workflow : target.workflow;
  const model = editors.model?.prepare(workflow);
  if (model) workflow = model.workflow;
  workflow = editors.lora?.prepare(workflow) ?? workflow;
  return {
    workflow,
    promptMode: model?.promptMode ?? target.promptMode,
    defaultSize: editors.size?.prepare() ?? target.defaultSize,
    autoRepair: editors.repair?.prepareDraft() ?? target.autoRepair,
  };
}
