export interface InpaintRect { x: number; y: number; width: number; height: number }

/** One integer rectangle shared by the visible reference frame and the submitted crop. */
export function inpaintReferenceRect(bounds: InpaintRect, width: number, height: number, factor: number, full = false): InpaintRect {
  if (full) return { x: 0, y: 0, width, height };
  const side = Math.ceil(Math.max(bounds.width, bounds.height) * factor);
  const w = Math.min(width, side), h = Math.min(height, side);
  return { x: Math.max(0, Math.min(width - w, Math.floor(bounds.x + bounds.width / 2 - w / 2))),
    y: Math.max(0, Math.min(height - h, Math.floor(bounds.y + bounds.height / 2 - h / 2))), width: w, height: h };
}

/** Keep the reference aspect ratio, rounding only for the model's latent grid. */
export function inpaintReferenceSize(rect: InpaintRect, target: number): { width: number; height: number } {
  const scale = target / Math.max(rect.width, rect.height);
  return { width: Math.max(64, Math.round(rect.width * scale / 32) * 32),
    height: Math.max(64, Math.round(rect.height * scale / 32) * 32) };
}
