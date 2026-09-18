import { describe, expect, it } from 'vitest';
import { normalizeResolutions, readResolution, resolutionText, workflowResolution } from './resolution';
import { parseImageTagContent, serializeImageTag, containsTagMarkup } from '@/st/imageTagRegex';
describe('saved and per-image dimensions', () => {
  it('normalizes saved dimensions without accepting partial matches or invalid numbers', () => {
    expect(normalizeResolutions(['1080x1920', {width:1080,height:1920}, '10000x1024', '1024x1024 extra', {width:1.5,height:1000}, '832×1216'])).toEqual([{width:1080,height:1920},{width:832,height:1216}]);
    expect(readResolution(' 1080 × 1920 ')).toEqual({width:1080,height:1920});
    expect(() => resolutionText({width:NaN,height:1024})).toThrow();
  });
  it('prefers the workflow default and preserves legacy orientation for unnormalized callers', () => {
    const old={portraitSize:'832×1216',landscapeSize:'1216×832'};
    expect(workflowResolution(old,'landscape')).toEqual({width:1216,height:832});
    expect(workflowResolution({...old,defaultSize:'1080×1920'},'landscape')).toEqual({width:1080,height:1920});
  });
  it('round trips per-image dimensions without polluting the prompt or changing old tags', () => {
    const original = parseImageTagContent('<bbi_image>a ceramic vase<size>portrait</size></bbi_image>');
    expect(serializeImageTag(original)).toBe('<bbi_image>a ceramic vase<size>portrait</size></bbi_image>');
    const edited={...original,resolution:{width:1080,height:1920}};
    expect(parseImageTagContent(serializeImageTag(edited))).toEqual(edited);
    const broken=parseImageTagContent('<bbi_image>a vase<resolution>10000×1024</resolution></bbi_image>');
    expect(broken.tag).toBe('a vase'); expect(broken.resolutionInvalid).toBe(true);
    expect(containsTagMarkup('<resolution>')).toBe(true);
  });
});
