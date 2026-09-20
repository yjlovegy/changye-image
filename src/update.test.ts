import { describe, expect, it, vi } from 'vitest';
import { isNewer, checkForUpdate, updateState } from './update';

describe('isNewer', () => {
  it('checks this distribution repository rather than the upstream release', async () => {
    const nextVersion = `${Number(updateState.current.split('.')[0]) + 1}.0.0`;
    const fetchMock=vi.fn().mockResolvedValue({ok:true,json:async()=>({version:nextVersion})});
    vi.stubGlobal('fetch',fetchMock);
    try {
      await checkForUpdate(true);
      expect(String(fetchMock.mock.calls[0][0])).toMatch(/^https:\/\/raw\.githubusercontent\.com\/yjlovegy\/changye-image\/main\/manifest\.json\?t=/);
      expect(updateState.available).toBe(true);
    } finally { vi.unstubAllGlobals(); }
  });
  it('compares numeric version segments', () => {
    expect(isNewer('0.1.3', '0.1.2')).toBe(true);
    expect(isNewer('0.1', '0.1.0')).toBe(false);
    expect(isNewer('1.0.0', '1.0.1')).toBe(false);
  });
});
