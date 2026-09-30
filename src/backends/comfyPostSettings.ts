export interface ComfyPostSettings {
  scale: number;
  upscale: { enabled: boolean; model: string };
  hires: { enabled: boolean; denoise: number; steps: number };
  detail: { enabled: boolean; face: boolean; eyes: boolean; denoise: number; resolution: number };
  sharpen: { enabled: boolean; strength: number };
  color: { enabled: boolean; brightness: number; contrast: number; saturation: number };
}

export function defaultComfyPost(): ComfyPostSettings {
  return {
    scale: 1.5,
    upscale: { enabled: false, model: 'RealESRGAN_x4plus_anime_6B.pth' },
    hires: { enabled: false, denoise: 0.25, steps: 0 },
    detail: { enabled: false, face: true, eyes: false, denoise: 0.3, resolution: 1024 },
    sharpen: { enabled: false, strength: 0.1 },
    color: { enabled: false, brightness: 1, contrast: 1, saturation: 1 },
  };
}

export function normalizeComfyPost(raw?: Partial<ComfyPostSettings> | null): ComfyPostSettings {
  const d = defaultComfyPost();
  const number = (v: unknown, fallback: number, min: number, max: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
  return {
    scale: number(raw?.scale, d.scale, 1, 4),
    upscale: { enabled: raw?.upscale?.enabled === true, model: typeof raw?.upscale?.model === 'string' ? raw.upscale.model.trim() : d.upscale.model },
    hires: { enabled: raw?.hires?.enabled === true, denoise: number(raw?.hires?.denoise, d.hires.denoise, 0.05, 0.6), steps: Math.round(number(raw?.hires?.steps, d.hires.steps, 0, 60)) },
    detail: { enabled: raw?.detail?.enabled === true, face: raw?.detail?.face !== false, eyes: raw?.detail?.eyes === true, denoise: number(raw?.detail?.denoise, d.detail.denoise, 0.05, 0.7), resolution: [512,768,1024,1536].includes(raw?.detail?.resolution ?? 0) ? raw!.detail!.resolution : d.detail.resolution },
    sharpen: { enabled: raw?.sharpen?.enabled === true, strength: number(raw?.sharpen?.strength, d.sharpen.strength, 0, 0.5) },
    color: { enabled: raw?.color?.enabled === true, brightness: number(raw?.color?.brightness, 1, 0.5, 1.5), contrast: number(raw?.color?.contrast, 1, 0.5, 1.5), saturation: number(raw?.color?.saturation, 1, 0, 2) },
  };
}

export function postEnabled(p?: Partial<ComfyPostSettings>): boolean {
  return !!p && ['upscale','hires','detail','sharpen','color'].some(k => (p[k as keyof ComfyPostSettings] as {enabled?: boolean})?.enabled === true);
}

export function validateComfyPost(p: ComfyPostSettings): void {
  const normalized = normalizeComfyPost(p);
  for (const key of Object.keys(normalized) as (keyof ComfyPostSettings)[]) {
    const a = p[key], b = normalized[key];
    if (typeof b === 'number' ? a !== b : Object.entries(b).some(([k,v]) => (a as unknown as Record<string,unknown>)?.[k] !== v)) throw new Error('高清与后期参数超出范围，请检查输入');
  }
  if (p.upscale.enabled && !p.upscale.model) throw new Error('请选择放大模型');
  if (p.detail.enabled && !p.detail.face && !p.detail.eyes) throw new Error('请至少选择脸部或眼睛');
}

export function postTargetSize(width: number, height: number, scale: number) {
  const w = Math.max(32, Math.round(width * scale / 32) * 32);
  const h = Math.max(32, Math.round(height * scale / 32) * 32);
  if (!Number.isFinite(w * h) || width <= 0 || height <= 0 || w * h > 16_000_000) throw new Error('后期目标尺寸超过 1600 万像素，请降低倍率');
  return {width:w,height:h};
}
