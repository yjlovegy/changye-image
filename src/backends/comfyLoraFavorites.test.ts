import { describe, expect, it } from 'vitest';
import { appendFavoriteTag, normalizeLoraFavorites, validateLoraFavorites } from './comfyLoraFavorites';

describe('LoRA 收藏', () => {
  it('旧设置默认空库，脏字段不进入库；保留可修复的旧标签', () => {
    expect(normalizeLoraFavorites(undefined)).toEqual([]);
    expect(normalizeLoraFavorites([null, 1, { tag: 2 }, { tag: 'fix me', note: 7 }, { tag: '<lora:detail:0.7>', note: '近景' }]))
      .toEqual([{ tag: 'fix me', note: '' }, { tag: '<lora:detail:0.7>', note: '近景' }]);
  });
  it('保存校验每条恰好一个标签，备注单独保留，支持模型和 CLIP 双权重', () => {
    expect(validateLoraFavorites([{ tag: ' <lora:detail:0.70:0.4> ', note: ' 近景 ' }]))
      .toEqual([{ tag: '<lora:detail:0.7:0.4>', note: '近景' }]);
    expect(() => validateLoraFavorites([{ tag: '', note: '未写标签' }])).toThrow('第 1 条');
    expect(() => validateLoraFavorites([{ tag: '<lora:a:1> <lora:b:1>', note: '' }])).toThrow('一个完整');
    expect(() => validateLoraFavorites([{ tag: '<lora:a:bad>', note: '' }])).toThrow('有效权重');
    expect(validateLoraFavorites([])).toEqual([]);
  });
  it('加入保留现有清单与权重；拒绝重复项及损坏的目标清单', () => {
    expect(appendFavoriteTag('<lora:light:0.50>', '<lora:detail:0.70:0.4>'))
      .toBe('<lora:light:0.50>\n<lora:detail:0.7:0.4>');
    expect(appendFavoriteTag('', '<lora:detail:0.7>')).toBe('<lora:detail:0.7>');
    expect(() => appendFavoriteTag('<lora:folder\\detail.safetensors:0.5>', '<lora:folder/detail:0.7>')).toThrow('已在目标组');
    expect(() => appendFavoriteTag('unfinished', '<lora:detail:0.7>')).toThrow('格式不完整');
  });
});
