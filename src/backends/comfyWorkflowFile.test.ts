import {describe,it,expect} from 'vitest';
import {exportWorkflowFile,readWorkflowFileOptions,readWorkflowFileExample,stripWorkflowFileOptions,workflowExportName} from './comfyWorkflowFile';
import {renderWorkflowTemplate} from './comfyui';
import {defaultComfyPost} from './comfyPostSettings';
import {newComfyWorkflow} from '@/state/settings';
describe('portable workflow options',()=>{
 it('round trips options in API-compatible metadata without leaking ids, endpoints or image paths',()=>{
  const preset={name:'Krea2',workflow:JSON.stringify({node:{class_type:'CLIPTextEncode',inputs:{text:'%prompt%'}}}),promptMode:'krea2',postProcessing:defaultComfyPost(),id:'private-id',exampleImage:'private.png',url:'secret',fixedPrompts:{positivePrefix:'literal %unknown%',positiveSuffix:'',negative:''},defaultSize:'512×768'} as any;
  const text=exportWorkflowFile(preset),p=readWorkflowFileOptions(text);expect(p.name).toBe('Krea2');expect(p.postProcessing).toEqual(preset.postProcessing);expect(text).not.toContain('private');expect(text).not.toContain('secret');expect(renderWorkflowTemplate(text,{prompt:'test'}).node._meta).not.toHaveProperty('changye');
 });
 it('imports old API files without resetting unrelated settings',()=>expect(readWorkflowFileOptions('{"node":{"class_type":"SaveImage","inputs":{}}}')).toEqual({}));
 it('round trips every per-workflow setting including LoRA restore data and the portable example',()=>{
  const p=newComfyWorkflow('漫画风格');
  p.workflow=JSON.stringify({n:{class_type:'KSampler',inputs:{steps:31,cfg:4.5}}},null,2);
  p.negativeEnabled=false;p.generateNegative=false;p.promptMode='krea2';p.naturalLanguage=true;
  p.fixedPrompts={positivePrefix:'prefix',positiveSuffix:'suffix',negative:'negative'};
  p.simple.steps=33;p.loraWorkflowBackup=p.workflow;p.legacyCustomWorkflow=p.workflow;
  p.postProcessing=defaultComfyPost();p.postProcessing.sharpen.enabled=true;
  p.autoRepair={enabled:true,hands:true,feet:false};
  const data='data:image/png;base64,aGVsbG8=';
  const text=exportWorkflowFile(p,data),restored={...newComfyWorkflow(),...readWorkflowFileOptions(text),workflow:stripWorkflowFileOptions(text)};
  for(const key of ['name','promptMode','negativeEnabled','generateNegative','naturalLanguage','simple','fixedPrompts','loraWorkflowBackup','legacyCustomWorkflow','postProcessing','autoRepair','defaultSize','portraitSize','landscapeSize'] as const)expect(restored[key]).toEqual(p[key]);
  expect(readWorkflowFileExample(text)).toBe(data);
  expect(JSON.parse(restored.workflow).n.inputs).toEqual(JSON.parse(p.workflow).n.inputs);
  expect(restored.id).not.toBe(p.id);
 });
 it('replaces old export metadata without recursive growth',()=>{
  const p=newComfyWorkflow();p.workflow='{"n":{"class_type":"SaveImage","inputs":{}}}';
  const first=exportWorkflowFile(p,null);p.workflow=first;
  expect(exportWorkflowFile(p,null)).toBe(first);
  expect(readWorkflowFileExample(first)).toBeNull();
  expect(stripWorkflowFileOptions(first)).not.toContain('changye');
 });
 it('keeps old v1 files compatible and rejects unsupported versions or external image sources',()=>{
  const file=(meta:any)=>JSON.stringify({n:{class_type:'SaveImage',inputs:{},_meta:{changye:meta}}});
  expect(readWorkflowFileOptions(file({version:1,name:'旧版'})).name).toBe('旧版');
  expect(()=>readWorkflowFileOptions(file({version:99}))).toThrow('暂不支持');
  expect(()=>readWorkflowFileExample(file({version:2,exampleImageData:'https://external/image.png'}))).toThrow('无效');
 });
 it('uses the required filename prefix and sanitizes invalid filename characters',()=>{
  expect(workflowExportName('Krea2 漫画')).toBe('长夜绘图器-Krea2 漫画.json');
  expect(workflowExportName('a/b:*?. ')).toBe('长夜绘图器-a_b___.json');
  expect(workflowExportName('')).toBe('长夜绘图器-未命名工作流.json');
 });
});
