import { extractCharRefNames } from '@/autoTag/charAnchors';
import type { ImageCharacterPrompt } from '@/autoTag/protocol';

/** Shared final contract, after user-customized backend rules. Not a claim of semantic validation. */
export function facialDetailContract(options: {
  mixed: boolean;
  characterPrompts: boolean;
  allowDesign: boolean;
}): string {
  const target = options.characterPrompts ? '各角色自己的 characters[].tag / characters[].nl' : 'tag / nl';
  return `【脸型与五官逐项要求】
本段优先于旧规范中的“细微五官只写自然语言”“只能用标准标签”“为精简省略五官”。先按当前动作确定身体姿态和镜头，再确定是否露脸及可见范围，逐人检查五组稳定结构：
1. 脸型 face：整体形状，以及有辨识度的下颌、下巴或颧颊轮廓，不能只有 beautiful face。
2. 眉形 eyebrows：粗细、弧度或走向，不能用皱眉等临时神态代替眉形。
3. 眼型 eyeShape：眼睛形状、眼角走向、眼睑或睫毛特征；eyes 中的瞳色仍保留，只有 blue eyes 之类瞳色不等于写了眼型。旧 eyes/raw/nl 已明确的眼型优先复用，不重复发明。
4. 鼻形 nose：鼻梁走向、轮廓或鼻尖形态，选择少量能区分人物的特征。
5. 唇形 mouth：厚薄、上下唇比例、唇峰或唇部轮廓，不能用 smile/open mouth 代替唇形。
${options.mixed
    ? `${target} 必须分别包含这五组中已确定且镜头可见的结构：tag 保留简短具体的英文视觉词组，不存在标准 Danbooru 标签时照样用准确的短英文描述；nl 在建立姿态与空间关系后，将同一组特征组织为该人物的一至数句完整英文面部描写，并融合当前眉眼嘴部神态和视线。不能把脸型鼻唇全塞进 nl 而 tag 只剩头发瞳色，也不能只在档案或内部检查中写过就算完成。`
    : '当前后端只消费 tag：五组中已确定且可见的面部结构必须保留在 tag 中，可用准确的短英文视觉词组，不强行加入不受支持的 nl。'}
正面或清晰的三分之二侧脸主体应交代五组；纯侧脸写实际可见的轮廓与五官。背影、面具/遮挡、脸在画外、难以辨认五官的远景以及无人画面，不强塞不可见部位，不改变剧情姿势、构图或种族来展示人脸。非人角色按已有面部结构描写，不强加人类鼻唇。
已有固定设定、手填字段以及当前草稿已经明确的结构优先。${options.allowDesign
    ? '用户允许对确实缺失的脸型、眉形、眼型、鼻形和唇形做相容的补全设计：先从已有字段、旧外貌文字和提供的资料找细节，仍缺失时才按已知外貌设计少量自然、一致的结构；不要所有人物套同一张脸，不强制美型。设计不得更改已有发色、瞳色、年龄、性别、种族或标志特征，不能声称设计细节是原文事实。档案保存规则由当前任务决定。'
    : '未提供的固定结构不擅自创造，只保留已有且可见的细节。'}
多人画面逐人绑定这些特征，不把眉眼鼻唇散放为公共属性；${options.characterPrompts ? 'NAI 的 Base 不放个人五官。' : '用稳定的区分性称谓承接同一人物。'}空间不足时先删重复形容和次要背景，不先删清晰可见的面部结构。
输出前逐人比对：脸型、眉形、眼型、鼻形、唇形分别是否已进入实际生图字段；遗漏可见项就补上，镜头不可见项则省略。直接写完整外貌，禁止 @角色名 占位符，不能依赖旧自然语言缓存替换。示例的五官只是输出形状参考，不是所有角色的默认长相。`;
}

export class ExplicitAppearanceValidationError extends Error {
  constructor(label: string) {
    super(`${label}仍含 @角色名 占位符：请在 tag 和英文描述中直接写全该人物可见的脸型、眉眼鼻唇及外貌，不能用旧档案自然语言代替`);
    this.name = 'ExplicitAppearanceValidationError';
  }
}

export const EXPLICIT_APPEARANCE_RETRY_INSTRUCTION = '上一轮输出仍有 @角色名 占位符，未通过验收。本轮请在实际 tag 和英文 nl 中直接写全每个人可见的脸型、眉形、眼型、鼻形、唇形及其它外貌；复用已提供的固定字段，不能依赖旧自然语言缓存。保持原选定画面与 JSON 协议，只交付修正后的完整 JSON。';

/** New AI output cannot fall back to an old, incomplete profile nl. Legacy saved tags remain readable. */
export function assertExplicitAppearance(
  content: { tag: string; nl: string; characters?: ImageCharacterPrompt[] },
  label = '图片',
): void {
  const text = [content.tag, content.nl, ...(content.characters ?? []).flatMap(character => [character.tag, character.nl])];
  if (text.some(value => extractCharRefNames(value).length > 0)) {
    throw new ExplicitAppearanceValidationError(label);
  }
}
