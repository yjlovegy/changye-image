import { describe,it,expect } from 'vitest';
import {buildInpaintGraph,buildDetectionGraph,dependencyGraph,normalizeAutoRepair} from './comfyInpaintGraph';
import type {ComfyWorkflow} from './comfyui';
const source=():ComfyWorkflow=>({
 model:{class_type:'UNETLoader',inputs:{unet_name:'model'}},clip:{class_type:'CLIPLoader',inputs:{clip_name:'qwen',type:'krea2'}},
 lora:{class_type:'LoraLoader',inputs:{model:['model',0],clip:['clip',0],lora_name:'style'}},vae:{class_type:'VAELoader',inputs:{vae_name:'vae'}},
 positive:{class_type:'CLIPTextEncode',inputs:{clip:['lora',1],text:'%prompt%'}},negative:{class_type:'CLIPTextEncode',inputs:{clip:['lora',1],text:'%negative_prompt%'}},
 sampler:{class_type:'KSampler',inputs:{model:['lora',0],positive:['positive',0],negative:['negative',0],steps:8,cfg:1,sampler_name:'euler',scheduler:'simple'}},
 decode:{class_type:'VAEDecode',inputs:{samples:['sampler',0],vae:['vae',0]}},unused:{class_type:'LLMRequest',inputs:{key:'not-for-output'}}
});
const opts={image:'source.png',mask:'mask.png',positive:'blue sleeves',negative:'blur',seed:123};
describe('shared inpaint graph',()=>{
 it('retains loaded model/LoRA/encoder, removes unrelated requests and does not mutate source',()=>{
  const s=source(),before=JSON.stringify(s),g=buildInpaintGraph(s,opts);expect(JSON.stringify(s)).toBe(before);
  expect(g.lora).toEqual(s.lora);expect(g.clip.inputs).toEqual({clip_name:'qwen',type:'krea2'});expect(g.unused).toBeUndefined();expect(g.positive).toBeUndefined();
  const sampler=Object.values(g).find(n=>n.class_type==='LanPaint_KSampler')!;
  expect(sampler.inputs).toMatchObject({steps:8,cfg:1,seed:123,model:['lora',0],denoise:1});
  expect(Object.values(g).filter(n=>n.class_type==='SaveImage')).toHaveLength(1);
  expect(Object.values(g).find(n=>n.class_type==='ImageToMask')?.inputs).toMatchObject({channel:'red'});
  expect(Object.values(g).find(n=>n.class_type==='LanPaint_ImageDecode')?.inputs).toHaveProperty('mask');
 });
 it('preserves linked scalar inputs and Anima encoder type',()=>{const s=source();s.clip.inputs={clip_name:'qwen',type:'anima'};s.steps={class_type:'PrimitiveInt',inputs:{value:20}};(s.sampler.inputs as any).steps=['steps',0];const g=buildInpaintGraph(s,opts);expect(g.steps).toEqual(s.steps);expect(g.clip).toEqual(s.clip);});
 it('rejects ambiguous models and broken graphs before submission',()=>{const s=source();s.second=structuredClone(s.sampler);expect(()=>buildInpaintGraph(s,opts)).toThrow('不唯一');expect(()=>dependencyGraph({a:{inputs:{b:['b',0]}}},['a'])).toThrow('不存在');expect(()=>dependencyGraph({a:{inputs:{b:['b',0]}},b:{inputs:{a:['a',0]}}},['a'])).toThrow('循环');});
 it('detects only selected parts and unions the masks',()=>{expect(buildDetectionGraph('x','sam',{enabled:true,hands:true,feet:false}).foot).toBeUndefined();expect(buildDetectionGraph('x','sam',{enabled:true,hands:true,feet:true}).union.inputs).toMatchObject({operation:'add'});expect(()=>buildDetectionGraph('x','sam',{enabled:true,hands:false,feet:false})).toThrow('至少');expect(normalizeAutoRepair()).toEqual({enabled:false,hands:true,feet:true});});
});
