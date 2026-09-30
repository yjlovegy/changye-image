import {describe,it,expect} from 'vitest';
import {exportWorkflowFile,readWorkflowFileOptions} from './comfyWorkflowFile';
import {renderWorkflowTemplate} from './comfyui';
import {defaultComfyPost} from './comfyPostSettings';
describe('portable workflow options',()=>{
 it('round trips options in API-compatible metadata without leaking ids, endpoints or image paths',()=>{
  const preset={name:'Krea2',workflow:JSON.stringify({node:{class_type:'CLIPTextEncode',inputs:{text:'%prompt%'}}}),promptMode:'krea2',postProcessing:defaultComfyPost(),id:'private-id',exampleImage:'private.png',url:'secret',fixedPrompts:{positivePrefix:'literal %unknown%',positiveSuffix:'',negative:''},defaultSize:'512×768'} as any;
  const text=exportWorkflowFile(preset),p=readWorkflowFileOptions(text);expect(p.name).toBe('Krea2');expect(p.postProcessing).toEqual(preset.postProcessing);expect(text).not.toContain('private');expect(text).not.toContain('secret');expect(renderWorkflowTemplate(text,{prompt:'test'}).node._meta).not.toHaveProperty('changye');
 });
 it('imports old API files without resetting unrelated settings',()=>expect(readWorkflowFileOptions('{"node":{"class_type":"SaveImage","inputs":{}}}')).toEqual({}));
});
