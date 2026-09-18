import type { ComfyWorkflow } from '@/backends/comfyui';

export interface ComfyPose {
  enabled: boolean;
  image: string;
  server: string;
  strength: number;
  kind: 'photo' | 'skeleton';
}
export const POSE_ADAPTER = 'anima_pose_preview2.safetensors';
export function poseServer(url: string): string {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('姿态控制需要不含凭据、查询参数的 HTTP ComfyUI 地址');
  }
  return parsed.href.replace(/\/+$/, '');
}
export function validatePose(value: unknown): ComfyPose {
  const p = value as ComfyPose;
  if (!p || typeof p.enabled !== 'boolean' || !['photo', 'skeleton'].includes(p.kind)
    || typeof p.image !== 'string' || !/^baibai_pose\/[a-zA-Z0-9_-]+\.(png|jpg|webp)$/.test(p.image)
    || !Number.isFinite(p.strength) || p.strength < 0 || p.strength > 2 || typeof p.server !== 'string') {
    throw new Error('姿态参考设置无效，请重新选择参考图');
  }
  return { enabled: p.enabled, image: p.image, server: poseServer(p.server), strength: p.strength, kind: p.kind };
}
export function poseImageUrl(pose: ComfyPose): string {
  const p = validatePose(pose);
  const query = new URLSearchParams({ filename: p.image.split('/')[1], subfolder: 'baibai_pose', type: 'input' });
  return `${p.server}/view?${query}`;
}

/** Inserts a request-local branch. Saved workflows and existing LoRA chains stay untouched. */
export function injectPose(workflow: ComfyWorkflow, pose: ComfyPose): ComfyWorkflow {
  const p = validatePose(pose);
  if (!p.enabled || p.strength === 0) return workflow;
  const nodes = Object.entries(workflow);
  const samplers = nodes.filter(([, n]) => n.class_type === 'KSampler' || n.class_type === 'KSamplerAdvanced');
  if (samplers.length !== 1) throw new Error('姿态控制目前支持一个 KSampler 的工作流；请为多阶段采样另建单阶段工作流');
  if (nodes.some(([, n]) => n.class_type === 'AnimaControlApply')) throw new Error('工作流已有 AnimaControlApply，请使用原工作流控制，避免重复叠加');
  const [samplerId, sampler] = samplers[0];
  const inputs = sampler.inputs as Record<string, unknown>;
  const link = (v: unknown): v is [string, number] => Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && Number.isInteger(v[1]);
  if (!link(inputs.model) || !link(inputs.latent_image)) throw new Error('无法识别采样器的模型或 latent 连线');
  const visited = new Set<string>();
  function ancestors(id: string): Array<Record<string, unknown>> {
    if (visited.has(id)) return [];
    visited.add(id);
    const node = workflow[id];
    if (!node) return [];
    return [node, ...Object.values((node.inputs ?? {}) as object).flatMap(v => link(v) ? ancestors(v[0]) : [])];
  }
  const upstream = ancestors(inputs.model[0]);
  if (!upstream.some(n => n.class_type === 'UNETLoader' && /anima/i.test(String((n.inputs as Record<string, unknown>).unet_name)))) {
    throw new Error('该姿态适配器仅支持 Anima 工作流；未找到连接到采样器的 Anima UNETLoader');
  }
  if (upstream.some(n => JSON.stringify(n.inputs).includes(POSE_ADAPTER))) throw new Error('模型链已加载姿态适配器 LoRA，请先从普通 LoRA 列表移除它，交给姿态控制统一加载');
  const latent = workflow[inputs.latent_image[0]];
  if (!latent || !['EmptyLatentImage', 'EmptySD3LatentImage'].includes(String(latent.class_type))) {
    throw new Error('姿态控制目前需要直接连接 EmptyLatentImage / EmptySD3LatentImage 的文生图采样器');
  }
  const dimensions = latent.inputs as Record<string, unknown>;
  const validDimension = (v: unknown) => link(v) || typeof v === 'number' && Number.isInteger(v) && v >= 64;
  if (!validDimension(dimensions.width) || !validDimension(dimensions.height)) throw new Error('无法取得工作流实际画幅尺寸');
  const decoders = nodes.filter(([, n]) => ['VAEDecode', 'VAEDecodeTiled'].includes(String(n.class_type))
    && link((n.inputs as Record<string, unknown>).samples) && ((n.inputs as Record<string, unknown>).samples as [string, number])[0] === samplerId);
  const vae = (decoders[0]?.[1].inputs as Record<string, unknown> | undefined)?.vae;
  if (!decoders.length || !link(vae) || decoders.some(([, n]) => JSON.stringify((n.inputs as Record<string, unknown>).vae) !== JSON.stringify(vae))) {
    throw new Error('无法确定该采样器对应的唯一 VAE 解码连线');
  }
  const out = JSON.parse(JSON.stringify(workflow)) as ComfyWorkflow;
  let next = 1;
  const add = (class_type: string, fields: Record<string, unknown>): [string, number] => {
    while (out[String(next)]) next++;
    const id = String(next++);
    out[id] = { class_type, inputs: fields, _meta: { title: `柏宝绘姿态 · ${class_type}` } };
    return [id, 0];
  };
  let image = add('LoadImage', { image: p.image });
  if (p.kind === 'photo') image = add('DWPreprocessor', {
    image, detect_hand: 'disable', detect_body: 'enable', detect_face: 'disable', resolution: 768,
    bbox_detector: 'yolox_l.onnx', pose_estimator: 'dw-ll_ucoco_384.onnx', scale_stick_for_xinsr_cn: 'disable',
  });
  // Match the actual latent dimensions, including linked dimension nodes, not UI defaults.
  image = add('ImageScale', { image, width: dimensions.width, height: dimensions.height, upscale_method: 'bilinear', crop: 'disabled' });
  const control = add('VAEEncode', { pixels: image, vae });
  const model = add('LoraLoaderModelOnly', { model: inputs.model, lora_name: POSE_ADAPTER, strength_model: 1 });
  const applied = add('AnimaControlApply', { model, control_latent: control, control_embedder_path: POSE_ADAPTER, strength: p.strength });
  (out[samplerId].inputs as Record<string, unknown>).model = applied;
  return out;
}

async function poseFetch(url: string, init?: RequestInit): Promise<Response> {
  try {
    const response = await fetch(url, init);
    if (!response.ok) throw new Error(`姿态参考请求失败 (${response.status})`);
    return response;
  } catch (error) {
    if (error instanceof TypeError) throw new Error('姿态控制需要浏览器直连 ComfyUI。请检查服务地址及 CORS；酒馆当前转发接口不支持参考图上传');
    throw error;
  }
}
export async function uploadPose(url: string, file: File, signal?: AbortSignal): Promise<ComfyPose> {
  const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[file.type];
  if (!ext || file.size > 10 * 1024 * 1024 || !file.size) throw new Error('请选择不超过 10 MB 的 PNG、JPG 或 WebP 参考图');
  const server = poseServer(url);
  const form = new FormData();
  const id = crypto.randomUUID?.() ?? Array.from(crypto.getRandomValues(new Uint8Array(16)), x => x.toString(16).padStart(2, '0')).join('');
  form.append('image', file, `${id}.${ext}`);
  form.append('type', 'input');
  form.append('subfolder', 'baibai_pose');
  form.append('overwrite', 'false');
  const response = await poseFetch(`${server}/upload/image`, { method: 'POST', body: form, signal });
  const data = await response.json();
  if (data.type !== 'input' || data.subfolder !== 'baibai_pose') throw new Error('ComfyUI 返回的参考图目录不正确');
  return validatePose({ enabled: true, image: `${data.subfolder}/${data.name}`, server, strength: 1, kind: 'photo' });
}
export async function preparePose(workflow: ComfyWorkflow, pose: ComfyPose, url: string, signal?: AbortSignal): Promise<ComfyWorkflow> {
  const p = validatePose(pose);
  if (!p.enabled || p.strength === 0) return workflow;
  if (p.server !== poseServer(url)) throw new Error('参考图属于另一个 ComfyUI 服务，请在当前服务重新上传');
  const result = injectPose(workflow, p);
  const required = ['AnimaControlApply', 'LoraLoaderModelOnly', 'LoadImage', 'ImageScale', 'VAEEncode', ...(p.kind === 'photo' ? ['DWPreprocessor'] : [])];
  await Promise.all(required.map(async name => {
    const info = await (await poseFetch(`${p.server}/object_info/${name}`, { signal })).json();
    if (!info[name]) throw new Error(`ComfyUI 缺少 ${name} 节点，请安装并重启后重试`);
    if (name === 'LoraLoaderModelOnly' && !info[name].input?.required?.lora_name?.[0]?.includes(POSE_ADAPTER)) {
      throw new Error(`ComfyUI 未找到 ${POSE_ADAPTER}，请放入 models/loras`);
    }
  }));
  // Check the exact stored reference before queueing an expensive generation.
  const image = await poseFetch(poseImageUrl(p), { signal });
  await image.body?.cancel();
  return result;
}
