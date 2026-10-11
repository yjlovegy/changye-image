import { afterEach, expect, it, vi } from 'vitest';
vi.mock('@/st/context', () => ({ getContext: () => ({ getRequestHeaders: () => ({ 'X-CSRF-Token': 'fixture' }) }) }));
import { openGalleryFolder } from './imageFolders';
afterEach(() => vi.unstubAllGlobals());
it('falls back to the legacy helper only when the new route is absent', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response('Not Found', { status: 404 })).mockResolvedValueOnce(Response.json({ ok: true }));
  vi.stubGlobal('fetch', fetcher);
  await openGalleryFolder('柏宝绘_示例');
  expect(fetcher.mock.calls.map(call => call[0])).toEqual(['/api/plugins/changye-image-folders/open-folder', '/api/plugins/baibai-image-folders/open-folder']);
  fetcher.mockReset().mockResolvedValue(Response.json({ error: '目录不存在' }, { status: 404 }));
  await expect(openGalleryFolder('长夜绘图器_示例')).rejects.toThrow('目录不存在');
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('sends only folder name with host headers', async () => {
  const fetcher = vi.fn(async () => Response.json({ ok: true })); vi.stubGlobal('fetch', fetcher);
  await openGalleryFolder('长夜绘图器_示例角色 A');
  expect(fetcher).toHaveBeenCalledWith('/api/plugins/changye-image-folders/open-folder', expect.objectContaining({ method: 'POST', headers: { 'X-CSRF-Token': 'fixture' }, body: JSON.stringify({ folder: '长夜绘图器_示例角色 A' }) }));
});
it('distinguishes missing helper from missing folder and rejects malformed success', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('Not Found', { status: 404 })));
  await expect(openGalleryFolder('长夜绘图器_A')).rejects.toThrow('重启酒馆');
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: '图片目录已不存在，请刷新图库。' }, { status: 404 })));
  await expect(openGalleryFolder('长夜绘图器_A')).rejects.toThrow('目录已不存在');
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({})));
  await expect(openGalleryFolder('长夜绘图器_A')).rejects.toThrow('打开文件夹失败');
});
