import { describe, it, expect } from 'vitest';
import { prepareWorkflowForm, type WorkflowFormEditors } from './workflowForm';
import { createWorkflowDrafts } from './workflowDrafts';
import type { ComfyWorkflowPreset } from './settings';

const saved = () => ({id:'a',name:'Saved',workflow:'original',promptMode:'krea2',defaultSize:'1080×1920',autoRepair:{enabled:false,hands:true,feet:true}} as ComfyWorkflowPreset);
const editors = ():WorkflowFormEditors => ({
 model:{dirty:true,prepare:workflow=>({workflow:workflow+'-model',promptMode:'krea2'})},
 lora:{dirty:true,prepare:workflow=>workflow+'-lora'},
 size:{prepare:()=> '1024×1024'},
 repair:{prepareDraft:()=>({enabled:true,hands:true,feet:false})},
});
describe('unified workflow form',()=>{
 it('collects all controls for a runtime draft without committing saved data',()=>{
  const original=saved(),store=createWorkflowDrafts<ComfyWorkflowPreset>(),draft=store.edit(original);
  Object.assign(draft,prepareWorkflowForm(draft,editors(),false));
  expect(store.current(original).workflow).toBe('original-model-lora');
  expect(store.current(original).defaultSize).toBe('1024×1024');
  expect(original.workflow).toBe('original');expect(original.defaultSize).toBe('1080×1920');
  const committed=store.commit(original);expect(committed.autoRepair?.feet).toBe(false);
 });
 it('rejects an invalid later field without a partial workflow write',()=>{
  const target=saved(),e=editors();e.size={prepare:()=>{throw Error('invalid size');}};
  expect(()=>Object.assign(target,prepareWorkflowForm(target,e,true))).toThrow('invalid size');
  expect(target).toEqual(saved());
 });
 it('does not automatically apply a JSON draft',()=>{
  const e=editors();e.json={dirty:true,prepare:()=> 'new JSON'};
  expect(()=>prepareWorkflowForm(saved(),e,false)).toThrow('JSON 尚未应用');
 });
 it('rejects conflicting JSON and parameter edits',()=>{
  const e=editors();e.json={dirty:true,prepare:()=> 'new JSON'};
  expect(()=>prepareWorkflowForm(saved(),e,true)).toThrow('同时有未应用修改');
 });
 it('allows explicit saving of valid JSON when other editors are clean',()=>{
  const json='{"n":{"class_type":"SaveImage","inputs":{}}}';
  expect(prepareWorkflowForm(saved(),{json:{dirty:true,prepare:()=> json}},true).workflow).toBe(json);
 });
 it('discards temporary control edits back to the committed preset',()=>{
  const original=saved(),store=createWorkflowDrafts<ComfyWorkflowPreset>();
  Object.assign(store.edit(original),prepareWorkflowForm(original,editors(),false));
  store.discard(original.id);expect(store.current(original)).toEqual(original);expect(store.dirty(original.id)).toBe(false);
 });
});
