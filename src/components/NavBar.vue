<script setup lang="ts">
import Icon from '@/components/Icon.vue';
import { PAGES } from '@/pages/registry';
import { closePanel, navigatePanel, ui } from '@/state/ui';
import { updateState } from '@/update';

const props = defineProps<{ placement: 'top' | 'bottom'; narrow?: boolean }>();

function showUpdateDot(id: string): boolean {
  return id === 'settings' && updateState.available;
}

// 移动端:再点一下当前页的导航按钮即关闭整窗(省得去够右上角的 ×);非当前页正常切页。
// 受 ui.navTapClose 开关控制(默认开,怕误触的用户可在设置里关)。
function onNavClick(id: string) {
  if (props.narrow && ui.navTapClose && ui.activePage === id) {
    closePanel();
    return;
  }
  navigatePanel(id);
}
</script>

<template>
  <nav class="changye-nav" :class="[`is-${placement}`, { 'is-narrow': narrow }]">
    <button
      v-for="p in PAGES"
      :key="p.id"
      class="changye-nav-item"
      :class="{ 'is-active': ui.activePage === p.id }"
      type="button"
      :title="p.label"
      :aria-label="p.label"
      :aria-current="ui.activePage === p.id ? 'page' : undefined"
      @click="onNavClick(p.id)"
    >
      <span class="changye-nav-icon-wrap">
        <Icon :name="p.id" class="changye-nav-icon" />
        <span v-if="showUpdateDot(p.id)" class="changye-nav-dot" aria-label="有可用更新"></span>
      </span>
      <!-- 顶部带文字;但窄屏(移动端)顶部也只放图标,否则一排带字胶囊横向放不下,会把后面的项挤出屏幕 -->
      <span v-if="placement === 'top' && !narrow" class="changye-nav-label">{{ p.label }}</span>
    </button>
  </nav>
</template>

<style scoped>
.changye-nav {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
}

/* —— 顶部:胶囊分段,横排图标+字 —— */
.changye-nav.is-top {
  gap: 4px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--changye-line);
}
.changye-nav.is-top .changye-nav-item {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 7px 14px;
  border: 0;
  border-radius: var(--changye-radius-pill);
  background: transparent;
  color: var(--changye-ink-soft);
  cursor: pointer;
  font-size: 14px;
  white-space: nowrap;
  transition:
    background var(--changye-dur) var(--changye-ease),
    color var(--changye-dur) var(--changye-ease);
}
.changye-nav.is-top .changye-nav-item:hover {
  background: var(--changye-surface-2);
  color: var(--changye-ink);
}
.changye-nav.is-top .changye-nav-item.is-active {
  background: var(--changye-accent);
  color: var(--changye-accent-ink);
}
.changye-nav.is-top .changye-nav-icon {
  font-size: 17px;
}

/* —— 顶部 + 窄屏(移动端):降级为仅图标,样式与底部导航完全一致(尺寸/配色/选中态),
   仅位置在顶,免得带字胶囊横向溢出把后面的项挤出屏幕 —— */
.changye-nav.is-top.is-narrow {
  justify-content: space-around;
  gap: 0;
  padding: 6px 6px;
}
.changye-nav.is-top.is-narrow .changye-nav-item {
  flex: 1;
  justify-content: center;
  gap: 0;
  padding: 10px 0;
  border-radius: 0;
  background: transparent;
  color: var(--changye-ink-muted);
}
.changye-nav.is-top.is-narrow .changye-nav-item:hover {
  background: transparent;
  color: var(--changye-ink-muted);
}
.changye-nav.is-top.is-narrow .changye-nav-item.is-active {
  background: transparent;
  color: var(--changye-accent);
}
.changye-nav.is-top.is-narrow .changye-nav-icon {
  font-size: 23px;
}

/* —— 底部:仅图标,等分,触达区大 —— */
.changye-nav.is-bottom {
  justify-content: space-around;
  padding: 6px 6px;
  padding-bottom: max(6px, env(safe-area-inset-bottom));
  border-top: 1px solid var(--changye-line);
  background: var(--changye-surface);
}
.changye-nav.is-bottom .changye-nav-item {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1;
  padding: 10px 0;
  border: 0;
  background: transparent;
  color: var(--changye-ink-muted);
  cursor: pointer;
  transition: color var(--changye-dur) var(--changye-ease);
}
.changye-nav.is-bottom .changye-nav-icon {
  font-size: 23px;
}
.changye-nav.is-bottom .changye-nav-item.is-active {
  color: var(--changye-accent);
}

.changye-nav-item:focus-visible {
  outline: 2px solid var(--changye-accent);
  outline-offset: 2px;
  border-radius: var(--changye-radius-sm);
}

.changye-nav-icon-wrap {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.changye-nav-dot {
  position: absolute;
  top: -2px;
  right: -3px;
  width: 7px;
  height: 7px;
  border-radius: var(--changye-radius-pill);
  background: var(--changye-danger);
  box-shadow: 0 0 0 1.5px var(--changye-surface);
  pointer-events: none;
}

</style>
