import type { STMessage } from '@/st/context';
import { stripImageTags } from '@/st/imageTagRegex';
export const PROMPT_SOURCES_KEY = 'bbi_prompt_sources';
export interface PromptSource { text: string; kind: 'selection' | 'floor' }
interface SourceRecord extends PromptSource { rawTag: string; swipe: number }
function entries(message: STMessage): SourceRecord[] {
  const value = message.extra?.[PROMPT_SOURCES_KEY];
  return Array.isArray(value) ? value.filter((v): v is SourceRecord => !!v && typeof v === 'object'
    && typeof v.text === 'string' && typeof v.rawTag === 'string' && Number.isInteger(v.swipe)
    && (v.kind === 'selection' || v.kind === 'floor')) : [];
}
export function sourceForPrompt(message: STMessage, rawTag: string, swipe: number): PromptSource & { legacy: boolean } {
  const saved = entries(message).find(v => v.rawTag === rawTag && v.swipe === swipe);
  return saved ? { text: saved.text, kind: saved.kind, legacy: false }
    : { text: stripImageTags(message.mes), kind: 'floor', legacy: true };
}
export function rememberPromptSources(message: STMessage, swipe: number, records: Array<PromptSource & { rawTag: string }>, replaceTag?: string): SourceRecord[] {
  const tags = new Set(records.map(v=>v.rawTag));
  return [...entries(message).filter(v=>v.swipe !== swipe || (!tags.has(v.rawTag) && v.rawTag !== replaceTag)),
    ...records.map(v=>({...v,swipe}))];
}
