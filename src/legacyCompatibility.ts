/** Legacy identifiers are wire/storage contracts, not current branding.
 * Keep these aliases readable: old chats, files and third-party consumers still use them.
 * Never rewrite stored prompt strings or paths: they are also history/cache identities.
 */
export const LEGACY_KEYS: Readonly<Record<string, string>> = {
  changye_image: 'baibai_image',
  changye_api_channels: 'baibai_api_channels',
  changye_exclude_settings: 'baibai_exclude_settings',
  changye_image_char_global: 'baibai_image_char_global',
  changye_image_char_tags: 'baibai_image_char_tags',
  changyeImage: 'bbiImage',
  changyeCharChanges: 'bbiCharChanges',
  changye_prompt_sources: 'bbi_prompt_sources',
  'changye.orb.pos.v1': 'bbi.orb.pos.v1',
  'changye.ui.charGlobalCollapsed.v1': 'bbi.ui.charGlobalCollapsed.v1',
  'changye.ui.charChatCollapsed.v1': 'bbi.ui.charChatCollapsed.v1',
  'changye.ui.page.v1': 'bbi.ui.page.v1',
  'changye.ui.galleryExpanded.v1': 'bbi.ui.galleryExpanded.v1',
};

/** An explicit new empty/null value wins, so clearing data cannot resurrect an old copy. */
export function readCompatibleField(record: Record<string, unknown> | null | undefined, key: string): unknown {
  if (!record) return undefined;
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : record[LEGACY_KEYS[key]];
}

export function readCompatibleLocal(key: string): string | null {
  return localStorage.getItem(key) ?? (LEGACY_KEYS[key] ? localStorage.getItem(LEGACY_KEYS[key]) : null);
}

/** Shared channels still receive edits from external plugins using the old protocol. */
export function readSharedCompatibleField(record: Record<string, unknown> | null | undefined, key: string): unknown {
  const current = readCompatibleField(record, key);
  const legacy = record?.[LEGACY_KEYS[key]];
  const revision = (value: unknown): number => value && typeof value === 'object'
    && typeof (value as { revision?: unknown }).revision === 'number'
    ? (value as { revision: number }).revision : -1;
  return revision(legacy) > revision(current) ? legacy : current;
}

export const LEGACY_IMAGE_FOLDER_PREFIX = '柏宝绘_';
export const LEGACY_ARTIST_PREVIEW_FOLDER = '柏宝绘_画师串';
export const LEGACY_IMAGE_API = 'STBaiBaiImage';
export const LEGACY_BOOK_API = 'STBaiBaiBook';
export const LEGACY_READY_EVENT = 'st-baibai-image:ready';
export const LEGACY_CHANGED_EVENT = 'st-baibai-image:changed';
export const LEGACY_CHANNELS_EVENT = 'st-baibai-api-channels:changed';
export const LEGACY_EXCLUDES_EVENT = 'st-baibai-exclude-settings:changed';
export const LEGACY_FOLDER_ENDPOINT = '/api/plugins/baibai-image-folders/open-folder';
export const LEGACY_VIBE_DB = 'baibai_image_vibes';

export function galleryFolderName(folder: string): string | null {
  if (folder === LEGACY_ARTIST_PREVIEW_FOLDER || folder === '长夜绘图器_画师串') return null;
  const prefix = ['长夜绘图器_', LEGACY_IMAGE_FOLDER_PREFIX].find(value => folder.startsWith(value));
  return prefix ? folder.slice(prefix.length) : null;
}
