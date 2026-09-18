import { parseSize, pickSize, type ImageSize, type Orientation, type SizePair } from './size';

/** Strict user dimensions; never silently round or truncate a saved resolution. */
export function validResolution(value: unknown): value is ImageSize {
  if (!value || typeof value !== 'object') return false;
  const { width, height } = value as ImageSize;
  return [width, height].every(n => Number.isInteger(n) && n >= 64 && n <= 4096);
}
export function resolutionText(value: ImageSize): string {
  if (!validResolution(value)) throw new Error('宽度和高度必须是 64–4096 范围内的整数');
  return `${value.width}×${value.height}`;
}
export function readResolution(value: unknown): ImageSize | undefined {
  if (typeof value !== 'string' || !/^\s*\d{2,4}\s*[×xX*]\s*\d{2,4}\s*$/.test(value)) return undefined;
  return parseSize(value) ?? undefined;
}
export function normalizeResolutions(raw: unknown): ImageSize[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  return raw.flatMap(value => {
    const size = typeof value === 'string' ? readResolution(value) : value;
    if (!validResolution(size) || seen.has(resolutionText(size))) return [];
    seen.add(resolutionText(size));
    return [{ width: size.width, height: size.height }];
  });
}
export function workflowResolution(pair: SizePair & { defaultSize?: string }, orientation: Orientation = 'portrait'): ImageSize {
  return readResolution(pair.defaultSize) ?? readResolution(pickSize(pair, orientation)) ?? { width: 832, height: 1216 };
}
