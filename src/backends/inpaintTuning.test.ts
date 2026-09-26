import {expect,it} from 'vitest';
import {defaultInpaintTuning,inpaintTargetSize,normalizeInpaintTuning,validateInpaintTuning} from './inpaintTuning';
it('uses workflow sampling by default and selects a bounded resolution from the selected area',()=>{
 const t=defaultInpaintTuning();expect(t.steps).toBeNull();expect(t.cfg).toBeNull();
 expect(inpaintTargetSize(t,180,120)).toBe(1024);expect(inpaintTargetSize(t,1000,800)).toBe(1536);
 expect(inpaintTargetSize({...t,resolution:'768'},1000,800)).toBe(768);
});
it('roundtrips explicit zero CFG and independent settings without extra stored values',()=>{
 const t={...defaultInpaintTuning(),cfg:0,steps:16,denoise:0.45};
 expect(normalizeInpaintTuning({...t,secret:'drop'})).toEqual(t);
 expect(normalizeInpaintTuning({denoise:NaN})).toEqual(defaultInpaintTuning());
});
it.each([{denoise:0},{steps:0},{steps:1.5},{cfg:31},{thinkingSteps:11},{feather:-1},{resolution:'999'},{context:0}])('rejects invalid request controls %j',changes=>{
 expect(()=>validateInpaintTuning({...defaultInpaintTuning(),...changes} as any)).toThrow();
});
