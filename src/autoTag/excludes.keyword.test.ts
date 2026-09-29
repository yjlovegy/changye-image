import { expect, it } from 'vitest';
import { isWorldInfoEntryExcluded } from './excludes';
const config={excludedChars:[],excludedWorldNames:[],excludedWorldInfoPatterns:[],customStripTags:[]};
it('treats keyword punctuation literally and keeps MVU regex matching names only',()=>{
 expect(isWorldInfoEntryExcluded({comment:'(状态)面板'} as any,config,['(状态)'])).toBe(true);
 expect(isWorldInfoEntryExcluded({comment:'状态'} as any,config,['(状态)'])).toBe(false);
 const mvu={...config,excludedWorldInfoPatterns:[String.raw`\[mvu[\s\S]*?\]`]};
 expect(isWorldInfoEntryExcluded({comment:'[MVU变量]规则'} as any,mvu)).toBe(true);
 expect(isWorldInfoEntryExcluded({comment:'人物外貌',content:'[MVU]'} as any,mvu)).toBe(false);
});
