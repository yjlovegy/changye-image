import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {nextTick} from 'vue';
const host=vi.hoisted(()=>({context:null as any}));
vi.mock('@/st/context',()=>({getContext:()=>host.context}));
beforeEach(()=>{vi.resetModules();vi.stubGlobal('window',{addEventListener:vi.fn(),dispatchEvent:vi.fn()});host.context={extensionSettings:{baibai_image:{comfyui:{activeWorkflowId:'a',workflows:[{id:'a',name:'Saved',workflow:'{"1":{"class_type":"CLIPTextEncode","inputs":{"text":"%prompt%"}}}'}]}}},saveSettingsDebounced:vi.fn()};});
afterEach(()=>vi.unstubAllGlobals());
describe('workflow draft persistence boundary',()=>{
  it('roundtrips explicit per-workflow inpaint defaults without saving a generation draft',async()=>{
    host.context.extensionSettings.baibai_image.inpaintProfiles={a:{mode:'touchup',denoise:0.35,resolution:'1024',feather:4,context:1.2,steps:16,cfg:0,thinkingSteps:5,promptMode:'Image First'}};
    const m=await import('./settings');await m.hydrateSettings();
    expect(m.settings.inpaintProfiles?.a.cfg).toBe(0);
    const saved=m.savedComfyPreset().workflow;m.comfyWorkflowDrafts.edit(m.savedComfyPreset()).workflow='temporary';
    m.settings.inpaintProfiles={...m.settings.inpaintProfiles,b:{...m.settings.inpaintProfiles!.a,denoise:0.8}};await nextTick();
    expect(host.context.extensionSettings.baibai_image.inpaintProfiles.b.denoise).toBe(0.8);
    expect(host.context.extensionSettings.baibai_image.inpaintProfiles.a.denoise).toBe(0.35);
    expect(host.context.extensionSettings.baibai_image.comfyui.workflows[0].workflow).toBe(saved);
  });
  it('uses drafts for generation but never leaks them into unrelated autosaves',async()=>{
    const m=await import('./settings');await m.hydrateSettings();const saved=m.savedComfyPreset();const before=JSON.parse(JSON.stringify(saved));
    expect(saved.negativeEnabled).toBe(true);expect(saved.generateNegative).toBe(true);
    const draft=m.comfyWorkflowDrafts.edit(saved);draft.workflow='{"2":{"class_type":"CLIPTextEncode","inputs":{"text":"%nl%"}}}';draft.fixedPrompts.negative='trial';draft.defaultSize='768×1024';draft.autoRepair={enabled:true,hands:true,feet:false};draft.negativeEnabled=false;draft.generateNegative=false;
    m.settings.ui.orbSize++;await nextTick();
    expect(m.effectiveComfyConn().workflow).toBe(draft.workflow);expect(m.effectiveComfyConn(saved).workflow).toBe(draft.workflow);
    expect(m.effectiveComfyConn().negativeEnabled).toBe(false);
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
