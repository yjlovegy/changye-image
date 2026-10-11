import { describe, expect, it } from 'vitest';

import { imageDownloadFileName } from '@/floor/download';

describe('imageDownloadFileName', () => {
  it('keeps Chinese characters in the downloaded filename', () => {
    expect(imageDownloadFileName('/user/files/changye____.png', '长夜', 'g123')).toBe(
      'changye_长夜_g123.png',
    );
  });

  it('replaces only characters forbidden in filenames', () => {
    expect(imageDownloadFileName('/user/files/image.jpg?x=1', '长夜/测试:卡', 'g123')).toBe(
      'changye_长夜_测试_卡_g123.jpg',
    );
  });
});
