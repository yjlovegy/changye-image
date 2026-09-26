import {afterEach,describe,it,expect,vi} from 'vitest';
vi.mock('./comfyui',()=>({parseWorkflowTemplate:JSON.parse,runComfyWorkflow:vi.fn()}));
vi.mock('./comfyInpaintGraph',()=>({inspectInpaintSource:vi.fn(),buildDetectionGraph:()=>({}),buildInpaintGraph:()=>({}),normalizeAutoRepair:(x:unknown)=>x}));
import {autoRepairImage,uploadInpaintImage,checkInpaintSupport} from './comfyInpaint';
import {runComfyWorkflow} from './comfyui';
const conn={url:'http://localhost:8188',workflow:'{}',autoRepair:{enabled:true,hands:true,feet:true}} as any;
const original=()=>({url:'data:image/png;base64,AA==',format:'png',filename:'base.png',revoke:vi.fn()});
afterEach(()=>{vi.unstubAllGlobals();vi.clearAllMocks();});
describe('inpaint failure boundaries',()=>{
 it('does not call network while automatic repair is disabled',async()=>{const fetch=vi.fn();vi.stubGlobal('fetch',fetch);const base=original();expect(await autoRepairImage({...conn,autoRepair:{...conn.autoRepair,enabled:false}},{},base)).toBe(base);expect(fetch).not.toHaveBeenCalled();});
 it('returns the successfully generated base image if dependencies are missing',async()=>{vi.stubGlobal('fetch',vi.fn(async()=>new Response('{}')));const base=original();const result=await autoRepairImage(conn,{},base);expect(result).toBe(base);expect(result.repairNotice).toContain('缺少节点');expect(base.revoke).not.toHaveBeenCalled();expect(runComfyWorkflow).not.toHaveBeenCalled();});
 it('stops without returning a late result when cancellation happens',async()=>{const c=new AbortController();c.abort();vi.stubGlobal('fetch',vi.fn(async()=>{throw new DOMException('stop','AbortError');}));const base=original();await expect(autoRepairImage(conn,{},base,c.signal)).rejects.toMatchObject({name:'AbortError'});expect(base.revoke).toHaveBeenCalledOnce();});
 it('rejects unexpected upload paths',async()=>{vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({name:'../x.png',type:'input',subfolder:'changye_inpaint'}))));await expect(uploadInpaintImage(conn.url,new Blob(['x']))).rejects.toThrow('路径无效');});
});
