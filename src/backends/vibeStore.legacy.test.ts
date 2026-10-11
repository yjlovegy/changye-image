import { afterEach, expect, it, vi } from 'vitest';

vi.mock('@/floor/upload', () => ({ uploadBase64File: vi.fn().mockRejectedValue(new Error('offline')), deleteUploadedFile: vi.fn() }));
afterEach(() => vi.unstubAllGlobals());

it('reads historical IndexedDB data, writes a new namespace and deletes only the requested generation', async () => {
  vi.resetModules();
  const original = { image: '', thumbnail: '', encodings: { a: { encoding: 'old' } } };
  const updated = { ...original, encodings: { a: { encoding: 'new' } } };
  const stores = new Map<string, Map<string, unknown>>([['baibai_image_vibes', new Map([['key', original]])]]);
  const later = (value: unknown) => {
    const request: any = { result: value };
    queueMicrotask(() => request.onsuccess?.());
    return request;
  };
  vi.stubGlobal('indexedDB', { open: (name: string) => {
    const store = stores.get(name) ?? new Map(); stores.set(name, store);
    return later({ transaction: () => ({ objectStore: () => ({
      get: (key: string) => later(store.get(key)),
      put: (value: unknown, key: string) => { store.set(key, value); return later(key); },
      delete: (key: string) => { store.delete(key); return later(undefined); },
    }) }) });
  } });
  const { loadVibeData, saveVibeFiles, deleteVibeData } = await import('./vibeStore');
  await expect(loadVibeData({ name: '历史', dataPath: 'idb:key' })).resolves.toEqual(original);
  const saved = await saveVibeFiles(updated as any, { dataPath: 'idb:key', thumbnailPath: '' });
  expect(saved.dataPath).toBe('idb-changye:key');
  await expect(loadVibeData({ name: '新数据', dataPath: saved.dataPath })).resolves.toEqual(updated);
  await expect(loadVibeData({ name: '历史', dataPath: 'idb:key' })).resolves.toEqual(original);
  await deleteVibeData(saved);
  expect(stores.get('changye_image_vibes')?.has('key')).toBe(false);
  expect(stores.get('baibai_image_vibes')?.has('key')).toBe(true);
});
