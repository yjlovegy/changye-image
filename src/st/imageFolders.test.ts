import { afterEach, expect, it, vi } from 'vitest';
vi.mock('@/st/context', () => ({ getContext: () => ({ getRequestHeaders: () => ({ 'X-CSRF-Token': 'fixture' }) }) }));
import { openGalleryFolder } from './imageFolders';
afterEach(() => vi.unstubAllGlobals());
it('sends only folder name with host headers', async () => {
  const fetcher = vi.fn(async () => Response.json({ ok: true })); vi.stubGlobal('fetch', fetcher);
  await openGalleryFolder('柏宝绘_示例角色 A');
  expect(fetcher).toHaveBeenCalledWith('/api/plugins/baibai-image-folders/open-folder', expect.objectContaining({ method: 'POST', headers: { 'X-CSRF-Token': 'fixture' }, body: JSON.stringify({ folder: '柏宝绘_示例角色 A' }) }));
});
it('distinguishes missing helper from missing folder and rejects malformed success', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('Not Found', { status: 404 })));
  await expect(openGalleryFolder('柏宝绘_A')).rejects.toThrow('重启酒馆');
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: '图片目录已不存在，请刷新图库。' }, { status: 404 })));
  await expect(openGalleryFolder('柏宝绘_A')).rejects.toThrow('目录已不存在');
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({})));
  await expect(openGalleryFolder('柏宝绘_A')).rejects.toThrow('打开文件夹失败');
});
