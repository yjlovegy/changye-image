import { buildDetectionGraph, buildInpaintGraph, normalizeAutoRepair, inspectInpaintSource } from './comfyInpaintGraph';
import { composeComfyNegative, composeComfyPositive, normalizeComfyFixedPrompts } from './comfyFixedPrompts';
import { parseWorkflowTemplate, runComfyWorkflow, type ComfyImageResult, type ComfyWorkflow, type ComfyProgressHooks } from './comfyui';
import type { ComfyRunConn } from '@/state/settings';
import { muteWorkflowNegative } from './comfyNegativePolicy';

const endpoint=(url:string,path:string)=>`${url.trim().replace(/\/+$/,'')}/${path}`;
async function request(url:string, init?:RequestInit):Promise<Response>{
  try {const r=await fetch(url,init);if(!r.ok)throw new Error(`ComfyUI 请求失败 (${r.status})：${(await r.text()).slice(0,250)}`);return r;}
  catch(e){if(e instanceof TypeError)throw new Error('局部重绘需要直连 ComfyUI，请检查服务地址与 CORS 设置');throw e;}
}
export async function checkInpaintSupport(conn:ComfyRunConn, automatic=false, signal?:AbortSignal) {
  signal = signal ? AbortSignal.any([signal,AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000);
  inspectInpaintSource(parseWorkflowTemplate(conn.workflow));
  const types=['LanPaint_KSampler','LanPaint_ImageEncode','LanPaint_ImageDecode','InpaintCropImproved','InpaintStitchImproved',...(automatic?['SAM3_Detect','CheckpointLoaderSimple']:[])];
  const nodes=Object.assign({},...await Promise.all(types.map(async name=>{
    const r=await request(endpoint(conn.url,`object_info/${name}`),{signal});return r.json();
  })));
  const absent=types.filter(name=>!nodes[name]);
  if(absent.length)throw new Error(`缺少节点：${absent.join('、')}。请安装 LanPaint / Inpaint Crop and Stitch，并重启 ComfyUI`);
  const samModels=nodes.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0]??[];
  const checkpoint=automatic?samModels.find((name:string)=>/sam3(?:[._-]|$)/i.test(name)):undefined;
  if(automatic&&!checkpoint)throw new Error('未找到 SAM3 模型，请将模型放入 ComfyUI/models/checkpoints');
  return {checkpoint:checkpoint as string|undefined};
}
export async function uploadInpaintImage(url:string, image:Blob, signal?:AbortSignal):Promise<string>{
  if(!image.size || image.size>50*1024*1024)throw new Error('重绘图片大小需在 50 MB 以内');
  const ext=image.type==='image/jpeg'?'jpg':image.type==='image/webp'?'webp':'png';
  const body=new FormData();body.append('image',image,`${crypto.randomUUID()}.${ext}`);body.append('type','input');body.append('subfolder','changye_inpaint');body.append('overwrite','false');
  const result=await(await request(endpoint(url,'upload/image'),{method:'POST',body,signal})).json();
  if(result.type!=='input'||result.subfolder!=='changye_inpaint'||typeof result.name!=='string'||/[\\/]/.test(result.name))throw new Error('ComfyUI 返回的上传路径无效');
  return `${result.subfolder}/${result.name}`;
}
export async function imageBlob(url:string,signal?:AbortSignal):Promise<Blob>{
  const r=await fetch(url,{signal});if(!r.ok)throw new Error(`无法读取原图 (${r.status})`);return r.blob();
}
async function hasWhitePixels(blob:Blob):Promise<boolean>{
  const bitmap=await createImageBitmap(blob);
  try{const c=document.createElement('canvas');c.width=bitmap.width;c.height=bitmap.height;
    const ctx=c.getContext('2d',{willReadFrequently:true})!;ctx.drawImage(bitmap,0,0);
    const data=ctx.getImageData(0,0,c.width,c.height).data;
    for(let i=0;i<data.length;i+=4)if(data[i]>25)return true;return false;
  }finally{bitmap.close();}
}
export interface InpaintRequest { source:string; mask:Blob; instruction:string; negative?:string; seed:number; context?:number }
export async function inpaintImage(conn:ComfyRunConn,input:InpaintRequest,signal?:AbortSignal,hooks?:ComfyProgressHooks):Promise<ComfyImageResult>{
  await checkInpaintSupport(conn,false,signal);
  if(!await hasWhitePixels(input.mask))throw new Error('请先涂选要修改的区域');
  const source=await imageBlob(input.source,signal);
  const [image,mask]=await Promise.all([uploadInpaintImage(conn.url,source,signal),uploadInpaintImage(conn.url,input.mask,signal)]);
  const fixed=normalizeComfyFixedPrompts(conn.fixedPrompts);
  const graph=buildInpaintGraph(parseWorkflowTemplate(conn.workflow),{image,mask,seed:input.seed,context:input.context,
    positive:composeComfyPositive(input.instruction,fixed),negative:conn.negativeEnabled === false ? '' : composeComfyNegative(input.negative??'',fixed)});
  const result=await runComfyWorkflow(conn,conn.negativeEnabled === false ? muteWorkflowNegative(graph) : graph,signal,hooks);result.workflowId=conn.workflowId;return result;
}

/** Best-effort post processing. The successful base image remains available when detection/repair fails. */
export async function autoRepairImage(conn:ComfyRunConn,source:ComfyWorkflow,original:ComfyImageResult,signal?:AbortSignal,hooks?:ComfyProgressHooks,scene=''):Promise<ComfyImageResult>{
  const repair=normalizeAutoRepair(conn.autoRepair);
  if(!repair.enabled||(!repair.hands&&!repair.feet))return original;
  let detection:ComfyImageResult|undefined;
  try{
    const {checkpoint}=await checkInpaintSupport(conn,true,signal);
    const image=await uploadInpaintImage(conn.url,await imageBlob(original.url,signal),signal);
    detection=await runComfyWorkflow(conn,buildDetectionGraph(image,checkpoint!,repair),signal,hooks);
    const maskBlob=await imageBlob(detection.url,signal);
    if(!await hasWhitePixels(maskBlob)){original.repairNotice='未检测到所选部位，已保留原图';return original;}
    const mask=await uploadInpaintImage(conn.url,maskBlob,signal);
    const fixed=normalizeComfyFixedPrompts(conn.fixedPrompts);
    const seed=Math.floor(Math.random()*2**48);
    const graph=buildInpaintGraph(source,{image,mask,positive:composeComfyPositive(`Anatomically correct ${[repair.hands?'hands with five distinct fingers':'',repair.feet?'feet with natural toes':''].filter(Boolean).join(' and ')}. Preserve the original pose, clothing, colors, lighting and illustration style. ${scene}`,fixed),negative:conn.negativeEnabled === false ? '' : composeComfyNegative('extra fingers, fused fingers, extra limbs, deformed hands, deformed feet',fixed),seed});
    const result=await runComfyWorkflow(conn,conn.negativeEnabled === false ? muteWorkflowNegative(graph) : graph,signal,hooks);
    const revoke=result.revoke;result.original=original;result.workflowId=conn.workflowId;result.seed=seed;
    result.revoke=()=>{revoke();original.revoke();};return result;
  }catch(e){
    if(signal?.aborted){original.revoke();throw new DOMException('已停止生图','AbortError');}
    original.repairNotice=`自动修复未完成，底图已保留：${e instanceof Error?e.message:String(e)}`;return original;
  }finally{detection?.revoke();}
}
