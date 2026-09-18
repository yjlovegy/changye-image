import type { ImageCharacterPrompt } from '@/autoTag/protocol';

/** 单输入后端完整保留核心标签与自然语言；独立双输入工作流不调用此合并。 */
export function combinePromptParts(tag: string, nl = ''): string {
  const tags = tag.trim();
  const description = nl.trim();
  if (!description || description === tags) return tags;
  return [tags, description].filter(Boolean).join('\n');
}

/** 只校验可证明的输出形状；细节是否有据、归属是否准确由规划规则约束。 */
export function assertMixedPrompt(
  content: { tag: string; nl: string; characters?: ImageCharacterPrompt[] },
  label = '图片',
): void {
  const check = (tag: string, nl: string, part: string) => {
    if (!tag.trim()) throw new Error(`${part}缺少核心 tag`);
    if (!nl.trim() || !/[A-Za-z]{2,}/.test(nl) || !/[.!?](?:\s|$)/.test(nl.trim())) {
      throw new Error(`${part}缺少完整英文自然语言描述：nl 必须包含英文句子和句末标点，不能留空或只写标签`);
    }
  };
  check(content.tag, content.nl, label);
  for (const character of content.characters ?? []) check(character.tag, character.nl, `${label}角色 ${character.name} `);
}
