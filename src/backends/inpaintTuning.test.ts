import {expect,it} from 'vitest';
import {applyInpaintPreset,defaultInpaintTuning,inpaintTargetSize,normalizeInpaintTuning,validateInpaintTuning} from './inpaintTuning';
it('uses workflow sampling by default and selects a bounded resolution from the selected area',()=>{
 const t=defaultInpaintTuning();expect(t.steps).toBeNull();expect(t.cfg).toBeNull();
 expect(inpaintTargetSize(t,180,120)).toBe(1024);expect(inpaintTargetSize({...t,resolution:'auto'},1000,800)).toBe(1536);
 expect(inpaintTargetSize({...t,resolution:'768'},1000,800)).toBe(768);
});
it('changes related controls together without overwriting saved sampling overrides',()=>{
 const base={...defaultInpaintTuning(),steps:18,cfg:0,reference:'full' as const};
 expect(applyInpaintPreset(base,'repair')).toMatchObject({denoise:.7,context:3,thinkingSteps:7,feather:8,promptMode:'Image First',steps:18,cfg:0,reference:'region'});
 expect(applyInpaintPreset(base,'replace')).toMatchObject({denoise:.85,context:3,thinkingSteps:7,promptMode:'Prompt First'});
 expect(base.reference).toBe('full');
});
it('retains a legacy customized profile and full-reference choices through normalization',()=>{
 const old={mode:'replace',denoise:1,resolution:'768',feather:4,context:1.2,steps:16,cfg:4,thinkingSteps:6,promptMode:'Image First'};
 expect(normalizeInpaintTuning(old)).toEqual({...old,reference:'region'});
 expect(normalizeInpaintTuning({...old,reference:'full'}).reference).toBe('full');
});
it('roundtrips explicit zero CFG and independent settings without extra stored values',()=>{
 const t={...defaultInpaintTuning(),cfg:0,steps:16,denoise:0.45};
 expect(normalizeInpaintTuning({...t,secret:'drop'})).toEqual(t);
 expect(normalizeInpaintTuning({denoise:NaN})).toEqual(defaultInpaintTuning());
});
it.each([{denoise:0},{steps:0},{steps:1.5},{cfg:31},{thinkingSteps:11},{feather:-1},{resolution:'999'},{context:0}])('rejects invalid request controls %j',changes=>{
 expect(()=>validateInpaintTuning({...defaultInpaintTuning(),...changes} as any)).toThrow();
});
