import { describe, it, expect } from 'vitest';
import { renderWorkflowTemplate } from './comfyui';
import { muteWorkflowNegative } from './comfyNegativePolicy';

const graph = () => ({
  p: {class_type:'CLIPTextEncode',inputs:{text:'%prompt%'}},
  n: {class_type:'CLIPTextEncode',inputs:{text:'hardcoded unwanted, %negative_prompt%'}},
  s: {class_type:'KSampler',inputs:{positive:['p',0],negative:['n',0],cfg:4}},
});
describe('negative use policy', () => {
  it('disables fixed, dynamic and hardcoded negative conditioning only in the submitted graph', () => {
    const original=graph(), template=JSON.stringify(original);
    const result=renderWorkflowTemplate(template,{prompt:'a tree',negative_prompt:'dynamic unwanted',negativeEnabled:false},
      {positivePrefix:'ink drawing',positiveSuffix:'',negative:'fixed unwanted'});
    expect(result.p.inputs).toEqual({text:'ink drawing, a tree'});
    expect(result.n.inputs).toEqual({text:'hardcoded unwanted, '});
    const inputs=result.s.inputs as any;
    expect(inputs.cfg).toBe(4);
    expect(result[inputs.negative[0]]).toEqual({class_type:'ConditioningZeroOut',inputs:{conditioning:['p',0]}});
    expect(JSON.stringify(original)).toBe(template);
    const restored=renderWorkflowTemplate(template,{prompt:'a tree',negative_prompt:'dynamic unwanted',negativeEnabled:true},
      {positivePrefix:'ink drawing',positiveSuffix:'',negative:'fixed unwanted'});
    expect(restored.n.inputs).toEqual({text:'fixed unwanted, hardcoded unwanted, dynamic unwanted'});
    expect(restored.s.inputs).toEqual(original.s.inputs);
  });
  it('does not require a negative placeholder when stored fixed negatives are disabled', () => {
    expect(()=>renderWorkflowTemplate(JSON.stringify({p:graph().p}),{prompt:'tree',negativeEnabled:false},
      {positivePrefix:'',positiveSuffix:'',negative:'keep me'})).not.toThrow();
  });
  it('handles standard and inpaint samplers independently without modifying the source', () => {
    const original={...graph(), i:{class_type:'LanPaint_KSampler',inputs:{positive:['p',0],negative:['n',0]}},
      cy_negative_off_s:{class_type:'KeepNode',inputs:{}}};
    const result=muteWorkflowNegative(original);
    expect(result.cy_negative_off_s).toEqual(original.cy_negative_off_s);
    expect((result.s.inputs as any).negative).toEqual(['cy_negative_off_s_',0]);
    expect((result.i.inputs as any).negative).toEqual(['cy_negative_off_i',0]);
    expect(original.i.inputs.negative).toEqual(['n',0]);
  });
});
