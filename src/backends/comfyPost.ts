import type { ComfyRunConn } from '@/state/settings';
import { parseWorkflowTemplate, runComfyWorkflow, type ComfyWorkflow, type ComfyImageResult, type ComfyProgressHooks } from './comfyui';
import { checkInpaintSupport, uploadInpaintImage, imageBlob, autoRepairImage } from './comfyInpaint';
import { buildInpaintGraph, inspectInpaintSource, dependencyGraph, isLink } from './comfyInpaintGraph';
import { buildPostGraph, buildFinishGraph, buildDetailDetection } from './comfyPostGraph';
import { normalizeComfyPost, postEnabled, postTargetSize, validateComfyPost, type ComfyPostSettings } from './comfyPostSettings';
import { decodePixels, protectedInpaintResult } from './inpaintComposite';
import { inpaintReferenceRect, inpaintReferenceSize } from './inpaintReference';
import { detailRegions, regionMask } from './detailRegions';

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
export async function checkPostSupport(conn:ComfyRunConn,p:ComfyPostSettings,signal?:AbortSignal){
  validateComfyPost(p);if(!postEnabled(p))return;
  const timeout=AbortSignal.timeout(15000),bounded=signal?AbortSignal.any([signal,timeout]):timeout;
  const types=['LoadImage','SaveImage',...(p.upscale.enabled?['ImageUpscaleWithModel']:[]),...(p.upscale.enabled||p.hires.enabled?['ImageScale']:[]),...(p.hires.enabled?['VAEEncodeTiled','VAEDecodeTiled']:[]),...(p.sharpen.enabled?['ImageSharpen']:[]),...(p.color.enabled?['LayerColor: BrightnessContrastV2']:[])];
  await Promise.all(types.map(name=>nodeInfo(conn.url,name,bounded)));
  if(p.upscale.enabled && !(await upscaleModels(conn.url,bounded)).includes(p.upscale.model))throw new Error(`未找到放大模型：${p.upscale.model}`);
  if(p.hires.enabled)inspectInpaintSource(parseWorkflowTemplate(conn.workflow));
  if(p.detail.enabled)await checkInpaintSupport(conn,true,bounded,true);
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
      const {checkpoint}=await checkInpaintSupport(conn,true,signal,true);
      const base=inspectInpaintSource(source);
      const text=(link:unknown)=>isLink(link)?Object.values(dependencyGraph(source,[link[0]])).filter(n=>n.class_type==='CLIPTextEncode').map(n=>String((n.inputs as Record<string,unknown>).text??'')).join('\n'):'';
      const positive=text(base.sampler.positive)||scene,negative=conn.negativeEnabled===false?'':text(base.sampler.negative);
      for(const part of ['face','eyes'] as const){
        if(!p.detail[part])continue;
        const input=await upload();
        const detection=await runComfyWorkflow(conn,buildDetailDetection(input,checkpoint!,part),signal,hooks);
        let mask;
        try{mask=await decodePixels(await imageBlob(detection.url,signal));}finally{detection.revoke();}
        const regions=detailRegions(mask);
        if(!regions.regions.length){notices.push(`未检测到${part==='face'?'脸部':'眼睛'}，已跳过`);continue;}
        if(regions.skipped)notices.push(`检测区域较多，仅处理面积最大的 6 处${part==='face'?'脸部':'眼睛'}`);
        for(const region of regions.regions){
          abort();const sourcePixels=await decodePixels(await imageBlob(current.url,signal));
          if(mask.width!==sourcePixels.width||mask.height!==sourcePixels.height)throw new Error('细节选区尺寸不一致');
          const blob=await regionMask(mask,regions.labels,region.id),maskPixels=await decodePixels(blob);
          const rect=inpaintReferenceRect(region,mask.width,mask.height,part==='face'?2:3,false);
          const [image,maskName]=await Promise.all([upload(),uploadInpaintImage(conn.url,blob,signal)]);
          const graph=buildInpaintGraph(source,{image,mask:maskName,seed,denoise:p.detail.denoise,thinkingSteps:3,promptMode:'Image First',referenceRect:rect,referenceSize:inpaintReferenceSize(rect,p.detail.resolution),positive:`Refine the existing ${part==='face'?'face':'eyes'} with clean natural details. Preserve the same identity, expression, gaze, colors, lighting and art style. Do not add accessories. ${positive}`,negative});
          const raw=await runComfyWorkflow(conn,graph,signal,hooks);
          adopt(await protectedInpaintResult(sourcePixels,maskPixels,raw,6,signal));
        }
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
