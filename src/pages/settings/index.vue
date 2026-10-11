<script setup lang="ts">
import { DEFAULT_KREA2_SPEC, DEFAULT_KREA2_THINKING, type PromptMode } from '@/promptMode';
import ChangYeSelect from '@/components/ChangYeSelect.vue';
import ChangYeCombo from '@/components/ChangYeCombo.vue';
import ChangYeTextarea from '@/components/ChangYeTextarea.vue';
import Collapsible from '@/components/Collapsible.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import Icon from '@/components/Icon.vue';
import ModalMask from '@/components/ModalMask.vue';
import { fetchModels, testChannel } from '@/api/client';
import {
  DEFAULT_COMFY_SPEC,
  DEFAULT_COMFY_THINKING,
  DEFAULT_JAILBREAK_PROMPT,
  DEFAULT_PREFILL_PROMPT,
  newChannel,
  sanitizeTagName,
  settings,
  type ApiChannel,
  type AutoTagPrompts,
} from '@/state/settings';
import { getContext } from '@/st/context';
import {
  ORB_SHAPES,
  THEMES,
  ui,
  type NavPosition,
  type OrbShape,
  type ThemeName,
} from '@/state/ui';
import { checkForUpdate, performUpdate, updateState } from '@/update';
import { computed, nextTick, onMounted, ref } from 'vue';

const NAV_OPTIONS: { value: NavPosition; label: string }[] = [
  { value: 'auto', label: '自动' },
  { value: 'top', label: '顶部' },
  { value: 'bottom', label: '底部' },
];

// 出图后端可选项:与渠道页页签同口径,藏掉未开放的 webui


/**
 * 思考强度候选:各家取值的并集,**不是**某一家的官方列表。
 * auto 是显式选项(值为空串 = 不发送该参数),不是「留空」——
 * 用 ChangYeSelect 而非可输入的 ChangYeCombo:移动端点输入框会弹出输入法,很打扰。
 * 取值不做校验,原样发给端点(见 ApiChannel.reasoningEffort)。
 */
const REASONING_EFFORT_OPTIONS = [
  { value: '', label: 'auto' },
  { value: 'minimal', label: 'minimal' },
  { value: 'low', label: 'low' },
  { value: 'medium', label: 'medium' },
  { value: 'high', label: 'high' },
  { value: 'xhigh', label: 'xhigh' },
  { value: 'max', label: 'max' },
];

/* —— 自绘下拉(ChangYeSelect)的 v-model 适配:组件按 string 收发,这里收窄回具体联合类型 —— */
const themeSel = computed<string>({
  get: () => ui.theme,
  set: v => (ui.theme = v as ThemeName),
});
const navSel = computed<string>({
  get: () => ui.navPosition,
  set: v => (ui.navPosition = v as NavPosition),
});
// 楼层卡片主题不再提供设置项:卡片无边框化后恒跟随 ST 主题。
// settings.ui.cardTheme 字段与 hydrate 读取保留(旧用户已改的值继续生效,无害)。
const orbShapeSel = computed<string>({
  get: () => ui.orbShape,
  set: v => (ui.orbShape = v as OrbShape),
});


/* —— 渠道:列表只读展示,编辑/新建都在弹窗里进行,避免一长列表平铺误触。
   渠道列表与角色记忆插件共享(见 state/settings.ts 的共享存储),任一端改动自动同步。 —— */
// editingId:正在编辑的「已有渠道」id;新建时为 null。仅用于「完成」时定位写回目标。
const editingId = ref<string | null>(null);
// 编辑用「草稿副本」:v-model 全改在草稿上,只有点「完成」才写回 settings(避免每敲一字就触发存盘)。
// 弹窗开关也以它为准:草稿存在 = 弹窗打开。
const editingChannel = ref<ApiChannel | null>(null);
// 深拷贝渠道(纯数据,JSON 即可),切断与 settings 真身的引用
function cloneChannel(ch: ApiChannel): ApiChannel {
  return JSON.parse(JSON.stringify(ch)) as ApiChannel;
}
// 密钥默认隐藏;每次打开/关闭弹窗都复位,避免密钥意外保持明文
const showKey = ref(false);

function normalizeAutoTagNumbers(changed?: 'minImages' | 'maxImages' | Event) {
  settings.autoTag.contextMessages = Math.max(1, Math.floor(Number(settings.autoTag.contextMessages) || 1));
  let minImages = Math.max(0, Math.floor(Number(settings.autoTag.minImages) || 0));
  let maxImages = Math.max(1, Math.floor(Number(settings.autoTag.maxImages) || 1));
  // 用户抬高下限时顺带抬高上限;用户压低上限时顺带压低下限。
  // 这样正在编辑的那一格始终保留用户意图,不会出现 min > max 的瞬时脏配置。
  if (changed === 'minImages') maxImages = Math.max(maxImages, minImages);
  else minImages = Math.min(minImages, maxImages);
  settings.autoTag.minImages = minImages;
  settings.autoTag.maxImages = maxImages;
  settings.autoTag.retryCount = Math.min(5, Math.max(0, Math.floor(Number(settings.autoTag.retryCount) || 0)));
}

/* —— 自定义提示词(UI 照搬角色记忆插件):列表只读展示,编辑在弹窗里进行。
   空串 = 回落内置默认;是否已自定义按 trim 非空判定。 —— */
interface TagPromptMeta {
  key: keyof AutoTagPrompts;
  label: string;
  hint: string;
  builtin: string;
  macros: { token: string; desc: string }[];
}

// 规范与思维链按后端成对排列:两者必须配对使用(思维链槽位要填的字段,
// 得在同后端规范里有判据和词表),列在一起是为了改一个时能看见另一个。
// 不按当前后端过滤——过滤会让「现在用的是哪份」变成隐式状态,反而更难排查。
//
// ⚠ NAI 只列一对,存的是 naiV5Spec / naiV5Thinking(键名带 V5 是历史包袱,见 settings.ts)。
// 4.5 以下那套单串 tag 的 naiSpec / naiThinking 已随模型列表收窄一起下线,不再列出:
// 可选模型只剩 4.5/V5,那两份永远走不到,列出来只会让人以为还有第二种口径要维护。
const TAG_PROMPT_METAS: TagPromptMeta[] = [
  {
    key: 'jailbreak',
    label: '破限词',
    hint: '作为置顶 system 附加在自动 TAG 请求里，降低副 API 拒答率。留空则用内置默认。全后端通用。',
    builtin: DEFAULT_JAILBREAK_PROMPT,
    macros: [],
  },
  {
    key: 'comfySpec',
    label: 'Anima 提示词规范',
    hint: '工作流选择 Anima 模式时使用。保留原 ComfyUI 规范的自定义内容，留空用内置默认。',
    builtin: DEFAULT_COMFY_SPEC,
    macros: [
      {
        token: '{{nl}}',
        desc: '展开完整英文描述规范，与核心标签同时使用。不写此宏时也会追加到规范末尾。',
      },
    ],
  },
  {
    key: 'comfyThinking',
    label: 'Anima 输出前检查',
    hint: 'ComfyUI 输出前的内部视觉检查清单，核对人物、动作归属、服装连续性、背景和标签一致性。最终只输出 JSON，不展示思考过程。留空用内置默认。',
    builtin: DEFAULT_COMFY_THINKING,
    macros: [],
  },
  { key: 'krea2Spec', label: 'Krea2 提示词规范', hint: '工作流选择 Krea2 模式时使用，生成连贯英文画面描述。留空用内置默认。', builtin: DEFAULT_KREA2_SPEC, macros: [] },
  { key: 'krea2Thinking', label: 'Krea2 输出前检查', hint: 'Krea2 的内部视觉检查清单；最终只输出任务 JSON，不展示检查过程。留空用内置默认。', builtin: DEFAULT_KREA2_THINKING, macros: [] },
  {
    key: 'prefill',
    label: '预填充',
    hint: 'assistant 预填充，随副 API「发送预填充」开关生效。留空时不预填，直接输出 JSON。',
    builtin: DEFAULT_PREFILL_PROMPT,
    macros: [],
  },
];

const ruleMode = ref<PromptMode>('anima');
const commonPromptMetas = TAG_PROMPT_METAS.filter(meta => ['jailbreak', 'prefill'].includes(meta.key));
const modePromptMetas = computed(() => TAG_PROMPT_METAS.filter(meta => (ruleMode.value === 'krea2' ? ['krea2Spec', 'krea2Thinking'] : ['comfySpec', 'comfyThinking']).includes(meta.key)));

// 正在编辑的提示词;draft 是草稿,点「完成」才写回 settings(取消则丢弃)。
const editingTagPrompt = ref<TagPromptMeta | null>(null);
const tagPromptDraft = ref('');
const tagPromptArea = ref<InstanceType<typeof ChangYeTextarea> | null>(null);

// 该条是否已自定义(非空即视为已覆盖内置)
function isTagPromptCustom(key: keyof AutoTagPrompts): boolean {
  return (settings.autoTag.prompts[key] ?? '').trim().length > 0;
}

function openTagPrompt(meta: TagPromptMeta) {
  editingTagPrompt.value = meta;
  // 已自定义→载入用户内容;未自定义→预填内置模板,方便直接在其上改
  tagPromptDraft.value = (settings.autoTag.prompts[meta.key] ?? '').trim() || meta.builtin;
}
function closeTagPrompt() {
  editingTagPrompt.value = null;
  tagPromptDraft.value = '';
}
function saveTagPrompt() {
  const meta = editingTagPrompt.value;
  if (!meta) return;
  // 草稿与内置完全一致→存空串(回落内置),避免把模板冗余存进设置、也便于显示「默认」
  const v = tagPromptDraft.value.trim();
  settings.autoTag.prompts[meta.key] = v === meta.builtin.trim() ? '' : tagPromptDraft.value;
  closeTagPrompt();
}
// 「恢复默认」:把草稿重置回内置模板(保存后即回落内置)
function resetTagPromptDraft() {
  if (editingTagPrompt.value) tagPromptDraft.value = editingTagPrompt.value.builtin;
}
// 点宏标签 → 插入到文本框光标处(无焦点则追加到末尾);光标定位由组件内部处理
function insertTagMacro(token: string) {
  tagPromptArea.value?.insertAtCursor(token);
}

// 排除参数:内部存 string[],编辑时用逗号分隔的单行文本承载,读/写两向转换。
const excludeParamsText = computed<string>({
  get: () => editingChannel.value?.excludeParams.join(', ') ?? '',
  set: v => {
    const ch = editingChannel.value;
    if (!ch) return;
    ch.excludeParams = v
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
  },
});

function addChannel() {
  showKey.value = false;
  editingId.value = null; // null = 新建,完成时 push
  editingChannel.value = newChannel(); // 草稿,尚未进 settings
}
function openChannel(id: string) {
  const src = settings.channels.find(c => c.id === id);
  if (!src) return;
  showKey.value = false;
  editingId.value = id;
  editingChannel.value = cloneChannel(src); // 编辑草稿副本,不动真身
}
/** 取消(× / 点遮罩):丢弃草稿,不写回 settings(无论新建还是编辑,改动都作废)。 */
function closeChannel() {
  showKey.value = false;
  editingId.value = null;
  editingChannel.value = null;
}
/** 完成:把草稿写回 settings —— 新建则 push,编辑则按 id 覆盖。此时才触发存盘。 */
function confirmChannel() {
  const draft = editingChannel.value;
  if (draft) {
    draft.timeoutSec =
      Number.isFinite(draft.timeoutSec) && draft.timeoutSec > 0
        ? Math.floor(draft.timeoutSec)
        : 180;
    const list = settings.channels;
    if (editingId.value) {
      const idx = list.findIndex(c => c.id === editingId.value);
      if (idx >= 0) list[idx] = draft;
      else list.push(draft); // 编辑期间原渠道被删等异常 → 兜底为新增
    } else {
      list.push(draft);
    }
  }
  showKey.value = false;
  editingId.value = null;
  editingChannel.value = null;
}
// 删除渠道前的二次确认:点删除先开确认弹窗,确认后才真正删。
const confirmDeleteOpen = ref(false);
function askRemoveChannel() {
  confirmDeleteOpen.value = true;
}
function confirmRemoveChannel() {
  confirmDeleteOpen.value = false;
  // 删除针对「已有渠道」(editingId);新建草稿尚未入库,等同直接丢弃草稿
  if (editingId.value) removeChannel(editingId.value);
  editingId.value = null;
  editingChannel.value = null;
}
function removeChannel(id: string) {
  const list = settings.channels;
  const idx = list.findIndex(c => c.id === id);
  if (idx >= 0) list.splice(idx, 1);
  // 清理指派:生成 tag 若指派了该渠道则清空(回落跟随主 API)
  if (settings.assignments.tagGen === id) settings.assignments.tagGen = '';
}

const testing = ref<Record<string, string>>({});
async function doTest(ch: ApiChannel) {
  testing.value[ch.id] = '测试中…';
  const r = await testChannel(ch);
  testing.value[ch.id] = r.message;
}

// 各渠道拉取到的模型列表 + 拉取状态
const models = ref<Record<string, string[]>>({});
const loadingModels = ref<Record<string, boolean>>({});
async function pullModels(ch: ApiChannel) {
  loadingModels.value[ch.id] = true;
  testing.value[ch.id] = '';
  try {
    const list = await fetchModels(ch);
    models.value[ch.id] = list;
    if (list.length && !ch.model) ch.model = list[0];
    if (!list.length) testing.value[ch.id] = '未返回任何模型';
  } catch (e) {
    testing.value[ch.id] = e instanceof Error ? e.message : String(e);
  } finally {
    loadingModels.value[ch.id] = false;
  }
}

/* —— 排除世界书:tag 生成副 API 不带这些整本世界书的条目。复刻排除角色的搜索+勾选弹窗;
   世界书名从 ST 的 getWorldInfoNames()(全部已加载的世界书文件)取。 —— */
const excludeWorldOpen = ref(false);
const excludeWorldSearch = ref('');

// 旧版 ST(如 1.13.5)的 getContext() 没有 getWorldInfoNames,退而从主页面世界书
// 下拉框 #world_editor_select 读选项文本(value="" 是占位项,跳过)。
function readWorldNamesFromDom(): string[] {
  const opts = document.querySelectorAll<HTMLOptionElement>('#world_editor_select option');
  const out: string[] = [];
  for (const o of opts) {
    if (o.value !== '' && o.textContent) out.push(o.textContent);
  }
  return out;
}

// 弹窗打开时一次性取世界书名(去重去空、按名排序);关闭后不持有。
const worldNames = computed<string[]>(() => {
  if (!excludeWorldOpen.value) return [];
  const getNames = getContext()?.getWorldInfoNames;
  const names = getNames ? getNames() : readWorldNamesFromDom();
  const seen = new Set<string>();
  for (const n of names) {
    const t = n?.trim();
    if (t) seen.add(t);
  }
  return [...seen].sort((a, b) => a.localeCompare(b, 'zh'));
});

const filteredWorldNames = computed<string[]>(() => {
  const q = excludeWorldSearch.value.trim().toLowerCase();
  if (!q) return worldNames.value;
  return worldNames.value.filter(n => n.toLowerCase().includes(q));
});

function openExcludeWorld() {
  excludeWorldSearch.value = '';
  excludeWorldOpen.value = true;
}
function closeExcludeWorld() {
  excludeWorldOpen.value = false;
}
function isWorldExcluded(name: string): boolean {
  return settings.excludes.excludedWorldNames.includes(name);
}
function toggleWorldExcluded(name: string) {
  const list = settings.excludes.excludedWorldNames;
  const idx = list.indexOf(name);
  if (idx >= 0) list.splice(idx, 1);
  else list.push(name);
}

/* —— 排除世界书条目:按条目名(comment)过滤,复刻清洗标签的输入框+chips。
   规则当正则,普通名字即包含匹配;编译失败降级子串。 —— */
const wiPatternDraft = ref('');
const wiRuleMode = ref('keyword');
const wiRuleError = ref('');
const mvuRule = String.raw`\[mvu[\s\S]*?\]`;
const mvuExcluded = computed({
  get: () => settings.excludes.excludedWorldInfoPatterns.includes(mvuRule),
  set: (enabled: boolean) => { if (enabled) { if (!mvuExcluded.value) settings.excludes.excludedWorldInfoPatterns.push(mvuRule); } else removeWiPattern(mvuRule); },
});
const visibleWiPatterns = computed(() => settings.excludes.excludedWorldInfoPatterns.filter(p => p !== mvuRule));
function removeWiKeyword(word: string) { settings.worldInfoKeywords = settings.worldInfoKeywords.filter(value => value !== word); }

function addWiPattern() {
  const pat = wiPatternDraft.value.trim();
  if (!pat) {
    wiPatternDraft.value = '';
    return;
  }
  wiRuleError.value = '';
  if (wiRuleMode.value === 'regex') {
    try { new RegExp(pat, 'i'); } catch { wiRuleError.value = '正则表达式无效，请检查后再添加。'; return; }
    if (!settings.excludes.excludedWorldInfoPatterns.includes(pat)) settings.excludes.excludedWorldInfoPatterns.push(pat);
  } else if (!settings.worldInfoKeywords.includes(pat)) settings.worldInfoKeywords.push(pat);
  wiPatternDraft.value = '';
}
function removeWiPattern(pat: string) {
  const idx = settings.excludes.excludedWorldInfoPatterns.indexOf(pat);
  if (idx >= 0) settings.excludes.excludedWorldInfoPatterns.splice(idx, 1);
}

/* 全局保留范围，与旧删除名单独立。 */
const stripTagDraft = ref('');
function addStripTag() {
  const tag = sanitizeTagName(stripTagDraft.value).toLowerCase();
  if (!tag) {
    stripTagDraft.value = '';
    return;
  }
  if (!settings.storyTags.includes(tag)) settings.storyTags.push(tag);
  stripTagDraft.value = '';
}
function removeStripTag(tag: string) {
  const idx = settings.storyTags.indexOf(tag);
  if (idx >= 0) settings.storyTags.splice(idx, 1);
}

/* —— 模型可搜索下拉(combobox):输入框既是当前值也是过滤词,聚焦弹出过滤列表 —— */
// 已拉取到的当前渠道模型列表
const modelList = computed<string[]>(() => {
  const id = editingChannel.value?.id;
  return id ? models.value[id] ?? [] : [];
});
const updateConfirmOpen = ref(false);
onMounted(() => void checkForUpdate(true));

function openUpdateConfirm() {
  if (updateState.available) updateConfirmOpen.value = true;
}

async function confirmUpdate() {
  updateConfirmOpen.value = false;
  const toastr = (globalThis as Record<string, any>).toastr;
  try {
    await performUpdate();
    toastr?.success?.('更新成功，正在刷新页面…', '长夜的绘图器');
  } catch (error) {
    toastr?.error?.(`更新失败：${error instanceof Error ? error.message : String(error)}`, '长夜的绘图器');
  }
}
</script>

<template>
  <section class="changye-page">
    <!-- 标题行右端显示版本号;有更新时旁边出现更新按钮。 -->
    <div class="changye-page-head">
      <h2 class="changye-title changye-title-sub">设置</h2>
      <div class="changye-ver-row">
        <button
          class="changye-ver"
          type="button"
          :disabled="updateState.checking"
          :title="updateState.checking ? '正在检查更新' : '点击检查更新'"
          @click="checkForUpdate(true)"
        >
          {{ updateState.current === '1.2.0' ? 'V1.2' : 'V' + (updateState.current || '—') }}
        </button>
        <button
          v-if="updateState.available"
          class="changye-btn changye-btn-primary changye-btn-sm"
          type="button"
          :disabled="updateState.updating"
          :title="`更新到 v${updateState.latest}`"
          @click="openUpdateConfirm"
        >
          {{ updateState.updating ? '更新中…' : '更新' }}
        </button>
      </div>
    </div>
    <hr class="changye-rule" />

    <!-- 总开关:整个插件的主控。全页唯一的大号滑动开关,与下方各项的小复选框拉开层级。 -->
    <div class="changye-master" :class="{ 'is-off': !settings.enabled }">
      <span class="changye-master-spine" aria-hidden="true"></span>
      <span class="changye-master-title">长夜的绘图器</span>
      <button
        type="button"
        role="switch"
        class="changye-toggle"
        :class="{ 'is-on': settings.enabled }"
        :aria-checked="settings.enabled"
        :title="settings.enabled ? '点击停用' : '点击启用'"
        @click="settings.enabled = !settings.enabled"
      >
        <span class="changye-toggle-knob"></span>
      </button>
    </div>

    <div class="changye-sections">
      <!-- 基本设置:主题 / 导航 / 入口 / 悬浮球等界面项,置于首位 -->
      <Collapsible title="基本设置" :open="false">
        <div class="changye-select-row">
          <span class="changye-field-label">主题</span>
          <ChangYeSelect v-model="themeSel" :options="THEMES" aria-label="主题" />
        </div>

        <div class="changye-select-row">
          <span class="changye-field-label">导航位置</span>
          <ChangYeSelect v-model="navSel" :options="NAV_OPTIONS" aria-label="导航位置" />
        </div>


        <label class="changye-switch-row">
          <span class="changye-field-label">新图保存为 JPG</span>
          <input v-model="settings.storage.saveAsJpeg" type="checkbox" class="changye-checkbox" />
        </label>
        <p class="changye-field-hint">
          体积约为 PNG 的一到两成；代价是图片不再内嵌生成参数（提示词与种子仍留在聊天记录里）。
        </p>

        <label class="changye-switch-row">
          <span class="changye-field-label">楼层图片默认折叠</span>
          <input v-model="settings.ui.autoCollapseImages" type="checkbox" class="changye-checkbox" />
        </label>
        <p class="changye-field-hint">
          开启后图片默认收成一条细条，点击才展开，适合在外面玩时防窥。在卡片上手动展开/折叠过的以手动状态为准（刷新页面后重置）。
        </p>

        <label class="changye-switch-row">
          <span class="changye-field-label">移动端点当前页导航关窗</span>
          <input v-model="ui.navTapClose" type="checkbox" class="changye-checkbox" />
        </label>
        <p class="changye-field-hint">移动端再点一下当前所在页的导航按钮即可关闭整个窗口，省得去够右上角的 ×。怕误触可关。</p>

        <label class="changye-switch-row">
          <span class="changye-field-label">在 ST 顶栏显示按钮</span>
          <input v-model="ui.showTopBar" type="checkbox" class="changye-checkbox" />
        </label>
        <p class="changye-field-hint">在酒馆顶部导航栏加一个快速打开按钮。左下角魔杖入口照旧保留。</p>

        <label class="changye-switch-row">
          <span class="changye-field-label">显示屏幕悬浮球</span>
          <input v-model="ui.showOrb" type="checkbox" class="changye-checkbox" />
        </label>
        <p class="changye-field-hint">在屏幕边缘挂一枚可拖动的悬浮球，点击即可打开。拖到中间可常驻悬浮，拖近左右边缘则吸附贴边。</p>

        <!-- 悬浮球外观:配置项多,开启后才收进小分组 -->
        <Collapsible v-if="ui.showOrb" title="悬浮球外观" :open="false">
          <div class="changye-select-row">
            <span class="changye-field-label">形状</span>
            <ChangYeSelect v-model="orbShapeSel" :options="ORB_SHAPES" aria-label="悬浮球形状" />
          </div>

          <div class="changye-field">
            <div class="changye-field-head">
              <span class="changye-field-label">大小</span>
              <span class="changye-field-value">{{ ui.orbSize }}px</span>
            </div>
            <input class="changye-range" type="range" min="32" max="80" step="1" v-model.number="ui.orbSize" />
          </div>

          <div class="changye-field">
            <div class="changye-field-head">
              <span class="changye-field-label">静止透明度</span>
              <span class="changye-field-value">{{ ui.orbOpacity }}%</span>
            </div>
            <input class="changye-range" type="range" min="20" max="100" step="1" v-model.number="ui.orbOpacity" />
            <p class="changye-field-hint">悬浮球静止时的不透明度；唤起 / 拖动时一律全显。</p>
          </div>

          <div class="changye-field">
            <div class="changye-field-head">
              <span class="changye-field-label">自定义图标</span>
            </div>
            <input class="changye-input" type="text" v-model="ui.orbImage" placeholder="ST 服务器图片路径" spellcheck="false" />
            <p class="changye-field-hint">留空用默认画笔图标。</p>
          </div>
        </Collapsible>
      </Collapsible>

      <Collapsible title="自动生成 TAG" :open="false">
        <label class="changye-switch-row">
          <span class="changye-field-label">自动生成 TAG</span>
          <input v-model="settings.autoTag.enabled" type="checkbox" class="changye-checkbox" />
        </label>
        <p class="changye-field-hint">AI 正文生成后自动判断该楼是否需要插图，需要就写入生图 TAG。</p>

        <label class="changye-switch-row">
          <span class="changye-field-label">自动生成图片</span>
          <input v-model="settings.autoTag.autoGenerate" type="checkbox" class="changye-checkbox" />
        </label>
        <p class="changye-field-hint">写入 TAG 后立即按当前出图渠道自动出图；关闭则只写 TAG，在卡片上手动生成。</p>

        <label class="changye-num-row">
          <span class="changye-field-label">携带最近 AI 楼数</span>
          <input
            v-model.number="settings.autoTag.contextMessages"
            class="changye-input changye-num"
            type="number"
            min="1"
            step="1"
            @change="normalizeAutoTagNumbers"
          />
        </label>
        <p class="changye-field-hint">按 AI 故事楼计数，中间的 user 楼一并携带。</p>

        <label class="changye-num-row">
          <span class="changye-field-label">单楼最少图片数</span>
          <input
            v-model.number="settings.autoTag.minImages"
            class="changye-input changye-num"
            type="number"
            min="0"
            :max="settings.autoTag.maxImages"
            step="1"
            @change="normalizeAutoTagNumbers('minImages')"
          />
        </label>

        <label class="changye-num-row">
          <span class="changye-field-label">单楼最多图片数</span>
          <input
            v-model.number="settings.autoTag.maxImages"
            class="changye-input changye-num"
            type="number"
            :min="Math.max(1, settings.autoTag.minImages)"
            step="1"
            @change="normalizeAutoTagNumbers('maxImages')"
          />
        </label>
        <p class="changye-field-hint">最少设为 0 时允许不出图；最多数量始终受插件硬限制。</p>

        <label class="changye-num-row">
          <span class="changye-field-label">失败自动重试次数</span>
          <input
            v-model.number="settings.autoTag.retryCount"
            class="changye-input changye-num"
            type="number"
            min="0"
            max="5"
            step="1"
            @change="normalizeAutoTagNumbers"
          />
        </label>
        <p class="changye-field-hint">副 API 请求失败或返回无法解析时自动重试；0 = 不重试，最多 5 次。</p>
      </Collapsible>

      <!-- 排除世界书内容:与角色记忆插件同名单共享 -->
      <Collapsible title="排除世界书内容" :open="false">
        <p class="changye-field-hint">
          排除生成 TAG 时不需要参考的世界书内容。整本名单与正则规则沿用共享设置。
        </p>

        <!-- 整本排除:复刻排除角色的搜索+勾选弹窗 -->
        <div class="changye-channel-bar">
          <span class="changye-field-label">整本排除 · 已选 {{ settings.excludes.excludedWorldNames.length }} 本</span>
          <button class="changye-btn changye-btn-primary changye-btn-sm" type="button" @click="openExcludeWorld">
            <Icon name="edit" /> 编辑名单
          </button>
        </div>
        <ul v-if="settings.excludes.excludedWorldNames.length" class="changye-exclude-chips">
          <li v-for="name in settings.excludes.excludedWorldNames" :key="name" class="changye-exclude-chip">
            <span class="changye-exclude-chip-name">{{ name }}</span>
            <button class="changye-exclude-chip-x" type="button" title="移出名单" @click="toggleWorldExcluded(name)">
              <Icon name="close" />
            </button>
          </li>
        </ul>
        <p v-else class="changye-field-hint">未整本排除世界书，仍按下方条目规则过滤。</p>

        <hr class="changye-rule" />

        <!-- 按条目名称排除:复刻清洗标签的输入框 + chips -->
        <div class="changye-field-head">
          <span class="changye-field-label">按条目名称排除</span>
        </div>
        <label class="changye-field-label"><input v-model="mvuExcluded" type="checkbox" /> 排除 MVU 条目</label>
        <p class="changye-field-hint">按条目名称中的 [MVU…] 标记匹配。</p>
        <select v-model="wiRuleMode" class="changye-input" aria-label="条目匹配方式">
          <option value="keyword">关键词</option><option value="regex">正则表达式</option>
        </select>
        <div class="changye-striptag-bar">
          <input
            v-model="wiPatternDraft"
            class="changye-input"
            type="text"
            :placeholder="wiRuleMode === 'keyword' ? '条目名称关键词' : '正则表达式，例如 ^规则'"
            @keydown.enter.prevent="addWiPattern"
          />
          <button class="changye-btn changye-btn-primary changye-btn-sm" type="button" @click="addWiPattern">
            <Icon name="plus" /> 添加
          </button>
        </div>
        <p v-if="wiRuleError" role="alert" class="changye-field-hint">{{ wiRuleError }}</p>
        <ul v-if="visibleWiPatterns.length || settings.worldInfoKeywords.length" class="changye-exclude-chips">
          <li v-for="word in settings.worldInfoKeywords" :key="'keyword:' + word" class="changye-exclude-chip">
            <span class="changye-exclude-chip-name">关键词：{{ word }}</span>
            <button class="changye-exclude-chip-x" type="button" title="移除关键词" @click="removeWiKeyword(word)"><Icon name="close" /></button>
          </li>
          <li v-for="pat in visibleWiPatterns" :key="pat" class="changye-exclude-chip">
            <span class="changye-exclude-chip-name">正则：{{ pat }}</span>
            <button class="changye-exclude-chip-x" type="button" title="移除" @click="removeWiPattern(pat)">
              <Icon name="close" />
            </button>
          </li>
        </ul>
        <p v-else class="changye-field-hint">暂无条目名规则。</p>
      </Collapsible>

      <!-- 全局正文标签范围独立保存，不与旧删除名单互换 -->
      <Collapsible title="自定义标签范围" :open="false">
        <p class="changye-field-hint">
          添加标签名，例如 <code>game</code>。仅从匹配标签内部选取正文，所有角色卡通用。
        </p>
        <div class="changye-striptag-bar">
          <input
            v-model="stripTagDraft"
            class="changye-input"
            type="text"
            placeholder="标签名，例如 game"
            @keydown.enter.prevent="addStripTag"
          />
          <button class="changye-btn changye-btn-primary changye-btn-sm" type="button" @click="addStripTag">
            <Icon name="plus" /> 添加
          </button>
        </div>
        <ul v-if="settings.storyTags.length" class="changye-exclude-chips">
          <li v-for="tag in settings.storyTags" :key="tag" class="changye-exclude-chip">
            <span class="changye-exclude-chip-name">&lt;{{ tag }}&gt;</span>
            <button class="changye-exclude-chip-x" type="button" title="移除" @click="removeStripTag(tag)">
              <Icon name="close" />
            </button>
          </li>
        </ul>
        <p v-else class="changye-field-hint">未设置标签范围，使用普通正文识别。</p>
      </Collapsible>

      <!-- 自定义提示词(与角色记忆插件同款入口,独立成区) -->
      <Collapsible title="自定义提示词" :open="false">
        <ul class="changye-prompt-list">
          <li v-for="m in commonPromptMetas" :key="m.key" class="changye-prompt-item">
            <button class="changye-prompt-open" type="button" @click="openTagPrompt(m)">
              <span class="changye-prompt-name">{{ m.label }}</span>
              <span class="changye-prompt-state" :class="{ 'is-custom': isTagPromptCustom(m.key) }">
                {{ isTagPromptCustom(m.key) ? '已自定义' : '默认' }}
              </span>
              <Icon name="edit" class="changye-prompt-edit" />
            </button>
          </li>
        </ul>
        <div class="changye-segmented changye-rule-mode" role="tablist" aria-label="提示词规则模式">
          <button v-for="mode in (['anima', 'krea2'] as const)" :key="mode" type="button" role="tab" class="changye-seg" :class="{ 'is-on': ruleMode === mode }" :aria-selected="ruleMode === mode" @click="ruleMode = mode">{{ mode === 'anima' ? 'Anima' : 'Krea2' }}</button>
        </div>
        <p class="changye-field-hint">两套规则分别保存；工作流的提示词模式决定使用哪一套。</p>
        <ul class="changye-prompt-list">
          <li v-for="m in modePromptMetas" :key="m.key" class="changye-prompt-item">
            <button class="changye-prompt-open" type="button" @click="openTagPrompt(m)">
              <span class="changye-prompt-name">{{ m.label }}</span>
              <span class="changye-prompt-state" :class="{ 'is-custom': isTagPromptCustom(m.key) }">{{ isTagPromptCustom(m.key) ? '已自定义' : '默认' }}</span>
              <Icon name="edit" class="changye-prompt-edit" />
            </button>
          </li>
        </ul>
      </Collapsible>

      <!-- 副 API:生成画图 tag 用的模型渠道(与角色记忆插件共享渠道列表) -->
      <Collapsible title="副 API" :open="false">
        <!-- 任务指派:只有一个任务——生成 tag -->
        <div class="changye-field changye-assign">
          <div class="changye-assign-row">
            <span class="changye-field-label">生成 TAG 使用</span>
            <ChangYeSelect v-model="settings.assignments.tagGen" style="width:100%" aria-label="生成 TAG 使用" :options="[{ value: '', label: '跟随主 API' }, ...settings.channels.map(c => ({ value: c.id, label: c.name }))]" />
          </div>
        </div>
        <p class="changye-field-hint">不指派渠道时跟随主API，想用不同模型再在下方建副渠道指派。</p>

        <hr class="changye-rule" />

        <!-- 渠道:顶部添加按钮 + 紧凑只读列表(点行进弹窗编辑),不再一长列表平铺 -->
        <div class="changye-channel-bar">
          <span class="changye-field-label">渠道</span>
          <button class="changye-btn changye-btn-primary changye-btn-sm" type="button" @click="addChannel()">
            <Icon name="plus" /> 添加渠道
          </button>
        </div>

        <ul v-if="settings.channels.length" class="changye-channel-list">
          <li v-for="ch in settings.channels" :key="ch.id" class="changye-channel-item">
            <button class="changye-channel-open" type="button" @click="openChannel(ch.id)">
              <span class="changye-channel-item-name">{{ ch.name || '未命名渠道' }}</span>
              <span class="changye-channel-item-model">{{ ch.model || '未设模型' }}</span>
            </button>
          </li>
        </ul>
        <p v-else class="changye-field-hint">还没有渠道。点「添加渠道」配置生成 TAG 要用的 API。</p>
      </Collapsible>
    </div>

    <!-- ===== 排除世界书弹窗:搜索 + 勾选列表(复刻排除角色) ===== -->
    <ModalMask :open="excludeWorldOpen" @close="closeExcludeWorld">
      <div class="changye-modal" role="dialog" aria-modal="true" aria-label="编辑排除世界书名单">
        <header class="changye-modal-head">
          <span class="changye-modal-title">整本排除世界书</span>
          <button class="changye-icon-mini" type="button" title="关闭" @click="closeExcludeWorld"><Icon name="close" /></button>
        </header>

        <input
          v-model="excludeWorldSearch"
          class="changye-input"
          type="search"
          placeholder="搜索世界书名…"
          spellcheck="false"
        />

        <div class="changye-exclude-list">
          <label v-for="name in filteredWorldNames" :key="name" class="changye-exclude-row">
            <input
              type="checkbox"
              class="changye-checkbox"
              :checked="isWorldExcluded(name)"
              @change="toggleWorldExcluded(name)"
            />
            <span class="changye-exclude-row-name">{{ name }}</span>
          </label>
          <p v-if="!worldNames.length" class="changye-field-hint">未读取到世界书。请先在 ST 里加载 / 挂载世界书。</p>
          <p v-else-if="!filteredWorldNames.length" class="changye-field-hint">没有匹配「{{ excludeWorldSearch }}」的世界书。</p>
        </div>

        <footer class="changye-modal-foot">
          <span class="changye-exclude-count">共 {{ worldNames.length }} 本 · 已排除 {{ settings.excludes.excludedWorldNames.length }}</span>
          <span class="changye-modal-foot-spacer"></span>
          <button class="changye-btn changye-btn-primary" type="button" @click="closeExcludeWorld">完成</button>
        </footer>
      </div>
    </ModalMask>

    <!-- ===== 渠道编辑弹窗 ===== -->
    <ModalMask :open="!!editingChannel" @close="closeChannel">
      <div v-if="editingChannel" class="changye-modal" role="dialog" aria-modal="true" aria-label="编辑渠道">
        <header class="changye-modal-head">
          <span class="changye-modal-title">编辑渠道</span>
          <button class="changye-icon-mini" type="button" title="关闭" @click="closeChannel"><Icon name="close" /></button>
        </header>

        <label class="changye-modal-field">
          <span class="changye-modal-label">渠道名</span>
          <input v-model="editingChannel.name" class="changye-input" placeholder="渠道名" />
        </label>
        <label class="changye-modal-field">
          <span class="changye-modal-label">API 地址</span>
          <input v-model="editingChannel.url" class="changye-input" placeholder="如 https://api.openai.com/v1" />
        </label>
        <label class="changye-modal-field">
          <span class="changye-modal-label">API 密钥</span>
          <div class="changye-model-row">
            <input
              v-model="editingChannel.key"
              class="changye-input"
              :type="showKey ? 'text' : 'password'"
              placeholder="API 密钥"
            />
            <button
              class="changye-icon-mini"
              type="button"
              :title="showKey ? '隐藏密钥' : '显示密钥'"
              :aria-pressed="showKey"
              @click="showKey = !showKey"
            >
              <Icon :name="showKey ? 'eye-off' : 'eye'" />
            </button>
          </div>
        </label>
        <label class="changye-modal-field">
          <span class="changye-modal-label">模型</span>
          <div class="changye-model-row">
            <ChangYeCombo v-model="editingChannel.model" :options="modelList" aria-label="副 API 模型" :placeholder="modelList.length ? '搜索或输入模型名…' : '模型名,如 gpt-4o-mini'" />
            <button
              class="changye-icon-mini"
              type="button"
              :title="loadingModels[editingChannel.id] ? '拉取中…' : '拉取模型'"
              :disabled="loadingModels[editingChannel.id]"
              @click="pullModels(editingChannel)"
            >
              <Icon name="refresh" />
            </button>
          </div>
        </label>
        <div class="changye-channel-row">
          <label class="changye-mini-field">
            <span>温度</span>
            <input v-model.number="editingChannel.temperature" class="changye-input" type="number" step="0.1" min="0" max="2" />
          </label>
          <label class="changye-mini-field">
            <span>最大 token</span>
            <input v-model.number="editingChannel.maxTokens" class="changye-input" type="number" step="256" min="256" />
          </label>
          <label class="changye-mini-field">
            <span>超时（秒）</span>
            <input v-model.number="editingChannel.timeoutSec" class="changye-input" type="number" step="10" min="1" />
          </label>
          <!-- 思考强度用 ChangYeSelect(纯选择,不唤起输入法);它自带 180px 固定宽,
               这里要跟其余三个等分,故在 .changye-mini-field 内用 :deep 放开宽度 -->
          <div class="changye-mini-field">
            <span>思考强度</span>
            <ChangYeSelect
              v-model="editingChannel.reasoningEffort"
              :options="REASONING_EFFORT_OPTIONS"
              aria-label="思考强度"
            />
          </div>
        </div>
        <span class="changye-field-hint">思考强度不知道的就选 auto，DS 系推荐 max</span>
        <label class="changye-switch-row">
          <span class="changye-modal-label">流式传输</span>
          <input v-model="editingChannel.stream" type="checkbox" class="changye-checkbox" />
        </label>
        <label class="changye-switch-row">
          <span class="changye-modal-label">发送预填充</span>
          <input v-model="editingChannel.prefill" type="checkbox" class="changye-checkbox" />
        </label>
        <span class="changye-field-hint">默认开。若副 API 报错信息里出现 prefill 字样，关掉它即可。</span>
        <label class="changye-modal-field">
          <span class="changye-modal-label">排除参数</span>
          <input
            v-model="excludeParamsText"
            class="changye-input"
            type="text"
            placeholder="逗号分隔，如 temperature, max_tokens"
          />
          <span class="changye-field-hint">这些参数会在发请求前从请求体里删除，用于规避不接受该参数的兼容端点报错。逗号分隔，留空则不排除。</span>
        </label>
        <p v-if="testing[editingChannel.id]" class="changye-channel-test">{{ testing[editingChannel.id] }}</p>

        <footer class="changye-modal-foot">
          <!-- 删除靠左、与右侧主操作拉开,破坏性动作不与「完成」相邻,降低误触。
               删除:始终显示文字;测试:PC 显「测试渠道」,移动端只显「测试」(短版,省版面) -->
          <button class="changye-btn changye-btn-danger" type="button" @click="askRemoveChannel">
            <Icon name="trash" /> 删除
          </button>
          <span class="changye-modal-foot-spacer"></span>
          <button class="changye-btn" type="button" title="测试渠道" @click="doTest(editingChannel)">
            <Icon name="plug" /> <span class="changye-btn-label-full">测试渠道</span><span class="changye-btn-label-short">测试</span>
          </button>
          <button class="changye-btn changye-btn-primary" type="button" @click="confirmChannel">完成</button>
        </footer>

        <!-- 删除渠道二次确认:叠在渠道弹窗之上。置于 v-if="editingChannel" 块内,
             渠道为 null 时整体不渲染——既合语义,也让 editingChannel.name 类型收窄。
             ConfirmDialog 自身 teleport + top-layer,放这儿不影响其渲染层级。 -->
        <ConfirmDialog
          v-model:open="confirmDeleteOpen"
          title="删除渠道"
          confirm-text="删除"
          confirm-icon="trash"
          tone="danger"
          top-layer
          @confirm="confirmRemoveChannel"
        >
          确定删除渠道「{{ editingChannel.name || '未命名渠道' }}」吗？此操作不可撤销，已指派该渠道的任务会被清空。
        </ConfirmDialog>
      </div>
    </ModalMask>

    <!-- ===== 自定义提示词编辑弹窗(UI 照搬角色记忆插件) ===== -->
    <ModalMask :open="!!editingTagPrompt" @close="closeTagPrompt">
      <div
        v-if="editingTagPrompt"
        class="changye-modal changye-modal-wide"
        role="dialog"
        aria-modal="true"
        :aria-label="`编辑${editingTagPrompt.label}`"
      >
        <header class="changye-modal-head">
          <span class="changye-modal-title">编辑{{ editingTagPrompt.label }}</span>
          <button class="changye-icon-mini" type="button" title="关闭" @click="closeTagPrompt"><Icon name="close" /></button>
        </header>

        <p class="changye-modal-label">{{ editingTagPrompt.hint }}</p>

        <!-- 可用宏:点一下插入到光标处(仅 ComfyUI 规范有 {{nl}};无宏的条目不显示这一栏) -->
        <div v-if="editingTagPrompt.macros.length" class="changye-macro-bar">
          <span class="changye-macro-tip">点击插入宏：</span>
          <button
            v-for="mac in editingTagPrompt.macros"
            :key="mac.token"
            class="changye-macro"
            type="button"
            :title="mac.desc"
            @click="insertTagMacro(mac.token)"
          >
            {{ mac.token }}
          </button>
        </div>

        <ChangYeTextarea
          ref="tagPromptArea"
          v-model="tagPromptDraft"
          class="changye-prompt-area"
          :rows="12"
          :max-rows="28"
          mono
        />

        <footer class="changye-modal-foot">
          <button class="changye-btn changye-btn-danger" type="button" @click="resetTagPromptDraft">
            <Icon name="refresh" /> 恢复默认
          </button>
          <span class="changye-modal-foot-spacer"></span>
          <button class="changye-btn" type="button" @click="closeTagPrompt">取消</button>
          <button class="changye-btn changye-btn-primary" type="button" @click="saveTagPrompt">完成</button>
        </footer>
      </div>
    </ModalMask>

    <ConfirmDialog
      v-model:open="updateConfirmOpen"
      title="发现新版本"
      confirm-text="更新并刷新"
      busy-text="更新中…"
      :busy="updateState.updating"
      @confirm="confirmUpdate"
    >
      当前版本 v{{ updateState.current || '—' }}，最新版本 v{{ updateState.latest }}。<br />
      现在更新吗？更新完成后会自动刷新页面生效。
    </ConfirmDialog>
  </section>
</template>

<style scoped>
.changye-rule-mode { margin-top: 20px; width: fit-content; }
.changye-ver-row {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

/* —— 版本标签:实心强调底 + 反白字,点击可重新检查 —— */
.changye-ver {
  border: 0;
  padding: 7px 12px;
  border-radius: var(--changye-radius-pill);
  background: var(--changye-accent);
  color: var(--changye-accent-ink);
  cursor: pointer;
  font-family: var(--changye-font-mono);
  font-size: 13px;
  font-weight: 600;
  line-height: 1;
}
.changye-ver:disabled {
  cursor: wait;
  opacity: 0.7;
}

/* —— 总开关主控卡 —— */
/* 左缘一道强调色竖脊;停用时整卡褪色、竖脊转灰,状态一眼可辨 */
.changye-master {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 16px;
  padding: 16px 18px 16px 16px;
  border: 1px solid var(--changye-line);
  border-radius: var(--changye-radius);
  background: var(--changye-surface);
  box-shadow: var(--changye-shadow);
  transition: opacity var(--changye-dur) var(--changye-ease);
}
.changye-master-spine {
  flex: 0 0 auto;
  align-self: stretch;
  width: 4px;
  border-radius: var(--changye-radius-pill);
  background: var(--changye-accent);
  transition: background var(--changye-dur) var(--changye-ease);
}
.changye-master.is-off .changye-master-spine {
  background: var(--changye-line-strong);
}
.changye-master.is-off .changye-master-title {
  opacity: 0.7;
}
.changye-master-title {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--changye-ink);
}

.changye-auto-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  margin: 4px 0 8px;
}

/* —— 滑动开关:全页仅总开关一处使用 —— */
.changye-toggle {
  flex: 0 0 auto;
  position: relative;
  width: 46px;
  height: 26px;
  padding: 0;
  border: 0;
  border-radius: var(--changye-radius-pill);
  background: var(--changye-line-strong);
  cursor: pointer;
  transition: background var(--changye-dur) var(--changye-ease);
}
.changye-toggle.is-on {
  background: var(--changye-accent);
}
.changye-toggle:focus-visible {
  outline: 2px solid var(--changye-accent);
  outline-offset: 2px;
}
.changye-toggle-knob {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--changye-surface);
  box-shadow: 0 1px 3px oklch(0 0 0 / 0.25);
  transition: transform var(--changye-dur) var(--changye-ease);
}
.changye-toggle.is-on .changye-toggle-knob {
  transform: translateX(20px);
}

/* ============ 副 API:渠道(与角色记忆插件同款) ============ */

/* 任务指派 */
.changye-assign {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.changye-assign-row { display: grid; grid-template-columns: minmax(0,1fr); gap: 8px; min-width: 0; }
.changye-assign-row > * { width: 100%; min-width: 0; }
/* 指派下拉:比全局 changye-select 更窄小一号,与右侧对齐、不撑满半行(角色记忆插件同款) */
.changye-assign-row .changye-select {
  max-width: 100%;
  font-size: 12px;
}

/* 渠道:顶部操作条(标签 + 添加按钮) */
.changye-channel-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

/* 渠道:紧凑只读列表,每渠道一行,点行进弹窗编辑 */
.changye-channel-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.changye-channel-item {
  display: flex;
  align-items: stretch;
  gap: 8px;
}
/* 行主体:整块可点,左名字右模型 */
.changye-channel-open {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  border: 1px solid var(--changye-line);
  border-radius: var(--changye-radius);
  background: var(--changye-surface-2);
  color: var(--changye-ink);
  font-family: var(--changye-font-sans);
  cursor: pointer;
  text-align: left;
  transition: border-color var(--changye-dur) var(--changye-ease), background var(--changye-dur) var(--changye-ease);
}
.changye-channel-open:hover {
  border-color: var(--changye-accent);
  background: var(--changye-surface);
}
/* 渠道名:完整显示,允许换行,占据剩余空间 */
.changye-channel-item-name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 14px;
  font-weight: 600;
  word-break: break-word;
}
/* 模型名:次要信息,过长则截断,不挤占名字 */
.changye-channel-item-model {
  flex: 0 1 auto;
  min-width: 0;
  font-size: 12px;
  color: var(--changye-ink-muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* —— 渠道编辑弹窗 —— */
.changye-model-row {
  display: flex;
  gap: 8px;
  align-items: center;
}
.changye-model-row .changye-input {
  flex: 1;
}
.changye-icon-mini {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: 1px solid var(--changye-line-strong);
  border-radius: var(--changye-radius-sm);
  background: var(--changye-surface);
  color: var(--changye-ink-soft);
  cursor: pointer;
  font-size: 14px;
}
.changye-icon-mini:hover {
  color: var(--changye-accent);
  border-color: var(--changye-accent);
}
.changye-icon-mini:disabled {
  opacity: 0.5;
  cursor: default;
}

/* 温度/最大 token/超时/思考强度:四个短控件并排,窄屏落到 2×2(见媒体查询) */
.changye-channel-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px;
}
.changye-mini-field {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--changye-ink-muted);
}
/* ChangYeSelect 自带 180px 固定宽(为设置页的行布局设计),这里要跟其余三个等分 */
.changye-mini-field :deep(.changye-select-box) {
  width: 100%;
}
/* 与相邻 number 输入等高:触发器默认 padding 比 .changye-input 略小 */
.changye-mini-field :deep(.changye-select-trigger) {
  padding: 7px 10px;
}
.changye-channel-test {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--changye-ink-soft);
  word-break: break-all;
}

/* 弹窗底部:spacer 把删除键推到最左,与右侧操作分隔 */
.changye-modal-foot-spacer {
  flex: 1 1 auto;
}
/* 危险操作按钮:描边低调,hover 才显红,避免误触 */
.changye-btn-danger {
  color: var(--changye-danger);
  border-color: var(--changye-line-strong);
}
.changye-btn-danger:hover {
  color: var(--changye-danger);
  border-color: var(--changye-danger);
  background: var(--changye-danger-soft);
}

/* 测试按钮文字:默认(PC)显完整版,短版藏起;窄屏在媒体查询里互换 */
.changye-btn-label-short {
  display: none;
}

/* —— 自定义提示词列表(UI 照搬角色记忆插件) —— */
.changye-prompt-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
/* 整行可点进弹窗编辑;布局沿用渠道列表的观感(描边、hover 显强调色) */
.changye-prompt-open {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border: 1px solid var(--changye-line);
  border-radius: var(--changye-radius);
  background: var(--changye-surface-2);
  color: var(--changye-ink);
  font-family: var(--changye-font-sans);
  cursor: pointer;
  text-align: left;
  transition: border-color var(--changye-dur) var(--changye-ease), background var(--changye-dur) var(--changye-ease);
}
.changye-prompt-open:hover {
  border-color: var(--changye-accent);
  background: var(--changye-surface);
}
.changye-prompt-name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
}
/* 状态药丸(.changye-prompt-state / .is-custom)已提到 base.css 全局:渠道页也用它 */
.changye-prompt-edit {
  flex: 0 0 auto;
  font-size: 16px;
  color: var(--changye-ink-muted);
}
.changye-prompt-open:hover .changye-prompt-edit {
  color: var(--changye-accent);
}

/* —— 提示词弹窗:更宽 + 大文本框 —— */
.changye-modal-wide {
  max-width: 680px;
}
/* 宏标签条:可横向裹行,每个宏点击插入 */
.changye-macro-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.changye-macro-tip {
  font-size: 12px;
  color: var(--changye-ink-muted);
  margin-right: 2px;
}
.changye-macro {
  padding: 3px 9px;
  border: 1px solid var(--changye-line-strong);
  border-radius: var(--changye-radius-pill);
  background: var(--changye-surface-2);
  color: var(--changye-ink-soft);
  font-family: var(--changye-font-mono);
  font-size: 12px;
  cursor: pointer;
  transition: color var(--changye-dur) var(--changye-ease), border-color var(--changye-dur) var(--changye-ease),
    background var(--changye-dur) var(--changye-ease);
}
.changye-macro:hover {
  color: var(--changye-accent);
  border-color: var(--changye-accent);
  background: var(--changye-accent-soft);
}
.changye-prompt-area {
  line-height: 1.6;
  font-size: 12.5px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  tab-size: 2;
}

/* ============ 排除名单(chips + 弹窗列表):与角色记忆插件同款交互,类名换 changye 前缀 ============ */
.changye-exclude-chips {
  list-style: none;
  margin: 10px 0 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.changye-exclude-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 6px 4px 11px;
  border-radius: var(--changye-radius-pill);
  background: var(--changye-accent-soft);
  color: var(--changye-accent);
  font-size: 12px;
  font-weight: 600;
}
.changye-exclude-chip-x {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: 12px;
  opacity: 0.7;
}
.changye-exclude-chip-x:hover {
  opacity: 1;
  background: oklch(0 0 0 / 0.08);
}
.changye-striptag-bar {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-top: 10px;
}
.changye-striptag-bar .changye-input {
  flex: 1;
  min-width: 0;
}
.changye-striptag-bar .changye-btn {
  flex: none;
}
.changye-exclude-list {
  max-height: 46vh;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 2px 0;
  padding-right: 2px;
}
.changye-exclude-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 8px;
  border-radius: var(--changye-radius-sm);
  cursor: pointer;
}
.changye-exclude-count {
  font-size: 12px;
  color: var(--changye-ink-muted);
}

/* ============ 移动端:折叠区内部正文整体收一号,与窄屏标题节奏统一 ============ */
@media (max-width: 640px) {
  .changye-auto-grid {
    grid-template-columns: 1fr;
  }
  /* 渠道参数四连:窄屏一行四个每个只剩几十 px,落成 2×2 */
  .changye-channel-row {
    grid-template-columns: repeat(2, 1fr);
  }
  .changye-channel-item-name {
    font-size: 13px;
  }
  .changye-channel-item-model {
    font-size: 11px;
  }
  /* 渠道弹窗底部:测试按钮窄屏只显短版「测试」,PC 显完整「测试渠道」 */
  .changye-btn-label-full {
    display: none;
  }
  .changye-btn-label-short {
    display: inline;
  }
}
</style>
