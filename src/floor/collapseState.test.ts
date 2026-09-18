import { describe, expect, it } from 'vitest';

import { isCollapsed, setCollapsed, shiftCollapseStateForInsertion } from '@/floor/collapseState';

describe('collapseState', () => {
  it('moves collapsed and expanded preferences with old images and leaves the inserted slot at its default', () => {
    setCollapsed('insert|1|0|0', false);
    setCollapsed('insert|1|0|1', true);
    setCollapsed('insert|1|0|2', false);
    setCollapsed('insert|1|1|1', true);
    shiftCollapseStateForInsertion('insert', 1, 0, 1);
    expect(isCollapsed('insert|1|0|0', true)).toBe(false);
    expect(isCollapsed('insert|1|0|1', false)).toBe(false);
    expect(isCollapsed('insert|1|0|1', true)).toBe(true);
    expect(isCollapsed('insert|1|0|2', false)).toBe(true);
    expect(isCollapsed('insert|1|0|3', true)).toBe(false);
    expect(isCollapsed('insert|1|1|1', false)).toBe(true);
  });
  it('未手动设置的槽位回落到默认值', () => {
    expect(isCollapsed('c|1|0|0', false)).toBe(false);
    expect(isCollapsed('c|1|0|0', true)).toBe(true);
  });

  it('手动设置后覆盖默认值', () => {
    setCollapsed('c|2|0|1', true);
    expect(isCollapsed('c|2|0|1', false)).toBe(true);

    setCollapsed('c|3|0|0', false);
    expect(isCollapsed('c|3|0|0', true)).toBe(false);
  });

  it('不同槽位互不影响', () => {
    setCollapsed('c|4|0|0', true);
    expect(isCollapsed('c|4|0|1', false)).toBe(false);
    // swipeId 是 key 的一部分:切 swipe 是另一个槽位
    expect(isCollapsed('c|4|1|0', false)).toBe(false);
  });
});
