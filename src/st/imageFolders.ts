import { LEGACY_FOLDER_ENDPOINT } from '@/legacyCompatibility';
import { getContext } from '@/st/context';

/** The local companion validates the user, origin and real directory before launching Explorer. */
export async function openGalleryFolder(folder: string): Promise<void> {
  const ctx = getContext();
  if (!ctx) throw new Error('SillyTavern 上下文不可用');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    let response = await fetch('/api/plugins/changye-image-folders/open-folder', {
      method: 'POST', headers: ctx.getRequestHeaders(), body: JSON.stringify({ folder }),
      signal: controller.signal,
    });
    // Old server helper can still open historical folders until it is upgraded.
    const firstError = response.status === 404 ? await response.clone().json().catch(() => null) : null;
    if (response.status === 404 && !firstError?.error) response = await fetch(LEGACY_FOLDER_ENDPOINT, {
      method: 'POST', headers: ctx.getRequestHeaders(), body: JSON.stringify({ folder }), signal: controller.signal,
    });
    const data = await response.json().catch(() => null) as { ok?: boolean; error?: string } | null;
    if (response.ok && data?.ok === true) return;
    if (response.status === 404 && !data?.error) {
      throw new Error('文件夹助手尚未加载，请安装配套服务插件并重启酒馆。');
    }
    throw new Error(data?.error || `打开文件夹失败（${response.status}）`);
  } catch (error) {
    if (controller.signal.aborted) throw new Error('打开文件夹请求超时，请稍后重试。');
    throw error;
  } finally { clearTimeout(timer); }
}
