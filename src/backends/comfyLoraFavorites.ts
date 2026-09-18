import { formatLoraTags, parseLoraTags } from './comfyLoras';

/** Shared by workflows; never part of the generation connection or graph. */
export interface ComfyLoraFavorite { tag: string; note: string }

export function normalizeLoraFavorites(raw: unknown): ComfyLoraFavorite[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap(row => row && typeof row === 'object' && typeof row.tag === 'string'
    ? [{ tag: row.tag, note: typeof row.note === 'string' ? row.note : '' }] : []);
}

export function validateLoraFavorites(rows: readonly ComfyLoraFavorite[]): ComfyLoraFavorite[] {
  return rows.map((row, index) => {
    try {
      const entries = parseLoraTags(row.tag);
      if (entries.length !== 1) throw new Error('每条收藏请填写一个完整 LoRA 标签');
      return { tag: formatLoraTags(entries), note: row.note.trim() };
    } catch (error) {
      throw new Error(`第 ${index + 1} 条：${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

/** Refuse duplicates instead of silently replacing the user's chosen weight. */
export function appendFavoriteTag(current: string, tag: string): string {
  const [favorite] = validateLoraFavorites([{ tag, note: '' }]);
  const entry = parseLoraTags(favorite.tag)[0]!;
  const entries = parseLoraTags(current);
  const key = (name: string) => name.replace(/\\/g, '/').replace(/\.safetensors$/i, '');
  if (entries.some(existing => key(existing.name) === key(entry.name))) {
    throw new Error('该 LoRA 已在目标组中，未重复添加；如需调整权重，请直接编辑目标组。');
  }
  return current.trim() ? `${current.trim()}\n${favorite.tag}` : favorite.tag;
}

/** Validate the whole selection first. Existing weights win; duplicates are reported, never stacked. */
export function appendFavoriteTags(current: string, tags: string[]): { text: string; added: number; skipped: number } {
  const entries = parseLoraTags(current);
  const favorites = validateLoraFavorites(tags.map(tag => ({ tag, note: '' })));
  const key = (name: string) => name.replace(/\\/g, '/').replace(/\.safetensors$/i, '');
  const names = new Set(entries.map(entry => key(entry.name)));
  const additions: string[] = [];
  for (const favorite of favorites) {
    const name = key(parseLoraTags(favorite.tag)[0]!.name);
    if (names.has(name)) continue;
    names.add(name); additions.push(favorite.tag);
  }
  return { text: [current.trim(), ...additions].filter(Boolean).join('\n'), added: additions.length, skipped: tags.length - additions.length };
}
