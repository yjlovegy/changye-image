/** Anima guidance only: no trimming of generated text or mutation of character profiles. */
export const ANIMA_CONTENT_RULE = 'tag 与 nl 必须同时非空。tag 用简短英文视觉关键词保留人数、一个景别、身份锚点、主要服装、核心姿态和必要场景；nl 用连贯英文句子补充人物归属、动作、物件关系与构图。两者信息互补且一致，允许为明确人物归属重复少量关键特征，不逐项复述全部外貌。不设机械词数，不截断句子或关键关系。';

export function animaVisualContract(allowDesign: boolean): string {
  return `【Anima 景别与描述取舍】
本段统一实际生图字段的写法，优先于旧自定义规范、思维链、档案说明和示例中“每图展开全部五官”“tag 与 nl 分别包含全部外貌”的要求；保留不冲突的自定义画风、角色设定和用户明确要求的细节。
${ANIMA_CONTENT_RULE}
角色档案完整保留，实际生图描述按景别取舍；未在本图提及的字段不表示删除、覆盖或重新设计档案。选中的特征须准确复用已有值，不擅自改变发色、瞳色、种族或年龄，不能用 beautiful face 等泛称替代辨识特征。
- 全身、远景、多人：优先发型发色、主要衣着、标志配饰与最有辨识度且能看清的面部特征，不逐项展开睫毛、鼻尖、唇峰等细节。
- 半身：在上述基础上选择可辨认的主要脸型、眉眼、神态和视线，不为凑齐五组结构列清单。
- 面部特写：按实际可见范围展开脸型、眉眼、鼻形、唇形等差异，已有细节准确复用；仍不要求在 tag 与 nl 两边逐项重复。
- 标志性的疤痕、异色瞳、种族结构等不可机械删掉；按镜头可见性和辨识需要保留。背影、面具、遮挡、画外和难以辨认五官的远景省略不可见细节；非人角色不强加人类五官。不能为了展示五官改变已确定的姿势、景别或人物身份。
多人用简短且能区分的称谓分组描述，同发色时用已有衣着或画面位置区分，不发明新特征。不能把衣着、配饰、肤色和物件散成无主关键词，也不在每个细节后机械重复 on + 同一整串称谓。nl 只保留明确归属所需的重复，连续句用无歧义的指代承接。
档案补全和本图描述分开处理：${allowDesign ? '仅在当前任务允许建档或补空时，才按已有资料对缺失的 face/eyebrows/eyeShape/nose/mouth 做相容补全设计，不能声称设计细节是原文事实；已有非空字段和锁定条目不改。补全得到的细节不必全部进入本图，选段、重写、按意见修改服从各自的档案写入限制。' : '未提供的固定结构不擅自创造；只复用已有资料，保持当前任务的档案写入限制。'}
输出前删除重复特征、同义修饰和无关背景，核对人数、身份、服装连续性、物件归属及同一瞬间的状态；不能为缩短丢掉用户明确要求或关键关系，也不能以全文截断代替取舍。保持原 JSON 协议，不输出检查表或推理过程。`;
}

// Neutral examples teach different detail levels instead of copying a complete profile into every image.
export const ANIMA_EXAMPLES = {
  single: {
    tag: '1girl, full body, adult woman, long silver hair, white dress, standing, holding book, art gallery, side lighting',
    nl: 'An adult woman with long silver hair stands beside a gallery window in a white dress. She holds a closed book at waist level with both hands and looks toward someone outside the frame. The view includes her whole figure, with framed paintings behind her.',
  },
  pair: {
    tag: '1boy, 1girl, full body, adult man with short black hair and white shirt, adult woman with long brown hair and blue dress, glasses on woman, library, daylight',
    nl: 'An adult man in a white shirt stands on the left, offering a closed book to an adult woman on the right. The woman in a blue dress and glasses reaches out to receive it. Both figures are visible from head to toe, with library shelves behind them.',
  },
  portrait: {
    tag: '1girl, close-up, adult woman, silver hair, red eyes, angular face, neutral expression',
    nl: 'A close-up portrait frames an adult woman with silver hair and red eyes. Straight brows sit above narrow eyes; her nose has a gently convex bridge and her lips are thin. Soft side light reveals her angular facial contour.',
  },
};
