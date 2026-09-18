import { afterEach, describe, expect, it, vi } from 'vitest';
import { injectPose, POSE_ADAPTER, preparePose, uploadPose, validatePose, type ComfyPose } from './comfyPose';
import type { ComfyWorkflow } from './comfyui';
import { parseImageTagContent, serializeImageTag } from '@/st/imageTagRegex';

const pose: ComfyPose = { enabled: true, server: 'http://127.0.0.1:8188', image: 'baibai_pose/test.png', strength: 1, kind: 'skeleton' };
const graph = (): ComfyWorkflow => ({
  '1': { class_type: 'UNETLoader', inputs: { unet_name: 'anima_baseV10.safetensors' } },
  '2': { class_type: 'LoraLoaderModelOnly', inputs: { model: ['1', 0], lora_name: 'style.safetensors', strength_model: 0.7 } },
  '3': { class_type: 'EmptyLatentImage', inputs: { width: ['7', 0], height: ['7', 1], batch_size: 1 } },
  '4': { class_type: 'KSampler', inputs: { model: ['2', 0], latent_image: ['3', 0], seed: 123 } },
  '5': { class_type: 'VAELoader', inputs: { vae_name: 'qwen_image_vae.safetensors' } },
  '6': { class_type: 'VAEDecode', inputs: { samples: ['4', 0], vae: ['5', 0] } },
  '7': { class_type: 'ResolutionPreset', inputs: { resolution_json: '{"width":768,"height":1024}' } },
});
afterEach(() => vi.unstubAllGlobals());
describe('per-image Anima pose', () => {
  it('inserts after existing style LoRA, shares real VAE and linked dimensions without editing the saved graph', () => {
    const original = graph(); const before = JSON.stringify(original);
    const result = injectPose(original, pose);
    expect(JSON.stringify(original)).toBe(before);
    const nodes = Object.values(result);
    expect(nodes.find(n => n.class_type === 'ImageScale')?.inputs).toMatchObject({ width: ['7', 0], height: ['7', 1], crop: 'disabled' });
    expect(nodes.find(n => n.class_type === 'VAEEncode')?.inputs).toMatchObject({ vae: ['5', 0] });
    expect(nodes.find(n => (n.inputs as any).lora_name === POSE_ADAPTER)?.inputs).toMatchObject({ model: ['2', 0], strength_model: 1 });
    expect(result['4'].inputs).toMatchObject({ latent_image: ['3', 0], seed: 123 });
    expect((result['4'].inputs as any).model).not.toEqual(['2', 0]);
    expect(nodes.some(n => n.class_type === 'DWPreprocessor')).toBe(false);
  });
  it('only detects body for reference photos', () => {
    const nodes = Object.values(injectPose(graph(), { ...pose, kind: 'photo' }));
    expect(nodes.find(n => n.class_type === 'DWPreprocessor')?.inputs).toMatchObject({ detect_hand: 'disable', detect_face: 'disable', detect_body: 'enable' });
  });
  it.each([{ ...pose, enabled: false }, { ...pose, strength: 0 }])('off or zero leaves the exact original graph', p => {
    const g = graph(); expect(injectPose(g, p)).toBe(g);
  });
  it('refuses incompatible, ambiguous and already patched graphs', () => {
    const wrong = graph(); (wrong['1'].inputs as any).unet_name = 'flux.safetensors';
    expect(() => injectPose(wrong, pose)).toThrow('Anima');
    const multi = graph(); multi['8'] = multi['4']; expect(() => injectPose(multi, pose)).toThrow('一个 KSampler');
    const duplicate = graph(); duplicate['8'] = { class_type: 'AnimaControlApply', inputs: {} }; expect(() => injectPose(duplicate, pose)).toThrow('重复');
    const lora = graph(); (lora['2'].inputs as any).lora_name = POSE_ADAPTER; expect(() => injectPose(lora, pose)).toThrow('普通 LoRA');
    const img2img = graph(); img2img['3'].class_type = 'VAEEncode'; expect(() => injectPose(img2img, pose)).toThrow('文生图');
  });
  it.each([{ ...pose, image: '../test.png' }, { ...pose, server: 'javascript:alert(1)' }, { ...pose, strength: NaN }, { ...pose, strength: 3 }])('rejects unsafe or invalid saved controls', p => expect(() => validatePose(p)).toThrow());
  it('roundtrips control separately from text, leaves other images unchanged, and flags broken controls', () => {
    const c = { tag: 'adult person', nl: 'A person waves.', negative: 'extra limbs', characters: [], size: 'portrait' as const, pose };
    expect(parseImageTagContent(serializeImageTag(c))).toEqual(c);
    expect(parseImageTagContent('<bbi_image>landscape</bbi_image>').pose).toBeUndefined();
    const invalid = parseImageTagContent('<bbi_image>adult person<pose>{broken}</pose></bbi_image>');
    expect(invalid.tag).toBe('adult person'); expect(invalid.poseInvalid).toBe(true);
  });
  it('blocks wrong servers and missing nodes before queueing', async () => {
    const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response('{}', { status: 200 })); vi.stubGlobal('fetch', fetch);
    await expect(preparePose(graph(), pose, 'http://other:8188')).rejects.toThrow('另一个');
    expect(fetch).not.toHaveBeenCalled();
    await expect(preparePose(graph(), pose, pose.server)).rejects.toThrow('缺少');
    expect(fetch.mock.calls.every(c => !String(c[0]).endsWith('/prompt'))).toBe(true);
  });
  it('uploads unique file to isolated input folder and validates returned path', async () => {
    const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ name: 'unique.png', subfolder: 'baibai_pose', type: 'input' })));
    vi.stubGlobal('fetch', fetch);
    const result = await uploadPose(pose.server, new File(['png'], 'ref.png', { type: 'image/png' }));
    expect(result.image).toBe('baibai_pose/unique.png');
    expect(fetch.mock.calls[0][0]).toBe(pose.server + '/upload/image');
    await expect(uploadPose(pose.server, new File(['bad'], 'ref.svg', { type: 'image/svg+xml' }))).rejects.toThrow('PNG');
  });
});
