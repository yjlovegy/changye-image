import { dependencyGraph, inspectInpaintSource, isLink } from './comfyInpaintGraph';
import type { ComfyWorkflow } from './comfyui';
import type { ComfyPostSettings } from './comfyPostSettings';
type Link = [string, number];

/** Only reuse model/conditioning dependencies. Do not rerun the original sampler or external branches. */
export function buildPostGraph(source: ComfyWorkflow, image: string, p: ComfyPostSettings, size: {width:number;height:number}, seed: number): ComfyWorkflow {
  let graph: ComfyWorkflow = {};
  const base = p.hires.enabled ? inspectInpaintSource(source) : undefined;
  if (base) {
    const roots = [base.model,base.vae,base.sampler.positive,base.sampler.negative,base.sampler.steps,base.sampler.cfg,base.sampler.sampler_name,base.sampler.scheduler].filter(isLink);
    graph = dependencyGraph(source, roots.map(v=>v[0]));
  }
  let seq = 0;
  const add = (class_type:string, inputs:Record<string,unknown>): Link => {
    let id:string; do { id=`cy_post_${++seq}`; } while (graph[id]);
    graph[id]={class_type,inputs}; return [id,0];
  };
  let pixels = add('LoadImage',{image});
  if (p.upscale.enabled) {
    const model = add('UpscaleModelLoader',{model_name:p.upscale.model});
    pixels = add('ImageUpscaleWithModel',{upscale_model:model,image:pixels});
  }
  // A single target size: enabling both stages must not multiply the scale twice.
  if (p.upscale.enabled || p.hires.enabled) pixels = add('ImageScale',{image:pixels,upscale_method:'lanczos',...size,crop:'disabled'});
  if (base) {
    const latent = add('VAEEncodeTiled',{pixels,vae:base.vae,tile_size:512,overlap:64,temporal_size:64,temporal_overlap:8});
    const sample = add('KSampler',{...base.sampler,latent_image:latent,seed,steps:p.hires.steps || base.sampler.steps,denoise:p.hires.denoise});
    pixels = add('VAEDecodeTiled',{samples:sample,vae:base.vae,tile_size:512,overlap:64,temporal_size:64,temporal_overlap:8});
  }
  add('SaveImage',{images:pixels,filename_prefix:'changye/enhance'});
  return graph;
}

export function buildFinishGraph(image:string, p:ComfyPostSettings):ComfyWorkflow {
  const graph:ComfyWorkflow={load:{class_type:'LoadImage',inputs:{image}}};
  let pixels:Link=['load',0];
  if(p.sharpen.enabled){graph.sharpen={class_type:'ImageSharpen',inputs:{image:pixels,sharpen_radius:1,sigma:1,alpha:p.sharpen.strength}};pixels=['sharpen',0];}
  if(p.color.enabled){graph.color={class_type:'LayerColor: BrightnessContrastV2',inputs:{image:pixels,brightness:p.color.brightness,contrast:p.color.contrast,saturation:p.color.saturation}};pixels=['color',0];}
  graph.output={class_type:'SaveImage',inputs:{images:pixels,filename_prefix:'changye/finish'}};
  return graph;
}

export function buildDetailDetection(image:string,checkpoint:string,part:'face'|'eyes'):ComfyWorkflow {
  return {
    load:{class_type:'LoadImage',inputs:{image}},sam:{class_type:'CheckpointLoaderSimple',inputs:{ckpt_name:checkpoint}},
    text:{class_type:'CLIPTextEncode',inputs:{clip:['sam',1],text:part}},
    detect:{class_type:'SAM3_Detect',inputs:{model:['sam',0],image:['load',0],conditioning:['text',0],threshold:0.35,refine_iterations:2,individual_masks:false}},
    pixels:{class_type:'MaskToImage',inputs:{mask:['detect',0]}},
    output:{class_type:'PreviewImage',inputs:{images:['pixels',0]}},
  };
}
