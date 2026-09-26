<script setup lang="ts">
import { getWorkflowPlaceholders, testComfyConnection } from '@/backends/comfyui';
import {
  configureWorkflowWithAi,
  type WorkflowAssistResult,
  type WorkflowBindingPurpose,
} from '@/backends/comfyWorkflowAssistant';
import ComfyLoraControls from './ComfyLoraControls.vue';
import ComfyModelControls from './ComfyModelControls.vue';
import ComfyAutoRepair from './ComfyAutoRepair.vue';
import ComfyWorkflowJson from './ComfyWorkflowJson.vue';
import WorkflowResolution from './WorkflowResolution.vue';
import WorkflowExample from './WorkflowExample.vue';
import { cleanUnusedWorkflowExample } from '@/st/workflowExamples';
import BbiSelect from '@/components/BbiSelect.vue';
import BbiTextarea from '@/components/BbiTextarea.vue';
import Collapsible from '@/components/Collapsible.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import Icon from '@/components/Icon.vue';
import ModalMask from '@/components/ModalMask.vue';
import { confirmDialog } from '@/components/confirm';
import { registerPanelLeaveGuard, leavePanel } from '@/state/ui';
import {
  effectiveComfyConn,
  newComfyWorkflow,
  settings,
  savedComfyPreset,
  comfyWorkflowDrafts,
  saveComfyWorkflow,
  comfyExampleOwners,
} from '@/state/settings';
import { computed, nextTick, ref, onBeforeUnmount, onMounted } from 'vue';

const testing = ref(false);
const configuring = ref(false);
const assistOpen = ref(false);
const assistDraft = ref('');
const assistResult = ref<WorkflowAssistResult | null>(null);
/** AI 预览针对哪一套:预览期间用户可能切走或删掉,应用时按 id 回写而不是写「当前」。 */
const assistTargetId = ref('');
const confirmDeleteOpen = ref(false);

/** 本渠道是否为当前出图渠道;「使用此渠道」按钮与设置页选择器、页签徽标同属一个开关。 */
const inUse = computed(() => settings.defaultBackend === 'comfyui');

/* ============ 工作流库 ============ */

/** Edit a runtime draft; the persisted preset changes only at the explicit save boundary. */
const active = computed(() => comfyWorkflowDrafts.edit(savedComfyPreset()));
const revision = ref(0);
const editorKey = computed(() => `${active.value.id}:${revision.value}`);
const modelEditor = ref<InstanceType<typeof ComfyModelControls>>();
const loraEditor = ref<InstanceType<typeof ComfyLoraControls>>();
const jsonEditor = ref<InstanceType<typeof ComfyWorkflowJson>>();
const sizeEditor = ref<InstanceType<typeof WorkflowResolution>>();
const repairEditor = ref<InstanceType<typeof ComfyAutoRepair>>();
const exampleEditor = ref<InstanceType<typeof WorkflowExample>>();
const saving = ref(false), saveStatus = ref(''), saveError = ref('');
const dirty = computed(() => comfyWorkflowDrafts.dirty(active.value.id) || renaming.value
  || modelEditor.value?.dirty || loraEditor.value?.dirty || jsonEditor.value?.dirty
  || sizeEditor.value?.dirty || repairEditor.value?.dirty);
const leaveOpen = ref(false);
let resolveLeave: ((allowed: boolean) => void) | undefined;

/** Gather all visible inputs first; a validation failure must not partly save a workflow. */
async function applyTemporary(): Promise<void> {
  if (exampleEditor.value?.busy || configuring.value) throw new Error('图片或工作流正在处理，请完成后再保存');
  commitRename();
  const target = active.value;
  if (jsonEditor.value?.dirty && (modelEditor.value?.dirty || loraEditor.value?.dirty)) {
    throw new Error('JSON 与模型或 LoRA 同时有未应用修改，请先处理 JSON，再修改对应控件，避免互相覆盖');
  }
  let workflow = jsonEditor.value?.prepare() ?? target.workflow;
  const model = modelEditor.value?.prepare(workflow);
  if (model) workflow = model.workflow;
  workflow = loraEditor.value?.prepare(workflow) ?? workflow;
  if (workflow.trim()) getWorkflowPlaceholders(workflow);
  const defaultSize = sizeEditor.value?.prepare() ?? target.defaultSize;
  const autoRepair = await repairEditor.value?.prepare(workflow) ?? target.autoRepair;
  if (active.value !== target) throw new Error('当前工作流已变化，请重新操作');
  Object.assign(target, { workflow, defaultSize, autoRepair, promptMode: model?.promptMode ?? target.promptMode });
  revision.value++;
  await nextTick();
}

async function saveCurrent(): Promise<boolean> {
  if (saving.value) return false;
  saving.value = true; saveError.value = ''; saveStatus.value = '';
  const previousImage = savedComfyPreset().exampleImage;
  try {
    await applyTemporary();
    saveComfyWorkflow(active.value.id);
    await nextTick();
    saveStatus.value = '已保存';
    await cleanUnusedWorkflowExample(previousImage, comfyExampleOwners);
    return true;
  } catch (error) { saveError.value = errorMessage(error); return false; }
  finally { saving.value = false; }
}

async function discardCurrent(ask = true): Promise<boolean> {
  if (exampleEditor.value?.busy || saving.value) return false;
  if (ask && !await confirmDialog({title:'放弃当前修改',text:'恢复到这套工作流上次保存的配置，临时修改将被丢弃。',confirmText:'放弃修改',cancelText:'继续编辑'})) return false;
  const previousImage = active.value.exampleImage;
  comfyWorkflowDrafts.discard(active.value.id);
  renaming.value = false; revision.value++; saveError.value = ''; saveStatus.value = '已恢复上次保存';
  await cleanUnusedWorkflowExample(previousImage, comfyExampleOwners);
  return true;
}

function finishLeave(allowed: boolean) { leaveOpen.value = false; resolveLeave?.(allowed); resolveLeave = undefined; }
async function leaveWith(choice: 'save' | 'keep' | 'discard') {
  if (choice === 'save') { if (await saveCurrent()) finishLeave(true); return; }
  if (choice === 'discard') { if (await discardCurrent(false)) finishLeave(true); return; }
  if (saving.value) return;
  saving.value = true; saveError.value = '';
  try { await applyTemporary(); finishLeave(true); }
  catch (error) { saveError.value = errorMessage(error); }
  finally { saving.value = false; }
}
const unregisterLeave = registerPanelLeaveGuard(async () => {
  if (saving.value || exampleEditor.value?.busy || configuring.value) { saveError.value = '正在处理，请稍后再操作'; return false; }
  if (!dirty.value) return true;
  leaveOpen.value = true;
  return new Promise<boolean>(resolve => { resolveLeave = resolve; });
});
function beforeUnload(event: BeforeUnloadEvent) {
  if (dirty.value || comfyWorkflowDrafts.values().some(p=>comfyWorkflowDrafts.dirty(p.id))) { event.preventDefault(); event.returnValue = ''; }
}
onMounted(() => window.addEventListener('beforeunload', beforeUnload));
onBeforeUnmount(() => { unregisterLeave(); finishLeave(false); window.removeEventListener('beforeunload', beforeUnload); });

const workflowOptions = computed(() =>
  settings.comfyui.workflows.map(w => ({ value: w.id, label: `${comfyWorkflowDrafts.current(w).name || '未命名工作流'}${comfyWorkflowDrafts.dirty(w.id) ? ' · 未保存' : ''}` })),
);

/**
 * 下拉的值取「实际生效的那一套」而非存的 id:存的 id 悬空时
 * activeComfyPreset 会回落第一条,下拉也该跟着显示第一条,不能显示空白。
 */
const activeId = computed<string>({
  get: () => active.value.id,
  set: id => {
    if (id !== active.value.id) void leavePanel(() => { settings.comfyui.activeWorkflowId = id; saveStatus.value = ''; saveError.value = ''; });
  },
});

/** 只剩一套时不给删:workflows 恒非空是全局不变式,禁用比「点了没反应」诚实。 */
const canRemove = computed(() => settings.comfyui.workflows.length > 1);

function switchTo(preset: { id: string }) {
  settings.comfyui.activeWorkflowId = preset.id;
}

/** 改名是低频操作:平时只显示下拉,点「改名」才把选择器原地换成输入框,省掉常驻的名称行。 */
const renaming = ref(false);
const renameDraft = ref('');
const renameInput = ref<HTMLInputElement | null>(null);

function startRename() {
  renameDraft.value = active.value.name;
  renaming.value = true;
  nextTick(() => renameInput.value?.focus());
}

/** Enter / 失焦都算确认;Esc 直接置 renaming=false 不经过这里,即为取消。 */
function commitRename() {
  if (renaming.value) active.value.name = renameDraft.value.trim();
  renaming.value = false;
}

function addWorkflow() { void leavePanel(() => {
  const preset = newComfyWorkflow(`工作流 ${settings.comfyui.workflows.length + 1}`);
  settings.comfyui.workflows.push(preset);
  switchTo(preset);
}); }

function duplicateWorkflow() { void leavePanel(() => {
  // 拷全部字段(JSON/开关/尺寸一起复制),只换 id 与名字;id 生成仍由 settings 统一口径。
  // simple 是嵌套对象(含 loras 数组),必须深拷——浅拷会让两套预设共享同一份参数。
  const preset = {
    ...JSON.parse(JSON.stringify(active.value)),
    id: newComfyWorkflow().id,
    name: `${active.value.name} 副本`,
    simple: {
      ...active.value.simple,
      loras: active.value.simple.loras.map(lora => ({ ...lora })),
    },
  };
  settings.comfyui.workflows.push(preset);
  switchTo(preset);
}); }

async function confirmRemoveWorkflow() {
  confirmDeleteOpen.value = false;
  const list = settings.comfyui.workflows;
  if (list.length <= 1) return;
  const index = list.findIndex(w => w.id === active.value.id);
  if (index < 0) return;
  const [removed] = list.splice(index, 1);
  comfyWorkflowDrafts.discard(removed.id);
  // 删掉的是当前项:接位到原位置那一条(已是最后一条则退一格)
  settings.comfyui.activeWorkflowId = list[Math.min(index, list.length - 1)].id;
  if (!await cleanUnusedWorkflowExample(removed.exampleImage, comfyExampleOwners)) {
    toastr.warning('工作流已删除，示例图文件清理失败，可在示例图目录手动清理');
  }
}

const fixedNegativeIssue = computed(() => {
  if (!active.value.workflow.trim()) return '';
  try { return getWorkflowPlaceholders(active.value.workflow).includes('negative_prompt') ? '' : '此工作流没有 %negative_prompt% 输入。填写固定负面后需先配置该占位符，才能生效。'; }
  catch { return ''; }
});

function errorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') return '操作已取消';
  return error instanceof Error ? error.message : String(error);
}

async function onTestConnection() {
  if (testing.value) return;
  testing.value = true;
  try {
    const result = await testComfyConnection(effectiveComfyConn());
    toastr.success(result.mode === 'server' ? 'ComfyUI 连接正常（ST 后端转发）' : 'ComfyUI 连接正常（浏览器直连）');
  } catch (error) {
    toastr.error(errorMessage(error), 'ComfyUI 连接失败');
  } finally {
    testing.value = false;
  }
}

const purposeLabels: Record<WorkflowBindingPurpose, string> = {
  positive_tag: '正向 TAG',
  positive_nl: '独立自然语言',
  positive_combined: '正向 TAG + 自然语言共用',
  negative: '负面提示词',
  seed: '随机种子',
  width: '主画布宽度',
  height: '主画布高度',
};

async function onAutoConfigure() {
  if (configuring.value || !active.value.workflow.trim()) return;
  configuring.value = true;
  const targetId = active.value.id;
  try {
    const result = await configureWorkflowWithAi(active.value.workflow);
    if (!result.changes.length) {
      toastr.info('工作流中的动态参数已经配置，无需修改', '长夜的绘图器');
      return;
    }
    assistResult.value = result;
    assistDraft.value = result.workflow;
    assistTargetId.value = targetId;
    assistOpen.value = true;
  } catch (error) {
    toastr.error(errorMessage(error), 'AI 配置工作流失败');
  } finally {
    configuring.value = false;
  }
}

function closeAssist() {
  assistOpen.value = false;
  assistResult.value = null;
  assistDraft.value = '';
  assistTargetId.value = '';
}

function applyAssist() {
  try {
    const savedTarget = settings.comfyui.workflows.find(w => w.id === assistTargetId.value);
    if (!savedTarget) throw new Error('目标工作流已被删除，请重新配置');
    const target = comfyWorkflowDrafts.edit(savedTarget);
    const placeholders = getWorkflowPlaceholders(assistDraft.value);
    if (!placeholders.includes('prompt') && !placeholders.includes('nl')) throw new Error('预览工作流缺少 %prompt% 或 %nl% 正向占位符');
    target.workflow = assistDraft.value;
    const name = target.name;
    closeAssist();
    toastr.success(`已应用 AI 配置的工作流（${name}）`, '长夜的绘图器');
  } catch (error) {
    toastr.error(errorMessage(error), '工作流无法应用');
  }
}
</script>

<template>
  <div class="panel">
    <div class="bbi-sections">
      <Collapsible title="配置" :open="false">
        <div class="api-row">
          <span class="bbi-field-label">URL</span>
          <input
            class="bbi-input"
            type="text"
            v-model="settings.comfyui.url"
            placeholder="http://127.0.0.1:8188"
            spellcheck="false"
          />
        </div>

        <div class="conn-actions">
          <span v-if="inUse" class="conn-inuse"><Icon name="check" :size="13" /> 当前出图渠道</span>
          <button
            v-else
            class="bbi-btn conn-use"
            type="button"
            @click="settings.defaultBackend = 'comfyui'"
          >
            使用此渠道出图
          </button>
          <button class="bbi-btn" type="button" :disabled="testing" @click="onTestConnection">
            <Icon name="plug" />
            {{ testing ? '连接中…' : '测试连接' }}
          </button>
        </div>
      </Collapsible>

      <Collapsible title="工作流" :open="false">
        <fieldset class="wf-edit-fieldset" :disabled="saving">
        <div class="wf-row">
          <span class="bbi-field-label">当前工作流</span>
          <input
            v-if="renaming"
            ref="renameInput"
            class="bbi-input"
            type="text"
            v-model="renameDraft"
            placeholder="工作流名称"
            spellcheck="false"
            title="Enter 确认，Esc 取消"
            @keydown.enter.prevent="commitRename"
            @keydown.esc.stop.prevent="renaming = false"
            @blur="commitRename"
          />
          <BbiSelect
            v-else
            class="wf-select"
            v-model="activeId"
            :options="workflowOptions"
            aria-label="当前工作流"
          />
          <span v-if="!renaming" class="wf-ops">
            <button
              class="bbi-icon-btn wf-op"
              type="button"
              title="重命名当前工作流"
              aria-label="重命名当前工作流"
              @click="startRename"
            >
              <Icon name="edit" :size="14" />
            </button>
            <button
              class="bbi-icon-btn wf-op"
              type="button"
              title="新建一套空工作流"
              aria-label="新建一套空工作流"
              @click="addWorkflow"
            >
              <Icon name="plus" :size="14" />
            </button>
            <button
              class="bbi-icon-btn wf-op"
              type="button"
              title="复制当前工作流(含开关与尺寸)"
              aria-label="复制当前工作流"
              @click="duplicateWorkflow"
            >
              <Icon name="copy" :size="14" />
            </button>
            <button
              class="bbi-icon-btn wf-op wf-remove"
              type="button"
              :disabled="!canRemove"
              :title="canRemove ? '删除当前工作流' : '至少要保留一套工作流'"
              aria-label="删除当前工作流"
              @click="confirmDeleteOpen = true"
            >
              <Icon name="trash" :size="14" />
            </button>
          </span>
        </div>

        <div class="wf-save-row">
          <span role="status" :class="{'wf-unsaved':dirty}">{{ dirty ? '有未保存修改' : saveStatus || '已保存' }}</span>
          <button type="button" class="bbi-btn" :disabled="!dirty || saving" @click="discardCurrent()">放弃修改</button>
          <button type="button" class="bbi-btn bbi-btn-primary" :disabled="!dirty || saving" @click="saveCurrent">{{saving ? '保存中…' : '保存当前工作流'}}</button>
        </div>
        <p class="bbi-field-hint">临时修改可用于试图；保存后才覆盖原配置，放弃修改可恢复。收藏库仍单独自动保存。</p>
        <p v-if="saveError" class="wf-fixed-warning" role="alert">{{saveError}}</p>
        <!-- 分界:线以下的开关、尺寸与 JSON 均跟随当前选中的这一套 -->
        <hr class="wf-divider" />
        <div :key="editorKey">

        <WorkflowExample ref="exampleEditor" :preset="active" />

        <ComfyModelControls ref="modelEditor" v-model:workflow="active.workflow" v-model:prompt-mode="active.promptMode" :url="settings.comfyui.url" />
        <ComfyAutoRepair ref="repairEditor" :preset="active" />
        <WorkflowResolution ref="sizeEditor" :preset="active" />

        <section class="wf-group" aria-label="固定生图提示词">
          <div class="wf-group-head"><span class="bbi-field-label">固定生图提示词</span></div>
          <p class="bbi-field-hint">临时用于当前工作流；点击「保存当前工作流」后保留。</p>
          <div class="wf-prompts">
            <div class="wf-fixed-field"><span class="bbi-field-label">固定正面 · 最前面</span><BbiTextarea v-model="active.fixedPrompts.positivePrefix" :rows="2" :max-rows="8" aria-label="固定正面最前面" placeholder="例如 illustration, soft lighting" /></div>
            <div class="wf-fixed-field"><span class="bbi-field-label">固定正面 · 最后面</span><BbiTextarea v-model="active.fixedPrompts.positiveSuffix" :rows="2" :max-rows="8" aria-label="固定正面最后面" placeholder="放在本次画面描述之后的固定内容" /></div>
            <div class="wf-fixed-field"><span class="bbi-field-label">固定负面</span><BbiTextarea v-model="active.fixedPrompts.negative" :rows="2" :max-rows="8" aria-label="固定负面" placeholder="例如 blurry, watermark" /></div>
          </div>
          <p class="bbi-field-hint">顺序：固定正面最前面 → 本次提示词和英文描述 → 固定正面最后面。固定负面与本次负面内容合并。</p>
          <p v-if="fixedNegativeIssue" class="wf-fixed-warning">{{ fixedNegativeIssue }}</p>
        </section>

        <ComfyLoraControls ref="loraEditor" :workflow-id="active.id" v-model:workflow="active.workflow" v-model:backup="active.loraWorkflowBackup" v-model:favorites="settings.comfyui.loraFavorites" />
        <ComfyWorkflowJson ref="jsonEditor" v-model="active.workflow" :name="active.name" :configuring="configuring" @assist="onAutoConfigure" />
        </div>
        </fieldset>
      </Collapsible>
    </div>

    <ModalMask :open="leaveOpen" top-layer @close="!saving && finishLeave(false)">
      <section class="bbi-modal" role="dialog" aria-modal="true" aria-label="工作流有未保存修改">
        <header class="bbi-modal-head"><span class="bbi-modal-title">工作流有未保存修改</span></header>
        <p>「{{active.name}}」的修改尚未保存。保留临时修改可继续试图，刷新页面后恢复为上次保存的配置。</p>
        <p v-if="saveError" class="wf-fixed-warning" role="alert">{{saveError}}</p>
        <footer class="wf-leave-actions">
          <button class="bbi-btn" :disabled="saving" @click="finishLeave(false)">取消</button>
          <button class="bbi-btn" :disabled="saving" @click="leaveWith('discard')">放弃修改</button>
          <button class="bbi-btn" :disabled="saving" @click="leaveWith('keep')">保留临时修改</button>
          <button class="bbi-btn bbi-btn-primary" :disabled="saving" @click="leaveWith('save')">保存并继续</button>
        </footer>
      </section>
    </ModalMask>

    <ConfirmDialog
      v-model:open="confirmDeleteOpen"
      title="删除工作流"
      confirm-text="删除"
      confirm-icon="trash"
      tone="danger"
      @confirm="confirmRemoveWorkflow"
    >
      确定删除工作流「{{ active.name || '未命名工作流' }}」？删除后无法恢复。
    </ConfirmDialog>

    <ModalMask :open="assistOpen" @close="closeAssist">
      <div
        v-if="assistResult"
        class="bbi-modal workflow-assist-modal"
        role="dialog"
        aria-modal="true"
        aria-label="预览 AI 配置的工作流"
      >
        <header class="bbi-modal-head">
          <span class="bbi-modal-title">预览工作流修改</span>
          <button class="bbi-icon-btn" type="button" aria-label="关闭" @click="closeAssist">
            <Icon name="close" />
          </button>
        </header>

        <p class="bbi-field-hint">原文与宏由本地重建，AI 只返回节点用途；请检查后再应用。</p>
        <div class="workflow-change-list">
          <div
            v-for="change in assistResult.changes"
            :key="`${change.node}:${change.input}`"
            class="workflow-change"
          >
            <span class="workflow-change-role">{{ purposeLabels[change.purpose] }}</span>
            <code>{{ change.node }}.inputs.{{ change.input }}</code>
          </div>
        </div>

        <BbiTextarea v-model="assistDraft" :rows="10" :max-rows="24" mono />

        <p v-if="assistResult.nlMode !== 'none'" class="workflow-detection">
          自然语言：{{ assistResult.nlMode === 'combined' ? '与正向 TAG 共用输入' : '使用独立输入' }}
        </p>
        <p v-if="assistResult.hasNegative" class="workflow-detection">
          已配置动态负面词；AI 每张必须返回本画面负面词，空结果会按重试设置重新请求。
        </p>

        <footer class="bbi-modal-foot">
          <span class="bbi-modal-foot-spacer"></span>
          <button class="bbi-btn" type="button" @click="closeAssist">取消</button>
          <button class="bbi-btn bbi-btn-primary" type="button" @click="applyAssist">
            <Icon name="check" />
            应用工作流
          </button>
        </footer>
      </div>
    </ModalMask>
  </div>
</template>

<style scoped>
.wf-edit-fieldset{border:0;padding:0;margin:0;min-width:0}.wf-save-row{display:flex;align-items:center;justify-content:flex-end;gap:10px;flex-wrap:wrap;margin:10px 0}.wf-save-row>span{margin-right:auto;font-size:13px;color:var(--bbi-ink-muted)}.wf-save-row>span.wf-unsaved{color:var(--bbi-accent)}.wf-save-row .bbi-btn,.wf-leave-actions .bbi-btn{display:inline-flex;align-items:center;justify-content:center;min-height:38px;line-height:1.4}.wf-leave-actions{display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap;margin-top:20px}
.wf-sizes { display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin:18px 0; }
.wf-size-field { display:grid;gap:8px;min-width:0; }
.wf-group { margin:18px 0;padding:16px;border:1px solid var(--bbi-line);border-radius:var(--bbi-radius-sm); }
.wf-group-head { margin-bottom:10px; }.wf-prompts { display:grid;gap:16px;margin:14px 0; }
@media(max-width:520px) { .wf-sizes { grid-template-columns:minmax(0,1fr); } }

.wf-fixed-field { display: flex; flex-direction: column; gap: 7px; min-width: 0; }
.wf-fixed-warning { font-size: 13px; color: var(--bbi-warning, #906100); overflow-wrap: anywhere; }
/* 工作流选择行:grid 而非 flex——靠 flex-basis 撑出的对齐一 wrap 就散,
   固定首列宽让标签列与下方 switch/num 行的标签列同起点。 */
.wf-row {
  display: grid;
  grid-template-columns: 5.5em minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  padding: 8px 0;
}
.wf-row > .bbi-field-label:first-child {
  white-space: nowrap;
}
.wf-row > .bbi-input {
  min-width: 0;
}
/* 下拉不吃满:名称通常很短,拉满只会拖出半截空白(子组件根类默认 180px/不伸缩,此处 0,2,0 压过) */
.wf-row > .wf-select {
  width: auto;
  max-width: 320px;
  min-width: 0;
}
.wf-ops {
  display: flex;
  gap: 4px;
  justify-self: end;
}
/* 四个操作是低频且同级的,图标化后整行只剩下拉一个视觉重点;
   文案退到 title/aria-label,不损失可达性。 */
.wf-op {
  width: 30px;
  height: 30px;
  font-size: 13px;
}
.wf-op:disabled {
  opacity: 0.4;
  cursor: default;
}
/* 选择器与预设内容的分界:线以下均跟随当前这套工作流 */
.wf-divider {
  border: 0;
  border-top: 1px dashed var(--bbi-line);
  margin: 4px 0;
}
/* 开关自带下留白,说明文字只需补一点上间距(base.css 的 .bbi-input + hint 规则不覆盖此组合) */
.wf-switch-hint {
  margin: 2px 0 6px;
}
/* 尺寸输入:比 .bbi-num 宽一点(要装「1024×1536」),但不右对齐——「宽×高」是文本不是数值 */
.wf-size {
  width: 130px;
  flex: 0 0 auto;
}
/* 危险操作按钮:平时与其它图标钮同样低调,hover 才显红(与 ConfirmDialog 同口径)。
   图标钮无描边,故 hover 只换底色与前景色,不碰 border。 */
.wf-remove:not(:disabled) {
  color: var(--bbi-danger);
}
.wf-remove:not(:disabled):hover {
  color: var(--bbi-danger);
  background: var(--bbi-danger-soft);
}
/* AI 预览弹窗关闭钮:.bbi-icon-btn 只在 App.vue 里声明(scoped 不跨组件),此处补一份 */
.bbi-icon-btn {
  width: 36px;
  height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface-2);
  color: var(--bbi-ink-soft);
  cursor: pointer;
  font-size: 15px;
  transition:
    color var(--bbi-dur) var(--bbi-ease),
    background var(--bbi-dur) var(--bbi-ease);
}
.bbi-icon-btn:hover {
  color: var(--bbi-ink);
  background: var(--bbi-line-strong);
}
.workflow-assist-modal {
  width: min(720px, calc(100vw - 32px));
}
.workflow-change-list {
  display: grid;
  gap: 6px;
  margin: 12px 0;
}
.workflow-change {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 9px;
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface-2);
  color: var(--bbi-ink-soft);
  font-size: 12px;
}
.workflow-change-role {
  flex: 0 0 118px;
  color: var(--bbi-ink);
  font-weight: 600;
}
.workflow-change code {
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--bbi-accent);
  font-family: var(--bbi-font-mono);
}
.workflow-detection {
  margin: 9px 0 0;
  color: var(--bbi-ink-soft);
  font-size: 12px;
  line-height: 1.5;
}
/* URL 标签与输入框同行:标签靠左不压缩,输入框吃满剩余宽度 */
.api-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 0;
}
.api-row .bbi-field-label {
  flex: 0 0 auto;
}
.api-row .bbi-input {
  flex: 1 1 auto;
  min-width: 0;
}
.conn-actions {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  margin-top: 12px;
}
/* 左侧「使用此渠道 / 当前出图渠道」与右侧测试连接分据两端 */
.conn-use,
.conn-inuse {
  margin-right: auto;
}
.conn-inuse {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--bbi-accent);
}
@media (max-width: 640px) {
  /* 窄屏:四个图标钮 + 标签会把下拉挤成一条缝,标签独占首行,下拉与操作组同行分据两端 */
  .wf-row {
    grid-template-columns: minmax(0, 1fr) auto;
    row-gap: 8px;
  }
  .wf-row > .bbi-field-label:first-child {
    grid-column: 1 / -1;
  }
  .wf-row > .wf-select {
    max-width: none;
  }
  .workflow-change {
    align-items: flex-start;
    flex-direction: column;
    gap: 3px;
  }
  .workflow-change-role {
    flex-basis: auto;
  }
}
</style>
