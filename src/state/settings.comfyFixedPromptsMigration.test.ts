import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSimpleWorkflow } from '@/backends/comfyTemplates';

const mocks = vi.hoisted(() => ({ context: null as Record<string, any> | null }));
vi.mock('@/st/context', () => ({ getContext: () => mocks.context }));

async function hydrate(workflows: unknown[]) {
  mocks.context = {
    extensionSettings: { baibai_image: { comfyui: { workflows, activeWorkflowId: 'a' } } },
    saveSettingsDebounced: vi.fn(),
  };
  const state = await import('@/state/settings');
  await state.hydrateSettings();
  return state;
}
const empty = { positivePrefix: '', positiveSuffix: '', negative: '' };

describe('ComfyUI 工作流固定词迁移', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('toastr', { info: vi.fn(), success: vi.fn(), error: vi.fn() });
    vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
  });

  it('旧自定义预设默认不添加词，不激活休眠的简易模式内容', async () => {
    const { settings } = await hydrate([{ id: 'a', workflow: 'kept', simple: { positive: 'dormant', negative: 'unused' } }]);
    const preset = settings.comfyui.workflows[0];
    expect(preset.fixedPrompts).toEqual(empty);
    expect(preset.simple.positive).toBe('dormant');
    expect(preset.simple.negative).toBe('unused');
    expect(preset.workflow).toBe('kept');
    expect(preset.loraWorkflowBackup).toBe('');
  });

  it('旧简易两格迁入新栏且只拼接一次，保持原来的请求文本', async () => {
    const { settings } = await hydrate([{ id: 'a', mode: 'simple', simple: {
      model: 'base.safetensors', positive: '  fixed quality  ', negative: '  fixed defects  ',
    } }]);
    const preset = settings.comfyui.workflows[0];
    expect(preset.fixedPrompts).toEqual({ positivePrefix: '  fixed quality  ', positiveSuffix: '', negative: '  fixed defects  ' });
    expect(preset.simple.positive).toBe('');
    expect(preset.simple.negative).toBe('');
    const result = buildSimpleWorkflow(preset.simple, {
      prompt: 'a tree', nl: 'A tree stands beside a path.', negative: 'extra tree', seed: 1, width: 512, height: 512,
    }, preset.fixedPrompts);
    expect(result['3'].inputs.text).toBe('fixed quality, a tree\nA tree stands beside a path.');
    expect(result['4'].inputs.text).toBe('fixed defects, extra tree');
  });

  it('旧简易工作流迁移后按 JSON 生效，保留休眠 JSON 且重复载入不再转换', async () => {
    const original = '{"dormant":{"class_type":"PreviewAny","inputs":{}}}';
    const first = await hydrate([{ id: 'legacy', mode: 'simple', workflow: original, simple: { model: 'base.safetensors' } }]);
    const preset = JSON.parse(JSON.stringify(first.settings.comfyui.workflows[0]));
    expect(preset.mode).toBe('custom');
    expect(preset.legacyCustomWorkflow).toBe(original);
    expect(preset.workflow).toContain('%width%');
    expect(preset.workflow).toContain('base.safetensors');
    const second = await hydrate([preset]);
    expect(second.settings.comfyui.workflows[0]).toEqual(preset);
  });

  it('已存在的新字段逐格清洗且显式清空不恢复旧值', async () => {
    const { settings } = await hydrate([
      { id: 'a', mode: 'simple', simple: { positive: 'legacy' }, fixedPrompts: { positivePrefix: '', positiveSuffix: 'end', negative: 5 }, loraWorkflowBackup: 'snapshot' },
      { id: 'b', fixedPrompts: null, loraWorkflowBackup: 42 },
    ]);
    expect(settings.comfyui.workflows[0].fixedPrompts).toEqual({ ...empty, positiveSuffix: 'end' });
    expect(settings.comfyui.workflows[0].loraWorkflowBackup).toBe('snapshot');
    expect(settings.comfyui.workflows[1].fixedPrompts).toEqual(empty);
    expect(settings.comfyui.workflows[1].loraWorkflowBackup).toBe('');
  });

  it('每个预设独立存储，派生连接获得快照而不引用 UI 设置', async () => {
    const shared = { positivePrefix: 'first', positiveSuffix: 'last', negative: 'defects' };
    const { settings, effectiveComfyConn, newComfyWorkflow } = await hydrate([
      { id: 'a', fixedPrompts: shared }, { id: 'b', fixedPrompts: shared },
    ]);
    const snapshot = effectiveComfyConn();
    settings.comfyui.workflows[0].fixedPrompts.positivePrefix = 'changed';
    expect(snapshot.fixedPrompts?.positivePrefix).toBe('first');
    expect(settings.comfyui.workflows[1].fixedPrompts.positivePrefix).toBe('first');
    settings.comfyui.activeWorkflowId = 'b';
    expect(effectiveComfyConn().fixedPrompts).toEqual(shared);
    const first = newComfyWorkflow();
    const second = newComfyWorkflow();
    first.fixedPrompts.positivePrefix = 'new';
    expect(second.fixedPrompts).toEqual(empty);
  });
});
