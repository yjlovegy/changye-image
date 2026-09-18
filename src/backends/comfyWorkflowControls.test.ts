import { describe, expect, it } from 'vitest';
import { inspectWorkflowFields, updateWorkflowFields, validateWorkflowJson } from './comfyWorkflowControls';
import { appendFavoriteTags } from './comfyLoraFavorites';
const graph = {
  unet: { class_type: 'UNETLoader', inputs: { unet_name: 'base.safetensors', weight_dtype: 'default' } },
  sampler: { class_type: 'KSampler', inputs: { model: ['unet', 0], steps: 30, cfg: 4, sampler_name: 'euler', scheduler: 'simple', denoise: 1, seed: '%seed%' } },
};
describe('custom workflow controls', () => {
  it('edits encoder type on its own loader, preserving files, connected types and all links', () => {
    const input=JSON.stringify({...graph, clip:{class_type:'CLIPLoader',inputs:{clip_name:'qwen.safetensors',type:'stable_diffusion'}}, dual:{class_type:'DualCLIPLoader',inputs:{clip_name1:'a',clip_name2:'b',type:['unet',0]}}});
    const inspected=inspectWorkflowFields(input);
    expect(inspected.fields.find(f=>f.id==='clip/type')?.options).toBe('encoderTypes');
    expect(inspected.fields.some(f=>f.id==='dual/type')).toBe(false);
    const output=JSON.parse(updateWorkflowFields(input,{'clip/type':'krea2'}));
    expect(output.clip.inputs).toEqual({clip_name:'qwen.safetensors',type:'krea2'});
    expect(output.sampler).toEqual(graph.sampler);
    expect(output.dual.inputs.type).toEqual(['unet',0]);
  });
  it('updates only scalar controls, preserving architecture, seed and graph links', () => {
    const input = JSON.stringify(graph);
    const result = JSON.parse(updateWorkflowFields(input, { 'unet/unet_name': 'next.safetensors', 'sampler/steps': '24', 'sampler/cfg': '5.5' }));
    expect(result.unet.inputs.weight_dtype).toBe('default');
    expect(result.sampler.inputs).toEqual({ ...graph.sampler.inputs, steps: 24, cfg: 5.5 });
    expect(graph.unet.inputs.unet_name).toBe('base.safetensors');
    expect(result.unet.inputs.unet_name).toBe('next.safetensors');
  });
  it('does not overwrite linked or dynamic parameters and rejects forged field ids', () => {
    const input = JSON.stringify({ ...graph, sampler: { ...graph.sampler, inputs: { ...graph.sampler.inputs, cfg: ['unet', 0], steps: '%steps%' } } });
    const result = inspectWorkflowFields(input);
    expect(result.warnings).toHaveLength(2);
    expect(result.fields.some(f => f.input === 'cfg' || f.input === 'steps')).toBe(false);
    expect(() => updateWorkflowFields(input, { 'sampler/cfg': 4 })).toThrow('变化');
    expect(() => updateWorkflowFields(JSON.stringify(graph), { 'unet/weight_dtype': 'fp8' })).toThrow('变化');
  });
  it.each<Record<string, string | number>>([{ 'sampler/steps': 1.5 }, { 'sampler/steps': '' }, { 'sampler/cfg': 'NaN' }, { 'sampler/denoise': -1 }, { 'sampler/denoise': 1.1 }, { 'unet/unet_name': '' }])('rejects invalid values atomically: %j', values => {
    expect(() => updateWorkflowFields(JSON.stringify(graph), values)).toThrow();
  });
  it('labels multiple same-role nodes without guessing a single target', () => {
    const result = inspectWorkflowFields(JSON.stringify({ ...graph, unet2: graph.unet }));
    expect(result.fields.filter(f => f.input === 'unet_name').map(f => f.label)).toEqual(['主模型（UNet） · #unet', '主模型（UNet） · #unet2']);
  });
  it('validates imports including unconfigured API exports, refuses broken links and GUI exports', () => {
    expect(JSON.parse(validateWorkflowJson(JSON.stringify(graph)))).toEqual(graph);
    expect(() => validateWorkflowJson('{')).toThrow();
    expect(() => validateWorkflowJson(JSON.stringify({ nodes: [] }))).toThrow('API');
    expect(() => validateWorkflowJson(JSON.stringify({ sampler: graph.sampler }))).toThrow('不存在');
    expect(() => validateWorkflowJson(JSON.stringify({ ...graph, invalid: { class_type: 'Foo', inputs: 'text' } }))).toThrow('API');
  });
  it('batch selection keeps existing weights and skips aliases, validates all before appending', () => {
    const result = appendFavoriteTags('<lora:detail.safetensors:0.3>', ['<lora:detail:0.7>', '<lora:light:0.5>', '<lora:light:1>']);
    expect(result).toEqual({ text: '<lora:detail.safetensors:0.3>\n<lora:light:0.5>', added: 1, skipped: 2 });
    expect(() => appendFavoriteTags('<lora:detail:0.3>', ['<lora:light:0.5>', 'broken'])).toThrow();
  });
});
