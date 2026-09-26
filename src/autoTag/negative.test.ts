import { describe, expect, it } from 'vitest';
import { assertSceneNegative, SceneNegativeValidationError, supportsSceneNegative } from '@/autoTag/negative';
import { simpleDefaults } from '@/backends/comfyTemplates';

const negativeWorkflow = JSON.stringify({ '1': { class_type: 'CLIPTextEncode', inputs: { text: '%negative_prompt%' } } });
const preset = () => ({ mode: 'custom' as const, workflow: negativeWorkflow, simple: simpleDefaults() });

describe('scene negative capability', () => {
  it('keeps AI generation independent of image-use policy and preserves legacy defaults', () => {
    expect(supportsSceneNegative('comfyui', preset())).toBe(true);
    expect(supportsSceneNegative('comfyui', {...preset(),generateNegative:false})).toBe(false);
    expect(supportsSceneNegative('comfyui', {...preset(),negativeEnabled:false,generateNegative:true})).toBe(true);
  });
  it('only enables a valid ComfyUI custom workflow with the negative placeholder', () => {
    expect(supportsSceneNegative('comfyui', preset())).toBe(true);
    expect(supportsSceneNegative('nai', preset())).toBe(false);
    expect(supportsSceneNegative('comfyui', null)).toBe(false);
    for (const workflow of ['', '{invalid %negative_prompt%', JSON.stringify({ '1': { class_type: 'CLIPTextEncode', inputs: { text: '%prompt%' } } })]) {
      expect(supportsSceneNegative('comfyui', { ...preset(), workflow })).toBe(false);
    }
  });

  it.each([['checkpoint', true], ['anima', true], ['flux', false]] as const)('uses simple %s capability instead of dormant custom placeholders', (template, expected) => {
    expect(supportsSceneNegative('comfyui', { ...preset(), mode: 'simple', simple: { ...simpleDefaults(), template } })).toBe(expected);
  });
});

describe('scene negative validation', () => {
  it.each([undefined, '', '  \n\t ', ',，;；|', '... -- () [] {}', '123', 'none', '(NULL)', 'N/A', 'no negatives', 'none, null, N/A'])('rejects missing or placeholder content %s', text => {
    expect(() => assertSceneNegative(text, '图片 2 ')).toThrow(SceneNegativeValidationError);
    expect(() => assertSceneNegative(text, '图片 2 ')).toThrow('图片 2 缺少本画面负面提示词');
  });

  it.each(['duplicate character', 'cropped hands, merged bodies', '(duplicate character:1.1)'])('accepts actual English negative content without rewriting it', text => {
    expect(() => assertSceneNegative(text)).not.toThrow();
  });
});
