<script setup lang="ts">
import Icon from '@/components/Icon.vue';
import { modalHost } from '@/state/ui';
import { computed, nextTick, onBeforeUnmount, ref } from 'vue';

/**
 * 自绘下拉选择(替代原生 <select>):触发器与弹出菜单都跟随 --changye-* 主题,
 * 选项可带图标;与设置页的 changye-select-row 行布局配套。
 *
 * 菜单为什么 Teleport 到 modalHost 而不是就地绝对定位:
 * 设置项都在 Collapsible(overflow:hidden)与 .changye-body 滚动容器里,就地定位会被裁剪
 * (角色记忆插件踩过同款坑)。modalHost 是 .changye-root 直接子级,菜单用视口级 fixed 定位,
 * 由触发器的 getBoundingClientRect 推算,下方空间不足时向上翻。
 * 窗口元素平时无 transform(仅移动端拖动抽屉时临时有),fixed 相对视口成立。
 *
 * 交互:点外部 / Esc / 滚动 / 缩放关闭;↑↓ 移动高亮,Enter/Space 选中,Home/End 跳首尾。
 */
const props = defineProps<{
  modelValue: string;
  options: { value: string; label: string; icon?: string }[];
  /** 无障碍名称(行标题是纯文本 span,与控件无 label 关联,靠它补上) */
  ariaLabel?: string;
  disabled?: boolean;
  reorderable?: boolean;
}>();
const emit = defineEmits<{ (e: 'update:modelValue', v: string): void; (e: 'reorder', ids: string[]): void }>();

const open = ref(false);
const trigger = ref<HTMLElement | null>(null);
const menu = ref<HTMLElement | null>(null);
const menuStyle = ref<Record<string, string>>({});
/** 键盘/悬停高亮项索引 */
const activeIndex = ref(0);
const dragId = ref('');
const dragOrder = ref<string[]>([]);
const displayedOptions = computed(() => dragId.value
  ? dragOrder.value.map(id => props.options.find(o => o.value === id)).filter((o): o is typeof props.options[number] => !!o)
  : props.options);
let press: { id: string; pointer: number; x: number; y: number; lastY: number; element: HTMLElement; scrolling: boolean } | undefined;
let holdTimer: ReturnType<typeof setTimeout> | undefined;
let scrollFrame = 0;
let suppressPick = false;

function cancelDrag() {
  clearTimeout(holdTimer); cancelAnimationFrame(scrollFrame);
  const previous = press; press = undefined;
  if (previous?.element.hasPointerCapture(previous.pointer)) previous.element.releasePointerCapture(previous.pointer);
  dragId.value = ''; dragOrder.value = [];
}
function positionDrag(y: number) {
  if (!dragId.value || !menu.value) return;
  const rows = [...menu.value.querySelectorAll<HTMLElement>('.changye-select-option')];
  const over = rows.find(row => { const r = row.getBoundingClientRect(); return y >= r.top && y <= r.bottom; });
  if (!over?.dataset.value || over.dataset.value === dragId.value) return;
  const next = [...dragOrder.value], from = next.indexOf(dragId.value), to = next.indexOf(over.dataset.value);
  if (from < 0 || to < 0) return;
  next.splice(to, 0, ...next.splice(from, 1)); dragOrder.value = next;
}
function scrollDrag() {
  if (!press || !dragId.value || !menu.value) return;
  const box = menu.value.getBoundingClientRect(), y = press.lastY;
  if (y < box.top + 24) menu.value.scrollTop -= 5;
  else if (y > box.bottom - 24) menu.value.scrollTop += 5;
  positionDrag(Math.max(box.top + 5, Math.min(box.bottom - 5, y)));
  scrollFrame = requestAnimationFrame(scrollDrag);
}
function pointerDown(event: PointerEvent, id: string) {
  if (!props.reorderable || props.disabled || event.button !== 0) return;
  cancelDrag(); suppressPick = false;
  const element = menu.value!;
  press = { id, pointer: event.pointerId, x: event.clientX, y: event.clientY, lastY: event.clientY, element, scrolling: false };
  element.setPointerCapture(event.pointerId);
  holdTimer = setTimeout(() => {
    if (!press) return;
    dragOrder.value = props.options.map(o => o.value); dragId.value = id; suppressPick = true;
    scrollFrame = requestAnimationFrame(scrollDrag);
  }, 400);
}
function pointerMove(event: PointerEvent) {
  if (!press || press.pointer !== event.pointerId) return;
  const previousY = press.lastY; press.lastY = event.clientY;
  if (dragId.value) { event.preventDefault(); positionDrag(event.clientY); return; }
  if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > 8) {
    clearTimeout(holdTimer); suppressPick = true; press.scrolling = true;
  }
  if (press.scrolling && menu.value) menu.value.scrollTop += previousY - event.clientY;
}
function pointerUp(event: PointerEvent) {
  if (!press || press.pointer !== event.pointerId) return;
  const picked = !dragId.value && !press.scrolling ? press.id : undefined;
  const ids = dragId.value ? [...dragOrder.value] : undefined;
  cancelDrag();
  if (ids && ids.some((id, i) => id !== props.options[i]?.value)) emit('reorder', ids);
  if (picked) { suppressPick = true; emit('update:modelValue', picked); closeMenu(true); }
}

const current = computed(() => props.options.find(o => o.value === props.modelValue) ?? null);

const MENU_GAP = 4;
const MENU_MAX_HEIGHT = 240;
const VIEWPORT_MARGIN = 8;

function openMenu() {
  const el = trigger.value;
  if (!el || open.value || props.disabled || !props.options.length) return;
  const rect = el.getBoundingClientRect();
  // 估算菜单高度决定朝向:下方不够且上方更宽裕就向上翻
  const estimated = Math.min(MENU_MAX_HEIGHT, props.options.length * 34 + 10);
  const below = window.innerHeight - rect.bottom - MENU_GAP - VIEWPORT_MARGIN;
  const upward = below < estimated && rect.top - VIEWPORT_MARGIN > below;
  const space = upward ? rect.top - MENU_GAP - VIEWPORT_MARGIN : below;
  menuStyle.value = {
    left: `${rect.left}px`,
    width: `${rect.width}px`,
    maxHeight: `${Math.max(96, Math.min(MENU_MAX_HEIGHT, space))}px`,
    ...(upward
      ? { top: 'auto', bottom: `${window.innerHeight - rect.top + MENU_GAP}px` }
      : { top: `${rect.bottom + MENU_GAP}px`, bottom: 'auto' }),
  };
  activeIndex.value = Math.max(
    0,
    props.options.findIndex(o => o.value === props.modelValue),
  );
  open.value = true;
  document.addEventListener('mousedown', onDocMousedown, true);
  document.addEventListener('keydown', onDocKeydown, true);
  // 菜单是视口级 fixed,不随内容滚动;滚动/缩放时直接关掉,比重算位置干净。
  // (菜单最高 240px、选项就几个,自身几乎不会出现内部滚动,故不排除菜单内滚动。)
  document.addEventListener('scroll', closeOnViewportChange, true);
  window.addEventListener('resize', closeOnViewportChange);
}

function closeMenu(restoreFocus = false) {
  cancelDrag();
  if (!open.value) return;
  open.value = false;
  document.removeEventListener('mousedown', onDocMousedown, true);
  document.removeEventListener('keydown', onDocKeydown, true);
  document.removeEventListener('scroll', closeOnViewportChange, true);
  window.removeEventListener('resize', closeOnViewportChange);
  if (restoreFocus) trigger.value?.focus();
}

function closeOnViewportChange(event: Event) {
  if (menu.value?.contains(event.target as Node)) return;
  closeMenu();
}

function toggle() {
  if (open.value) closeMenu(true);
  else openMenu();
}

function pick(option: { value: string }) {
  if (suppressPick) { suppressPick = false; return; }
  emit('update:modelValue', option.value);
  closeMenu(true);
}

function onDocMousedown(event: MouseEvent) {
  // composedPath 穿透 shadow root;点到触发器或菜单内部都不算外部
  const path = event.composedPath();
  if (trigger.value && path.includes(trigger.value)) return;
  if (menu.value && path.includes(menu.value)) return;
  closeMenu();
}

function scrollActiveIntoView() {
  menu.value
    ?.querySelectorAll('.changye-select-option')
    [activeIndex.value]?.scrollIntoView({ block: 'nearest' });
}

function onDocKeydown(event: KeyboardEvent) {
  if (!open.value) return;
  const count = props.options.length;
  if (event.key === 'Escape') {
    // 捕获阶段拦截,只关菜单,别触发窗口级 Esc(关整个面板)
    event.preventDefault();
    event.stopPropagation();
    closeMenu(true);
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    if (!count) return;
    event.preventDefault();
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    if (props.reorderable && event.altKey) {
      const to = Math.max(0, Math.min(count - 1, activeIndex.value + delta));
      const ids = props.options.map(o => o.value);
      ids.splice(to, 0, ...ids.splice(activeIndex.value, 1));
      emit('reorder', ids); activeIndex.value = to; void nextTick(scrollActiveIntoView); return;
    }
    activeIndex.value = (activeIndex.value + delta + count) % count;
    scrollActiveIntoView();
  } else if (event.key === 'Home' || event.key === 'End') {
    event.preventDefault();
    activeIndex.value = event.key === 'Home' ? 0 : count - 1;
    scrollActiveIntoView();
  } else if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    const option = props.options[activeIndex.value];
      if (option) { suppressPick = false; pick(option); }
  }
}

/** 原生 select 习惯:收起态按 ↑/↓ 直接展开 */
function onTriggerKeydown(event: KeyboardEvent) {
  if (open.value) return;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    openMenu();
  }
}

onBeforeUnmount(() => closeMenu());
</script>

<template>
  <!-- 根类名不能叫 changye-select:base.css 里那个类是给美化原生 <select> 用的,
       带背景图三角 + padding-right,撞上会在触发器右边多画一个三角 -->
  <div class="changye-select-box">
    <button
      ref="trigger"
      class="changye-select-trigger"
      type="button"
      aria-haspopup="listbox"
      :aria-expanded="open"
      :aria-label="ariaLabel"
      :disabled="disabled"
      @click="toggle"
      @keydown="onTriggerKeydown"
    >
      <span class="changye-select-current">
        <Icon v-if="current?.icon" :name="current.icon" :size="14" />
        <span class="changye-select-label">{{ current?.label ?? modelValue }}</span>
      </span>
      <Icon name="chevron" class="changye-select-caret" :class="{ 'is-open': open }" :size="12" />
    </button>

    <Teleport :to="modalHost" :disabled="!modalHost">
      <ul v-if="open" ref="menu" class="changye-select-menu" :class="{ 'is-sortable': reorderable, 'is-dragging': dragId }" role="listbox" :aria-label="ariaLabel" :style="menuStyle"
        @pointermove="pointerMove" @pointerup="pointerUp" @pointercancel="cancelDrag" @lostpointercapture="cancelDrag">
        <li
          v-for="(option, i) in displayedOptions"
          :key="option.value"
          class="changye-select-option"
          :class="{ 'is-active': i === activeIndex, 'is-selected': option.value === modelValue, 'is-grabbed': option.value === dragId }"
          :data-value="option.value"
          :title="reorderable ? '长按拖动排序，或按 Alt＋方向键调整' : undefined"
          role="option"
          :aria-selected="option.value === modelValue"
          @mouseenter="activeIndex = i"
          @click="pick(option)"
          @pointerdown="pointerDown($event, option.value)"
          @contextmenu="reorderable && $event.preventDefault()"
        >
          <Icon v-if="option.icon" :name="option.icon" :size="14" />
          <span class="changye-select-option-label">{{ option.label }}</span>
          <Icon
            v-if="option.value === modelValue"
            name="check"
            class="changye-select-check"
            :size="13"
          />
        </li>
      </ul>
    </Teleport>
  </div>
</template>

<style scoped>
.changye-select-box {
  width: 180px;
  flex: none;
}
.changye-select-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  padding: 6px 10px;
  border: 1px solid var(--changye-line-strong);
  border-radius: var(--changye-radius-sm);
  background: var(--changye-surface);
  color: var(--changye-ink);
  font-family: var(--changye-font-sans);
  font-size: 13px;
  line-height: 1.5;
  cursor: pointer;
  transition:
    border-color var(--changye-dur) var(--changye-ease),
    background var(--changye-dur) var(--changye-ease);
}
.changye-select-trigger:hover,
.changye-select-trigger[aria-expanded="true"] {
  background: var(--changye-surface-2);
}
.changye-select-trigger:focus-visible {
  outline: 2px solid var(--changye-accent);
  outline-offset: 1px;
}
.changye-select-current {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.changye-select-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.changye-select-caret {
  flex: none;
  color: var(--changye-ink-soft);
  transition: transform var(--changye-dur) var(--changye-ease);
}
.changye-select-caret.is-open {
  transform: rotate(180deg);
}

/* 菜单 Teleport 到 modalHost(scoped 样式在同 shadow root 内照常生效) */
.changye-select-menu {
  position: fixed;
  /* 10003:高于普通弹窗遮罩(10001)与叠加层遮罩(10002)。
     本组件现在也用在弹窗内部(渠道弹窗的「思考强度」),菜单与遮罩会同时存在;
     同级时靠「后插入者胜出」能侥幸盖住,但删除确认那类 -top 遮罩(10002)会反压菜单,
     故显式抬高,不依赖插入顺序。 */
  z-index: 10003;
  margin: 0;
  padding: 4px;
  list-style: none;
  overflow-y: auto;
  background: var(--changye-surface);
  border: 1px solid var(--changye-line);
  border-radius: var(--changye-radius);
  box-shadow: var(--changye-shadow);
}
.changye-select-option {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 10px;
  border-radius: var(--changye-radius-sm);
  font-size: 13px;
  color: var(--changye-ink);
  cursor: pointer;
}
.changye-select-option.is-active {
  background: var(--changye-surface-2);
}
.changye-select-option.is-selected {
  background: var(--changye-surface-2);
  color: var(--changye-accent);
  font-weight: 600;
}
.changye-select-option-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.changye-select-check {
  flex: none;
  color: var(--changye-accent);
}
.is-sortable .changye-select-option { touch-action: none; user-select: none; -webkit-user-select: none; }
.is-dragging .changye-select-option { cursor: grabbing; }
.changye-select-option.is-grabbed { outline: 2px solid var(--changye-accent); outline-offset: -2px; background: var(--changye-surface-2); }
</style>
