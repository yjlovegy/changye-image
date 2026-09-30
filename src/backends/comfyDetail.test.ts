import {afterEach,describe,it,expect,vi} from 'vitest';
vi.mock('./comfyui',()=>({parseWorkflowTemplate:JSON.parse,runComfyWorkflow:vi.fn(),runComfyWorkflowBatch:vi.fn()}));
vi.mock('./comfyInpaint',()=>({imageBlob:vi.fn(async(url:string)=>new Blob([url])),uploadInpaintImage:vi.fn(async(_url:string,blob:Blob)=>blob.text()),autoRepairImage:vi.fn()}));
vi.mock('./inpaintComposite',()=>({decodePixels:vi.fn(),protectedInpaintResult:vi.fn(async(_s,_m,r)=>r)}));
vi.mock('./detailRegions',async importOriginal=>({...await importOriginal<object>(),detailMaskBlob:vi.fn(async()=>new Blob(['mask.png']))}));
import {postProcessImage} from './comfyPost';
import {runComfyWorkflow,runComfyWorkflowBatch} from './comfyui';
import {decodePixels,protectedInpaintResult} from './inpaintComposite';
import {defaultComfyPost} from './comfyPostSettings';
const graph={model:{class_type:'UNETLoader',inputs:{}},clip:{class_type:'CLIPLoader',inputs:{}},vae:{class_type:'VAELoader',inputs:{}},p:{class_type:'CLIPTextEncode',inputs:{clip:['clip',0],text:'two people holding books in a library'}},n:{class_type:'CLIPTextEncode',inputs:{clip:['clip',0],text:'scene negatives'}},s:{class_type:'KSampler',inputs:{model:['model',0],positive:['p',0],negative:['n',0],steps:20,cfg:4,sampler_name:'euler',scheduler:'simple'}},decode:{class_type:'VAEDecode',inputs:{samples:['s',0],vae:['vae',0]}}};
const result=(url:string)=>({url,filename:url,format:'png',revoke:vi.fn()});
function pixels(x:number,y:number,w:number,h:number){const data=new Uint8ClampedArray(128*128*4);for(let row=y;row<y+h;row++)for(let col=x;col<x+w;col++)data[(row*128+col)*4]=255;return {width:128,height:128,data};}
function setup(){
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>{const type=url.split('/').pop()!;return new Response(JSON.stringify({[type]:{input:{required:{individual_masks:['BOOLEAN'],ckpt_name:[['sam3.pt']]}}}}));}));
 vi.mocked(decodePixels).mockImplementation(async(blob:Blob)=>{const name=await blob.text();return name==='face'?pixels(30,20,60,85):name==='eye1'?pixels(40,45,12,6):name==='eye2'?pixels(65,45,12,6):pixels(0,0,128,128);});
 const masks=[result('face'),result('eye1'),result('eye2')];
 vi.mocked(runComfyWorkflowBatch).mockResolvedValueOnce([masks[0]]).mockResolvedValueOnce(masks.slice(1));
 const final=result('final');vi.mocked(runComfyWorkflow).mockResolvedValue(final);
 const p=defaultComfyPost();p.detail={enabled:true,face:true,eyes:true,denoise:0.3,resolution:1024};
 return {masks,final,p,base:result('base')};
}
afterEach(()=>{vi.resetAllMocks();vi.unstubAllGlobals();});
describe('detail stage coordination',()=>{
 it.each([true,false])('processes face=%s and eyes once on the same original crop',async face=>{
  const {masks,final,p,base}=setup();p.detail.face=face;
  const r=await postProcessImage({url:'http://host',postProcessing:p,negativeEnabled:false} as any,graph,base);
  expect(r).toBe(final);expect(runComfyWorkflow).toHaveBeenCalledOnce();expect(runComfyWorkflowBatch).toHaveBeenCalledTimes(2);
  for(const call of vi.mocked(runComfyWorkflowBatch).mock.calls)expect(call[1].load.inputs).toEqual({image:'base'});
  const g=vi.mocked(runComfyWorkflow).mock.calls[0][1],nodes=Object.values(g);
  expect(nodes.find(n=>n.class_type==='KSampler')?.inputs).toMatchObject({denoise:0.3});
  const text=nodes.filter(n=>n.class_type==='CLIPTextEncode').map(n=>(n.inputs as any).text);
  expect(text.join(' ')).not.toContain('library');expect(text[1]).toBe('');
  expect(protectedInpaintResult).toHaveBeenCalledOnce();masks.forEach(m=>expect(m.revoke).toHaveBeenCalledOnce());
 });
 it('keeps the base when no trustworthy region is found',async()=>{
  const {p,base}=setup();vi.mocked(runComfyWorkflowBatch).mockReset().mockResolvedValueOnce([]);
  expect(await postProcessImage({url:'http://host',postProcessing:p} as any,graph,base)).toBe(base);
  expect(runComfyWorkflow).not.toHaveBeenCalled();expect(base.revoke).not.toHaveBeenCalled();
 });
 it('propagates cancellation and releases masks and the current result',async()=>{
  const {masks,p,base,final}=setup(),controller=new AbortController();
  vi.mocked(runComfyWorkflow).mockImplementationOnce(async()=>{controller.abort();return final;});
  await expect(postProcessImage({url:'http://host',postProcessing:p} as any,graph,base,controller.signal)).rejects.toMatchObject({name:'AbortError'});
  masks.forEach(m=>expect(m.revoke).toHaveBeenCalledOnce());expect(base.revoke).toHaveBeenCalledOnce();expect(final.revoke).toHaveBeenCalledOnce();
 });
});
