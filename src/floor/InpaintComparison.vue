<script setup lang="ts">
import { ref, nextTick, onBeforeUnmount } from 'vue';

defineProps<{ source: string; result: string }>();
const nativeSize = ref(false);
const originalView = ref<HTMLElement>();
const resultView = ref<HTMLElement>();
const dragging = ref<HTMLElement | null>(null);
let drag: { view: HTMLElement; id: number; x: number; y: number; left: number; top: number } | null = null;

function sync(view: HTMLElement) {
  if (!nativeSize.value) return;
  const other = view === originalView.value ? resultView.value : originalView.value;
  if (!other) return;
  // Compare before writing so mirrored scroll events cannot create a feedback loop.
  if (Math.abs(other.scrollLeft - view.scrollLeft) > 0.5) other.scrollLeft = view.scrollLeft;
  if (Math.abs(other.scrollTop - view.scrollTop) > 0.5) other.scrollTop = view.scrollTop;
}
function scroll(e: Event) { sync(e.currentTarget as HTMLElement); }
function start(e: PointerEvent) {
  if (!nativeSize.value || e.button !== 0 || drag) return;
  const view = e.currentTarget as HTMLElement;
  const rect = view.getBoundingClientRect();
  // Leave the native scrollbars to the browser.
  if (e.clientX - rect.left >= view.clientWidth || e.clientY - rect.top >= view.clientHeight) return;
  e.preventDefault();
  view.focus({ preventScroll: true });
  view.setPointerCapture(e.pointerId);
  drag = { view, id: e.pointerId, x: e.clientX, y: e.clientY, left: view.scrollLeft, top: view.scrollTop };
  dragging.value = view;
}
function move(e: PointerEvent) {
  if (!drag || drag.id !== e.pointerId) return;
  drag.view.scrollLeft = drag.left + drag.x - e.clientX;
  drag.view.scrollTop = drag.top + drag.y - e.clientY;
  sync(drag.view);
}
function stop(e?: PointerEvent) {
  if (!drag || (e && e.pointerId !== drag.id)) return;
  const previous = drag;
  drag = null;
  dragging.value = null;
  if (previous.view.hasPointerCapture(previous.id)) previous.view.releasePointerCapture(previous.id);
}
function wheel(e: WheelEvent) {
  if (!nativeSize.value || !e.shiftKey || e.deltaX || !e.deltaY) return;
  const view = e.currentTarget as HTMLElement;
  if (view.scrollWidth <= view.clientWidth) return;
  e.preventDefault();
  view.scrollLeft += e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? view.clientWidth : 1);
  sync(view);
}
async function toggleSize() {
  stop();
  nativeSize.value = !nativeSize.value;
  await nextTick();
  for (const view of [originalView.value, resultView.value]) {
    if (view) { view.scrollLeft = 0; view.scrollTop = 0; }
  }
}
onBeforeUnmount(() => stop());
</script>

<template>
  <div class="result-body">
    <div class="result-heading"><h3>重绘结果</h3><button class="bbi-btn" :aria-pressed="nativeSize" @click="toggleSize">{{nativeSize?'适应窗口':'原尺寸对比'}}</button></div>
    <div class="result-grid" :class="{'native-size':nativeSize}">
      <figure><figcaption>原图</figcaption>
        <div ref="originalView" class="result-image" :class="{dragging:dragging===originalView}" :tabindex="nativeSize?0:undefined" role="region" aria-label="原图对比区域" :title="nativeSize?'拖动查看；Shift＋滚轮横向移动':undefined"
          @scroll="scroll" @wheel="wheel" @pointerdown="start" @pointermove="move" @pointerup="stop" @pointercancel="stop" @lostpointercapture="stop">
          <img :src="source" alt="重绘前的原图" draggable="false"/>
        </div>
      </figure>
      <figure><figcaption>重绘后</figcaption>
        <div ref="resultView" class="result-image" :class="{dragging:dragging===resultView}" :tabindex="nativeSize?0:undefined" role="region" aria-label="重绘后对比区域" :title="nativeSize?'拖动查看；Shift＋滚轮横向移动':undefined"
          @scroll="scroll" @wheel="wheel" @pointerdown="start" @pointermove="move" @pointerup="stop" @pointercancel="stop" @lostpointercapture="stop">
          <img :src="result" alt="局部重绘结果" draggable="false"/>
        </div>
      </figure>
    </div>
  </div>
</template>

<style scoped>
.result-body{padding:20px 24px;background:var(--bbi-bg);min-width:0}
.result-heading{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:14px}
.result-heading h3{margin:0}
.bbi-btn{display:inline-flex;justify-content:center;align-items:center;white-space:nowrap;min-height:42px;line-height:1.3}
.result-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px;align-items:start}
figure{min-width:0;text-align:center;margin:0}
figcaption{font-size:14px;margin-bottom:10px}
.result-image{width:100%;min-width:0;overflow:auto;border-radius:8px}
.result-image img{max-width:100%;height:430px;object-fit:contain;border-radius:8px;vertical-align:top}
.native-size .result-image{height:clamp(160px,55dvh,480px);cursor:grab;touch-action:none;user-select:none;overscroll-behavior:contain;scrollbar-width:auto;scrollbar-gutter:stable}
.native-size .result-image.dragging{cursor:grabbing}
.native-size .result-image img{display:block;width:auto;max-width:none;height:auto;max-height:none;border-radius:0;pointer-events:none}
.native-size .result-image::-webkit-scrollbar{width:12px;height:12px}
.native-size .result-image::-webkit-scrollbar-thumb{background:var(--bbi-ink-muted);border:3px solid var(--bbi-bg);border-radius:8px}
.native-size .result-image::-webkit-scrollbar-track,.native-size .result-image::-webkit-scrollbar-corner{background:var(--bbi-bg)}
.result-image:focus-visible,button:focus-visible{outline:2px solid var(--bbi-accent);outline-offset:2px}
@media(max-width:620px){.result-body{padding:16px 12px}.result-grid{gap:10px}.result-image img{height:280px}.result-heading{gap:10px}.bbi-btn{font-size:13px;min-height:39px}}
</style>
