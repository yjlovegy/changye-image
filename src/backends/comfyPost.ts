import type { ComfyRunConn } from '@/state/settings';
import { parseWorkflowTemplate, runComfyWorkflow, runComfyWorkflowBatch, type ComfyWorkflow, type ComfyImageResult, type ComfyProgressHooks } from './comfyui';
import { uploadInpaintImage, imageBlob, autoRepairImage } from './comfyInpaint';
import { buildInpaintGraph, inspectInpaintSource } from './comfyInpaintGraph';
import { buildPostGraph, buildFinishGraph, buildDetailDetection } from './comfyPostGraph';
import { normalizeComfyPost, postEnabled, postTargetSize, validateComfyPost, type ComfyPostSettings } from './comfyPostSettings';
import { decodePixels, protectedInpaintResult } from './inpaintComposite';
import { inpaintReferenceSize } from './inpaintReference';
import { planDetailRegions, detailMaskBlob, detailPrompt } from './detailRegions';

const endpoint=(url:string,path:string)=>`${url.trim().replace(/\/+$/,'')}/${path}`;
const choices=(field:unknown):string[]=>{const f=field as any;return (Array.isArray(f?.[0])?f[0]:f?.[1]?.options)??[];};
async function nodeInfo(url:string,name:string,signal?:AbortSignal){
  const r=await fetch(endpoint(url,`object_info/${encodeURIComponent(name)}`),{signal});
  if(!r.ok)throw new Error(`无法检查 ComfyUI 节点：${name}`);
  const data=await r.json();if(!data[name])throw new Error(`缺少节点：${name}`);return data[name];
}
export async function upscaleModels(url:string,signal?:AbortSignal):Promise<string[]>{
  return choices((await nodeInfo(url,'UpscaleModelLoader',signal??AbortSignal.timeout(15000))).input?.required?.model_name);
}
async function checkDetailSupport(conn:ComfyRunConn,signal?:AbortSignal) {
  const bounded=signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000);
  const types=['VAEEncode','VAEDecode','SetLatentNoiseMask','KSampler','ImageBlur','ImageCrop','CropMask','ImageScale','ImageToMask','MaskToImage','ImageCompositeMasked'];
  await Promise.all(types.map(name=>nodeInfo(conn.url,name,bounded)));
  const detector=await nodeInfo(conn.url,'SAM3_Detect',bounded);
  if(!detector.input?.required?.individual_masks && !detector.input?.optional?.individual_masks)throw new Error('SAM3 节点不支持独立选区，请更新 ComfyUI');
  const checkpoint=choices((await nodeInfo(conn.url,'CheckpointLoaderSimple',bounded)).input?.required?.ckpt_name).find(name=>/sam3(?:[._-]|$)/i.test(name));
  if(!checkpoint)throw new Error('未找到 SAM3 模型');
  return checkpoint;
}
export async function checkPostSupport(conn:ComfyRunConn,p:ComfyPostSettings,signal?:AbortSignal){
  validateComfyPost(p);if(!postEnabled(p))return;
  const timeout=AbortSignal.timeout(15000),bounded=signal?AbortSignal.any([signal,timeout]):timeout;
  const types=['LoadImage','SaveImage',...(p.upscale.enabled?['ImageUpscaleWithModel']:[]),...(p.upscale.enabled||p.hires.enabled?['ImageScale']:[]),...(p.hires.enabled?['VAEEncodeTiled','VAEDecodeTiled']:[]),...(p.sharpen.enabled?['ImageSharpen']:[]),...(p.color.enabled?['LayerColor: BrightnessContrastV2']:[])];
  await Promise.all(types.map(name=>nodeInfo(conn.url,name,bounded)));
  if(p.upscale.enabled && !(await upscaleModels(conn.url,bounded)).includes(p.upscale.model))throw new Error(`未找到放大模型：${p.upscale.model}`);
  if(p.hires.enabled)inspectInpaintSource(parseWorkflowTemplate(conn.workflow));
  if(p.detail.enabled){inspectInpaintSource(parseWorkflowTemplate(conn.workflow));await checkDetailSupport(conn,bounded);}
}

/** Execute optional stages independently. A failed stage never destroys a successful base image. */
export async function postProcessImage(conn:ComfyRunConn,source:ComfyWorkflow,original:ComfyImageResult,signal?:AbortSignal,hooks?:ComfyProgressHooks,scene=''){
  const p=normalizeComfyPost(conn.postProcessing);
  let current=original;
  const notices:string[]=[];
  const abort=()=>{if(signal?.aborted)throw new DOMException('已停止生图','AbortError');};
  const adopt=(next:ComfyImageResult)=>{
    if(next===current)return;
    const prior=current;
    next.workflowId=conn.workflowId;next.preservePixels=true;current=next;
    if(prior!==original)prior.revoke();
  };
  const stage=async(label:string,fn:()=>Promise<void>)=>{
    abort();try{await fn();abort();}catch(e){if(signal?.aborted || (e instanceof DOMException && e.name==='AbortError'))throw e;notices.push(`${label}未完成：${e instanceof Error?e.message:String(e)}`);}
  };
  const upload=async()=>uploadInpaintImage(conn.url,await imageBlob(current.url,signal),signal);
  const seed=original.seed??Math.floor(Math.random()*2**48);
  try{
    if(p.upscale.enabled||p.hires.enabled)await stage('高清处理',async()=>{
      const pixels=await decodePixels(await imageBlob(current.url,signal));
      const size=postTargetSize(pixels.width,pixels.height,p.scale);
      const input=await upload();
      adopt(await runComfyWorkflow(conn,buildPostGraph(source,input,p,size,seed),signal,hooks));
    });
    if(conn.autoRepair?.enabled)await stage('自动修复',async()=>{
      // Give the legacy repair stage a borrowed input; this coordinator owns URLs.
      const borrowed={...current,revoke:()=>{}};
      const repaired=await autoRepairImage(conn,source,borrowed,signal,hooks,scene);
      if(repaired.repairNotice)notices.push(repaired.repairNotice);
      if(repaired!==borrowed){delete repaired.original;adopt(repaired);}
    });
    if(p.detail.enabled)await stage('局部细节',async()=>{
      const checkpoint=await checkDetailSupport(conn,signal);
      const baseline=await imageBlob(current.url,signal),pixels=await decodePixels(baseline);
      const image=await uploadInpaintImage(conn.url,baseline,signal);
      const detect=async(part:'face'|'eyes')=>{
        const masks=await runComfyWorkflowBatch(conn,buildDetailDetection(image,checkpoint,part),'output',signal,hooks);
        try {
          if(masks.length*pixels.width*pixels.height>24_000_000)throw new Error('检测选区过多或过大，已跳过细节处理');
          const decoded=[];
          for(const mask of masks)decoded.push(await decodePixels(await imageBlob(mask.url,signal)));
          return decoded;
        }finally{masks.forEach(mask=>mask.revoke());}
      };
      const faces=await detect('face');
      const eyes=p.detail.eyes&&faces.length?await detect('eyes'):[];
      const plan=planDetailRegions(faces,eyes,pixels,p.detail);
      if(plan.rejected)notices.push(`已跳过 ${plan.rejected} 处范围异常或归属不明确的细节选区`);
      if(plan.skipped)notices.push('检测区域较多，仅处理前 6 张脸');
      if(!plan.regions.length){notices.push('未找到可安全处理的细节选区，已保留处理前图片');return;}
      for(const region of plan.regions){
        abort();const sourcePixels=await decodePixels(await imageBlob(current.url,signal));
        const mask=await uploadInpaintImage(conn.url,await detailMaskBlob(region.mask),signal);
        // Every crop sees the unchanged baseline; final compositing keeps previous faces intact.
        const graph=buildInpaintGraph(source,{image,mask,seed,denoise:p.detail.denoise,sampling:'masked-img2img',referenceRect:region.reference,referenceSize:inpaintReferenceSize(region.reference,p.detail.resolution),positive:detailPrompt(region.part),negative:conn.negativeEnabled===false?'':'blurry facial features, distorted face, duplicate facial features, extra eyes'});
        const raw=await runComfyWorkflow(conn,graph,signal,hooks);
        adopt(await protectedInpaintResult(sourcePixels,region.mask,raw,8,signal));
      }
    });
    if(p.sharpen.enabled||p.color.enabled)await stage('锐化与调色',async()=>{
      adopt(await runComfyWorkflow(conn,buildFinishGraph(await upload(),p),signal,hooks));
    });
    abort();if(notices.length)current.repairNotice=notices.join('；');
    if(current!==original){const release=current.revoke;current.original=original;current.revoke=()=>{release();original.revoke();};}
    return current;
  }catch(e){current.revoke();if(current!==original)original.revoke();throw e;}
}
