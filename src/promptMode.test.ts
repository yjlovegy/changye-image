import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertNaturalPrompt, normalizePromptMode, DEFAULT_KREA2_SPEC } from '@/promptMode';
import { renderWorkflowTemplate } from '@/backends/comfyui';
import { parseImagePlan } from '@/autoTag/protocol';
import { parseImageTagContent, serializeImageTag, containsTagMarkup } from '@/st/imageTagRegex';
import { buildAutoTagMessages, backendPromptSpec } from '@/autoTag/prompt';
import { settings, activeComfyPreset } from '@/state/settings';
import type { STContext } from '@/st/context';

const original = JSON.parse(JSON.stringify(settings));
afterEach(() => { Object.assign(settings, JSON.parse(JSON.stringify(original))); vi.restoreAllMocks(); });
const nl = 'An adult woman sits by a window. Her right hand rests on a closed book on the table.';
const content = { tag: '', nl, negative: '', size: 'portrait' as const, characters: [], promptMode: 'krea2' as const };

describe('Krea2 natural-language pipeline', () => {
  it('keeps unknown and existing workflows in Anima mode until explicitly changed', () => {
    for (const value of [undefined, '', 'flux', 'Krea2', null]) expect(normalizePromptMode(value)).toBe('anima');
    expect(normalizePromptMode('krea2')).toBe('krea2');
  });
  it('accepts nl-only planning only when the captured workflow mode allows it', () => {
    const raw = JSON.stringify({ images: [{ position: 'P1', ...content }], changes: [] });
    const segments = [{ id: 'P1', sourceLine: 0, text: '她坐在窗边。' }];
    expect(parseImagePlan(raw, segments, 1, 1, 'krea2').images[0]).toMatchObject(content);
    expect(() => parseImagePlan(raw, segments, 1, 1, 'anima')).toThrow('tag 不能为空');
    expect(() => parseImagePlan(raw.replace(nl, 'woman, window'), segments, 1, 1, 'krea2')).toThrow('完整英文');
  });
  it('serializes mode as metadata, without leaking it into prompt text', () => {
    const parsed = parseImageTagContent(serializeImageTag(content));
    expect(parsed).toEqual(content);
    expect(parseImageTagContent('<bbi_image>old tags<nl>Old description.</nl></bbi_image>')).not.toHaveProperty('promptMode');
    expect(containsTagMarkup('<prompt_mode>krea2</prompt_mode>')).toBe(true);
  });
  it.each(['%prompt%', '%nl%', '%prompt%\n%nl%'])('fills %s once, preserving fixed words and negatives', marker => {
    const graph = JSON.stringify({ 1: { class_type: 'CLIPTextEncode', inputs: { text: marker } }, 2: { class_type: 'CLIPTextEncode', inputs: { text: '%negative_prompt%' } } });
    const result = renderWorkflowTemplate(graph, { prompt: 'old, duplicate tags', nl, promptMode: 'krea2', negative_prompt: 'extra people' }, { positivePrefix: 'Illustration.', positiveSuffix: 'Warm palette.', negative: 'watermark' });
    const positive = (result['1'].inputs as { text: string }).text;
    expect(positive.split(nl)).toHaveLength(2);
    expect(positive).not.toContain('duplicate tags');
    expect(positive).toContain('Illustration.');
    expect(positive).toContain('Warm palette.');
    expect((result['2'].inputs as { text: string }).text).toContain('extra people');
    expect((result['2'].inputs as { text: string }).text).toContain('watermark');
  });
  it('populates separate positive encoders without leaving either empty', () => {
    const graph = JSON.stringify({ 1: { class_type: 'CLIPTextEncode', inputs: { text: '%prompt%' } }, 2: { class_type: 'CLIPTextEncode', inputs: { text: '%nl%' } } });
    const result = renderWorkflowTemplate(graph, { prompt: '', nl, promptMode: 'krea2' });
    expect(result['1'].inputs).toEqual({ text: nl });
    expect(result['2'].inputs).toEqual({ text: nl });
  });
  it('leaves Anima separate tag/prose rendering unchanged', () => {
    const graph = JSON.stringify({ 1: { class_type: 'CLIPTextEncode', inputs: { text: '%prompt%\n%nl%' } } });
    expect(renderWorkflowTemplate(graph, { prompt: '1girl', nl, promptMode: 'anima' })['1'].inputs).toEqual({ text: '1girl\n' + nl });
  });
  it('selects the matching custom spec and internal checklist without legacy mixed requirements', async () => {
    settings.defaultBackend = 'comfyui';
    activeComfyPreset().promptMode = 'krea2';
    settings.autoTag.prompts = { ...settings.autoTag.prompts, jailbreak: 'Fixture system', comfySpec: 'ANIMA_CUSTOM', comfyThinking: 'ANIMA_CHECK', krea2Spec: 'KREA_CUSTOM', krea2Thinking: 'KREA_CHECK' };
    const context = { chat: [{ mes: '她坐在窗边。', is_user: false, name: '角色' }], name1: '用户', name2: '角色', getCurrentChatId: () => 'fixture' } as STContext;
    const messages = await buildAutoTagMessages(context, 0, settings.autoTag, null, { segments: [{ id: 'P1', sourceLine: 0, text: '她坐在窗边。' }], promptText: '她坐在窗边。 ⟦P1⟧' }, null, false, 'krea2');
    const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
    expect(system).toContain('KREA_CUSTOM'); expect(system).toContain('KREA_CHECK');
    expect(system).not.toContain('ANIMA_CUSTOM'); expect(system).not.toContain('ANIMA_CHECK');
    expect(system).not.toContain('tag 与 nl 必须同时非空');
    expect(system).not.toContain('每张图必须同时交付核心 tag');
    expect(system).not.toContain('核心 tag 必须照抄');
    const task = messages.find(m => m.content.includes('你是严谨的剧情画面规划'))!.content;
    const example = JSON.parse(task.split('\n').find(line => line.startsWith('{"images":'))!).images[0];
    expect(example.tag).toBe(''); expect(() => assertNaturalPrompt(example)).not.toThrow();
    expect(backendPromptSpec(settings.autoTag, true, false, 'comfyui', 'anima')).toContain('ANIMA_CUSTOM');
    settings.autoTag.prompts.krea2Spec = '';
    expect(backendPromptSpec(settings.autoTag, true, false, 'comfyui', 'krea2')).toBe(DEFAULT_KREA2_SPEC);
  });
});
