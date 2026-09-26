import { beforeEach, expect, it, vi } from 'vitest';
import { rewriteImagePrompt } from './promptRewrite';
import { requestCompletion, requestViaMainApi } from '@/api/client';
import { buildAutoTagMessages } from './prompt';
import type { STContext } from '@/st/context';
import type { ImageTagContent } from '@/st/imageTagRegex';
const state=vi.hoisted(()=>({preset:{promptMode:'krea2',mode:'custom',workflow:'{}'},channel:null as any}));
vi.mock('@/state/settings',()=>({settings:{defaultBackend:'comfyui',autoTag:{},excludes:{customStripTags:[]}},activeComfyPreset:()=>state.preset,getTagGenChannel:()=>state.channel}));
vi.mock('@/api/client',()=>({requestCompletion:vi.fn(),requestViaMainApi:vi.fn()}));
vi.mock('./prompt',()=>({buildAutoTagMessages:vi.fn(async (_c,_f,_o,_m,p)=>[{role:'system',content:'rules'},{role:'user',content:p.promptText}])}));
vi.mock('./bookMemory',()=>({readBookMemory:()=>null}));
vi.mock('./selection',()=>({prepareSelectionCharState:()=>({entries:[]})}));
vi.mock('@/state/charTags',()=>({CHAR_TAG_FIELDS:[],charTagsBeforeFloor:()=>[],lockedCharTagNames:()=>new Set(),readCharTagFloorDelta:()=>null}));
const original:ImageTagContent={tag:'old tags',nl:'Old description.',negative:'old negative',characters:[],size:'portrait',resolution:{width:768,height:1152},promptMode:'anima'};
const image={position:'P1',tag:'adult artist, blue shirt, studio',nl:'An adult artist wearing a blue shirt opens a sketchbook beside the studio window.',negative:'extra hands'};
const context={chat:[{mes:'她先开门，然后翻书。',swipe_id:0}],name1:'user',saveChat:vi.fn()} as unknown as STContext;
beforeEach(()=>{
  vi.clearAllMocks(); state.channel=null; state.preset.promptMode='krea2';
  vi.mocked(requestViaMainApi).mockImplementation(async (_m,o)=>{const raw=JSON.stringify({images:[image],changes:[]});o?.validate?.(raw);return raw;});
});
it('uses the original selection and current workflow mode, returning only a detached draft',async()=>{
  const before=JSON.stringify({original,chat:context.chat});
  const next=await rewriteImagePrompt(context,0,{text:'她翻书。',kind:'selection'},original,new AbortController().signal);
  expect(next).toMatchObject({promptMode:'krea2',tag:'',nl:image.nl,resolution:original.resolution});
  const args=vi.mocked(buildAutoTagMessages).mock.calls[0];
  expect(args[4]?.promptText).toContain('她翻书。');
  expect(args[4]?.promptText).not.toContain('她先开门');
  expect(args[7]).toBe('krea2');
  expect(JSON.stringify({original,chat:context.chat})).toBe(before);
  expect(context.saveChat).not.toHaveBeenCalled();
});
it('uses the selected auxiliary channel and validates Anima output',async()=>{
  state.channel={id:'test'};state.preset.promptMode='anima';
  vi.mocked(requestCompletion).mockImplementation(async(_c,_m,o)=>{const raw=JSON.stringify({images:[image]});o?.validate?.(raw);return raw;});
  const next=await rewriteImagePrompt(context,0,{text:'她翻书。',kind:'floor'},original,new AbortController().signal);
  expect(next.tag).toBe(image.tag); expect(requestCompletion).toHaveBeenCalledTimes(1);
  expect(requestViaMainApi).not.toHaveBeenCalled();
});
it('rejects multiple images instead of silently choosing another scene',async()=>{
  vi.mocked(requestViaMainApi).mockImplementation(async(_m,o)=>{const raw=JSON.stringify({images:[image,image]});o?.validate?.(raw);return raw;});
  await expect(rewriteImagePrompt(context,0,{text:'她翻书。',kind:'selection'},original,new AbortController().signal)).rejects.toThrow('一张');
  expect(context.saveChat).not.toHaveBeenCalled();
});
it('does not request a cancelled rewrite',async()=>{
  const c=new AbortController();c.abort();
  await expect(rewriteImagePrompt(context,0,{text:'她翻书。',kind:'selection'},original,c.signal)).rejects.toMatchObject({name:'AbortError'});
  expect(requestViaMainApi).not.toHaveBeenCalled();
});
