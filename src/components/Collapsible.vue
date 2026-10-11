<script setup lang="ts">
import Icon from '@/components/Icon.vue';
import { ref } from 'vue';

const props = withDefaults(
  defineProps<{
    /** 标题文本。用 #header 插槽时可留空。 */
    title?: string;
    /** 初始是否展开 */
    open?: boolean;
  }>(),
  { title: '', open: true },
);

const expanded = ref(props.open);
defineExpose({ expand: () => { expanded.value = true; } });

// 用 grid-template-rows 0fr<->1fr 做高度过渡,无需测量 scrollHeight,内容自适应。
</script>

<template>
  <section class="changye-collapsible" :class="{ 'is-open': expanded }">
    <button class="changye-collapsible-head" type="button" :aria-expanded="expanded" @click="expanded = !expanded">
      <!-- 默认只放标题文本;需要在标题行放徽章/元信息时用 #header 插槽覆盖
           (插槽内不要放按钮等可交互元素——整个头本身就是一个 button)。 -->
      <slot name="header">
        <span class="changye-collapsible-title">{{ title }}</span>
      </slot>
      <Icon name="chevron" class="changye-collapsible-chevron" />
    </button>
    <div class="changye-collapsible-outer">
      <div class="changye-collapsible-inner">
        <div class="changye-collapsible-body">
          <slot />
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.changye-collapsible {
  border: 1px solid var(--changye-line);
  border-radius: var(--changye-radius);
  background: var(--changye-surface);
  overflow: hidden;
}

.changye-collapsible-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 14px 16px;
  border: 0;
  background: transparent;
  color: var(--changye-ink);
  cursor: pointer;
  font-family: var(--changye-font-sans);
  font-size: 15px;
  font-weight: 600;
  text-align: left;
  transition: background var(--changye-dur) var(--changye-ease);
}
.changye-collapsible-head:hover {
  background: var(--changye-surface-2);
}
.changye-collapsible-head:focus-visible {
  outline: 2px solid var(--changye-accent);
  outline-offset: -2px;
}

.changye-collapsible-chevron {
  font-size: 18px;
  color: var(--changye-ink-muted);
  transition: transform var(--changye-dur) var(--changye-ease);
}
/* 用直接子代 > 限定:嵌套 Collapsible 时,外层 .is-open 不得波及内层的 outer/chevron,
   否则内层会被外层钉死在展开态、永远收不起来。 */
.changye-collapsible.is-open > .changye-collapsible-head .changye-collapsible-chevron {
  transform: rotate(180deg);
}

/* 高度过渡:grid 0fr -> 1fr */
.changye-collapsible-outer {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows var(--changye-dur) var(--changye-ease);
}
.changye-collapsible.is-open > .changye-collapsible-outer {
  grid-template-rows: 1fr;
}
.changye-collapsible-inner {
  min-height: 0;
  overflow: hidden;
}
.changye-collapsible-body {
  padding: 14px 16px;
  border-top: 1px solid var(--changye-line);
}

/* 移动端:折叠区标题略小一号,与窄屏整体节奏更协调 */
@media (max-width: 640px) {
  .changye-collapsible-head {
    font-size: 13px;
  }
}
</style>
