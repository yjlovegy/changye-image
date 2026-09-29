/** Shared by extraction, correction, generation and revision. */
export const ACCESSORY_EVIDENCE_RULE = `【配饰必须有依据】
仅使用明确属于该角色、且角色资料或当前剧情明确写出的配饰。没有描述发卡、发夹、发簪、蝴蝶结、头饰、耳饰、项链等，就不得为了美观、补全或匹配风格自行添加；发型不意味着配有发饰。未提及不等于允许设计，字段可以为空。明确摘下或未佩戴的配饰不得沿用旧设定。本规则同时约束 TAG、自然语言和角色建档，不能在另一种表达里偷偷补回。`;

/** Reject common accessory inventions whose supporting quote contains no such object. */
export function hasUnsupportedAccessory(value: string, quote: string): boolean {
  const types: Array<[RegExp, RegExp]> = [
    [/hair[ _-]?(?:clip|pin|barrette)|barrette/i, /发[卡夹簪钗]|簪子|钗子|hair[ _-]?(?:clip|pin)|barrette/i],
    [/hair[ _-]?(?:bow|ribbon)|ribbon|\bbow\b/i, /蝴蝶结|缎带|丝带|发带|ribbon|\bbow\b/i],
    [/earrings?|ear[ _-]?studs?/i, /耳[环饰钉坠]|earrings?|ear[ _-]?studs?/i],
    [/necklace|choker/i, /项链|颈链|颈饰|颈圈|necklace|choker/i],
    [/glasses|spectacles/i, /眼镜|glasses|spectacles/i],
    [/headband|tiara|crown/i, /发箍|头箍|冠|headband|tiara|crown/i],
  ];
  return types.some(([output, proof]) => output.test(value) && !proof.test(quote));
}
