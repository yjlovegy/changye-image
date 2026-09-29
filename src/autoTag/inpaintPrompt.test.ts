import { beforeEach, expect, it, vi } from 'vitest';
import { composeInpaintDescription } from './inpaintPrompt';
import { requestCompletion } from '@/api/client';
const state=vi.hoisted(()=>({channel:{url:'http://example.test',model:'test',excludeParams:[]} as any}));
vi.mock('@/state/settings',()=>({getTagGenChannel:()=>state.channel}));
vi.mock('@/api/client',()=>({requestCompletion:vi.fn()}));
const input={instruction:'将内搭改成蓝色',original:'white inner shirt, red jacket',promptMode:'anima' as const};
beforeEach(()=>{vi.clearAllMocks();state.channel={url:'http://example.test',model:'test',excludeParams:[]};});
function reply(value:unknown){vi.mocked(requestCompletion).mockImplementation(async(_c,_m,o)=>{const raw=JSON.stringify(value);o?.validate?.(raw);return raw;});}
it('returns only a detached local draft, using the selected workflow mode and snapshot channel',async()=>{
 reply({tag:'blue inner shirt',nl:'A blue inner shirt beneath the red jacket.'});
 expect(await composeInpaintDescription(input,new AbortController().signal)).toBe('blue inner shirt\n\nA blue inner shirt beneath the red jacket.');
 const [channel,messages,options]=vi.mocked(requestCompletion).mock.calls[0];
 expect(channel).not.toBe(state.channel);expect(channel.excludeParams).not.toBe(state.channel.excludeParams);
 expect(JSON.parse(messages[1].content)).toEqual({originalPrompt:input.original,modification:input.instruction});
 expect(options?.source).toBe('整理局部重绘画面描述');
});
it('accepts natural language without TAG for Krea2',async()=>{
 reply({tag:'',nl:'A blue shirt with soft fabric folds.'});
 expect(await composeInpaintDescription({...input,promptMode:'krea2'},new AbortController().signal)).toBe('A blue shirt with soft fabric folds.');
});
it.each([{tag:'blue shirt'}, {tag:'',nl:'A blue shirt.'}, {tag:'shirt',nl:'<script>bad</script>'}])('rejects invalid Anima drafts %j',async value=>{
 reply(value);await expect(composeInpaintDescription(input,new AbortController().signal)).rejects.toThrow();
});
it('does not issue requests without configuration or after cancellation',async()=>{
 state.channel=null;await expect(composeInpaintDescription(input,new AbortController().signal)).rejects.toThrow('副 API');
 const c=new AbortController();c.abort();await expect(composeInpaintDescription(input,c.signal)).rejects.toMatchObject({name:'AbortError'});
 expect(requestCompletion).not.toHaveBeenCalled();
});
it('discards a late response after cancellation',async()=>{
 const c=new AbortController();vi.mocked(requestCompletion).mockImplementation(async(_c,_m,o)=>{c.abort();o?.validate?.('{"tag":"shirt","nl":"A shirt."}');return '';});
 await expect(composeInpaintDescription(input,c.signal)).rejects.toMatchObject({name:'AbortError'});
});
