import { exportWorkflowFile, readWorkflowFileExample } from '@/backends/comfyWorkflowFile';
import type { ComfyWorkflowPreset } from '@/state/settings';
import { readFileAsDataUrl } from './imageFile';
import { normalizeWorkflowExample, setWorkflowExample } from './workflowExamples';

/** Bundle the example image itself, never a machine-specific path or server credentials. */
export async function exportPortableWorkflow(preset:ComfyWorkflowPreset):Promise<string> {
  // Validate the settings before fetching an optional image.
  exportWorkflowFile(preset);
  const path=normalizeWorkflowExample(preset.exampleImage);
  let data:string|null=null;
  if(path){
    const response=await fetch(path,{signal:AbortSignal.timeout(30_000)});
    if(!response.ok)throw new Error('示例图读取失败，请重新上传或移除后再导出');
    const blob=await response.blob();
    if(blob.size>20*1024*1024 || !['image/png','image/jpeg','image/webp'].includes(blob.type))throw new Error('示例图格式或大小无效');
    data=await readFileAsDataUrl(new File([blob],'example',{type:blob.type}));
  }
  return exportWorkflowFile(preset,data);
}

/** Import to the existing managed image folder, without trusting any path in a JSON file. */
export async function importPortableWorkflowExample(workflow:string):Promise<Partial<ComfyWorkflowPreset>> {
  const data=readWorkflowFileExample(workflow);
  if(data===undefined)return {};
  if(data===null)return {exampleImage:undefined};
  const mime=data.slice(5,data.indexOf(';')),bytes=Uint8Array.from(atob(data.split(',')[1]),c=>c.charCodeAt(0));
  const owner:{id:string;exampleImage?:string}={id:'workflow-import'};
  await setWorkflowExample(owner,new File([bytes],'example',{type:mime}),()=>[owner]);
  return {exampleImage:owner.exampleImage};
}
