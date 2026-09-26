import { expect, it } from 'vitest';
import type { STMessage } from '@/st/context';
import { PROMPT_SOURCES_KEY, rememberPromptSources, sourceForPrompt } from './promptSource';
it('remembers the original selection after prompt edits without mutating other swipes', () => {
  const message = {mes:'正文<bbi_image>old</bbi_image>',extra:{}} as STMessage;
  message.extra![PROMPT_SOURCES_KEY]=rememberPromptSources(message,0,[{rawTag:'old',text:'她打开书。',kind:'selection'}]);
  message.extra![PROMPT_SOURCES_KEY]=rememberPromptSources(message,1,[{rawTag:'old',text:'他在写字。',kind:'floor'}]);
  const before=JSON.stringify(message);
  const next=rememberPromptSources(message,0,[{rawTag:'new',text:'她打开书。',kind:'selection'}],'old');
  expect(JSON.stringify(message)).toBe(before);
  message.extra![PROMPT_SOURCES_KEY]=next;
  expect(sourceForPrompt(message,'new',0)).toEqual({text:'她打开书。',kind:'selection',legacy:false});
  expect(sourceForPrompt(message,'old',1).text).toBe('他在写字。');
  expect(next).toHaveLength(2);
});
it('uses prose without image tags as an explicit fallback for legacy images', () => {
  const message={mes:'原正文\n<bbi_image>old prompt</bbi_image>',extra:{[PROMPT_SOURCES_KEY]:[null,{}]}} as unknown as STMessage;
  expect(sourceForPrompt(message,'old',0)).toMatchObject({text:expect.stringContaining('原正文'),legacy:true,kind:'floor'});
  expect(sourceForPrompt(message,'old',0).text).not.toContain('old prompt');
});
