import { describe, expect, it } from 'vitest';
import { formatLoraTags, inspectWorkflowLoras, parseLoraTags, updateWorkflowLoras } from './comfyLoras';

function fixture() {
  return {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'base.safetensors' } },
    '72': {
      class_type: 'Lora Loader (LoraManager)',
      _meta: { title: '细节组' },
      inputs: {
        model: ['1', 0], clip: ['1', 1], text: '<lora:detail:0.7>',
        loras: { __value__: [
          { name: 'detail', strength: 0.7, clipStrength: 0.4, active: true, locked: true, custom: 'keep' },
          { name: 'off', strength: 1, active: false, expanded: true },
        ], widgetVersion: 2 },
        unrelated: { enabled: true },
      },
    },
    '243': { class_type: 'Lora Loader (LoraManager)', inputs: {
      model: ['72', 0], clip: ['72', 1], text: '', loras: { __value__: [] },
    } },
    '300': { class_type: 'TriggerWord Toggle (LoraManager)', inputs: { text: ['72', 2] } },
    '301': { class_type: 'TextConsumer', inputs: { text: ['72', 3], prompt: 'A quiet garden.' } },
    '302': { class_type: 'KSampler', inputs: { model: ['243', 0], seed: '%seed%' } },
  };
}

describe('LoRA tag syntax', () => {
  it('supports newline, punctuation, negative/zero/decimal and separate CLIP weights', () => {
    const text = '<lora:detail:0.70>\n<lora:folder/light.safetensors:-0.2:0>，<LORA:line:.5>; <lora:soft:1e-2>';
    const entries = parseLoraTags(text);
    expect(entries).toEqual([
      { name: 'detail', strength: 0.7 },
      { name: 'folder/light.safetensors', strength: -0.2, clipStrength: 0 },
      { name: 'line', strength: 0.5 },
      { name: 'soft', strength: 0.01 },
    ]);
    expect(parseLoraTags(formatLoraTags(entries))).toEqual(entries);
  });

  it('preserves order and repeated names', () => {
    expect(parseLoraTags('<lora:same:0.5><lora:same:0.2>').map(x => x.strength)).toEqual([0.5, 0.2]);
  });

  it.each(['<lora:detail>', '<lora:detail:bad>', '<lora:detail:Infinity>', '<lora:detail:1e999>',
    '<lora:detail:0.7', 'ordinary prompt <lora:detail:0.7>', '<lora::0.7>', '<lora:detail:0.7> extra',
    '<lora:detail:0.7:>', '<lora:bad\nname:0.7>'])('rejects malformed or unrelated input atomically: %s', text => {
    expect(() => parseLoraTags(text)).toThrow();
  });

  it('empty text clears the list and equal weights format simply', () => {
    expect(parseLoraTags(' \n ')).toEqual([]);
    expect(formatLoraTags([{ name: 'detail', strength: 0.7, clipStrength: 0.7 }])).toBe('<lora:detail:0.7>');
  });
});

describe('LoraManager workflow controls', () => {
  it('lists independent groups and only enabled entries, excluding trigger/text helper nodes', () => {
    const groups = inspectWorkflowLoras(JSON.stringify(fixture()));
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ nodeId: '72', label: '细节组 · #72', editable: true,
      tags: '<lora:detail:0.7:0.4>', count: 1, disabledCount: 1 });
    expect(groups[0].warnings[0]).toContain('移除原有 1 个停用项');
    expect(groups[1]).toMatchObject({ nodeId: '243', tags: '', count: 0, editable: true });
  });

  it('replaces only selected list/text, preserves item metadata, all edges and unrelated fields', () => {
    const before = fixture();
    const after = JSON.parse(updateWorkflowLoras(JSON.stringify(before), '72', '<lora:detail:0.8:0.3>\n<lora:lighting:0.2>'));
    expect(after['72'].inputs.loras).toEqual({ widgetVersion: 2, __value__: [
      { name: 'detail', strength: 0.8, clipStrength: 0.3, active: true, locked: true, custom: 'keep', selected: false, expanded: false },
      { name: 'lighting', strength: 0.2, clipStrength: 0.2, active: true, locked: false, selected: false, expanded: false },
    ] });
    expect(after['72'].inputs.text).toBe('<lora:detail:0.8:0.3>\n<lora:lighting:0.2>');
    expect(after['72'].inputs.model).toEqual(before['72'].inputs.model);
    expect(after['72'].inputs.clip).toEqual(before['72'].inputs.clip);
    expect(after['72'].inputs.unrelated).toEqual(before['72'].inputs.unrelated);
    expect(after['72']._meta).toEqual(before['72']._meta);
    for (const id of ['1', '243', '300', '301', '302']) expect(after[id]).toEqual(before[id as keyof typeof before]);
    expect(before['72'].inputs.loras.__value__).toHaveLength(2);
  });

  it('clears and re-adds with original model/CLIP/trigger/loaded-LoRA outputs intact', () => {
    const before = fixture();
    const cleared = updateWorkflowLoras(JSON.stringify(before), '72', '');
    const parsed = JSON.parse(cleared);
    expect(parsed['72'].inputs.loras.__value__).toEqual([]);
    expect(parsed['72'].inputs.text).toBe('');
    expect(parsed['300']).toEqual(before['300']);
    expect(parsed['301']).toEqual(before['301']);
    const readded = updateWorkflowLoras(cleared, '72', '<lora:new:1>');
    expect(inspectWorkflowLoras(readded)[0].tags).toBe('<lora:new:1>');
    expect(updateWorkflowLoras(readded, '72', '<lora:new:1>')).toBe(readded);
  });

  it('supports the old array shape and preserves metadata per repeated occurrence', () => {
    const workflow = { a: { class_type: 'Lora Loader (LoraManager)', inputs: {
      text: '', model: ['1', 0], loras: [
        { name: 'repeat', strength: 1, active: true, custom: 'first' },
        { name: 'repeat', strength: 1, active: true, custom: 'second' },
      ],
    } } };
    const after = JSON.parse(updateWorkflowLoras(JSON.stringify(workflow), 'a', '<lora:repeat:0.2><lora:repeat:0.4>'));
    expect(Array.isArray(after.a.inputs.loras)).toBe(true);
    expect(after.a.inputs.loras.map((x: { custom: string }) => x.custom)).toEqual(['first', 'second']);
  });

  it('does not silently activate disabled entries when applying the displayed list', () => {
    const original = JSON.stringify(fixture());
    const group = inspectWorkflowLoras(original)[0];
    const after = JSON.parse(updateWorkflowLoras(original, group.nodeId, group.tags));
    expect(after['72'].inputs.loras.__value__.map((x: { name: string }) => x.name)).toEqual(['detail']);
  });

  it('accepts LoraManager float-compatible numeric strings mixed with numbers', () => {
    const workflow = { a: { class_type: 'Lora Loader (LoraManager)', inputs: {
      model: ['1', 0], text: '', loras: { __value__: [
        { name: 'detail', strength: '1.00', clipStrength: '0.70', active: true, locked: true },
        { name: 'light', strength: 0.5, clipStrength: '2.00', active: true },
        { name: 'line', strength: ' -0.25 ', active: true },
        { name: 'soft', strength: '1e-2', clipStrength: 0, active: true },
      ] },
    } } };
    const source = JSON.stringify(workflow);
    const group = inspectWorkflowLoras(source)[0];
    expect(group).toMatchObject({ editable: true, count: 4,
      tags: '<lora:detail:1:0.7>\n<lora:light:0.5:2>\n<lora:line:-0.25>\n<lora:soft:0.01:0>' });
    const applied = updateWorkflowLoras(source, 'a', group.tags);
    expect(JSON.parse(applied).a.inputs.loras.__value__[0]).toMatchObject({ strength: 1, clipStrength: 0.7, locked: true });
    expect(updateWorkflowLoras(applied, 'a', group.tags)).toBe(applied);
  });

  it.each(['', '  ', 'NaN', 'Infinity', '-Infinity', '1e999', '0x10', null, true])('rejects invalid LM weight %j in either field', value => {
    for (const field of ['strength', 'clipStrength']) {
      const workflow = fixture();
      Object.assign(workflow['72'].inputs.loras.__value__[0], { [field]: value });
      const source = JSON.stringify(workflow);
      expect(inspectWorkflowLoras(source)[0].editable).toBe(false);
      expect(() => updateWorkflowLoras(source, '72', '<lora:detail:0.7>')).toThrow();
    }
  });

  it('blocks upper-stack input so the field cannot claim to control hidden upstream LoRAs', () => {
    const workflow = fixture();
    Object.assign(workflow['72'].inputs, { lora_stack: ['900', 0] });
    const text = JSON.stringify(workflow);
    expect(inspectWorkflowLoras(text)[0]).toMatchObject({ editable: false, reason: expect.stringContaining('lora_stack') });
    expect(() => updateWorkflowLoras(text, '72', '')).toThrow('lora_stack');
  });

  it.each([['900', 0], { unexpected: [] }, { __value__: [{ active: true, name: 'bad', strength: 'variable' }] }])('rejects dynamic or malformed list shape: %j', loras => {
    const workflow = fixture();
    Object.assign(workflow['72'].inputs, { loras });
    const text = JSON.stringify(workflow);
    expect(inspectWorkflowLoras(text)[0].editable).toBe(false);
    expect(() => updateWorkflowLoras(text, '72', '<lora:detail:1>')).toThrow();
  });

  it('invalid draft cannot partially modify original JSON', () => {
    const source = JSON.stringify(fixture());
    expect(() => updateWorkflowLoras(source, '72', '<lora:new:0.5> invalid')).toThrow();
    expect(inspectWorkflowLoras(source)[0].tags).toBe('<lora:detail:0.7:0.4>');
    expect(() => updateWorkflowLoras(source, 'missing', '')).toThrow('不存在');
  });
});

describe('Power LoRA and unsupported nodes', () => {
  const power = () => ({ x: { class_type: 'Power Lora Loader (rgthree)', inputs: {
    model: ['1', 0], clip: ['1', 1], custom: 'keep',
    lora_2: { on: true, lora: 'style.safetensors', strength: 0.6, strengthTwo: 0.4, note: 'preserve' },
    lora_9: { on: false, lora: 'off.safetensors', strength: 0.8 },
  } }, out: { class_type: 'KSampler', inputs: { model: ['x', 0] } } });

  it('replaces dynamic entries while keeping loader edges and unrelated inputs', () => {
    const source = JSON.stringify(power());
    expect(inspectWorkflowLoras(source)[0]).toMatchObject({ tags: '<lora:style.safetensors:0.6:0.4>', disabledCount: 1 });
    const after = JSON.parse(updateWorkflowLoras(source, 'x', '<lora:style.safetensors:0.8> <lora:detail.safetensors:0.3:0.2>'));
    expect(after.x.inputs).toEqual({ model: ['1', 0], clip: ['1', 1], custom: 'keep',
      lora_1: { on: true, lora: 'style.safetensors', strength: 0.8, note: 'preserve' },
      lora_2: { on: true, lora: 'detail.safetensors', strength: 0.3, strengthTwo: 0.2 } });
    expect(after.out).toEqual(power().out);
    const cleared = updateWorkflowLoras(JSON.stringify(after), 'x', '');
    expect(JSON.parse(cleared).x.inputs).toEqual({ model: ['1', 0], clip: ['1', 1], custom: 'keep' });
    expect(updateWorkflowLoras(cleared, 'x', '')).toBe(cleared);
  });

  it('reports standard/unknown loaders without changing their graph', () => {
    for (const class_type of ['LoraLoader', 'LoraLoaderModelOnly', 'Custom Lora Loader']) {
      const text = JSON.stringify({ '4': { class_type, inputs: { model: ['1', 0], lora_name: 'detail.safetensors' } } });
      expect(inspectWorkflowLoras(text)[0].editable).toBe(false);
      expect(() => updateWorkflowLoras(text, '4', '<lora:detail:1>')).toThrow('暂不支持');
    }
  });

  it('accepts null Power strengthTwo as model-strength fallback and removes it on sync', () => {
    const workflow = power();
    Object.assign(workflow.x.inputs.lora_2, { strengthTwo: null });
    const source = JSON.stringify(workflow);
    const group = inspectWorkflowLoras(source)[0];
    expect(group).toMatchObject({ editable: true, tags: '<lora:style.safetensors:0.6>' });
    const applied = updateWorkflowLoras(source, 'x', group.tags);
    expect(JSON.parse(applied).x.inputs.lora_1).toEqual({ on: true, lora: 'style.safetensors', strength: 0.6, note: 'preserve' });
    expect(updateWorkflowLoras(applied, 'x', group.tags)).toBe(applied);
  });

  it.each(['', '{', 'null', '[]', '{}'])('rejects invalid workflow %s', input => {
    expect(() => inspectWorkflowLoras(input)).toThrow();
  });
});
