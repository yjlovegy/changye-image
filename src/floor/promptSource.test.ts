import { expect, it } from 'vitest';
import type { STMessage } from '@/st/context';
import { PROMPT_SOURCES_KEY, rememberPromptSources, sourceForPrompt, sourceForPlannedImage } from './promptSource';
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
it('extracts explicit sources and refuses to guess sources from an insertion position', () => {
  const segments = [
    { id: 'P1', sourceLine: 0, text: '她走进图书馆。' },
    { id: 'P2', sourceLine: 2, text: '她翻开桌上的书。' },
    { id: 'P3', sourceLine: 4, text: '稍后她离开大楼。' },
  ];
  expect(sourceForPlannedImage({ position: 'P2', sourceParagraphs: ['P1','P2'] }, segments)).toEqual({ text: '她走进图书馆。\n\n她翻开桌上的书。', kind: 'excerpt' });
  expect(sourceForPlannedImage({ position: 'P3', sourceParagraphs: ['P1','P2'] }, segments).text).not.toContain('离开');
  expect(() => sourceForPlannedImage({ position: 'P2' }, segments)).toThrow('缺少 sourceParagraphs');
  expect(() => sourceForPlannedImage({ position: 'P99', sourceParagraphs: ['P99'] }, segments)).toThrow('已失效');
  expect(sourceForPlannedImage({ position: 'P2' }, [segments[1]]).text).toBe(segments[1].text);
});
it.each(['“啊……”', '「找到了！」', '啪……咚！', '…', '"Oh!"'])('rejects source consisting only of standalone speech or sounds: %s', text => {
  expect(() => sourceForPlannedImage({position:'P1',sourceParagraphs:['P1']}, [{id:'P1',sourceLine:0,text}])).toThrow('只有独立对白');
});
it.each(['她抬手。', '她抱着书说：“找到了！”', 'The reader says, "Found it!"'])('keeps concise narrative and mixed speech: %s', text => {
  expect(sourceForPlannedImage({position:'P1'}, [{id:'P1',sourceLine:0,text}]).text).toBe(text);
});
it('keeps captured excerpts stable after later prose edits and preserves legacy floor snapshots', () => {
  const message = { mes: '改写后的正文', extra: {} } as STMessage;
  message.extra![PROMPT_SOURCES_KEY] = rememberPromptSources(message, 0, [
    { rawTag: 'new', text: '原来的目标段落。', kind: 'excerpt' },
    { rawTag: 'old', text: '旧版保存的整楼正文。', kind: 'floor' },
  ]);
  expect(sourceForPrompt(message, 'new', 0)).toEqual({ text: '原来的目标段落。', kind: 'excerpt', legacy: false });
  expect(sourceForPrompt(message, 'old', 0)).toEqual({ text: '旧版保存的整楼正文。', kind: 'floor', legacy: false });
});
