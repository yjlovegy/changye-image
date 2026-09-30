import {afterEach,describe,it,expect,vi} from 'vitest';
import {runComfyWorkflow,runComfyWorkflowBatch} from './comfyui';
const conn={url:'http://comfy'} as any,graph={output:{class_type:'PreviewImage',inputs:{}}};
const json=(value:unknown)=>new Response(JSON.stringify(value));
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
function setup(names:string[],failed=''){
 const created=vi.spyOn(URL,'createObjectURL').mockImplementation(()=>`blob:${Math.random()}`);
 const revoked=vi.spyOn(URL,'revokeObjectURL').mockImplementation(()=>{});
 const fetcher=vi.fn(async(input:RequestInfo|URL)=>{
  const url=String(input);
  if(url.endsWith('/prompt'))return json({prompt_id:'p'});
  if(url.includes('/history/'))return json({p:{outputs:{output:{images:names.map(filename=>({filename,type:'temp'}))},unrelated:{images:[{filename:'ignore.png'}]}},status:{completed:true}}});
  return url.includes(failed)&&failed?new Response('failed',{status:500}):new Response(new Blob(['png'],{type:'image/png'}));
 });vi.stubGlobal('fetch',fetcher);return {created,revoked,fetcher};
}
describe('instance mask batch transport',()=>{
 it('downloads every instance of the requested output node',async()=>{
  const {revoked,fetcher}=setup(['a.png','b.png']);
  const batch=await runComfyWorkflowBatch(conn,graph,'output');expect(batch.map(r=>r.filename)).toEqual(['a.png','b.png']);
  expect(fetcher.mock.calls.some(([u])=>String(u).includes('ignore.png'))).toBe(false);
  batch.forEach(r=>r.revoke());expect(revoked).toHaveBeenCalledTimes(2);
 });
 it('keeps ordinary generation single-result',async()=>{
  setup(['a.png','b.png']);expect((await runComfyWorkflow(conn,graph)).filename).toBe('a.png');
 });
 it('accepts an empty completed detector result',async()=>{
  const {created}=setup([]);expect(await runComfyWorkflowBatch(conn,graph,'output')).toEqual([]);expect(created).not.toHaveBeenCalled();
 });
 it('releases prior instance URLs when a later image download fails',async()=>{
  const {revoked}=setup(['a.png','b.png'],'b.png');await expect(runComfyWorkflowBatch(conn,graph,'output')).rejects.toThrow();expect(revoked).toHaveBeenCalledOnce();
 });
 it('bounds unexpectedly large detection batches',async()=>{
  const {created}=setup(Array.from({length:33},(_,i)=>`${i}.png`));await expect(runComfyWorkflowBatch(conn,graph,'output')).rejects.toThrow('过多');expect(created).not.toHaveBeenCalled();
 });
});
