import {afterEach,describe,it,expect,vi} from 'vitest';
vi.mock('./comfyui',()=>({parseWorkflowTemplate:JSON.parse,runComfyWorkflow:vi.fn()}));
vi.mock('./comfyInpaintGraph',()=>({inspectInpaintSource:vi.fn(),buildDetectionGraph:()=>({}),buildInpaintGraph:()=>({}),normalizeAutoRepair:(x:unknown)=>x}));
import {autoRepairImage,uploadInpaintImage,checkInpaintSupport} from './comfyInpaint';
import {runComfyWorkflow} from './comfyui';
import {trackImageTask,activeImageTasks} from '@/state/imageTasks';
import {stopGenerationTasks} from '@/state/generationTasks';
const conn={url:'http://localhost:8188',workflow:'{}',autoRepair:{enabled:true,hands:true,feet:true}} as any;
const original=()=>({url:'data:image/png;base64,AA==',format:'png',filename:'base.png',revoke:vi.fn()});
afterEach(()=>{stopGenerationTasks();vi.unstubAllGlobals();vi.resetAllMocks();});
describe('inpaint failure boundaries',()=>{
 it.each(['dependencies','detection','repair'])('history stop reaches automatic repair at %s and releases temporary images',async(stage)=>{
  let reached!:()=>void;const started=new Promise<void>(resolve=>{reached=resolve;});
  const waitForStop=(signal:AbortSignal)=>new Promise<never>((_resolve,reject)=>{reached();signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});
  vi.stubGlobal('fetch',vi.fn(async(input,init)=>{
   const url=String(input);
   if(url.includes('/object_info/')){
    if(stage==='dependencies')return waitForStop(init.signal);
    const name=url.split('/').at(-1)!;
    return new Response(JSON.stringify({[name]:{input:{required:{ckpt_name:[['sam3.pt']]}}}}));
   }
   if(url.endsWith('/upload/image'))return new Response(JSON.stringify({name:'fixture.png',type:'input',subfolder:'changye_inpaint'}));
   return new Response(new Blob(['image'],{type:'image/png'}));
  }));
  vi.stubGlobal('createImageBitmap',vi.fn(async()=>({width:1,height:1,close:vi.fn()})));
  vi.stubGlobal('document',{createElement:()=>({getContext:()=>({drawImage(){},getImageData:()=>({data:[255,255,255,255]})})})});
  const detection=original();
  if(stage==='repair')vi.mocked(runComfyWorkflow).mockResolvedValueOnce(detection);
  vi.mocked(runComfyWorkflow).mockImplementation((_conn,_graph,signal)=>waitForStop(signal!));
  const controller=new AbortController(),release=trackImageTask(controller),base=original();
  const job=autoRepairImage(conn,{},base,controller.signal).finally(release);
  await started;
  expect(activeImageTasks.value).toBe(1);
  stopGenerationTasks();
  await expect(job).rejects.toMatchObject({name:'AbortError'});
  expect(base.revoke).toHaveBeenCalledOnce();
  if(stage==='repair')expect(detection.revoke).toHaveBeenCalledOnce();
  expect(activeImageTasks.value).toBe(0);
 });
 it('does not call network while automatic repair is disabled',async()=>{const fetch=vi.fn();vi.stubGlobal('fetch',fetch);const base=original();expect(await autoRepairImage({...conn,autoRepair:{...conn.autoRepair,enabled:false}},{},base)).toBe(base);expect(fetch).not.toHaveBeenCalled();});
 it('returns the successfully generated base image if dependencies are missing',async()=>{vi.stubGlobal('fetch',vi.fn(async()=>new Response('{}')));const base=original();const result=await autoRepairImage(conn,{},base);expect(result).toBe(base);expect(result.repairNotice).toContain('缺少节点');expect(base.revoke).not.toHaveBeenCalled();expect(runComfyWorkflow).not.toHaveBeenCalled();});
 it('stops without returning a late result when cancellation happens',async()=>{const c=new AbortController();c.abort();vi.stubGlobal('fetch',vi.fn(async()=>{throw new DOMException('stop','AbortError');}));const base=original();await expect(autoRepairImage(conn,{},base,c.signal)).rejects.toMatchObject({name:'AbortError'});expect(base.revoke).toHaveBeenCalledOnce();});
 it('rejects unexpected upload paths',async()=>{vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({name:'../x.png',type:'input',subfolder:'changye_inpaint'}))));await expect(uploadInpaintImage(conn.url,new Blob(['x']))).rejects.toThrow('路径无效');});
});
