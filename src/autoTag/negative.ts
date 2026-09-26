import { templateSupportsNegative } from '@/backends/comfyTemplates';
import { getWorkflowPlaceholders } from '@/backends/comfyui';
import type { ComfyWorkflowPreset } from '@/state/settings';

/** 提示词协议和响应验收共用的能力判断；调用方在请求开始时保存结果。 */
export function supportsSceneNegative(
  backend: string,
  preset?: Pick<ComfyWorkflowPreset, 'mode' | 'simple' | 'workflow' | 'negativeEnabled' | 'generateNegative'> | null,
): boolean {
  if (backend !== 'comfyui' || !preset) return false;
  if (preset.generateNegative === false) return false;
  if (preset.mode === 'simple') return templateSupportsNegative(preset.simple.template);
  if (!preset.workflow.trim()) return false;
  try {
    return getWorkflowPlaceholders(preset.workflow).includes('negative_prompt');
  } catch {
    // 无效工作流由渠道配置校验提示，不能凭字符串误判出负面输入。
    return false;
  }
}

export class SceneNegativeValidationError extends Error {
  constructor(label: string) {
    super(`${label}缺少本画面负面提示词：当前工作流要求 negative 包含非空的英文场景负面短词，不能只填分隔符或 none/null 等占位`);
    this.name = 'SceneNegativeValidationError';
  }
}

/** 只验证有实际内容，不凭机械比词判定语义冲突，也不自动编造负面词。 */
export function assertSceneNegative(text: string | undefined, label = '图片 '): void {
  const value = (text ?? '').trim();
  const words = value.replace(/^[\s,，;；|.。:：()[\]{}"'`_-]+|[\s,，;；|.。:：()[\]{}"'`_-]+$/g, '').trim();
  const terms = words.split(/[,，;；|\n]+/).map(term => term.trim()).filter(Boolean);
  const hasContent = terms.some(term => /[a-z]/i.test(term) && !/^(?:none|null|undefined|n\s*\/\s*a|no\s+negatives?)$/i.test(term));
  if (!hasContent) {
    throw new SceneNegativeValidationError(label);
  }
}

export const SCENE_NEGATIVE_RETRY_INSTRUCTION = '【本次输出修正】上一轮未提供有效的本画面 negative。请重新输出完整 JSON，每张图的 negative 必须填写与该图人数、外貌一致性、动作或构图相关的英文场景负面短词，不能省略、留空、只填标点或 none/null；不要用通用质量词代替。逐项确认不否定正文和本图 tag/nl 已成立的内容，不为填写负面词改动场景事实。只输出最终 JSON。';
