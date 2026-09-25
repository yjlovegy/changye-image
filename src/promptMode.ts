/** Stored separately from encoder type: model loading and prompt writing are independent. */
export type PromptMode = 'anima' | 'krea2';
export const PROMPT_MODE_OPTIONS = [
  { value: 'anima', label: 'Anima · 核心标签＋英文描述' },
  { value: 'krea2', label: 'Krea2 · 自然语言描述' },
];
export function normalizePromptMode(value: unknown): PromptMode {
  return value === 'krea2' ? 'krea2' : 'anima';
}

// Adapted to the extension JSON contract, not the upstream plain-paragraph response format.
// Sources: github.com/krea-ai/krea-2/blob/main/docs/{prompting.md,expansion.txt}
export const DEFAULT_KREA2_SPEC = `【Krea2 自然语言绘图规范】
使用连贯、具体的英文自然语言描述一个可见瞬间。先说明主体、画面范围和关键动作，再补充人物外貌、服装、神态、环境与光线。把每个人的特征和动作放在一起，用稳定称谓承接，明确相对位置、动作归属和接触点。
忠实保留剧情与用户已指定的主体、动作、颜色、物品、空间关系及媒介。指定插画就保留插画，指定摄影就保留摄影；Krea2 模式不代表必须写实。不要擅加角色、道具、环境细节或不相容的镜头。
已有角色复用固定外貌。只写当前镜头可见的脸型、眉形、眼型与瞳色、鼻形、唇形、头发及标志特征；背面、遮挡或远景看不清的部位不强写。不为了展示脸部改变用户要求的姿势。
不重抽已有五官；仅在当前任务允许建档或补空时，对缺失的脸型、眉形、眼型、鼻形和唇形作相容补全，设计不得伪称原文事实。动作、衣着、神态等临时状态不进入固定外貌库。明确发生的永久变化按任务的 changes 协议记录，临时变化仅用于当前画面。
用可画出的身体关系描述动作：人物躯干朝向、参与动作的肢体、谁持有什么、接触与支撑位置。画面左右与人物自身左右分别表达；多人关系不能串人。只选一个时点，不把连续动作同时写进画面。
需要渲染的文字用英文双引号明确标出确切内容。不堆 Danbooru 标签、括号权重或泛泛的质量口号。描述充分即可，不设机械词数；已有描述清楚时只作必要润色，删除重复而保留核心动作和身份。
遵守插件最终 JSON 协议，将一段完整英文放进 nl；tag 返回空字符串，不再生成同内容的标签串。固定正负面词由工作流设置追加，不在 nl 重复。仅当任务要求时生成本画面 negative，排除项不能否定正向事实。
size 按构图填 portrait 或 landscape；实际像素由用户设置决定。只返回 JSON，不输出说明、Markdown、思考过程或检查表。`;

export const DEFAULT_KREA2_THINKING = `【Krea2 输出前内部检查】
在内部核对以下事项，最终只输出任务协议要求的 JSON：
1. 当前时点、出镜人数与人物身份正确；复用固定外貌，区别临时状态和明确的永久变化。
2. 同一时点的躯干方向、肢体状态、接触支撑和物件归属能够同时成立；相机方向不等于身体方向。
3. 镜头能够表现关键动作；脸型和五官仅在实际可见时描述，不为补脸改姿势或构图。
4. 衣服、神态、环境和媒介符合剧情与用户要求；没有凭空增加人物或道具。
5. nl 是连贯英文段落，已去除重复与冲突；必要文字准确加引号；tag 为空；negative 不否定正向事实。
6. position、changes 和其它字段符合当前任务协议，JSON 可解析。不在分析中预写完整提示词、候选或 JSON。`;

export const KREA2_CONTENT_RULE = 'tag 返回空字符串；nl 必须是一段完整、连贯、有英文句末标点的正面画面描述。只在 nl 写一次主体、可见外貌、动作和场景，不同时生成重复标签串。';

export const KREA2_VISUAL_CONTRACT = `【Krea2 人物与空间约束】
${KREA2_CONTENT_RULE}
人物从当前剧情和固定档案确定，字段可以转换为自然英文但含义不能改。每个人用自己的称谓绑定脸型、眉眼鼻唇、服装、神态和动作；不写 @角色占位符，不靠 beautiful face 等泛称代替可见结构。
区分 screen left/right 与人物自身左右。明确躯干方向和参与动作的手脚、持有者、接触点、承重与分离关系。相机俯视不是人物弯腰，前景位置不是身体前倾。每个人只处于一个可同时成立的动作状态；交接物件只选一个时点。
镜头应包含核心动作所需的关节、末端和参照物；不同时要求脸部特写和完整四肢，不因需要五官而改写姿势。背面、遮挡或远景不可见的五官省略。正向矛盾先在 nl 中解决，不能靠 negative 抵消。
已有五官稳定复用；只在当前任务允许时对缺失的 face/eyeShape/eyebrows/nose/mouth 相容补全，新角色写入 new.fields，已有未锁定角色用 fillOnly:true，reason 标注“五官补全设计”。不覆盖已有非空字段，不擅改年龄、种族、发色和瞳色。临时状态仅用于本图。选段任务服从其更严格的建档规则；修改意见任务不写角色库。
不添加无关在场者、道具或剧情。保留用户媒介和风格。不输出推理过程；只交付当前任务所需 JSON。`;

export function assertNaturalPrompt(content: { nl: string }, label = '图片'): void {
  if (!content.nl.trim() || !/[A-Za-z]{2,}/.test(content.nl) || !/[.!?](?:\s|$)/.test(content.nl.trim())) {
    throw new Error(`${label}缺少完整英文画面描述：Krea2 的 nl 必须为连贯英文句子，包含句末标点`);
  }
}
