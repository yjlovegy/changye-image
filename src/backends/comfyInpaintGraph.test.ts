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
 it('uses original-image masked sampling for automatic details without scene conditioning or LanPaint',()=>{
  const s=source(),before=JSON.stringify(s);
  const g=buildInpaintGraph(s,{...opts,positive:'existing face detail',sampling:'masked-img2img',denoise:0.2,referenceRect:{x:32,y:64,width:128,height:160},referenceSize:{width:768,height:960}});
  const nodes=Object.values(g);
  expect(nodes.some(n=>String(n.class_type).startsWith('LanPaint'))).toBe(false);
  expect(nodes.find(n=>n.class_type==='VAEEncode')).toBeDefined();
  expect(nodes.find(n=>n.class_type==='SetLatentNoiseMask')).toBeDefined();
  expect(nodes.find(n=>n.class_type==='ImageBlur')).toBeDefined();
  expect(nodes.find(n=>n.class_type==='KSampler')?.inputs).toMatchObject({steps:8,cfg:1,sampler_name:'euler',scheduler:'simple',denoise:0.2});
  expect(nodes.filter(n=>n.class_type==='CLIPTextEncode').map(n=>(n.inputs as any).text)).toEqual(['existing face detail','blur']);
  expect(g.positive).toBeUndefined();expect(g.lora).toEqual(s.lora);expect(JSON.stringify(s)).toBe(before);
 });
 it('uses the explicit reference rectangle for both image and mask and pastes at original coordinates',()=>{
  const g=buildInpaintGraph(source(),{...opts,referenceRect:{x:123,y:456,width:400,height:700},referenceSize:{width:576,height:1024}});
  const nodes=Object.values(g);
  expect(nodes.find(n=>n.class_type==='ImageCrop')?.inputs).toMatchObject({x:123,y:456,width:400,height:700});
  expect(nodes.find(n=>n.class_type==='CropMask')?.inputs).toMatchObject({x:123,y:456,width:400,height:700});
  expect(nodes.filter(n=>n.class_type==='ImageScale').map(n=>n.inputs)).toEqual(expect.arrayContaining([
   expect.objectContaining({width:576,height:1024,upscale_method:'lanczos',crop:'disabled'}),
   expect.objectContaining({width:576,height:1024,upscale_method:'nearest-exact'}),
   expect.objectContaining({width:400,height:700}),
  ]));
  expect(nodes.find(n=>n.class_type==='ImageCompositeMasked')?.inputs).toMatchObject({x:123,y:456,resize_source:false});
  expect(nodes.some(n=>n.class_type==='InpaintCropImproved')).toBe(false);
  expect(g.lora).toEqual(source().lora);
 });
 it('applies independent repair quality settings and disables outward mask blending',()=>{
  const g=buildInpaintGraph(source(),{...opts,denoise:0.4,steps:18,cfg:0,thinkingSteps:7,targetSize:1536,context:1.2,promptMode:'Prompt First'});
  expect(Object.values(g).find(n=>n.class_type==='LanPaint_KSampler')?.inputs).toMatchObject({denoise:0.4,steps:18,cfg:0,LanPaint_NumSteps:7,LanPaint_PromptMode:'Prompt First'});
  expect(Object.values(g).find(n=>n.class_type==='InpaintCropImproved')?.inputs).toMatchObject({mask_blend_pixels:0,mask_expand_pixels:0,output_target_width:1536,output_target_height:1536,context_from_mask_extend_factor:1.2});
  expect(Object.values(g).find(n=>n.class_type==='LanPaint_ImageDecode')?.inputs).toMatchObject({blend_overlap:1});
 });
 it('retains loaded model/LoRA/encoder, removes unrelated requests and does not mutate source',()=>{
  const s=source(),before=JSON.stringify(s),g=buildInpaintGraph(s,opts);expect(JSON.stringify(s)).toBe(before);
  expect(g.lora).toEqual(s.lora);expect(g.clip.inputs).toEqual({clip_name:'qwen',type:'krea2'});expect(g.unused).toBeUndefined();expect(g.positive).toBeUndefined();
  const sampler=Object.values(g).find(n=>n.class_type==='LanPaint_KSampler')!;
  expect(sampler.inputs).toMatchObject({steps:8,cfg:1,seed:123,model:['lora',0],denoise:0.7,LanPaint_NumSteps:5});
  expect(Object.values(g).filter(n=>n.class_type==='SaveImage')).toHaveLength(1);
  expect(Object.values(g).find(n=>n.class_type==='ImageToMask')?.inputs).toMatchObject({channel:'red'});
  expect(Object.values(g).find(n=>n.class_type==='LanPaint_ImageDecode')?.inputs).toHaveProperty('mask');
 });
 it('preserves linked scalar inputs and Anima encoder type',()=>{const s=source();s.clip.inputs={clip_name:'qwen',type:'anima'};s.steps={class_type:'PrimitiveInt',inputs:{value:20}};(s.sampler.inputs as any).steps=['steps',0];const g=buildInpaintGraph(s,opts);expect(g.steps).toEqual(s.steps);expect(g.clip).toEqual(s.clip);});
 it('rejects ambiguous models and broken graphs before submission',()=>{const s=source();s.second=structuredClone(s.sampler);expect(()=>buildInpaintGraph(s,opts)).toThrow('不唯一');expect(()=>dependencyGraph({a:{inputs:{b:['b',0]}}},['a'])).toThrow('不存在');expect(()=>dependencyGraph({a:{inputs:{b:['b',0]}},b:{inputs:{a:['a',0]}}},['a'])).toThrow('循环');});
 it('detects only selected parts and unions the masks',()=>{expect(buildDetectionGraph('x','sam',{enabled:true,hands:true,feet:false}).foot).toBeUndefined();expect(buildDetectionGraph('x','sam',{enabled:true,hands:true,feet:true}).union.inputs).toMatchObject({operation:'add'});expect(()=>buildDetectionGraph('x','sam',{enabled:true,hands:false,feet:false})).toThrow('至少');expect(normalizeAutoRepair()).toEqual({enabled:false,hands:true,feet:true});});
});
