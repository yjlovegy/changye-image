import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { validateRequest, resolveImageDirectory, launchExplorer, createOpenHandler } from './index.mjs';
const request = () => ({ socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:8000', origin: 'http://127.0.0.1:8000' }, user: { directories: { userImages: '/test/images' } }, body: { folder: '长夜绘图器_示例角色 A' } });
test('valid local origin and one basename; reject foreign, proxied or malformed input', () => {
  assert.equal(validateRequest(request()), '长夜绘图器_示例角色 A');
  for (const folder of ['../x', '长夜绘图器_../x', '长夜绘图器_..\\x', 'C:\\x', '长夜绘图器_x:stream', '长夜绘图器_x\u0000', '长夜绘图器_x.', '长夜绘图器_']) {
    assert.throws(() => validateRequest({ ...request(), body: { folder } }));
  }
  for (const origin of [undefined, 'http://evil.example', 'http://127.0.0.1:9000', 'null']) {
    const req = request(); req.headers.origin = origin; assert.throws(() => validateRequest(req));
  }
  const remote = request(); remote.socket.remoteAddress = '192.168.1.2'; assert.throws(() => validateRequest(remote));
  const proxy = request(); proxy.headers['x-forwarded-for'] = '127.0.0.1'; assert.throws(() => validateRequest(proxy));
  const user = request(); delete user.user; assert.throws(() => validateRequest(user));
});
test('only an existing directory directly under the current user root; reject file, missing and junction', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'changye-folders-test-'));
  try {
    const root = path.join(temp, 'images'), outside = path.join(temp, 'other-user');
    await mkdir(root); await mkdir(outside);
    const target = path.join(root, '长夜绘图器_示例角色 A'); await mkdir(target);
    assert.equal(await resolveImageDirectory(root, '长夜绘图器_示例角色 A'), target);
    await writeFile(path.join(root, '长夜绘图器_file'), 'fixture');
    await assert.rejects(resolveImageDirectory(root, '长夜绘图器_file'));
    await assert.rejects(resolveImageDirectory(root, '长夜绘图器_missing'));
    await symlink(outside, path.join(root, '长夜绘图器_link'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(resolveImageDirectory(root, '长夜绘图器_link'));
    await assert.rejects(resolveImageDirectory(outside, '长夜绘图器_示例角色 A'));
  } finally {
    // Only remove this test's fixed-prefix directory returned by mkdtemp.
    assert.equal(path.dirname(temp), path.resolve(tmpdir()));
    assert.ok(path.basename(temp).startsWith('changye-folders-test-'));
    await rm(temp, { recursive: true, force: true });
  }
});
test('Explorer uses one literal argument, no shell; startup errors propagate', async () => {
  const target = 'E:\\images\\长夜绘图器_A & B';
  await launchExplorer(target, (exe, args, options) => {
    assert.equal(exe, 'C:\\Windows\\explorer.exe'); assert.deepEqual(args, [target]);
    assert.equal(options.shell, false); assert.equal(options.windowsHide, false);
    const child = new EventEmitter(); child.unref = () => {}; queueMicrotask(() => child.emit('spawn')); return child;
  }, 'C:\\Windows');
  await assert.rejects(launchExplorer(target, () => {
    const child = new EventEmitter(); queueMicrotask(() => child.emit('error', new Error('fixture failure'))); return child;
  }, 'C:\\Windows'));
});
test('handler rejects before launch, scopes resolution to user root and throttles repeated clicks', async () => {
  let calls = 0;
  const handler = createOpenHandler({ platform: 'win32', now: () => 1000,
    resolve: async (root, folder) => { assert.equal(root, '/test/images'); assert.equal(folder, '长夜绘图器_示例角色 A'); return '/validated'; },
    launch: async target => { assert.equal(target, '/validated'); calls++; },
  });
  const res = { code: 200, data: null, status(c) { this.code=c; return this; }, json(d) { this.data=d; } };
  const bad = request(); bad.body.folder = '../escape'; await handler(bad, res); assert.equal(calls, 0);
  await handler(request(), res); assert.deepEqual(res.data, { ok: true }); assert.equal(calls, 1);
  await handler(request(), res); assert.equal(res.code, 429); assert.equal(calls, 1);
  const unsupported = createOpenHandler({ platform: 'linux', launch: async () => { throw new Error('must not launch'); } });
  await unsupported(request(), res); assert.equal(res.code, 501);
});

// Historical folders stay valid; prefix-only names and traversal stay invalid.
test('accepts historical gallery names without widening directory access', () => {
  const req = request(); req.body.folder = '柏宝绘_历史';
  assert.equal(validateRequest(req), '柏宝绘_历史');
  for (const folder of ['柏宝绘_', '长夜绘图器_', '柏宝绘_../x', '长夜绘图器_../x']) {
    req.body.folder = folder; assert.throws(() => validateRequest(req));
  }
});
