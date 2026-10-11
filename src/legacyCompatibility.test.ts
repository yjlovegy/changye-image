import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { galleryFolderName, readCompatibleField, readSharedCompatibleField } from './legacyCompatibility';

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

it('prefers explicit new values and never resurrects deliberately cleared data', () => {
  expect(readCompatibleField({ bbiImage: { old: true } }, 'changyeImage')).toEqual({ old: true });
  expect(readCompatibleField({ bbiImage: { old: true }, changyeImage: {} }, 'changyeImage')).toEqual({});
  expect(readCompatibleField({ bbiCharChanges: {}, changyeCharChanges: null }, 'changyeCharChanges')).toBeNull();
  expect(readSharedCompatibleField({ changye_api_channels: { revision: 2 }, baibai_api_channels: { revision: 3 } }, 'changye_api_channels')).toEqual({ revision: 3 });
});

it('recognizes both gallery generations without renaming existing paths or including artist previews', () => {
  expect(galleryFolderName('柏宝绘_示例')).toBe('示例');
  expect(galleryFolderName('长夜绘图器_示例')).toBe('示例');
  expect(galleryFolderName('柏宝绘_画师串')).toBeNull();
  expect(galleryFolderName('长夜绘图器_画师串')).toBeNull();
  expect(galleryFolderName('other')).toBeNull();
});

it('loads old workflow/channel data, writes new settings, and still receives legacy channel events', async () => {
  const oldSettings = { comfyui: { activeWorkflowId: 'kept', workflows: [{ id: 'kept', name: '保留', workflow: '{"1":{"class_type":"SaveImage","inputs":{"filename_prefix":"BaiBai"}}}' }] } };
  const context = { extensionSettings: { baibai_image: oldSettings, baibai_api_channels: { schemaVersion: 1, revision: 3, channels: [{ id: 'channel', name: '保留渠道', url: 'http://example.test', model: 'fixture' }] } } as Record<string, any>, saveSettingsDebounced: vi.fn() };
  const target = Object.assign(new EventTarget(), { SillyTavern: { getContext: () => context } });
  vi.stubGlobal('window', target);
  const { hydrateSettings, settings } = await import('./state/settings');
  const { nextTick } = await import('vue');
  await hydrateSettings();
  expect(settings.comfyui.activeWorkflowId).toBe('kept');
  expect(settings.comfyui.workflows[0].workflow).toBe(oldSettings.comfyui.workflows[0].workflow);
  expect(settings.channels[0].id).toBe('channel');
  settings.channels[0].name = '新名称';
  await nextTick();
  expect(context.extensionSettings.changye_image.channels[0].name).toBe('新名称');
  expect(context.extensionSettings.baibai_api_channels.channels[0].name).toBe('新名称');
  const revision = context.extensionSettings.changye_api_channels.revision;
  context.extensionSettings.baibai_api_channels = { schemaVersion: 1, revision: revision + 1, channels: [] };
  target.dispatchEvent(new CustomEvent('st-baibai-api-channels:changed'));
  expect(settings.channels).toEqual([]);
  expect(context.extensionSettings.baibai_image).toEqual(oldSettings);
});

it('loads historical character metadata and floor deltas without reintroducing removed characters', async () => {
  const context = { chatMetadata: {} as Record<string, any>, extensionSettings: {}, chat: [] as any[], saveMetadataDebounced: vi.fn(), saveChat: vi.fn().mockResolvedValue(undefined) };
  vi.stubGlobal('window', Object.assign(new EventTarget(), { SillyTavern: { getContext: () => context } }));
  const chars = await import('./state/charTags');
  context.chatMetadata.baibai_image_char_tags = { version: 3, entries: [{ name: '示例', fields: { ...chars.emptyCharFields(), hair: 'black hair' }, raw: '', nl: '', source: 'manual', desc: '', history: [] }] };
  context.chat = [{ mes: '正文', is_user: false, extra: { bbiCharChanges: { v: 1, swipe: 0, ops: [chars.createCharTagSetOp('示例', 'hair', 'loose hair', '剧情变化', 1)] } } }];
  chars.hydrateCharTags();
  expect(chars.findCharTag('示例')?.fields.hair).toBe('loose hair');
  chars.removeCharTag('示例');
  chars.hydrateCharTags();
  expect(chars.findCharTag('示例')).toBeUndefined();
  expect(chars.readCharTagFloorDelta(context.chat[0])).toBeNull();
});

it('preserves old tags, picture history hashes and source records while producing new tags', async () => {
  const tags = await import('./st/imageTagRegex');
  const storage = await import('./floor/storage');
  const sources = await import('./floor/promptSource');
  const old = '<bbi_image>adult artist<nl>An adult artist paints.</nl><size>portrait</size></bbi_image>';
  const fresh = tags.serializeImageTag(tags.parseImageTagContent(old));
  expect(fresh).toContain('<changye_image>');
  expect(tags.parseImageTags(`${old}\n正文\n${fresh}`)).toEqual([old, fresh]);
  expect(tags.stripImageTags(`前文\n${old}\n后文\n${fresh}`)).toBe('前文\n后文');
  expect(tags.containsTagMarkup('</bbi_image>')).toBe(true);
  const oldStore = { '0': { [storage.promptHash(old)]: [{ path: '/user/images/柏宝绘_示例/bbi_a_0_h-g1.png', prompt: old }] } };
  const message = { mes: old, is_user: false, extra: { bbiImage: oldStore, bbi_prompt_sources: [{ rawTag: old, swipe: 0, text: '确切选段', kind: 'selection' }] } } as any;
  expect(storage.readStore(message)).toBe(oldStore);
  expect(sources.sourceForPrompt(message, old, 0)).toEqual({ text: '确切选段', kind: 'selection', legacy: false });
  expect(storage.sidecarPathFor(oldStore['0'][storage.promptHash(old)][0].path)).toBe('/user/files/bbi_a_0_h-g1.json');
  expect(storage.imageFileName('示例', 0, 'h', 'g1', 'png')).toMatch(/^changye_/);
});

it('replaces historical managed regexes exactly once and hides both formats from prompts', async () => {
  const custom = { id: 'user-regex', findRegex: 'keep' };
  const context = { extensionSettings: { regex: [{ id: 'bbi-image-tag-slot' }, { id: 'bbi-image-tag-hide' }, custom] }, saveSettingsDebounced: vi.fn() };
  vi.stubGlobal('window', { SillyTavern: { getContext: () => context } });
  const { ensureImageTagRegexRegistered, imageTagHideScript } = await import('./st/imageTagRegex');
  ensureImageTagRegexRegistered(); ensureImageTagRegexRegistered();
  expect(context.extensionSettings.regex.map(v => v.id)).toEqual(['user-regex', 'changye-image-tag-slot', 'changye-image-tag-hide']);
  expect(context.extensionSettings.regex[0]).toBe(custom);
  const script = imageTagHideScript();
  const regex = new RegExp(script.findRegex.slice(1, script.findRegex.lastIndexOf('/')), 'gi');
  expect('前<bbi_image>old</bbi_image>中<changye_image>new</changye_image>后'.replace(regex, script.replaceString)).toBe('前中后');
});
