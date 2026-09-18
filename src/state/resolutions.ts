import { settings } from './settings';
import { normalizeResolutions, resolutionText } from '@/backends/resolution';

export function saveResolutionFavorite(width: number, height: number): void {
  resolutionText({ width, height });
  settings.comfyui.resolutionFavorites = normalizeResolutions([
    ...settings.comfyui.resolutionFavorites, { width, height },
  ]);
}
export function removeResolutionFavorite(width: number, height: number): void {
  settings.comfyui.resolutionFavorites = settings.comfyui.resolutionFavorites.filter(s => s.width !== width || s.height !== height);
}
