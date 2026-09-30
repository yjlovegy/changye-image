import {describe,it,expect} from 'vitest';
import {buildPostGraph,buildFinishGraph,buildDetailDetection} from './comfyPostGraph';
import {defaultComfyPost,postTargetSize,validateComfyPost} from './comfyPostSettings';
import type {ComfyWorkflow} from './comfyui';
const source=():ComfyWorkflow=>({model:{class_type:'UNETLoader',inputs:{unet_name:'original'}},clip:{class_type:'CLIPLoader',inputs:{type:'krea2'}},vae:{class_type:'VAELoader',inputs:{}},pos:{class_type:'CLIPTextEncode',inputs:{clip:['clip',0],text:'scene'}},neg:{class_type:'CLIPTextEncode',inputs:{clip:['clip',0],text:''}},latent:{class_type:'EmptyLatentImage',inputs:{width:512,height:768}},sampler:{class_type:'KSampler',inputs:{model:['model',0],positive:['pos',0],negative:['neg',0],latent_image:['latent',0],steps:8,cfg:1,sampler_name:'euler',scheduler:'simple',denoise:1,seed:1}},decode:{class_type:'VAEDecode',inputs:{vae:['vae',0],samples:['sampler',0]}},output:{class_type:'SaveImage',inputs:{images:['decode',0]}},llm:{class_type:'UnrelatedRemoteNode',inputs:{}}});
describe('post graphs and isolation',()=>{
 it('requests multiple independent face and eye masks instead of SAM3 default single detection',()=>{
  expect(buildDetailDetection('a','sam','face').text.inputs).toMatchObject({text:'face:6'});
  const eyes=buildDetailDetection('a','sam','eyes');expect(eyes.text.inputs).toMatchObject({text:'eyes:12'});
  expect(eyes.detect.inputs).toMatchObject({individual_masks:true,threshold:0.5});
 });
 it('combines upscaling and hires with one target size and the original model settings',()=>{const s=source(),before=JSON.stringify(s),p=defaultComfyPost();p.upscale.enabled=p.hires.enabled=true;const g=buildPostGraph(s,'original.png',p,postTargetSize(512,768,1.5),42),nodes=Object.values(g);expect(nodes.filter(n=>n.class_type==='ImageScale')).toHaveLength(1);expect(nodes.find(n=>n.class_type==='ImageScale')?.inputs).toMatchObject({width:768,height:1152});expect(nodes.filter(n=>n.class_type==='KSampler')).toHaveLength(1);expect(nodes.find(n=>n.class_type==='KSampler')?.inputs).toMatchObject({cfg:1,steps:8,seed:42,denoise:0.25});expect(g.llm).toBeUndefined();expect(g.latent).toBeUndefined();expect(JSON.stringify(s)).toBe(before);});
 it('runs model-free upscale and finish without requiring an inspectable sampler',()=>{const p=defaultComfyPost();p.upscale.enabled=true;expect(Object.values(buildPostGraph({},'a',p,{width:768,height:1024},1)).some(n=>n.class_type==='UNETLoader')).toBe(false);p.color.enabled=true;expect(buildFinishGraph('a',p).color.inputs).toMatchObject({brightness:1,contrast:1,saturation:1});});
 it('rejects excessively large or invalid user values',()=>{expect(()=>postTargetSize(2048,4096,4)).toThrow();const p=defaultComfyPost();p.hires.denoise=NaN;expect(()=>validateComfyPost(p)).toThrow();});
});
