import { readFileAsDataUrl } from './imageFile';
import { deleteUserImage, uploadUserImage } from './images';

export const WORKFLOW_EXAMPLE_FOLDER = '长夜的绘图器_工作流示例';
interface ExampleOwner { id: string; exampleImage?: string }
type Owners = () => ExampleOwner[];
const pending = new Set<ExampleOwner>();

/** Only this feature's own local image paths may be displayed, downloaded or deleted. */
export function normalizeWorkflowExample(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  let path: string;
  try { path = decodeURIComponent(value); } catch { return undefined; }
  const prefix = `/user/images/${WORKFLOW_EXAMPLE_FOLDER}/`;
  if (!path.startsWith('/')) path = '/' + path;
  if (!path.startsWith(prefix) || !/^wfimg_[a-zA-Z0-9_-]+\.(png|jpg|webp)$/.test(path.slice(prefix.length))) return undefined;
  return path;
}

/** Shared by workflow copies: never delete a file still referenced by another workflow. */
export async function cleanUnusedWorkflowExample(path: unknown, owners: Owners): Promise<boolean> {
  const safe = normalizeWorkflowExample(path);
  if (!safe || owners().some(owner => normalizeWorkflowExample(owner.exampleImage) === safe)) return true;
  try { await deleteUserImage(safe); return true; } catch { return false; }
}

export async function setWorkflowExample(target: ExampleOwner, file: File, owners: Owners): Promise<boolean> {
  if (pending.has(target)) throw new Error('该工作流的示例图正在处理，请稍后再试');
  if (!owners().includes(target)) throw new Error('目标工作流已删除，请重新选择');
  pending.add(target);
  try {
    const formats: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
    const format = formats[file.type];
    if (!format || !file.size || file.size > 20 * 1024 * 1024) throw new Error('请选择不超过 20 MB 的 PNG、JPG 或 WebP 图片');
    const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    const signature = format === 'png' ? [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v)
      : format === 'jpg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF' && new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP';
    if (!signature) throw new Error('图片内容与文件格式不符，请重新选择');
    const data = await readFileAsDataUrl(file);
    const image = new Image();
    image.src = data;
    try { await image.decode(); } catch { throw new Error('无法读取这张图片，请重新选择'); }
    if (!owners().includes(target)) throw new Error('目标工作流已删除，请重新选择');
    // New filename per upload prevents cache staleness and keeps the old image intact on failure.
    const path = normalizeWorkflowExample(await uploadUserImage(
      WORKFLOW_EXAMPLE_FOLDER, `wfimg_${crypto.randomUUID()}`, data.split(',')[1], format,
    ));
    if (!path) throw new Error('服务端返回的图片路径无效');
    if (!owners().includes(target)) {
      const cleaned = await cleanUnusedWorkflowExample(path, owners);
      throw new Error(cleaned ? '目标工作流已删除，上传已取消' : '目标工作流已删除，上传文件需在示例图目录手动清理');
    }
    const previous = target.exampleImage;
    target.exampleImage = path;
    return await cleanUnusedWorkflowExample(previous, owners);
  } finally { pending.delete(target); }
}

export async function removeWorkflowExample(target: ExampleOwner, owners: Owners): Promise<boolean> {
  if (pending.has(target)) throw new Error('该工作流的示例图正在处理，请稍后再试');
  pending.add(target);
  try {
    const previous = target.exampleImage;
    target.exampleImage = undefined;
    return await cleanUnusedWorkflowExample(previous, owners);
  } finally { pending.delete(target); }
}
