import { describe, expect, it } from 'vitest';
import { buildSimpleWorkflow, migrateSimpleWorkflow, simpleDefaults } from './comfyTemplates';
import { renderWorkflowTemplate } from './comfyui';
import { validateWorkflowJson, updateWorkflowFields } from './comfyWorkflowControls';

describe('retired simple presets become editable API workflows', () => {
  for (const template of ['checkpoint', 'anima', 'flux'] as const) {
    it(`${template}: preserves models, LoRA, prompts and sampling while leaving dimensions/seed dynamic`, () => {
      const simple = { ...simpleDefaults(template), model: 'model.safetensors', vae: 'vae.safetensors',
        clip1: 'clip1.safetensors', clip2: 'clip2.safetensors', steps: 17, cfg: 4.5,
        loras: [{ name: 'detail.safetensors', strength: 0.6 }], positive: 'soft light',
        negative: template === 'flux' ? '' : 'watermark' };
      const fixed = { positivePrefix: 'illustration', positiveSuffix: 'blue tones', negative: template === 'flux' ? '' : 'blurry' };
      const source = migrateSimpleWorkflow(simple);
      expect(validateWorkflowJson(source)).toBe(source);
      for (const [width, height, seed] of [[832, 1216, 42], [1216, 832, 987]]) {
        const values = { prompt: 'a cup', nl: 'A cup rests on a table.', negative: 'duplicate cup', width, height, seed };
        expect(renderWorkflowTemplate(source, { ...values, negative_prompt: values.negative }, fixed))
          .toEqual(buildSimpleWorkflow(simple, values, fixed));
      }
    });
  }
  it('keeps incomplete old settings editable instead of throwing during hydration', () => {
    const source = migrateSimpleWorkflow(simpleDefaults('checkpoint'));
    expect(() => validateWorkflowJson(source)).not.toThrow();
    const updated = updateWorkflowFields(source, { '1/ckpt_name': 'chosen.safetensors' });
    expect(JSON.parse(updated)['1'].inputs.ckpt_name).toBe('chosen.safetensors');
  });
});
