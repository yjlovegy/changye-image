import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {nextTick} from 'vue';
const host=vi.hoisted(()=>({context:null as any}));
vi.mock('@/st/context',()=>({getContext:()=>host.context}));
beforeEach(()=>{vi.resetModules();vi.stubGlobal('window',{addEventListener:vi.fn(),dispatchEvent:vi.fn()});host.context={extensionSettings:{baibai_image:{comfyui:{activeWorkflowId:'a',workflows:[{id:'a',name:'Saved',workflow:'{"1":{"class_type":"CLIPTextEncode","inputs":{"text":"%prompt%"}}}'}]}}},saveSettingsDebounced:vi.fn()};});
afterEach(()=>vi.unstubAllGlobals());
describe('workflow draft persistence boundary',()=>{
  it('uses drafts for generation but never leaks them into unrelated autosaves',async()=>{
    const m=await import('./settings');await m.hydrateSettings();const saved=m.savedComfyPreset();const before=JSON.parse(JSON.stringify(saved));
    const draft=m.comfyWorkflowDrafts.edit(saved);draft.workflow='{"2":{"class_type":"CLIPTextEncode","inputs":{"text":"%nl%"}}}';draft.fixedPrompts.negative='trial';draft.defaultSize='768×1024';draft.autoRepair={enabled:true,hands:true,feet:false};
    m.settings.ui.orbSize++;await nextTick();
    expect(m.effectiveComfyConn().workflow).toBe(draft.workflow);expect(m.effectiveComfyConn(saved).workflow).toBe(draft.workflow);
    expect(m.savedComfyPreset()).toEqual(before);expect(host.context.extensionSettings.baibai_image.comfyui.workflows[0]).toEqual(before);
    m.saveComfyWorkflow('a');await nextTick();expect(host.context.extensionSettings.baibai_image.comfyui.workflows[0]).toEqual(JSON.parse(JSON.stringify(draft)));
    draft.fixedPrompts.negative='second trial';m.comfyWorkflowDrafts.discard('a');expect(m.activeComfyPreset().fixedPrompts.negative).toBe('trial');
  });
  it('retains saved example image ownership while a replacement is staged',async()=>{
    const m=await import('./settings');await m.hydrateSettings();const saved=m.savedComfyPreset();saved.exampleImage='/user/images/长夜的绘图器_工作流示例/wfimg_old.png';
    const draft=m.comfyWorkflowDrafts.edit(saved);draft.exampleImage='/user/images/长夜的绘图器_工作流示例/wfimg_new.png';
    expect(m.comfyExampleOwners().map(p=>p.exampleImage)).toContain(saved.exampleImage);expect(m.comfyExampleOwners()).toContain(draft);
    m.comfyWorkflowDrafts.discard('a');expect(m.comfyExampleOwners()).not.toContain(draft);
  });
});
