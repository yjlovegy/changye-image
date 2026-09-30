import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {exportPortableWorkflow,importPortableWorkflowExample} from './workflowTransfer';
import {exportWorkflowFile,readWorkflowFileExample} from '@/backends/comfyWorkflowFile';
import {newComfyWorkflow} from '@/state/settings';
import {uploadUserImage} from './images';
vi.mock('./images',()=>({uploadUserImage:vi.fn(),deleteUserImage:vi.fn()}));
vi.mock('./imageFile',()=>({readFileAsDataUrl:vi.fn(async()=>'data:image/png;base64,iVBORw0KGgo=')}));
const path='/user/images/长夜的绘图器_工作流示例/wfimg_test.png';
const preset=()=>({...newComfyWorkflow('测试'),workflow:'{"n":{"class_type":"SaveImage","inputs":{}}}'});
beforeEach(()=>{vi.clearAllMocks();vi.stubGlobal('Image',class{src='';decode=async()=>{}});vi.mocked(uploadUserImage).mockResolvedValue(path);});
afterEach(()=>vi.unstubAllGlobals());
describe('portable workflow example',()=>{
 it('embeds a local example and restores it through managed storage',async()=>{
  const p={...preset(),exampleImage:path};
  const fetcher=vi.fn(async(_path:string,_options?:RequestInit)=>new Response(new Uint8Array([137,80,78,71,13,10,26,10]),{headers:{'Content-Type':'image/png'}}));vi.stubGlobal('fetch',fetcher);
  const text=await exportPortableWorkflow(p);expect(text).not.toContain(path);expect(readWorkflowFileExample(text)).toMatch(/^data:image\/png;base64,/);
  expect(await importPortableWorkflowExample(text)).toEqual({exampleImage:path});expect(uploadUserImage).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls[0][0]).toBe(path);
 });
 it('fails export when an existing example cannot be read rather than silently losing it',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(null,{status:404})));
  await expect(exportPortableWorkflow({...preset(),exampleImage:path})).rejects.toThrow('示例图读取失败');
 });
 it('clears the example only for a full export that explicitly has no example',async()=>{
  expect(await importPortableWorkflowExample(exportWorkflowFile(preset()))).toEqual({});
  expect(await importPortableWorkflowExample(exportWorkflowFile(preset(),null))).toEqual({exampleImage:undefined});
  expect(uploadUserImage).not.toHaveBeenCalled();
 });
 it('rejects spoofed embedded image bytes before upload',async()=>{
  await expect(importPortableWorkflowExample(exportWorkflowFile(preset(),'data:image/png;base64,aGVsbG8='))).rejects.toThrow('图片内容与文件格式不符');
  expect(uploadUserImage).not.toHaveBeenCalled();
 });
});
