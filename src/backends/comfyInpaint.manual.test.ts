import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {inpaintImage} from './comfyInpaint';
import {buildInpaintGraph} from './comfyInpaintGraph';
import {decodePixels,protectedInpaintResult} from './inpaintComposite';
import {defaultInpaintTuning} from './inpaintTuning';
vi.mock('./comfyui',()=>({parseWorkflowTemplate:JSON.parse,runComfyWorkflow:vi.fn(async()=>({url:'result',revoke:vi.fn()}))}));
vi.mock('./comfyInpaintGraph',()=>({inspectInpaintSource:vi.fn(),buildInpaintGraph:vi.fn(()=>({})),buildDetectionGraph:vi.fn(),normalizeAutoRepair:vi.fn()}));
vi.mock('./inpaintComposite',()=>({decodePixels:vi.fn(),maskBounds:()=>({x:100,y:200,width:100,height:200}),protectedInpaintResult:vi.fn(async()=>({url:'protected',revoke:vi.fn()}))}));
const conn={url:'http://local.test',workflow:'{}',workflowId:'w',fixedPrompts:{positivePrefix:'prefix',positiveSuffix:'suffix',negative:'bad'}} as any;
beforeEach(()=>{
 vi.clearAllMocks();vi.mocked(decodePixels).mockResolvedValue({width:1080,height:1920,data:new Uint8ClampedArray()});
 vi.stubGlobal('fetch',vi.fn(async(url)=>{
  const name=String(url).split('/').at(-1)!;
  if(String(url).includes('/object_info/'))return new Response(JSON.stringify({[name]:{}}));
  if(name==='image')return new Response(JSON.stringify({name:'test.png',type:'input',subfolder:'changye_inpaint'}));
  return new Response(new Blob(['source']));
 }));
});
afterEach(()=>vi.unstubAllGlobals());
it('submits the user-reviewed draft verbatim and protects pixels with the original mask',async()=>{
 const tuning={...defaultInpaintTuning(),reference:'full' as const};
 const result=await inpaintImage(conn,{source:'source',mask:new Blob(['mask']),instruction:'Edited blue shirt.',preparedPrompt:true,seed:1,tuning});
 expect(vi.mocked(buildInpaintGraph).mock.calls[0][1]).toMatchObject({positive:'Edited blue shirt.',referenceRect:{x:0,y:0,width:1080,height:1920},referenceSize:{width:576,height:1024}});
 const [source,mask,,feather]=vi.mocked(protectedInpaintResult).mock.calls[0];
 expect(source).toBe(await vi.mocked(decodePixels).mock.results[1].value);
 expect(mask.width).toBe(1080);expect(feather).toBe(tuning.feather);expect(result.workflowId).toBe('w');
});
it('keeps legacy prompt composition and rejects mismatched masks before uploading',async()=>{
 await inpaintImage(conn,{source:'source',mask:new Blob(['mask']),instruction:'blue',seed:1});
 expect(vi.mocked(buildInpaintGraph).mock.calls[0][1].positive).toBe('prefix, blue, suffix');
 vi.mocked(buildInpaintGraph).mockClear();
 vi.mocked(decodePixels).mockResolvedValueOnce({width:1,height:1,data:new Uint8ClampedArray()});
 await expect(inpaintImage(conn,{source:'source',mask:new Blob(['mask']),instruction:'blue',seed:1})).rejects.toThrow('尺寸');
 expect(buildInpaintGraph).not.toHaveBeenCalled();
});
