import { beforeEach, expect, it, vi } from 'vitest';
const env=vi.hoisted(()=>({context:null as any}));
vi.mock('@/st/context',()=>({getContext:()=>env.context}));
beforeEach(()=>{vi.resetModules();vi.stubGlobal('window',{addEventListener:vi.fn(),dispatchEvent:vi.fn()});vi.stubGlobal('toastr',{info:vi.fn(),error:vi.fn(),success:vi.fn()});});
it('keeps positive scopes separate from legacy shared deletion and role exclusion lists',async()=>{
 const shared={schemaVersion:1,revision:3,excludedChars:['旧角色'],excludedWorldNames:['机制'],excludedWorldInfoPatterns:['^规则'],customStripTags:['game']};
 env.context={extensionSettings:{baibai_image:{storyTags:['GAME','game','正文'],worldInfoKeywords:['(状态)']},baibai_exclude_settings:structuredClone(shared)},saveSettingsDebounced:vi.fn()};
 const {hydrateSettings,settings}=await import('./settings'); await hydrateSettings();
 expect(settings.storyTags).toEqual(['game','正文']);
 expect(settings.worldInfoKeywords).toEqual(['(状态)']);
 expect(settings.excludes.customStripTags).toEqual(['game']);
 expect(env.context.extensionSettings.baibai_exclude_settings).toEqual(shared);
});
it('does not turn an old deletion list into a new inclusion list',async()=>{
 env.context={extensionSettings:{baibai_image:{excludes:{customStripTags:['snow']}}},saveSettingsDebounced:vi.fn()};
 const {hydrateSettings,settings}=await import('./settings');await hydrateSettings();
 expect(settings.storyTags).toEqual([]);expect(settings.excludes.customStripTags).toEqual(['snow']);
});
