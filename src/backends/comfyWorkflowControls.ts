import { getWorkflowPlaceholders, parseWorkflowTemplate } from './comfyui';
import type { ComfyModelLists } from './comfyObjectInfo';

export interface WorkflowField {
  id: string; nodeId: string; input: string; label: string; value: string | number;
  options?: keyof Pick<ComfyModelLists, 'checkpoints' | 'unets' | 'ggufs' | 'clips' | 'vaes' | 'samplers' | 'schedulers' | 'encoderTypes' | 'dualEncoderTypes'>;
  min?: number; max?: number; step?: number;
}
type Spec = Omit<WorkflowField, 'id' | 'nodeId' | 'value'>;
const fields: Record<string, Spec[]> = {
  UNETLoader: [{ input: 'unet_name', label: '主模型（UNet）', options: 'unets' }],
  UnetLoaderGGUF: [{ input: 'unet_name', label: '主模型（GGUF）', options: 'ggufs' }],
  CheckpointLoaderSimple: [{ input: 'ckpt_name', label: '主模型（Checkpoint）', options: 'checkpoints' }],
  CLIPLoader: [{ input: 'clip_name', label: '文本编码器（CLIP）', options: 'clips' }, { input: 'type', label: '编码器类型', options: 'encoderTypes' }],
  DualCLIPLoader: [{ input: 'clip_name1', label: '文本编码器 1', options: 'clips' }, { input: 'clip_name2', label: '文本编码器 2', options: 'clips' }, { input: 'type', label: '编码器类型', options: 'dualEncoderTypes' }],
  VAELoader: [{ input: 'vae_name', label: 'VAE', options: 'vaes' }],
  KSampler: [
    { input: 'sampler_name', label: '采样器', options: 'samplers' },
    { input: 'scheduler', label: '调度器', options: 'schedulers' },
    { input: 'steps', label: '采样步数', min: 1, max: 10000, step: 1 },
    { input: 'cfg', label: 'CFG', min: 0, max: 100, step: 0.1 },
    { input: 'denoise', label: '降噪强度', min: 0, max: 1, step: 0.01 },
  ],
};

export function inspectWorkflowFields(text: string): { fields: WorkflowField[]; warnings: string[] } {
  const graph = parseWorkflowTemplate(text);
  const result: WorkflowField[] = [], warnings: string[] = [];
  for (const [nodeId, node] of Object.entries(graph)) {
    if (typeof node.class_type !== 'string' || !node.inputs || typeof node.inputs !== 'object' || Array.isArray(node.inputs)) continue;
    const inputs = node.inputs as Record<string, unknown>;
    for (const spec of fields[node.class_type] ?? []) {
      const value = inputs[spec.input];
      if ((spec.options && typeof value === 'string' && !value.includes('%'))
        || (!spec.options && typeof value === 'number' && Number.isFinite(value))) {
        result.push({ ...spec, nodeId, id: `${nodeId}/${spec.input}`, value: value as string | number });
      } else warnings.push(`${spec.label}（#${nodeId}）由连线或其他节点控制，请在工作流中编辑。`);
    }
  }
  const counts = new Map<string, number>();
  for (const f of result) counts.set(f.label, (counts.get(f.label) ?? 0) + 1);
  for (const f of result) if (counts.get(f.label)! > 1) f.label += ` · #${f.nodeId}`;
  return { fields: result, warnings };
}

/** Edits only whitelisted scalar inputs on the latest graph. Never changes graph topology. */
export function updateWorkflowFields(text: string, values: Record<string, string | number>): string {
  const graph = parseWorkflowTemplate(text);
  const available = inspectWorkflowFields(text).fields;
  for (const [id, raw] of Object.entries(values)) {
    const field = available.find(f => f.id === id);
    if (!field) throw new Error('工作流输入已变化，请重新加载参数');
    let value: string | number;
    if (field.options) {
      if (typeof raw !== 'string' || !raw.trim() || raw.includes('%')) throw new Error(`${field.label}不能为空或包含占位符`);
      value = raw.trim();
    } else {
      value = typeof raw === 'number' ? raw : raw.trim() ? Number(raw) : NaN;
      if (!Number.isFinite(value) || value < field.min! || value > field.max!
        || (field.step === 1 && !Number.isInteger(value))) throw new Error(`${field.label}请输入 ${field.min}–${field.max} 范围内的${field.step === 1 ? '整数' : '数值'}`);
    }
    (graph[field.nodeId]!.inputs as Record<string, unknown>)[field.input] = value;
  }
  return JSON.stringify(graph, null, 2);
}

export function validateWorkflowJson(text: string): string {
  const graph = parseWorkflowTemplate(text);
  for (const [id, node] of Object.entries(graph)) {
    if (!node || typeof node !== 'object' || typeof node.class_type !== 'string' || !node.inputs || typeof node.inputs !== 'object' || Array.isArray(node.inputs)) {
      throw new Error(`节点 ${id} 不是有效的 API 格式节点，请使用 Save (API Format) 导出`);
    }
    for (const input of Object.values(node.inputs)) {
      if (Array.isArray(input) && input.length === 2 && typeof input[0] === 'string' && typeof input[1] === 'number' && !graph[input[0]]) {
        throw new Error(`节点 ${id} 引用了不存在的节点 ${input[0]}`);
      }
    }
  }
  const unknown = getWorkflowPlaceholders(text).filter(p => !['prompt', 'nl', 'negative_prompt', 'seed', 'width', 'height'].includes(p));
  if (unknown.length) throw new Error(`不支持的占位符：${unknown.join('、')}`);
  // Unconfigured API graphs may be saved before the user invokes AI auto-configuration.
  return JSON.stringify(graph, null, 2);
}
