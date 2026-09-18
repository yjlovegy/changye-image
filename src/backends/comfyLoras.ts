/**
 * Edit the LoRA list of a known multi-LoRA loader without touching graph edges.
 * Runtime contracts verified against local ComfyUI-Lora-Manager db38ad80 and
 * rgthree-comfy 2c5342a8. Standard single-LoRA chains need topology editing and
 * are deliberately reported as unsupported here.
 */
type JsonObject = Record<string, unknown>;
type Workflow = Record<string, JsonObject>;

export interface LoraTagEntry {
  name: string;
  strength: number;
  /** Omitted means use the model strength for CLIP too. */
  clipStrength?: number;
}

export interface WorkflowLoraGroup {
  nodeId: string;
  classType: string;
  label: string;
  tags: string;
  /** Enabled entries only. */
  count: number;
  disabledCount: number;
  warnings: string[];
  editable: boolean;
  reason?: string;
}

const MANAGER = 'Lora Loader (LoraManager)';
const POWER = 'Power Lora Loader (rgthree)';
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseWorkflow(template: string): Workflow {
  let value: unknown;
  try {
    value = JSON.parse(template);
  } catch {
    throw new Error('工作流 JSON 格式错误，请先修正后再编辑 LoRA');
  }
  if (!isObject(value) || !Object.keys(value).length) throw new Error('工作流必须是非空的 API JSON 对象');
  return value as Workflow;
}

function numeric(value: string): number | null {
  const trimmed = value.trim();
  if (!NUMBER.test(trimmed)) return null;
  const number = Number(trimmed);
  return Number.isFinite(number) ? number : null;
}

/** LoraManager explicitly calls float() for its widget weights. */
function managerWeight(value: unknown): number | null {
  if (typeof value === 'string') return numeric(value);
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function assertEntry(entry: LoraTagEntry): void {
  if (!entry.name.trim() || /[<>\r\n\u0000-\u001f]/.test(entry.name)) {
    throw new Error('LoRA 名称不能为空，也不能包含尖括号或控制字符');
  }
  if (!Number.isFinite(entry.strength) || (entry.clipStrength !== undefined && !Number.isFinite(entry.clipStrength))) {
    throw new Error(`LoRA「${entry.name}」的权重必须是有限数值`);
  }
}

/** Strict parsing: unrelated prompt text and incomplete tags must never erase a list. */
export function parseLoraTags(text: string): LoraTagEntry[] {
  const entries: LoraTagEntry[] = [];
  const pattern = /<lora:([^<>]+)>/gi;
  let end = 0;
  for (const match of text.matchAll(pattern)) {
    if (!/^[\s,;，；]*$/.test(text.slice(end, match.index))) {
      throw new Error('LoRA 控制栏只能填写 <lora:名称:权重>，多个标签用空格或换行分隔');
    }
    const pieces = match[1].split(':');
    const last = numeric(pieces.at(-1) ?? '');
    if (pieces.length < 2 || last === null) throw new Error('LoRA 标签缺少有效权重，例如 <lora:detail:0.7>');
    pieces.pop();
    const previous = pieces.length > 1 ? numeric(pieces.at(-1) ?? '') : null;
    const entry: LoraTagEntry = previous === null
      ? { name: pieces.join(':').trim(), strength: last }
      : { name: pieces.slice(0, -1).join(':').trim(), strength: previous, clipStrength: last };
    assertEntry(entry);
    entries.push(entry);
    end = match.index! + match[0].length;
  }
  if (!/^[\s,;，；]*$/.test(text.slice(end))) {
    throw new Error('LoRA 标签格式不完整；请使用 <lora:名称:权重> 或 <lora:名称:模型权重:CLIP权重>');
  }
  return entries;
}

export function formatLoraTags(entries: readonly LoraTagEntry[]): string {
  return entries.map(entry => {
    assertEntry(entry);
    const extra = entry.clipStrength !== undefined && entry.clipStrength !== entry.strength ? `:${entry.clipStrength}` : '';
    return `<lora:${entry.name.trim()}:${entry.strength}${extra}>`;
  }).join('\n');
}

interface ReadGroup {
  entries: LoraTagEntry[];
  rawEntries: JsonObject[];
  disabledCount: number;
  reason?: string;
}

function managerEntries(inputs: JsonObject): ReadGroup {
  const source = inputs.loras;
  const list = Array.isArray(source) ? source : isObject(source) ? source.__value__ : null;
  if (!Array.isArray(list) || (Array.isArray(source) && source.length === 2 && typeof source[0] === 'string')) {
    return { entries: [], rawEntries: [], disabledCount: 0, reason: '该节点的 LoRA 列表由连线或未知格式提供，请在 ComfyUI 中编辑来源' };
  }
  const entries: LoraTagEntry[] = [];
  const rawEntries: JsonObject[] = [];
  let disabledCount = 0;
  for (const item of list) {
    if (!isObject(item) || typeof item.active !== 'boolean') {
      return { entries, rawEntries, disabledCount, reason: '该节点包含无法识别的 LoRA 条目，未进行修改' };
    }
    rawEntries.push(item);
    if (!item.active) { disabledCount++; continue; }
    const strength = managerWeight(item.strength);
    const clipStrength = item.clipStrength === undefined ? undefined : managerWeight(item.clipStrength);
    if (typeof item.name !== 'string' || strength === null || clipStrength === null) {
      return { entries, rawEntries, disabledCount, reason: '该节点包含非静态的 LoRA 名称或权重，请在 ComfyUI 中编辑' };
    }
    const entry: LoraTagEntry = { name: item.name, strength };
    if (clipStrength !== undefined) entry.clipStrength = clipStrength;
    try { assertEntry(entry); } catch { return { entries, rawEntries, disabledCount, reason: '该节点包含无效的 LoRA 名称或权重' }; }
    entries.push(entry);
  }
  if (typeof inputs.text !== 'string') return { entries, rawEntries, disabledCount, reason: '该节点的 text 输入不是静态文本，暂不支持同步' };
  if (inputs.lora_stack !== undefined && inputs.lora_stack !== null
    && !(Array.isArray(inputs.lora_stack) && inputs.lora_stack.length === 0)) {
    return { entries, rawEntries, disabledCount, reason: '该节点还接入了上游 lora_stack；此栏无法控制上游 LoRA，请先在 ComfyUI 中整理该连接' };
  }
  return { entries, rawEntries, disabledCount };
}

function powerEntries(inputs: JsonObject): ReadGroup {
  const entries: LoraTagEntry[] = [];
  const rawEntries: JsonObject[] = [];
  let disabledCount = 0;
  for (const [key, item] of Object.entries(inputs)) {
    if (!/^lora_/i.test(key)) continue;
    if (!isObject(item) || typeof item.on !== 'boolean') {
      return { entries, rawEntries, disabledCount, reason: '该节点包含无法识别的 LoRA 条目，未进行修改' };
    }
    rawEntries.push(item);
    if (!item.on) { disabledCount++; continue; }
    if (typeof item.lora !== 'string' || typeof item.strength !== 'number'
      || (item.strengthTwo != null && typeof item.strengthTwo !== 'number')) {
      return { entries, rawEntries, disabledCount, reason: '该节点包含非静态的 LoRA 名称或权重，请在 ComfyUI 中编辑' };
    }
    const entry: LoraTagEntry = { name: item.lora, strength: item.strength };
    // rgthree treats None/null the same as an omitted second strength.
    if (item.strengthTwo != null) entry.clipStrength = item.strengthTwo as number;
    try { assertEntry(entry); } catch { return { entries, rawEntries, disabledCount, reason: '该节点包含无效的 LoRA 名称或权重' }; }
    entries.push(entry);
  }
  return { entries, rawEntries, disabledCount };
}

function readGroup(node: JsonObject): ReadGroup {
  if (!isObject(node.inputs)) return { entries: [], rawEntries: [], disabledCount: 0, reason: '该节点没有有效 inputs' };
  if (node.class_type === MANAGER) return managerEntries(node.inputs);
  if (node.class_type === POWER) return powerEntries(node.inputs);
  return { entries: [], rawEntries: [], disabledCount: 0, reason: '该节点暂不支持独立标签控制；请在 ComfyUI 中修改，或使用 LoraManager / Power Lora Loader 多 LoRA 节点' };
}

export function inspectWorkflowLoras(template: string): WorkflowLoraGroup[] {
  const workflow = parseWorkflow(template);
  return Object.entries(workflow).flatMap(([nodeId, node]) => {
    if (!isObject(node) || typeof node.class_type !== 'string'
      || !/(?:lora.*(?:loader|stack|pool|cycler|randomizer))|(?:(?:loader|stack).*lora)/i.test(node.class_type)) return [];
    const group = readGroup(node);
    const title = isObject(node._meta) && typeof node._meta.title === 'string' ? node._meta.title : node.class_type;
    const warnings = group.disabledCount
      ? [`当前仅显示启用的 ${group.entries.length} 项；应用会替换整个节点的清单，并移除原有 ${group.disabledCount} 个停用项。`]
      : [];
    if (group.reason) warnings.push(group.reason);
    return [{ nodeId, classType: node.class_type, label: `${title} · #${nodeId}`, tags: formatLoraTags(group.entries),
      count: group.entries.length, disabledCount: group.disabledCount, warnings, editable: !group.reason, reason: group.reason }];
  });
}

/** Reuse matched item metadata once per occurrence; duplicate names remain ordered. */
function takeExisting(list: JsonObject[], key: 'name' | 'lora', entry: LoraTagEntry): JsonObject {
  const index = list.findIndex(item => item[key] === entry.name);
  return index < 0 ? {} : list.splice(index, 1)[0];
}

export function updateWorkflowLoras(template: string, nodeId: string, tags: string): string {
  const entries = parseLoraTags(tags);
  const workflow = parseWorkflow(template);
  const node = workflow[nodeId];
  if (!isObject(node)) throw new Error('目标 LoRA 节点已不存在，请重新选择');
  const group = readGroup(node);
  if (group.reason) throw new Error(group.reason);
  const inputs = node.inputs as JsonObject;
  const available = [...group.rawEntries];
  if (node.class_type === MANAGER) {
    const list = entries.map(entry => ({
      expanded: false, selected: false, locked: false,
      ...takeExisting(available, 'name', entry),
      name: entry.name, strength: entry.strength, clipStrength: entry.clipStrength ?? entry.strength, active: true,
    }));
    inputs.loras = Array.isArray(inputs.loras) ? list : { ...(inputs.loras as JsonObject), __value__: list };
    // LoraManager ignores text when loading; synchronize it only for its editor display.
    inputs.text = formatLoraTags(entries);
  } else if (node.class_type === POWER) {
    for (const key of Object.keys(inputs)) if (/^lora_/i.test(key)) delete inputs[key];
    entries.forEach((entry, index) => {
      const item: JsonObject = { ...takeExisting(available, 'lora', entry), on: true, lora: entry.name, strength: entry.strength };
      if (entry.clipStrength === undefined) delete item.strengthTwo;
      else item.strengthTwo = entry.clipStrength;
      inputs[`lora_${index + 1}`] = item;
    });
  }
  return JSON.stringify(workflow, null, 2);
}
