import { describe, expect, it } from 'vitest';
import { prepareTargetText, cleanHistoryText } from './clean';
import { storyRanges } from './storyScope';
import { locateSelectionSourceEnd } from '@/floor/selectionAnchor';
import { injectImageTags, parseImagePlan } from './protocol';

describe('positive story scope', () => {
  it('preserves original line positions while excluding outside text', () => {
    const source = '状态栏\n<game>\n她在窗边读书。\n她合上书。\n</game>\n总结';
    const target = prepareTargetText(source, [], ['game']);
    expect(target.segments.map(s => [s.text, s.sourceLine])).toEqual([['她在窗边读书。',2],['她合上书。',3]]);
    const plan = parseImagePlan(JSON.stringify({images:[{position:'P1',sourceParagraphs:['P1'],tag:'reading'}]}),target.segments,1,1);
    const result = injectImageTags(source, plan.images);
    expect(result.indexOf('<bbi_image')).toBeGreaterThan(result.indexOf('她在窗边读书。'));
    expect(result.indexOf('<bbi_image')).toBeLessThan(result.indexOf('她合上书。'));
  });
  it('keeps images inside inline closing wrappers', () => {
    const source = '<game>她在窗边读书。</game>状态栏<think><game>隐藏示例</game></think>';
    const target = prepareTargetText(source, [], ['game']);
    const plan = parseImagePlan(JSON.stringify({images:[{position:'P1',sourceParagraphs:['P1'],tag:'reading'}]}),target.segments,1,1);
    const result = injectImageTags(source,plan.images);
    expect(result.indexOf('</bbi_image>')).toBeLessThan(result.indexOf('</game>'));
    expect(result.endsWith('</game>状态栏<think><game>隐藏示例</game></think>')).toBe(true);
  });
  it('supports alternatives, repeated and nested blocks without duplicates', () => {
    const source = '<GAME class="a">甲<正文>乙</正文>丙</GAME>外部<story>丁</story><game>戊</game>';
    expect(prepareTargetText(source, [], ['game','正文','story']).segments[0].text).toBe('甲 乙 丙 丁 戊');
    expect(storyRanges(source,['game','正文','story'])).toHaveLength(3);
  });
  it('never falls back to all prose when tags are configured', () => {
    for (const text of ['正文', '<gameball>正文</gameball>', '<game>未闭合', '<!-- <game>示例</game> -->', '<thinking><game>思考</game></thinking>']) {
      expect(prepareTargetText(text, [], ['game']).segments).toEqual([]);
    }
    expect(cleanHistoryText('无标签的旧楼',[],['game'])).toBe('');
    expect(prepareTargetText('普通正文',[],[]).segments).toHaveLength(1);
  });
  it('retains only scoped history for appearance and context', () => {
    expect(cleanHistoryText('外部<game>她放下书。</game>总结',[],['game'])).toBe('她放下书。');
  });
  it('rejects manual selections outside the range and supports custom flow wrappers', () => {
    const source = '说明<正文>她在窗边读书。</正文>总结';
    const visible = '说明她在窗边读书。总结';
    const inside = locateSelectionSourceEnd(source,visible,'说明','她在窗边读书。',[],[],['正文']);
    expect(inside.offset).toBe(source.indexOf('</正文>'));
    expect(locateSelectionSourceEnd(source,visible,'','说明',[],[],['正文']).reason).toContain('标签范围');
    expect(locateSelectionSourceEnd(source,visible,'说明','她在窗边读书。总结',[],[],['正文']).reason).toContain('标签范围');
  });
});
