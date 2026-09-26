export type InpaintMode = 'touchup' | 'repair' | 'replace';
export interface InpaintTuning {
  mode: InpaintMode;
  denoise: number;
  resolution: 'auto' | '768' | '1024' | '1536';
  feather: number;
  context: number;
  steps: number | null;
  cfg: number | null;
  thinkingSteps: number;
  promptMode: 'Image First' | 'Prompt First';
}
export const modeStrength: Record<InpaintMode, number> = { touchup: 0.35, repair: 0.7, replace: 1 };
export function defaultInpaintTuning(): InpaintTuning {
  return { mode: 'repair', denoise: 0.7, resolution: 'auto', feather: 6, context: 1.5,
    steps: null, cfg: null, thinkingSteps: 5, promptMode: 'Image First' };
}
export function validateInpaintTuning(t: InpaintTuning): void {
  if (!['touchup','repair','replace'].includes(t.mode)) throw new Error('请选择重绘模式');
  if (!Number.isFinite(t.denoise) || t.denoise < 0.05 || t.denoise > 1) throw new Error('重绘强度需在 0.05–1 之间');
  if (!['auto','768','1024','1536'].includes(t.resolution)) throw new Error('请选择有效的重绘分辨率');
  if (!Number.isInteger(t.feather) || t.feather < 0 || t.feather > 32) throw new Error('边缘柔化需为 0–32 像素');
  if (!Number.isFinite(t.context) || t.context < 1 || t.context > 3) throw new Error('参考范围需在 1–3 之间');
  if (t.steps !== null && (!Number.isInteger(t.steps) || t.steps < 1 || t.steps > 100)) throw new Error('采样步数需为 1–100，或留空跟随工作流');
  if (t.cfg !== null && (!Number.isFinite(t.cfg) || t.cfg < 0 || t.cfg > 30)) throw new Error('CFG 需在 0–30 之间，或留空跟随工作流');
  if (!Number.isInteger(t.thinkingSteps) || t.thinkingSteps < 1 || t.thinkingSteps > 10) throw new Error('细化次数需为 1–10');
  if (!['Image First','Prompt First'].includes(t.promptMode)) throw new Error('请选择重绘优先方式');
}
export function normalizeInpaintTuning(raw?: unknown): InpaintTuning {
  const defaults = defaultInpaintTuning();
  if (!raw || typeof raw !== 'object') return defaults;
  const value = Object.fromEntries(Object.keys(defaults).map(key => [key, (raw as any)[key] ?? (defaults as any)[key]])) as unknown as InpaintTuning;
  try { validateInpaintTuning(value); return value; } catch { return defaults; }
}
export function inpaintTargetSize(t: InpaintTuning, width: number, height: number): number {
  if (t.resolution !== 'auto') return Number(t.resolution);
  return Math.max(1024, Math.min(1536, Math.ceil(Math.max(width, height) * t.context / 64) * 64));
}
