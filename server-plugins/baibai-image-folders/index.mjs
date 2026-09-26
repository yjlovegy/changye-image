import path from 'node:path';
import { lstat, realpath, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';

export const info = { id: 'baibai-image-folders', name: '长夜的绘图器文件夹助手', description: '在本机打开当前用户的长夜的绘图器图片目录（v1.1.0）' };
const loopback = host => ['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost', '[::1]'].includes(host);
const fail = (status, message) => Object.assign(new Error(message), { status });

export function validateRequest(req) {
  if (!loopback(req.socket?.remoteAddress) || req.headers.forwarded || req.headers['x-forwarded-for'] || req.headers['x-forwarded-host']) {
    throw fail(403, '打开文件夹仅支持直接访问本机酒馆。');
  }
  let origin;
  try { origin = new URL(req.headers.origin); } catch { throw fail(403, '请求来源无效。'); }
  if (!['http:', 'https:'].includes(origin.protocol) || !loopback(origin.hostname) || origin.host !== req.headers.host || origin.origin !== req.headers.origin) {
    throw fail(403, '请求来源必须是当前本机酒馆。');
  }
  if (!req.user?.directories?.userImages) throw fail(401, '当前用户不可用。');
  const folder = req.body?.folder;
  if (typeof folder !== 'string' || !folder.startsWith('柏宝绘_') || folder.length <= 4 || folder.length > 240 || /[<>:"/\\|?*\x00-\x1f]/u.test(folder) || /[. ]$/u.test(folder)) {
    throw fail(400, '图片目录名无效。');
  }
  return folder;
}

export async function resolveImageDirectory(root, folder) {
  const base = await realpath(path.resolve(root));
  const candidate = path.join(base, folder);
  if ((await lstat(candidate)).isSymbolicLink()) throw fail(403, '不能打开链接目录。');
  const target = await realpath(candidate);
  const relative = path.relative(base, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || path.dirname(relative) !== '.') {
    throw fail(403, '目录必须位于当前用户的图片目录内。');
  }
  if (!(await stat(target)).isDirectory()) throw fail(400, '目标不是图片目录。');
  return target;
}

export function launchExplorer(target, launch = spawn, systemRoot = process.env.SystemRoot) {
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) throw fail(503, 'Windows 系统目录不可用。');
  const executable = path.win32.join(systemRoot, 'explorer.exe');
  return new Promise((resolve, reject) => {
    // Explorer is the user-requested GUI, not a background console helper.
    // On Windows, windowsHide also supplies SW_HIDE to GUI applications.
    const child = launch(executable, [target], { shell: false, windowsHide: false, detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

export function createOpenHandler({ platform = process.platform, launch = launchExplorer, resolve = resolveImageDirectory, now = Date.now } = {}) {
  const busy = new Map();
  return async (req, res) => {
    try {
      const folder = validateRequest(req);
      if (platform !== 'win32') throw fail(501, '打开文件夹目前仅支持 Windows 本机酒馆。');
      const root = req.user.directories.userImages;
      const time = now();
      for (const [key, last] of busy) if (time - last >= 1000) busy.delete(key);
      if (busy.has(root)) throw fail(429, '请稍候再打开文件夹。');
      busy.set(root, time);
      const target = await resolve(root, folder);
      await launch(target);
      res.json({ ok: true });
    } catch (error) {
      const status = error.status || (error.code === 'ENOENT' ? 404 : 500);
      res.status(status).json({ error: error.status ? error.message : error.code === 'ENOENT' ? '图片目录已不存在，请刷新图库。' : '无法启动文件夹，请检查本机文件夹助手。' });
    }
  };
}

export async function init(router) {
  router.post('/open-folder', createOpenHandler());
}
