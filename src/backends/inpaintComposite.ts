import type { ComfyImageResult } from './comfyui';
import { imageAbortError } from '@/state/imageTasks';

export interface Pixels { width: number; height: number; data: Uint8ClampedArray }
export async function decodePixels(blob: Blob): Promise<Pixels> {
  const bitmap = await createImageBitmap(blob);
  try {
    if (bitmap.width * bitmap.height > 32_000_000) throw new Error('重绘图片超过 3200 万像素');
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0);
    return ctx.getImageData(0, 0, canvas.width, canvas.height);
  } finally { bitmap.close(); }
}

export function maskBounds(mask: Pixels): { width: number; height: number } {
  let left = mask.width, top = mask.height, right = -1, bottom = -1;
  for (let y = 0; y < mask.height; y++) for (let x = 0; x < mask.width; x++) {
    if (mask.data[(y * mask.width + x) * 4] > 0) {
      left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
  }
  if (right < 0) throw new Error('请先涂选要修改的区域');
  return { width: right - left + 1, height: bottom - top + 1 };
}

/** Feather inward only. Zero-mask pixels retain all four source channels exactly. */
export function blendProtectedPixels(source: Pixels, generated: Pixels, mask: Pixels, feather: number): Pixels {
  const { width, height } = source, count = width * height;
  if (![generated, mask].every(p => p.width === width && p.height === height && p.data.length === count * 4)
    || source.data.length !== count * 4) throw new Error('重绘结果或选区尺寸与原图不一致，已拒绝覆盖');
  if (!Number.isInteger(feather) || feather < 0 || feather > 32) throw new Error('边缘柔化参数无效');
  const data = new Uint8ClampedArray(source.data);
  const distance = new Uint8Array(count), limit = feather + 1;
  for (let i = 0; i < count; i++) distance[i] = mask.data[i * 4] ? limit : 0;
  if (feather) {
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (x) distance[i] = Math.min(distance[i], distance[i - 1] + 1);
      if (y) distance[i] = Math.min(distance[i], distance[i - width] + 1);
    }
    for (let y = height - 1; y >= 0; y--) for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x;
      if (x + 1 < width) distance[i] = Math.min(distance[i], distance[i + 1] + 1);
      if (y + 1 < height) distance[i] = Math.min(distance[i], distance[i + width] + 1);
    }
  }
  for (let i = 0; i < count; i++) {
    const at = i * 4, weight = mask.data[at] / 255 * distance[i] / limit;
    if (!weight) continue;
    const a = source.data[at + 3] / 255 * (1 - weight), b = generated.data[at + 3] / 255 * weight;
    for (let c = 0; c < 3; c++) data[at + c] = a + b ? (source.data[at + c] * a + generated.data[at + c] * b) / (a + b) : 0;
    data[at + 3] = (a + b) * 255;
  }
  return { width, height, data };
}

export async function protectedInpaintResult(source: Pixels, mask: Pixels, result: ComfyImageResult, feather: number, signal?: AbortSignal): Promise<ComfyImageResult> {
  try {
    const response = await fetch(result.url, { signal });
    if (!response.ok) throw new Error('无法读取重绘结果');
    const generated = await decodePixels(await response.blob());
    if (signal?.aborted) throw imageAbortError();
    const pixels = blendProtectedPixels(source, generated, mask, feather);
    const canvas = document.createElement('canvas'); canvas.width = pixels.width; canvas.height = pixels.height;
    const ctx = canvas.getContext('2d')!;
    const output = ctx.createImageData(pixels.width, pixels.height); output.data.set(pixels.data); ctx.putImageData(output, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('无法保存重绘结果')), 'image/png'));
    if (signal?.aborted) throw imageAbortError();
    const url = URL.createObjectURL(blob);
    return { ...result, url, filename: `inpaint-${Date.now()}.png`, format: 'png', preservePixels: true, revoke: () => URL.revokeObjectURL(url) };
  } finally { result.revoke(); }
}
