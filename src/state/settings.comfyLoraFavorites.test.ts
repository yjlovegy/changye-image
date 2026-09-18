import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
const mocks = vi.hoisted(() => ({ context: null as Record<string, any> | null }));
vi.mock('@/st/context', () => ({ getContext: () => mocks.context }));

async function hydrate(loraFavorites?: unknown) {
  mocks.context = { extensionSettings: { baibai_image: { comfyui: {
    workflows: [{ id: 'a', workflow: 'graph-a' }, { id: 'b', workflow: 'graph-b' }], activeWorkflowId: 'a', loraFavorites,
  } } }, saveSettingsDebounced: vi.fn() };
  const state = await import('./settings');
  await state.hydrateSettings();
  return state;
}
describe('跨工作流 LoRA 收藏持久化', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('toastr', { info: vi.fn(), success: vi.fn(), error: vi.fn() });
    vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
  });
  it('旧配置增加空库，不修改已有工作流', async () => {
    const { settings } = await hydrate();
    expect(settings.comfyui.loraFavorites).toEqual([]);
    expect(settings.comfyui.workflows.map(w => w.workflow)).toEqual(['graph-a', 'graph-b']);
  });
  it('保存、切换与重载共用收藏，备注不进入出图连接，清空不会恢复', async () => {
    const rows = [{ tag: '<lora:detail:0.7>', note: '近景使用' }];
    const { settings, effectiveComfyConn } = await hydrate(rows);
    settings.comfyui.activeWorkflowId = 'b';
    settings.comfyui.loraFavorites = [...rows, { tag: '<lora:light:0.5>', note: '柔光' }];
    await nextTick();
    const saved = JSON.parse(JSON.stringify(mocks.context!.extensionSettings.baibai_image.comfyui));
    expect(saved.loraFavorites).toEqual(settings.comfyui.loraFavorites);
    expect(mocks.context!.saveSettingsDebounced).toHaveBeenCalled();
    expect(effectiveComfyConn()).not.toHaveProperty('loraFavorites');
    expect(effectiveComfyConn().workflow).toBe('graph-b');
    vi.resetModules();
    const restored = await hydrate(saved.loraFavorites);
    expect(restored.settings.comfyui.loraFavorites).toEqual(saved.loraFavorites);
    restored.settings.comfyui.loraFavorites = [];
    await nextTick();
    expect(mocks.context!.extensionSettings.baibai_image.comfyui.loraFavorites).toEqual([]);
  });
});
