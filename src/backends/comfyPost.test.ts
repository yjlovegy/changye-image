import {afterEach,describe,it,expect,vi} from 'vitest';
vi.mock('./comfyui',()=>({parseWorkflowTemplate:JSON.parse,runComfyWorkflow:vi.fn()}));
vi.mock('./comfyInpaint',()=>({imageBlob:vi.fn(async()=>new Blob(['image'])),uploadInpaintImage:vi.fn(async()=> 'input.png'),checkInpaintSupport:vi.fn(),autoRepairImage:vi.fn()}));
vi.mock('./inpaintComposite',()=>({decodePixels:vi.fn(async()=>({width:512,height:768,data:new Uint8ClampedArray()})),protectedInpaintResult:vi.fn()}));
import {postProcessImage,upscaleModels} from './comfyPost';
import {runComfyWorkflow} from './comfyui';
import {autoRepairImage} from './comfyInpaint';
import {defaultComfyPost} from './comfyPostSettings';
import {saveImageResult, readStore, historyEntries, promptHash} from '@/floor/storage';
import {settings} from '@/state/settings';
const result=(name='base')=>({url:name,filename:name+'.png',format:'png',revoke:vi.fn()});
afterEach(()=>{vi.resetAllMocks();vi.unstubAllGlobals();});
describe('optional post processing lifecycle',()=>{
 it('releases intermediate versions and retains the base only for resource ownership',async()=>{const p=defaultComfyPost();p.upscale.enabled=p.color.enabled=true;const base=result(),middle=result('upscale'),last=result('finish'),releaseMiddle=middle.revoke;vi.mocked(runComfyWorkflow).mockResolvedValueOnce(middle).mockResolvedValueOnce(last);const r=await postProcessImage({postProcessing:p} as any,{},base);expect(r.original).toBe(base);expect(releaseMiddle).toHaveBeenCalledOnce();expect(base.revoke).not.toHaveBeenCalled();r.revoke();expect(base.revoke).toHaveBeenCalledOnce();expect(releaseMiddle).toHaveBeenCalledOnce();});
 it('keeps a successful upscale when a later finish stage fails',async()=>{const p=defaultComfyPost();p.upscale.enabled=p.color.enabled=true;const base=result(),middle=result('upscale');vi.mocked(runComfyWorkflow).mockResolvedValueOnce(middle).mockRejectedValueOnce(new Error('finish failed'));const r=await postProcessImage({postProcessing:p} as any,{},base);expect(r).toBe(middle);expect(r.original).toBe(base);expect(r.repairNotice).toContain('finish failed');expect(base.revoke).not.toHaveBeenCalled();});
 it('has zero requests when everything is disabled',async()=>{const b=result();expect(await postProcessImage({} as any,{},b)).toBe(b);expect(runComfyWorkflow).not.toHaveBeenCalled();});
 it('keeps the original when the first processing stage fails',async()=>{const p=defaultComfyPost();p.sharpen.enabled=true;vi.mocked(runComfyWorkflow).mockRejectedValueOnce(new Error('node unavailable'));const b=result();const r=await postProcessImage({postProcessing:p} as any,{},b);expect(r).toBe(b);expect(r.repairNotice).toContain('node unavailable');expect(b.revoke).not.toHaveBeenCalled();});
 it('preserves original ownership and propagates cancellation after a result arrives',async()=>{const p=defaultComfyPost();p.sharpen.enabled=true;const b=result(),out=result('out'),revokeOut=out.revoke,c=new AbortController();vi.mocked(runComfyWorkflow).mockImplementationOnce(async()=>{c.abort();return out;});await expect(postProcessImage({postProcessing:p} as any,{},b,c.signal)).rejects.toMatchObject({name:'AbortError'});expect(b.revoke).toHaveBeenCalledOnce();expect(revokeOut).toHaveBeenCalledOnce();});
 it('returns a lossless final version linked to the original',async()=>{const p=defaultComfyPost();p.color.enabled=true;const b=result(),out=result('out');vi.mocked(runComfyWorkflow).mockResolvedValueOnce(out);const r=await postProcessImage({postProcessing:p,workflowId:'a'} as any,{},b);expect(r.original).toBe(b);expect(r.preservePixels).toBe(true);expect(r.workflowId).toBe('a');r.revoke();expect(b.revoke).toHaveBeenCalledOnce();});
 it('keeps the legacy repair path operational',async()=>{const b=result();vi.mocked(autoRepairImage).mockResolvedValueOnce(b);expect(await postProcessImage({autoRepair:{enabled:true}} as any,{},b)).toBe(b);expect(autoRepairImage).toHaveBeenCalledOnce();});
 it.each([[[['a.pth']],['a.pth']],[['COMBO',{options:['b.pth']}],['b.pth']]])('reads both ComfyUI model list formats',async(field,expected)=>{vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({UpscaleModelLoader:{input:{required:{model_name:field}}}}))));expect(await upscaleModels('http://host')).toEqual(expected);});
});

describe('post processing to chat storage',()=>{
 it.each([[true,false],[false,true],[true,true]])('inserts exactly one final image for upscale=%s, sharpen=%s',async(upscale,sharpen)=>{
  settings.storage.saveAsJpeg=false;
  const p=defaultComfyPost();p.upscale.enabled=upscale;p.sharpen.enabled=sharpen;
  const base={...result(),url:'data:image/png;base64,AAAA'};
  const middle={...result('upscale'),url:'data:image/png;base64,BBBB'};
  const finish={...result('finish'),url:'data:image/png;base64,CCCC'};
  if(upscale)vi.mocked(runComfyWorkflow).mockResolvedValueOnce(middle);
  if(sharpen)vi.mocked(runComfyWorkflow).mockResolvedValueOnce(finish);
  const final=await postProcessImage({postProcessing:p} as any,{},base);
  const message={name:'test',mes:'neutral scene',is_user:false,is_system:false};
  const saveChat=vi.fn(async()=>{}),tag='<bbi_image>still life</bbi_image>';
  const ctx={chat:[message],saveChat,getCurrentChatId:()=>'test',getRequestHeaders:()=>({})};
  vi.stubGlobal('window',{SillyTavern:{getContext:()=>ctx}});
  const fetchMock=vi.fn(async()=>new Response(JSON.stringify({path:'/user/images/final.png'})));
  vi.stubGlobal('fetch',fetchMock);
  const entry=await saveImageResult(0,0,0,tag,123,final);
  expect(historyEntries(readStore(message),0,promptHash(tag),0)).toEqual([entry]);
  expect(saveChat).toHaveBeenCalledOnce();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body)).image).toBe(sharpen?'CCCC':'BBBB');
  expect(runComfyWorkflow).toHaveBeenCalledTimes(Number(upscale)+Number(sharpen));
  final.revoke();expect(base.revoke).toHaveBeenCalledOnce();
 });
});
