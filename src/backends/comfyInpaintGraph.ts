import type { ComfyWorkflow } from './comfyui';

export interface AutoRepairSettings { enabled: boolean; hands: boolean; feet: boolean }
export function normalizeAutoRepair(value?: Partial<AutoRepairSettings> | null): AutoRepairSettings {
  return { enabled: value?.enabled === true, hands: value?.hands !== false, feet: value?.feet !== false };
}
type Link = [string, number];
type Inputs = Record<string, unknown>;
export const isLink = (v: unknown): v is Link => Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && Number.isInteger(v[1]);
const inputs = (graph: ComfyWorkflow, id: string) => (graph[id]?.inputs ?? {}) as Inputs;

/** Keep only dependencies of the requested output. Never execute unrelated API/LLM/save branches. */
export function dependencyGraph(graph: ComfyWorkflow, outputs: string[]): ComfyWorkflow {
  const out: ComfyWorkflow = {}, visiting = new Set<string>();
  const visit = (id: string) => {
    if (out[id]) return;
    if (!graph[id]) throw new Error(`工作流引用了不存在的节点 ${id}`);
    if (visiting.has(id)) throw new Error('工作流存在循环连线');
    visiting.add(id);
    for (const value of Object.values(inputs(graph,id))) if (isLink(value)) visit(value[0]);
    visiting.delete(id);out[id] = structuredClone(graph[id]);
  };
  outputs.forEach(visit);return out;
}

export function inspectInpaintSource(graph: ComfyWorkflow) {
  const samplers = Object.entries(graph).filter(([,n]) => n.class_type === 'KSampler');
  if (samplers.length !== 1) throw new Error('局部重绘暂需一个标准 KSampler 的工作流；当前采样分支不唯一，请使用单采样器版本');
  const [id] = samplers[0], s = inputs(graph,id);
  if (!isLink(s.model) || !isLink(s.positive) || !isLink(s.negative)) throw new Error('采样器的模型或提示词连线不完整');
  const decoders = Object.entries(graph).filter(([,n]) => ['VAEDecode','VAEDecodeTiled'].includes(String(n.class_type))
    && isLink((n.inputs as Inputs)?.samples) && ((n.inputs as Inputs).samples as Link)[0] === id);
  const vaes = decoders.map(([key])=>inputs(graph,key).vae).filter(isLink);
  if (!vaes.length || vaes.some(v=>JSON.stringify(v)!==JSON.stringify(vaes[0]))) throw new Error('无法确定局部重绘使用的 VAE');
  const positiveGraph = dependencyGraph(graph,[s.positive[0]]);
  const clips = Object.values(positiveGraph).filter(n=>n.class_type==='CLIPTextEncode').map(n=>(n.inputs as Inputs).clip).filter(isLink);
  if (!clips.length || clips.some(v=>JSON.stringify(v)!==JSON.stringify(clips[0]))) throw new Error('无法确定局部重绘的文本编码器，请使用标准 CLIPTextEncode 节点');
  return { sampler:s, model:s.model, clip:clips[0], vae:vaes[0] };
}

export interface InpaintGraphOptions {
  image: string; mask: string; positive: string; negative: string; seed: number;
  context?: number; targetSize?: number; thinkingSteps?: number;
}

/** API graph shared by Krea2 and Anima; retain the model/CLIP/LoRA graph without editing the saved workflow. */
export function buildInpaintGraph(source: ComfyWorkflow, o: InpaintGraphOptions): ComfyWorkflow {
  if (!o.positive.trim()) throw new Error('请填写修改要求');
  const {sampler,model,clip,vae} = inspectInpaintSource(source);
  const scalarLinks = [sampler.steps,sampler.cfg,sampler.sampler_name,sampler.scheduler].filter(isLink);
  const graph = dependencyGraph(source,[model[0],clip[0],vae[0],...scalarLinks.map(v=>v[0])]);
  let seq=0;
  const add=(class_type:string, values:Inputs):Link=>{
    let id:string;do{id=`cy_inpaint_${++seq}`;}while(graph[id]);
    graph[id]={class_type,inputs:values,_meta:{title:`局部重绘 · ${class_type}`}};return [id,0];
  };
  const image=add('LoadImage',{image:o.image}), maskImage=add('LoadImage',{image:o.mask});
  const mask=add('ImageToMask',{image:maskImage,channel:'red'});
  const crop=add('InpaintCropImproved',{
    image,mask,downscale_algorithm:'bilinear',upscale_algorithm:'bicubic',
    preresize:false,preresize_mode:'ensure minimum resolution',preresize_min_width:1024,preresize_min_height:1024,
    preresize_max_width:16384,preresize_max_height:16384,mask_fill_holes:false,mask_expand_pixels:0,
    mask_invert:false,mask_blend_pixels:16,mask_hipass_filter:0.1,extend_for_outpainting:false,
    extend_up_factor:1,extend_down_factor:1,extend_left_factor:1,extend_right_factor:1,
    context_from_mask_extend_factor:o.context??1.5,output_resize_to_target_size:true,
    output_target_width:o.targetSize??768,output_target_height:o.targetSize??768,output_padding:'32',device_mode:'cpu (compatible)',
  });
  const croppedImage:Link=[crop[0],1], croppedMask:Link=[crop[0],2];
  const latent=add('LanPaint_ImageEncode',{image:croppedImage,mask:croppedMask,vae});
  const positive=add('CLIPTextEncode',{clip,text:o.positive}), negative=add('CLIPTextEncode',{clip,text:o.negative});
  const sample=add('LanPaint_KSampler',{
    model,positive,negative,latent_image:latent,seed:o.seed,steps:sampler.steps,cfg:sampler.cfg,
    sampler_name:sampler.sampler_name,scheduler:sampler.scheduler,denoise:1,
    LanPaint_NumSteps:o.thinkingSteps??3,LanPaint_PromptMode:'Image First',LanPaint_Info:'',Inpainting_mode:'🖼️ Image Inpainting',
  });
  const decoded=add('LanPaint_ImageDecode',{samples:sample,vae,image:croppedImage,mask:croppedMask,blend_overlap:9});
  const stitched=add('InpaintStitchImproved',{stitcher:crop,inpainted_image:decoded});
  const output=add('SaveImage',{images:stitched,filename_prefix:'changye/inpaint'});
  return dependencyGraph(graph,[output[0]]);
}

export function buildDetectionGraph(image:string, checkpoint:string, repair:AutoRepairSettings):ComfyWorkflow {
  if (!repair.hands&&!repair.feet) throw new Error('请至少选择手部或脚部');
  const g:ComfyWorkflow={load:{class_type:'LoadImage',inputs:{image}},sam:{class_type:'CheckpointLoaderSimple',inputs:{ckpt_name:checkpoint}}};
  const masks:Link[]=[];
  for(const part of ['hand','foot']) {
    if(part==='hand'?!repair.hands:!repair.feet)continue;
    g[`${part}_text`]={class_type:'CLIPTextEncode',inputs:{clip:['sam',1],text:part}};
    g[part]={class_type:'SAM3_Detect',inputs:{model:['sam',0],image:['load',0],conditioning:[`${part}_text`,0],threshold:0.35,refine_iterations:2,individual_masks:false}};
    masks.push([part,0]);
  }
  let mask=masks[0];
  if(masks.length===2){g.union={class_type:'MaskComposite',inputs:{destination:masks[0],source:masks[1],x:0,y:0,operation:'add'}};mask=['union',0];}
  g.expand={class_type:'GrowMask',inputs:{mask,expand:12,tapered_corners:true}};
  g.image={class_type:'MaskToImage',inputs:{mask:['expand',0]}};
  g.output={class_type:'PreviewImage',inputs:{images:['image',0]}};return g;
}
