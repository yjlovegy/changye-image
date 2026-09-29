<script setup lang="ts">
import { cachedCurrentAppearance, syncCurrentAppearance, saveCurrentAppearance, forgetCurrentAppearance, CURRENT_FIELDS, CURRENT_LABELS, type CurrentField, type CurrentLook } from '@/autoTag/currentAppearance';
import { trackPromptTask } from '@/state/promptTasks';
import BbiTextarea from '@/components/BbiTextarea.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import Icon from '@/components/Icon.vue';
import ModalMask from '@/components/ModalMask.vue';
import { appearanceContextKey, completeCharacterAppearance, type AppearanceCompletion, type AppearanceMode } from '@/autoTag/charCompletion';
import {
  CHAR_PREFERENCE_FIELDS,
  CHAR_PREFERENCE_FIELD_LABELS,
  CHAR_TAG_FIELDS,
  CHAR_TAG_FIELD_LABELS,
  buildEntryTag,
  charTagBaseNames,
  charTagLib,
  emptyCharFields,
  emptyCharPreferences,
  findCharTag,
  removeCharTag,
  rollbackCharTag,
  upsertCharTag,
  type CharTagChangeRecord,
  type CharTagEntry,
  type CharTagField,
  type CharPreferenceField,
} from '@/state/charTags';
import {
  copyGlobalCharTagToChat,
  globalCharTagLib,
  promoteCharTagToGlobal,
  removeGlobalCharTag,
  upsertGlobalCharTag,
} from '@/state/globalCharTags';
import { getContext } from '@/st/context';
import { computed, nextTick, onUnmounted, ref } from 'vue';

/**
 * 角色管理 —— 两层固定外貌库:
 * - 全局库:跨所有聊天生效的只读模板,AI 永不修改,仅手动维护(适合玩家角色等固定形象)。
 * - 本聊天库:仅当前聊天,角色记忆插件自动建档、AI 随剧情变更;同名时优先于全局。
 * 外貌按字段记录(sex/hair/eyes/...),拼接结果即最终 tag;生成 tag 时 AI 照抄库中字段,
 * 残留的 @角色名 占位符由插件兜底替换 —— 外貌稳定不漂移。
 */

type Scope = 'chat' | 'global';

interface Draft {
  name: string;
  fields: Record<CharTagField, string>;
  preferences: Record<CharPreferenceField, string>;
  raw: string;
  nl: string;
}

// editingName:正在编辑的已有条目名;null = 新建。弹窗开关以 draft 是否存在为准。
const editingName = ref<string | null>(null);
// editingScope:被编辑条目所在层;draftScope:草稿保存到哪层(仅新建时可选)。
const editingScope = ref<Scope>('chat');
const draftScope = ref<Scope>('chat');
const draft = ref<Draft | null>(null);
const editorElement = ref<HTMLElement | null>(null);
let opener: HTMLElement | null = null;
function editorKeys(event: KeyboardEvent) {
  if (confirmDeleteOpen.value || confirmPromoteOpen.value || confirmRollbackOpen.value || confirmRawTransitionOpen.value) return;
  if (event.key === 'Escape') { event.preventDefault(); closeEntry(); return; }
  if (event.key !== 'Tab') return;
  const elements = [...(editorElement.value?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select,summary,[tabindex="0"]') ?? [])].filter(e => e.getClientRects().length);
  const first = elements[0], last = elements.at(-1);
  const active = editorElement.value?.getRootNode() as Document | ShadowRoot | undefined;
  if (event.shiftKey && active?.activeElement === first) { event.preventDefault(); last?.focus(); }
  else if (!event.shiftKey && active?.activeElement === last) { event.preventDefault(); first?.focus(); }
}
const draftContextKey = ref<string | null>(null);
// 从整串改成字段时,保存前展示实际生效内容;相同预览在本次编辑中只确认一次。
const draftStartedWithFields = ref(false);
const confirmedFieldPreview = ref<string | null>(null);
const confirmRawTransitionOpen = ref(false);
// 手改内容转 manual；资料补全只补缺项，不改已有档案来源。
const draftSource = ref<CharTagEntry['source']>('manual');
const draftDesc = ref('');
const regenerating = ref(false);
let completionController: AbortController | null = null;
function stopAppearance() { completionController?.abort(); }
const completionSummary = ref('');
const completionEvidence = ref<AppearanceCompletion['evidence']>({});
// 弹窗内历史面板开关
const historyOpen = ref(false);
const editorTab = ref<'base' | 'current' | 'ai'>('base');
const moreOpen = ref(false);
const appearanceMode = ref<AppearanceMode>('fill');
const currentDraft = ref<Record<CurrentField, string>>({ hair: '', outfit: '', accessories: '', other: '' });
let initialCurrent: Record<CurrentField, string> = { hair: '', outfit: '', accessories: '', other: '' };
const currentEvidence = ref<CurrentLook>({});
interface Suggestion { target: 'base' | 'current'; field: CharTagField | CurrentField; before: string; value: string; source: string; quote: string; selected: boolean; }
const suggestions = ref<Suggestion[]>([]);
const currentCount = computed(() => CURRENT_FIELDS.filter(f => currentDraft.value[f]).length);
const currentPreview = computed(() => {
  if (!draft.value) return '';
  const fields = { ...draft.value.fields };
  for (const f of ['hair', 'outfit', 'accessories'] as const) if (currentDraft.value[f]) fields[f] = currentDraft.value[f];
  return [buildEntryTag({ fields, raw: draft.value.raw }), currentDraft.value.other].filter(Boolean).join(', ');
});
function initCurrent(name: string) {
  if (typeof document !== 'undefined') {
    const root = document.activeElement?.shadowRoot;
    opener = (root?.activeElement ?? document.activeElement) as HTMLElement | null;
    void nextTick(() => editorElement.value?.querySelector<HTMLInputElement>('input')?.focus());
  }
  editorTab.value = 'base'; moreOpen.value = false; suggestions.value = [];
  const ctx = getContext();
  currentEvidence.value = ctx ? cachedCurrentAppearance(ctx, charTagLib.entries)[name] ?? {} : {};
  currentDraft.value = Object.fromEntries(CURRENT_FIELDS.map(f => [f, currentEvidence.value[f]?.value ?? ''])) as Record<CurrentField, string>;
  initialCurrent = { ...currentDraft.value };
}
function baseCurrentValue(field: CurrentField): string {
  return field === 'other' ? '' : draft.value?.fields[field] || '';
}
function useSuggestions() {
  if (!draft.value || !guardDraftContext()) return;
  let used = 0, skipped = 0;
  for (const item of suggestions.value.filter(s => s.selected)) {
    const live = item.target === 'base' ? draft.value.fields[item.field as CharTagField] : currentDraft.value[item.field as CurrentField];
    if (live !== item.before) { skipped++; continue; }
    if (item.target === 'base') draft.value.fields[item.field as CharTagField] = item.value;
    else currentDraft.value[item.field as CurrentField] = item.value;
    item.selected = false; used++;
  }
  if (used) markManual();
  completionSummary.value = `已采用 ${used} 项，请保存角色。${skipped ? `另有 ${skipped} 项因草稿已修改而保留原值。` : ''}`;
}

// 回滚确认
const confirmRollbackOpen = ref(false);
const pendingRollback = ref<{ name: string; record: CharTagChangeRecord } | null>(null);

const FIELD_PLACEHOLDERS: Record<CharTagField, string> = {
  fandom: '同人角色填： character name (copyright name), 不带转义括号； 原创留空',
  sex: '如 1girl / 1boy',
  age: '如 adult woman, mature appearance（描述视觉年龄）',
  hair: '如 waist-length black hair, blunt bangs, straight hair',
  face: '如 oval face, narrow chin, defined cheekbones',
  eyes: '如 brown eyes, almond-shaped eyes, long eyelashes',
  eyeShape: '如 almond-shaped eyes, defined upper eyelids, long eyelashes',
  eyebrows: '如 straight eyebrows, thick eyebrows',
  nose: '如 small nose, straight nose bridge',
  mouth: '如 thin lips, defined cupid’s bow',
  ears: '如 pointed ears（只在设定有依据时填写）',
  skin: '如 pale skin, freckles（保留肤色和皮肤细节）',
  height: '如 tall, long legs（身高与比例）',
  body: '如 slim, narrow shoulders, defined waist',
  extra: '如 mole under left eye, scar on right cheek（注明左右与位置）',
  accessories: '如 round glasses, silver stud earrings（长期佩戴）',
  outfit: '如 white collared shirt, navy pleated skirt（角色标志服装，可不填）',
};

const FIELD_GROUPS: { title: string; fields: CharTagField[] }[] = [
  { title: '身份与年龄', fields: ['fandom', 'sex', 'age'] },
  { title: '头发与面部', fields: ['hair', 'face', 'eyes', 'eyeShape', 'accessories'] },
  { title: '更多五官与体态', fields: ['eyebrows', 'nose', 'mouth', 'ears', 'skin', 'height', 'body', 'extra'] },
  { title: '默认服装', fields: ['outfit'] },
];

const PREFERENCE_PLACEHOLDERS: Record<CharPreferenceField, string> = {
  expression: '如：平时神情沉静，微笑时嘴角轻扬；当前剧情有明确情绪时服从剧情',
  gaze: '如：交谈时看向对方的眼睛，思考时稍微垂眸',
  action: '如：紧张时轻捏袖口；只在当前场景适合时使用',
  pose: '如：站立时肩膀放松，坐姿端正；剧情指定姿势时服从剧情',
};

/** 全局库名字集(响应式),用于分区与「覆盖」徽标。 */
const globalNameSet = computed(() => new Set(globalCharTagLib.entries.map(entry => entry.name)));

/**
 * 本聊天分区 = 派生库里「属于本聊天」的条目:
 * 本聊天基线里的(含覆盖全局的同名条目)+ 非全局的(AI 楼层建档等)。
 * 纯全局条目只出现在全局分区。
 */
const chatEntries = computed(() =>
  charTagLib.entries.filter(
    entry => charTagBaseNames.has(entry.name) || !globalNameSet.value.has(entry.name),
  ),
);

/** 有字段时以字段为准;所有字段留空时才使用旧整串。 */
const draftHasRaw = computed(() => !!draft.value?.raw.trim());
const draftHasFields = computed(() => !!draft.value && CHAR_TAG_FIELDS.some(f => draft.value!.fields[f].trim()));
const draftIsRaw = computed(() => draftHasRaw.value && !draftHasFields.value);
const draftHasInactiveRaw = computed(() => draftHasRaw.value && draftHasFields.value);

const previewTag = computed(() => {
  const d = draft.value;
  if (!d) return '';
  return buildEntryTag({ fields: d.fields, raw: d.raw });
});

/** 正在编辑的本聊天条目的实时历史(回滚后随之刷新);全局条目不记历史。 */
const editingHistory = computed<CharTagChangeRecord[]>(() => {
  if (!editingName.value || editingScope.value !== 'chat') return [];
  return findCharTag(editingName.value)?.history ?? [];
});

/** 卡片上的字段 chips:有字段用字段,整串模式回退 raw 文本(模板里分支)。 */
function chipsOf(entry: CharTagEntry): { label: string; value: string }[] {
  const chips: { label: string; value: string }[] = [];
  for (const f of CHAR_TAG_FIELDS) {
    const value = entry.fields[f]?.trim();
    if (value) chips.push({ label: CHAR_TAG_FIELD_LABELS[f], value });
  }
  return chips;
}

function openEntry(entry: CharTagEntry, scope: Scope) {
  completionController?.abort();
  completionController = null;
  regenerating.value = false;
  completionSummary.value = '';
  completionEvidence.value = {};
  const context = getContext();
  draftContextKey.value = context ? appearanceContextKey(context) : null;
  editingName.value = entry.name;
  editingScope.value = scope;
  draftScope.value = scope;
  draft.value = {
    name: entry.name,
    fields: { ...emptyCharFields(), ...entry.fields },
    preferences: { ...emptyCharPreferences(), ...entry.preferences },
    raw: entry.raw,
    nl: entry.nl,
  };
  draftStartedWithFields.value = CHAR_TAG_FIELDS.some(field => entry.fields[field]?.trim());
  confirmedFieldPreview.value = null;
  confirmRawTransitionOpen.value = false;
  draftSource.value = entry.source;
  draftDesc.value = entry.desc;
  historyOpen.value = false;
  initCurrent(entry.name);
}

function addEntry(scope: Scope = 'chat') {
  completionController?.abort();
  completionController = null;
  regenerating.value = false;
  completionSummary.value = '';
  completionEvidence.value = {};
  const context = getContext();
  draftContextKey.value = context ? appearanceContextKey(context) : null;
  editingName.value = null;
  editingScope.value = scope;
  draftScope.value = scope;
  draft.value = { name: '', fields: emptyCharFields(), preferences: emptyCharPreferences(), raw: '', nl: '' };
  draftStartedWithFields.value = false;
  confirmedFieldPreview.value = null;
  confirmRawTransitionOpen.value = false;
  draftSource.value = 'manual';
  draftDesc.value = '';
  historyOpen.value = false;
  initCurrent('');
}

/* —— 分区折叠(参照角色记忆插件「计划/悬念」)——
 * 标题行兼作折叠开关;折叠态是本机视图偏好,走 localStorage、不进设置(跨设备同步没意义)。 */
const COLLAPSE_KEYS: Record<Scope, string> = {
  global: 'bbi.ui.charGlobalCollapsed.v1',
  chat: 'bbi.ui.charChatCollapsed.v1',
};
function loadCollapsed(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}
function persistCollapsed(key: string, value: boolean) {
  try {
    localStorage.setItem(key, value ? '1' : '0');
  } catch {
    /* localStorage 不可用时仅本次会话生效 */
  }
}
const globalCollapsed = ref(loadCollapsed(COLLAPSE_KEYS.global));
const chatCollapsed = ref(loadCollapsed(COLLAPSE_KEYS.chat));
function toggleFold(scope: Scope) {
  const target = scope === 'global' ? globalCollapsed : chatCollapsed;
  target.value = !target.value;
  persistCollapsed(COLLAPSE_KEYS[scope], target.value);
}
// 无条目即无可折叠:不显示箭头与计数,也强制展开(避免删空后卡在收拢的空态)
const globalFoldable = computed(() => globalCharTagLib.entries.length > 0);
const globalShown = computed(() => !globalCollapsed.value || !globalFoldable.value);
const chatFoldable = computed(() => chatEntries.value.length > 0);
const chatShown = computed(() => !chatCollapsed.value || !chatFoldable.value);

function closeEntry() {
  opener?.focus(); opener = null;
  completionController?.abort();
  completionController = null;
  completionSummary.value = '';
  completionEvidence.value = {};
  editingName.value = null;
  draft.value = null;
  draftContextKey.value = null;
  regenerating.value = false;
  historyOpen.value = false;
  confirmRawTransitionOpen.value = false;
  confirmedFieldPreview.value = null;
  confirmDeleteOpen.value = false;
  confirmPromoteOpen.value = false;
  confirmRollbackOpen.value = false;
  pendingRollback.value = null;
}

/** Every mutation belongs to the context in which the draft opened, including global-library actions. */
function guardDraftContext(): boolean {
  if (!draft.value) return false;
  const context = getContext();
  if (context && draftContextKey.value === appearanceContextKey(context)) return true;
  completionController?.abort();
  completionController = null;
  regenerating.value = false;
  toastr.warning('角色卡或聊天已切换，本次操作未执行。请切回原上下文继续，或关闭后重新打开角色。', '长夜的绘图器');
  return false;
}

onUnmounted(closeEntry);

/** 手动编辑过的字段 → 条目归手动(但仍可被 AI 变更接管) */
function markManual() {
  draftSource.value = 'manual';
  draftDesc.value = '';
  completionSummary.value = '';
  completionEvidence.value = {};
}

function confirmEntry() {
  const d = draft.value;
  if (!d || !guardDraftContext()) return;
  const name = d.name.trim();
  if (!name) {
    toastr.warning('角色名不能为空', '长夜的绘图器');
    return;
  }
  if (!previewTag.value) {
    toastr.warning('至少填一个外貌字段（或整串 TAG）', '长夜的绘图器');
    return;
  }
  if (draftHasInactiveRaw.value && !draftStartedWithFields.value && confirmedFieldPreview.value !== previewTag.value) {
    confirmRawTransitionOpen.value = true;
    return;
  }
  const changes: Partial<Record<CurrentField, string>> = {};
  for (const field of CURRENT_FIELDS) {
    if (currentDraft.value[field] !== initialCurrent[field] || (editingName.value && editingName.value !== name && currentDraft.value[field])) changes[field] = currentDraft.value[field].trim();
  }
  const ctx = getContext();
  if (Object.keys(changes).length && (!ctx || !ctx.chat.length)) { toastr.warning('请先开始聊天，再保存当前造型', '长夜的绘图器'); return; }
  const entryData: CharTagEntry = {
    name,
    fields: d.fields,
    preferences: d.preferences,
    raw: d.raw,
    nl: d.nl,
    source: draftSource.value,
    desc: draftDesc.value,
    history: [],
  };
  const ok =
    draftScope.value === 'global'
      ? upsertGlobalCharTag(entryData, editingName.value ?? undefined)
      : upsertCharTag(entryData, editingName.value ?? undefined, { recordChanges: true });
  if (ok) {
    if (ctx && editingName.value && editingName.value !== name) forgetCurrentAppearance(ctx, editingName.value);
    if (ctx && Object.keys(changes).length) saveCurrentAppearance(ctx, name, changes);
    closeEntry();
  }
}

function confirmRawTransition() {
  confirmRawTransitionOpen.value = false;
  confirmedFieldPreview.value = previewTag.value;
  confirmEntry();
}

/* —— 删除:二次确认 —— */
const confirmDeleteOpen = ref(false);
function askRemove() {
  if (!guardDraftContext()) return;
  confirmDeleteOpen.value = true;
}
function confirmRemove() {
  confirmDeleteOpen.value = false;
  if (!editingName.value || !guardDraftContext()) return;
  if (editingScope.value === 'global') removeGlobalCharTag(editingName.value);
  else removeCharTag(editingName.value);
  const context = getContext();
  if (context) forgetCurrentAppearance(context, editingName.value);
  closeEntry();
}

/* —— 提升为全局 / 复制到本聊天 —— */
const confirmPromoteOpen = ref(false);
function askPromote() {
  if (!guardDraftContext()) return;
  confirmPromoteOpen.value = true;
}
function confirmPromote() {
  confirmPromoteOpen.value = false;
  if (!editingName.value || !guardDraftContext()) return;
  if (promoteCharTagToGlobal(editingName.value)) {
    toastr.success(`「${editingName.value}」已提升为全局角色，所有聊天生效`, '长夜的绘图器');
  }
  closeEntry();
}

function copyToChat() {
  if (!editingName.value || !guardDraftContext()) return;
  const name = editingName.value;
  if (copyGlobalCharTagToChat(name)) {
    toastr.success(`已把「${name}」复制到本聊天，之后本聊天以副本为准`, '长夜的绘图器');
  }
  closeEntry();
}

/* —— 显式资料补全:复用角色卡/人设/世界书/角色记忆插件/最近正文,仅填空字段,结果仍由用户保存 —— */
async function completeFromReferences() {
  const d = draft.value;
  if (!d || !guardDraftContext()) return;
  const name = d.name.trim();
  if (!name) {
    toastr.warning('先填写角色名', '长夜的绘图器');
    return;
  }
  const ctx = getContext();
  if (!ctx) {
    toastr.info('当前酒馆上下文不可用，请打开角色后重试', '长夜的绘图器');
    return;
  }
  const contextKey = appearanceContextKey(ctx);
  completionController?.abort();
  const controller = new AbortController();
  completionController = controller;
  regenerating.value = true;
  suggestions.value = [];
  const mode = appearanceMode.value;
  const fieldsAtStart = { ...d.fields };
  const currentAtStart = { ...currentDraft.value };
  const releaseTask = trackPromptTask(controller);
  try {
    const result = await completeCharacterAppearance(ctx, name, {
      fields: { ...d.fields }, raw: d.raw, nl: d.nl,
    }, controller.signal, mode);
    if (draft.value !== d || controller.signal.aborted || d.name.trim() !== name) return;
    const currentContext = getContext();
    if (!currentContext || appearanceContextKey(currentContext) !== contextKey) {
      toastr.info('角色卡或聊天已切换，本次外貌补全未应用', '长夜的绘图器');
      return;
    }
    const next: Suggestion[] = [];
    for (const field of CHAR_TAG_FIELDS) {
      const value = result.fields[field]?.trim();
      if (!value || value === d.fields[field] || d.fields[field] !== fieldsAtStart[field]) continue;
      if (mode === 'fill' && d.fields[field].trim()) continue;
      const evidence = result.evidence[field];
      next.push({ target: 'base', field, before: d.fields[field], value, source: evidence?.source ?? '', quote: evidence?.quote ?? '', selected: true });
    }
    if (mode !== 'fill') {
      const look = (await syncCurrentAppearance(ctx, [{ name, fields: { ...d.fields }, raw: d.raw, nl: d.nl, source: 'manual', desc: '', history: [] }], ctx.chat.length, controller.signal, false))[name];
      if (draft.value !== d || d.name.trim() !== name || controller.signal.aborted || !guardDraftContext()) return;
      for (const field of CURRENT_FIELDS) {
        const item = look?.[field];
        if (!item || item.value === currentDraft.value[field] || currentDraft.value[field] !== currentAtStart[field]) continue;
        next.push({ target: 'current', field, before: currentDraft.value[field], value: item.value, source: `第 ${item.floor} 楼`, quote: item.quote, selected: true });
      }
    }
    suggestions.value = next;
    completionSummary.value = next.length ? `找到 ${next.length} 项建议。` : '没有发现有依据的新修改。';
  } catch (error) {
    if (draft.value === d && !controller.signal.aborted) toastr.error(error instanceof Error ? error.message : String(error), '长夜的绘图器');
  } finally {
    releaseTask();
    if (completionController === controller) {
      completionController = null;
      regenerating.value = false;
    }
  }
}

/* —— 历史展示与回滚(仅本聊天条目) —— */
function fieldLabel(field: CharTagChangeRecord['field']): string {
  if (field === 'new') return '建档';
  if (field === 'raw') return '整串';
  if (field === 'nl') return '自然语言';
  return CHAR_TAG_FIELD_LABELS[field];
}

function askRollback(record: CharTagChangeRecord) {
  if (!editingName.value || !guardDraftContext()) return;
  pendingRollback.value = { name: editingName.value, record };
  confirmRollbackOpen.value = true;
}

function confirmRollback() {
  confirmRollbackOpen.value = false;
  const p = pendingRollback.value;
  pendingRollback.value = null;
  if (!p || !guardDraftContext()) return;
  if (rollbackCharTag(p.name, p.record)) {
    toastr.success(`已回滚「${p.name}」的${fieldLabel(p.record.field)}变更`, '长夜的绘图器');
  } else {
    toastr.warning('回滚失败：条目可能已删除', '长夜的绘图器');
  }
}

function sourceLabel(entry: CharTagEntry): string {
  return entry.source === 'book' ? '角色记忆插件' : entry.source === 'ai' ? 'AI 维护' : '手动';
}
</script>

<template>
  <section class="bbi-page">
    <div class="bbi-page-head">
      <h2 class="bbi-title bbi-title-sub">角色管理</h2>
    </div>
    <hr class="bbi-rule" />

    <p class="bbi-field-hint">
      为角色记录固定外貌与五官细节，生成时作为外貌依据。神态、视线、动作和姿势默认随剧情，也可填写角色偏好。
    </p>
    <p class="bbi-field-hint">
      自动配图和选段配图会为未锁定的结构化档案补齐缺失的脸型、眉形、眼型、鼻形与唇形，已有值优先保留。
    </p>

    <!-- ===== 全局角色库 ===== -->
    <div class="bbi-char-section">
      <div class="bbi-char-section-head">
        <button
          class="bbi-fold-head"
          type="button"
          :class="{ 'is-static': !globalFoldable }"
          :disabled="!globalFoldable"
          :aria-expanded="globalShown"
          :title="globalFoldable ? (globalShown ? '收起全局角色库' : '展开全局角色库') : ''"
          @click="toggleFold('global')"
        >
          <Icon v-if="globalFoldable" name="chevron" class="bbi-fold-caret" :class="{ 'is-collapsed': !globalShown }" />
          <span class="bbi-field-label">全局角色库</span>
          <span v-if="globalFoldable" class="bbi-count">{{ globalCharTagLib.entries.length }}</span>
        </button>
        <button class="bbi-add-mini" type="button" title="添加全局角色" @click="addEntry('global')">
          <Icon name="plus" />
        </button>
      </div>
      <!-- grid 1fr↔0fr 收展:高度自适应、无需写死 max-height -->
      <div class="bbi-fold-wrap" :class="{ 'is-collapsed': !globalShown }">
        <div class="bbi-fold-inner">
          <p class="bbi-field-hint">
            所有聊天生效，仅手动维护——AI 不会修改全局角色，适合玩家角色等固定形象。本聊天有同名角色时以本聊天为准。
          </p>
          <ul v-if="globalCharTagLib.entries.length" class="bbi-char-grid">
          <li v-for="entry in globalCharTagLib.entries" :key="entry.name" class="bbi-char-card">
            <button class="bbi-char-card-btn" type="button" @click="openEntry(entry, 'global')">
              <span class="bbi-char-card-head">
                <span class="bbi-char-name">{{ entry.name }}</span>
                <span class="bbi-char-pills">
                  <span class="bbi-char-pill is-global">全局</span>
                  <span v-if="charTagBaseNames.has(entry.name)" class="bbi-char-pill is-override" title="本聊天有同名角色，当前聊天以本聊天的为准">
                    本聊天已覆盖
                  </span>
                </span>
              </span>
              <span v-if="chipsOf(entry).length" class="bbi-char-chips">
                <span v-for="chip in chipsOf(entry)" :key="chip.label" class="bbi-chip" :title="chip.label">
                  {{ chip.value }}
                </span>
              </span>
              <span v-else class="bbi-char-raw">{{ entry.raw }}</span>
            </button>
          </li>
          </ul>
          <p v-else class="bbi-char-empty">
            还没有全局角色。在本聊天角色的编辑弹窗里点「提升为全局」，或点右上角「+」添加。
          </p>
        </div>
      </div>
    </div>

    <!-- ===== 本聊天角色 ===== -->
    <div class="bbi-char-section">
      <div class="bbi-char-section-head">
        <button
          class="bbi-fold-head"
          type="button"
          :class="{ 'is-static': !chatFoldable }"
          :disabled="!chatFoldable"
          :aria-expanded="chatShown"
          :title="chatFoldable ? (chatShown ? '收起本聊天角色' : '展开本聊天角色') : ''"
          @click="toggleFold('chat')"
        >
          <Icon v-if="chatFoldable" name="chevron" class="bbi-fold-caret" :class="{ 'is-collapsed': !chatShown }" />
          <span class="bbi-field-label">本聊天角色</span>
          <span v-if="chatFoldable" class="bbi-count">{{ chatEntries.length }}</span>
        </button>
        <button class="bbi-add-mini" type="button" title="添加本聊天角色" @click="addEntry('chat')">
          <Icon name="plus" />
        </button>
      </div>
      <div class="bbi-fold-wrap" :class="{ 'is-collapsed': !chatShown }">
        <div class="bbi-fold-inner">
          <p class="bbi-field-hint">
            仅当前聊天生效：根据同步的角色记忆自动建档，AI 随剧情记录永久变化；可查看历史并回滚。
          </p>
          <ul v-if="chatEntries.length" class="bbi-char-grid">
          <li v-for="entry in chatEntries" :key="entry.name" class="bbi-char-card">
            <button class="bbi-char-card-btn" type="button" @click="openEntry(entry, 'chat')">
              <span class="bbi-char-card-head">
                <span class="bbi-char-name">{{ entry.name }}</span>
                <span class="bbi-char-pills">
                  <span
                    class="bbi-char-pill"
                    :class="{ 'is-book': entry.source === 'book', 'is-ai': entry.source === 'ai' }"
                  >
                    {{ sourceLabel(entry) }}
                  </span>
                  <span v-if="globalNameSet.has(entry.name)" class="bbi-char-pill is-override" title="与全局库同名，当前聊天以本条为准">
                    覆盖全局
                  </span>
                  <span
                    v-if="entry.history.length"
                    class="bbi-char-history-badge"
                    :title="`${entry.history.length} 条变更记录,点卡片查看`"
                  >
                    <Icon name="history" />{{ entry.history.length }}
                  </span>
                </span>
              </span>
              <span v-if="chipsOf(entry).length" class="bbi-char-chips">
                <span v-for="chip in chipsOf(entry)" :key="chip.label" class="bbi-chip" :title="chip.label">
                  {{ chip.value }}
                </span>
              </span>
              <span v-else class="bbi-char-raw">{{ entry.raw }}</span>
            </button>
          </li>
          </ul>
          <p v-else class="bbi-char-empty">
            本聊天还没有角色。生成 TAG 时会根据同步的角色记忆自动建档，也可点右上角「+」手动添加。
          </p>
        </div>
      </div>
    </div>

    <!-- ===== 角色编辑弹窗 ===== -->
    <ModalMask :open="!!draft" @close="closeEntry">
      <div v-if="draft" ref="editorElement" class="bbi-modal bbi-char-modal" role="dialog" aria-modal="true" aria-label="编辑角色" @keydown="editorKeys">
        <header class="bbi-modal-head">
          <span class="bbi-modal-title">
            {{ editingName ? '编辑角色' : '添加角色' }}
            <span v-if="editingName" class="bbi-char-pill" :class="editingScope === 'global' ? 'is-global' : 'is-chat'">
              {{ editingScope === 'global' ? '全局' : '本聊天' }}
            </span>
          </span>
          <button class="bbi-icon-mini" type="button" title="关闭" @click="closeEntry"><Icon name="close" /></button>
        </header>

        <div class="bbi-char-identity">
          <label class="bbi-modal-field"><span class="bbi-modal-label">角色名</span><input v-model="draft.name" class="bbi-input" @input="markManual" /></label>
          <label v-if="!editingName" class="bbi-modal-field"><span class="bbi-modal-label">资料范围</span><select v-model="draftScope" class="bbi-input"><option value="chat">本聊天</option><option value="global">全局</option></select></label>
        </div>
        <div class="bbi-char-tabs" role="tablist" aria-label="角色编辑内容">
          <button v-for="tab in (['base','current','ai'] as const)" :id="`bbi-char-tab-${tab}`" :key="tab" role="tab" :aria-selected="editorTab === tab" :aria-controls="`bbi-char-panel-${tab}`" type="button" :class="{ 'is-active': editorTab === tab }" @click="editorTab = tab">{{ tab === 'base' ? '基础外貌' : tab === 'current' ? `当前造型${currentCount ? ` · ${currentCount}` : ''}` : 'AI 整理' }}</button>
        </div>
        <div class="bbi-char-editor-body">
        <section v-show="editorTab === 'base'" id="bbi-char-panel-base" class="bbi-char-panel" role="tabpanel" aria-labelledby="bbi-char-tab-base">
          <template v-for="group in FIELD_GROUPS" :key="group.title">
            <component :is="group.title === '更多五官与体态' ? 'details' : 'fieldset'" class="bbi-char-field-group">
              <component :is="group.title === '更多五官与体态' ? 'summary' : 'legend'" class="bbi-char-group-label">{{ group.title }}</component>
              <div class="bbi-char-form">
                <label v-for="f in group.fields" :key="f" class="bbi-char-form-row" :class="{ 'is-wide': f === 'hair' || f === 'outfit' || f === 'extra' }">
                  <span class="bbi-char-form-label">{{ CHAR_TAG_FIELD_LABELS[f] }}</span>
                  <BbiTextarea v-model="draft.fields[f]" :rows="1" :max-rows="4" :placeholder="FIELD_PLACEHOLDERS[f]" @update:model-value="markManual" />
                </label>
              </div>
            </component>
          </template>
          <details class="bbi-char-field-group"><summary>表情与姿势偏好</summary><div class="bbi-char-form"><label v-for="f in CHAR_PREFERENCE_FIELDS" :key="f" class="bbi-char-form-row"><span class="bbi-char-form-label">{{ CHAR_PREFERENCE_FIELD_LABELS[f] }}</span><BbiTextarea v-model="draft.preferences[f]" :rows="2" :max-rows="5" :placeholder="PREFERENCE_PLACEHOLDERS[f]" @update:model-value="markManual" /></label></div></details>
          <details class="bbi-char-field-group"><summary>高级：整串 TAG 与自然语言外貌</summary>
            <label class="bbi-modal-field"><span class="bbi-modal-label">整串 TAG</span><BbiTextarea v-model="draft.raw" :rows="2" :max-rows="6" mono @update:model-value="markManual" /></label>
            <p v-if="draftHasInactiveRaw" class="bbi-field-hint">当前使用结构字段，整串仅作备份保留。</p>
            <label class="bbi-modal-field"><span class="bbi-modal-label">自然语言外貌</span><BbiTextarea v-model="draft.nl" :rows="2" :max-rows="4" mono @update:model-value="markManual" /></label>
          </details>
          <div class="bbi-char-preview"><span class="bbi-field-label">基础外貌 TAG</span><code class="bbi-char-preview-tag">{{ previewTag || '(空)' }}</code><span class="bbi-char-preview-mode">{{ draftIsRaw ? '整串模式' : '字段模式' }}</span></div>
          <details v-if="editingHistory.length" class="bbi-char-history"><summary>基础资料变更记录</summary><ul class="bbi-char-history-list"><li v-for="(record, i) in [...editingHistory].reverse()" :key="i" class="bbi-char-history-item"><div class="bbi-char-history-main"><span>{{ fieldLabel(record.field) }}：{{ record.from }} → {{ record.to }}</span><span class="bbi-char-history-meta">{{ record.reason }}</span></div><button class="bbi-btn bbi-btn-sm" type="button" @click="askRollback(record)">回滚</button></li></ul></details>
        </section>
        <section v-show="editorTab === 'current'" id="bbi-char-panel-current" class="bbi-char-panel" role="tabpanel" aria-labelledby="bbi-char-tab-current">
          <div class="bbi-char-current-title"><strong>当前造型</strong><span class="bbi-char-pill">仅本聊天</span></div>
          <div v-for="field in CURRENT_FIELDS" :key="field" class="bbi-char-current-row">
            <strong>{{ CURRENT_LABELS[field] }}</strong><div class="bbi-char-current-value">
              <span v-if="baseCurrentValue(field)" class="bbi-field-hint">基础：{{ baseCurrentValue(field) }}</span>
              <label class="bbi-modal-field"><span class="bbi-modal-label">当前使用</span><BbiTextarea v-model="currentDraft[field]" :rows="2" :max-rows="5" :placeholder="field === 'other' ? '未填写' : '留空则沿用基础设定'" /></label>
              <blockquote v-if="currentEvidence[field] && currentDraft[field] === initialCurrent[field]" class="bbi-char-evidence">{{ currentEvidence[field]?.quote === '手动设置' ? '手动设置' : `第 ${currentEvidence[field]?.floor} 楼 · ${currentEvidence[field]?.quote}` }}</blockquote>
              <button v-if="currentDraft[field]" class="bbi-btn bbi-btn-sm bbi-char-restore" type="button" @click="currentDraft[field] = ''">恢复基础{{ CURRENT_LABELS[field] }}</button>
            </div>
          </div>
          <div class="bbi-char-preview"><span class="bbi-field-label">当前生图外貌 TAG</span><code class="bbi-char-preview-tag">{{ currentPreview || '(空)' }}</code></div>
        </section>
        <section v-show="editorTab === 'ai'" id="bbi-char-panel-ai" class="bbi-char-panel" role="tabpanel" aria-labelledby="bbi-char-tab-ai">
          <div class="bbi-char-ai-tools"><button v-for="mode in (['fill','check','extract'] as const)" :key="mode" class="bbi-btn" :class="{ 'bbi-btn-primary': appearanceMode === mode }" :aria-pressed="appearanceMode === mode" :disabled="regenerating" type="button" @click="appearanceMode = mode">{{ mode === 'fill' ? '补全空项' : mode === 'check' ? '检查纠错' : '重新提取' }}</button></div>
          <div class="bbi-char-ai-tools"><button class="bbi-btn" type="button" :disabled="regenerating" @click="completeFromReferences">{{ regenerating ? '整理中…' : '开始整理' }}</button><button v-if="regenerating" class="bbi-btn" type="button" @click="stopAppearance">停止</button><span class="bbi-field-hint" role="status">{{ completionSummary }}</span></div>
          <article v-for="(item, index) in suggestions" :key="index" class="bbi-char-suggestion">
            <header><label><input v-model="item.selected" type="checkbox" /> {{ item.target === 'base' ? CHAR_TAG_FIELD_LABELS[item.field as CharTagField] : CURRENT_LABELS[item.field as CurrentField] }}</label><span class="bbi-char-pill">{{ item.target === 'base' ? '基础外貌' : '当前造型' }}</span></header>
            <div class="bbi-char-form"><div><span class="bbi-modal-label">当前内容</span><p>{{ item.before || '未填写' }}</p></div><label class="bbi-modal-field"><span class="bbi-modal-label">建议内容</span><BbiTextarea v-model="item.value" :rows="2" :max-rows="6" /></label></div>
            <blockquote class="bbi-char-evidence">{{ item.source }} · {{ item.quote }}</blockquote>
          </article>
          <button v-if="suggestions.length" class="bbi-btn bbi-btn-primary bbi-char-restore" :disabled="!suggestions.some(s => s.selected)" type="button" @click="useSuggestions">采用选中项</button>
          <p v-else-if="!regenerating && !completionSummary" class="bbi-field-hint">整理后可逐项核对，采用到草稿后再保存。</p>
        </section>
        </div>
        <div v-if="moreOpen" class="bbi-char-ai-tools">
          <button v-if="editingName" class="bbi-btn bbi-btn-danger" type="button" @click="askRemove"><Icon name="trash" /> 删除角色</button>
          <button v-if="editingName && editingScope === 'chat'" class="bbi-btn" type="button" @click="askPromote">提升为全局</button>
          <button v-if="editingName && editingScope === 'global'" class="bbi-btn" type="button" @click="copyToChat">复制到本聊天</button>
        </div>
        <footer class="bbi-modal-foot">
          <button class="bbi-btn" type="button" :aria-expanded="moreOpen" @click="moreOpen = !moreOpen">更多操作</button><span class="bbi-modal-foot-spacer"></span>
          <button class="bbi-btn" type="button" @click="closeEntry">取消</button><button class="bbi-btn bbi-btn-primary" type="button" :disabled="regenerating" @click="confirmEntry">保存角色</button>
        </footer>

        <ConfirmDialog
          v-model:open="confirmRawTransitionOpen"
          title="确认使用字段外貌"
          confirm-text="按预览保存"
          cancel-text="返回补充"
          top-layer
          @confirm="confirmRawTransition"
        >
          当前使用上方字段，旧整串仅保留为备份。请确认原有外貌中仍需保留的特征已移入字段；也可返回，将上方字段留空继续使用整串。
          <span class="bbi-char-confirm-preview-label">保存后实际生效的外貌 TAG:</span>
          <code class="bbi-char-confirm-preview">{{ previewTag }}</code>
        </ConfirmDialog>

        <ConfirmDialog
          v-model:open="confirmDeleteOpen"
          title="删除角色"
          confirm-text="删除"
          confirm-icon="trash"
          tone="danger"
          top-layer
          @confirm="confirmRemove"
        >
          确定删除「{{ editingName }}」的固定外貌 TAG 吗？之后生成时该角色的外貌将不再锚定。
        </ConfirmDialog>

        <ConfirmDialog
          v-model:open="confirmPromoteOpen"
          title="提升为全局"
          confirm-text="提升"
          confirm-icon="star"
          top-layer
          @confirm="confirmPromote"
        >
          把「{{ editingName }}」的当前外貌快照进全局库？之后所有聊天（包括本聊天）都以全局值为准，
          AI 不能再修改它；本聊天的副本与变更记录将被清除。
        </ConfirmDialog>
      </div>
    </ModalMask>

    <!-- ===== 回滚确认 ===== -->
    <ConfirmDialog
      v-model:open="confirmRollbackOpen"
      title="回滚变更"
      confirm-text="回滚"
      tone="danger"
      top-layer
      @confirm="confirmRollback"
    >
      <template v-if="pendingRollback">
        把「{{ pendingRollback.name }}」的「{{ fieldLabel(pendingRollback.record.field) }}」从
        <code>{{ pendingRollback.record.to }}</code> 回滚到
        <code>{{ pendingRollback.record.from || '(空)' }}</code> ?
        建档记录的回滚会删除整个条目。
      </template>
    </ConfirmDialog>
  </section>
</template>

<style scoped>
/* —— 计数药丸:与设置页版本号同款观感 —— */
.bbi-count {
  border: 0;
  padding: 7px 12px;
  border-radius: var(--bbi-radius-pill);
  background: var(--bbi-surface-2);
  color: var(--bbi-ink-soft);
  font-family: var(--bbi-font-mono);
  font-size: 13px;
  font-weight: 600;
  line-height: 1;
}

/* —— 分区 —— */
.bbi-char-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 20px;
}
.bbi-char-section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

/* —— 折叠开关(参照角色记忆插件「计划/悬念」)——
 * 标题行整体可点:左箭头 + 标题 + 计数标。无框透明,折叠是辅助操作,标题仍是主体。 */
.bbi-fold-head {
  flex: 1 1 auto;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.bbi-fold-head.is-static {
  cursor: default;
}
/* 折叠箭头:展开朝下,收拢转 -90° 朝右。描边继承 currentColor(muted),hover 整行点亮强调色。 */
.bbi-fold-caret {
  flex: 0 0 auto;
  color: var(--bbi-ink-muted);
  transition: transform 0.2s var(--bbi-ease), color 0.15s;
}
.bbi-fold-caret.is-collapsed {
  transform: rotate(-90deg);
}
.bbi-fold-head:hover:not(.is-static) .bbi-fold-caret,
.bbi-fold-head:focus-visible .bbi-fold-caret {
  color: var(--bbi-accent);
}

/* 可收展容器:grid 1fr↔0fr,高度随内容自适应,无需写死 max-height */
.bbi-fold-wrap {
  display: grid;
  grid-template-rows: 1fr;
  transition: grid-template-rows 0.24s var(--bbi-ease);
}
.bbi-fold-wrap.is-collapsed {
  grid-template-rows: 0fr;
}
.bbi-fold-inner {
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* 区头右侧小「+」:透明底,hover 才点亮,不喷宾夺主 */
.bbi-add-mini {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 0;
  border-radius: var(--bbi-radius-sm);
  background: transparent;
  color: var(--bbi-ink-muted);
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}
.bbi-add-mini:hover {
  color: var(--bbi-accent);
  background: var(--bbi-surface-2);
}
.bbi-char-empty {
  margin: 0;
  padding: 14px 16px;
  border: 1px dashed var(--bbi-line);
  border-radius: var(--bbi-radius);
  color: var(--bbi-ink-muted);
  font-size: 12.5px;
}

/* —— 角色卡片网格 —— */
.bbi-char-grid {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 10px;
}
.bbi-char-card {
  min-width: 0;
}
.bbi-char-card-btn {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius);
  background: var(--bbi-surface);
  color: var(--bbi-ink);
  font-family: var(--bbi-font-sans);
  cursor: pointer;
  text-align: left;
  transition:
    border-color var(--bbi-dur) var(--bbi-ease),
    box-shadow var(--bbi-dur) var(--bbi-ease),
    transform var(--bbi-dur) var(--bbi-ease);
}
.bbi-char-card-btn:hover {
  border-color: var(--bbi-accent);
  box-shadow: 0 8px 20px -12px var(--bbi-overlay);
  transform: translateY(-1px);
}
.bbi-char-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-width: 0;
}
.bbi-char-name {
  font-size: 15px;
  font-weight: 600;
  word-break: break-word;
  min-width: 0;
}
.bbi-char-pills {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 6px;
}

/* —— 徽标药丸:全局=实心强调;角色记忆插件/AI=强调浅底;手动=弱化;覆盖=警示色 —— */
.bbi-char-pill {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 9px;
  border-radius: var(--bbi-radius-pill);
  color: var(--bbi-ink-muted);
  background: var(--bbi-surface-2);
  border: 1px solid var(--bbi-line);
  white-space: nowrap;
}
.bbi-char-pill.is-global {
  color: var(--bbi-accent-ink);
  background: var(--bbi-accent);
  border-color: transparent;
}
.bbi-char-pill.is-chat {
  color: var(--bbi-ink-soft);
}
.bbi-char-pill.is-book,
.bbi-char-pill.is-ai {
  color: var(--bbi-accent);
  background: var(--bbi-accent-soft);
  border-color: transparent;
}
.bbi-char-pill.is-override {
  color: var(--bbi-warning);
  background: var(--bbi-warning-soft);
  border-color: transparent;
}

/* —— 字段 chips:两行封顶,超出裁切 —— */
.bbi-char-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  max-height: 52px;
  overflow: hidden;
}
.bbi-chip {
  font-family: var(--bbi-font-mono);
  font-size: 11px;
  padding: 3px 9px;
  border-radius: var(--bbi-radius-pill);
  background: var(--bbi-surface-2);
  color: var(--bbi-ink-soft);
  border: 1px solid var(--bbi-line);
  white-space: nowrap;
}
/* 整串模式:mono 小字两行截断 */
.bbi-char-raw {
  font-family: var(--bbi-font-mono);
  font-size: 12px;
  color: var(--bbi-ink-muted);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
}
.bbi-char-history-badge {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-family: var(--bbi-font-mono);
  font-size: 11px;
  color: var(--bbi-ink-muted);
}

/* —— 弹窗加宽,容纳两列字段表单 —— */
.bbi-char-modal {
  max-width: 900px;
  overflow: hidden;
}
.bbi-char-modal > * { flex-shrink: 0; }
.bbi-char-editor-body { overflow: auto; min-height: 0; flex: 1 1 auto; padding: 2px; }
.bbi-char-panel { display: flex; flex-direction: column; gap: 18px; }
.bbi-char-identity { display: grid; grid-template-columns: 1fr auto; gap: 16px; }
.bbi-char-tabs { display: flex; gap: 22px; border-bottom: 1px solid var(--bbi-line); }
.bbi-char-tabs button { border: 0; border-bottom: 3px solid transparent; background: none; color: var(--bbi-ink-muted); padding: 10px 0; font: inherit; cursor: pointer; }
.bbi-char-tabs button.is-active { color: var(--bbi-accent); border-bottom-color: var(--bbi-accent); }
.bbi-char-field-group summary { cursor: pointer; font-size: 13px; }
.bbi-char-field-group[open] > summary { margin-bottom: 14px; }
.bbi-char-current-title,.bbi-char-suggestion header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.bbi-char-current-row { display: grid; grid-template-columns: 90px 1fr; gap: 18px; padding: 12px 0; border-bottom: 1px solid var(--bbi-line); }
.bbi-char-current-value { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.bbi-char-evidence { margin: 0; border-left: 2px solid var(--bbi-accent); padding: 10px 12px; background: var(--bbi-surface-2); color: var(--bbi-ink-muted); font-size: 12px; overflow-wrap: anywhere; }
.bbi-char-restore { align-self: flex-end; }
.bbi-char-ai-tools { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.bbi-char-suggestion { border: 1px solid var(--bbi-line); border-radius: var(--bbi-radius-sm); padding: 14px; display: grid; gap: 14px; }
.bbi-char-suggestion label { display: flex; gap: 8px; align-items: center; }
.bbi-char-suggestion .bbi-modal-field { align-items: stretch; }
.bbi-char-suggestion p { overflow-wrap: anywhere; }
@media (max-width: 640px) {
  .bbi-char-current-row { grid-template-columns: 1fr; gap: 10px; }
  .bbi-char-tabs { gap: 18px; }

}

/* —— 按外貌部位分组,延续现有浅边框与两列表单 —— */
.bbi-char-field-group {
  min-width: 0;
  margin: 0;
  padding: 12px;
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius-sm);
}
.bbi-char-group-label {
  padding: 0 5px;
  color: var(--bbi-ink-soft);
  font-size: 12px;
  font-weight: 600;
}
.bbi-char-preferences > .bbi-field-hint {
  margin: 0 0 10px;
}
.bbi-char-form {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px 12px;
}
.bbi-char-form-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.bbi-char-form-row.is-wide {
  grid-column: 1 / -1;
}
.bbi-char-form-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--bbi-ink-soft);
}

/* —— 弹窗内历史面板 —— */
.bbi-char-history {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.bbi-char-history-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  align-self: flex-start;
  border: 0;
  background: none;
  padding: 2px 6px;
  color: var(--bbi-ink-muted);
  font-size: 12px;
  font-family: var(--bbi-font-sans);
  cursor: pointer;
  border-radius: var(--bbi-radius-sm);
}
.bbi-char-history-toggle:hover {
  color: var(--bbi-accent);
  background: var(--bbi-surface-2);
}
.bbi-char-history-caret {
  display: inline-flex;
  transition: transform var(--bbi-dur) var(--bbi-ease);
}
.bbi-char-history-caret.is-open {
  transform: rotate(180deg);
}
.bbi-char-history-list {
  list-style: none;
  margin: 0;
  padding: 10px 12px;
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface-2);
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 240px;
  overflow-y: auto;
}
.bbi-char-history-item {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}
.bbi-char-history-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.bbi-char-history-field {
  font-size: 11px;
  font-weight: 600;
  color: var(--bbi-accent);
}
.bbi-char-history-change {
  font-family: var(--bbi-font-mono);
  font-size: 12px;
  color: var(--bbi-ink);
  word-break: break-word;
}
.bbi-char-history-reason {
  font-size: 12px;
  color: var(--bbi-ink-muted);
}
.bbi-char-history-meta {
  font-size: 11px;
  color: var(--bbi-ink-muted);
}

/* —— 最终 tag 预览 —— */
.bbi-char-preview {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface-2);
}
.bbi-char-preview-tag {
  flex: 1 1 auto;
  flex-basis: 100%;
  min-width: 0;
  font-family: var(--bbi-font-mono);
  font-size: 12px;
  color: var(--bbi-ink);
  word-break: break-word;
}
.bbi-char-preview-mode {
  flex: 0 0 auto;
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: var(--bbi-radius-pill);
  color: var(--bbi-ink-muted);
  background: var(--bbi-surface);
  border: 1px solid var(--bbi-line);
}
.bbi-char-raw-notice {
  margin: 0;
  padding: 10px 12px;
  border: 1px solid var(--bbi-warning);
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-warning-soft);
  color: var(--bbi-ink);
  font-size: 12px;
  line-height: 1.7;
}
.bbi-char-confirm-preview-label {
  display: block;
  margin-top: 10px;
  font-weight: 600;
}
.bbi-char-confirm-preview {
  display: block;
  margin-top: 4px;
  padding: 8px;
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface-2);
  color: var(--bbi-ink);
  font-family: var(--bbi-font-mono);
  font-size: 12px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.bbi-icon-mini {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: 1px solid var(--bbi-line-strong);
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface);
  color: var(--bbi-ink-soft);
  cursor: pointer;
  font-size: 14px;
}
.bbi-icon-mini:hover {
  color: var(--bbi-accent);
  border-color: var(--bbi-accent);
}

.bbi-modal-foot {
  flex-wrap: wrap;
}
.bbi-modal-foot-spacer {
  flex: 1 1 auto;
}
.bbi-btn-danger {
  color: var(--bbi-danger);
  border-color: var(--bbi-line-strong);
}
.bbi-btn-danger:hover {
  color: var(--bbi-danger);
  border-color: var(--bbi-danger);
  background: var(--bbi-danger-soft);
}

@media (max-width: 640px) {
  .bbi-char-grid {
    grid-template-columns: 1fr;
  }
  .bbi-char-form {
    grid-template-columns: 1fr;
  }
  .bbi-char-name {
    font-size: 14px;
  }
}
</style>
