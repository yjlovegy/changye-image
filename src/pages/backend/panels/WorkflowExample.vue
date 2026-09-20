<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import Icon from '@/components/Icon.vue';
import { openLightbox } from '@/floor/lightbox';
import { saveImageFile } from '@/floor/download';
import { settings, type ComfyWorkflowPreset } from '@/state/settings';
import { normalizeWorkflowExample, removeWorkflowExample, setWorkflowExample } from '@/st/workflowExamples';

const props = defineProps<{ preset: ComfyWorkflowPreset }>();
const input = ref<HTMLInputElement | null>(null);
const busy = ref(false);
const broken = ref(false);
const status = ref('');
const src = computed(() => normalizeWorkflowExample(props.preset.exampleImage));
const owners = () => settings.comfyui.workflows;
let pickedTarget: ComfyWorkflowPreset | undefined;
const filename = computed(() => `${props.preset.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_') || '工作流'}-示例图.${src.value?.split('.').pop() || 'png'}`);
watch(src, () => { broken.value = false; status.value = ''; }, { flush: 'sync' });

function pick() {
  pickedTarget = props.preset;
  if (input.value) { input.value.value = ''; input.value.click(); }
}
async function upload(event: Event) {
  const element = event.target as HTMLInputElement;
  const file = element.files?.[0];
  const target = pickedTarget;
  pickedTarget = undefined;
  element.value = '';
  if (!file || !target || busy.value) return;
  busy.value = true;
  status.value = '';
  try {
    const cleaned = await setWorkflowExample(target, file, owners);
    status.value = '✓ 示例图已保存';
    if (!cleaned) toastr.warning('新图已保存，旧文件清理失败，可在示例图目录手动清理');
  } catch (error) { toastr.error(error instanceof Error ? error.message : String(error), '示例图上传失败'); }
  finally { busy.value = false; }
}
async function remove() {
  if (busy.value) return;
  busy.value = true;
  try {
    const cleaned = await removeWorkflowExample(props.preset, owners);
    status.value = '示例图已移除';
    if (!cleaned) toastr.warning('示例图关联已移除，文件清理失败，可在示例图目录手动清理');
  } catch (error) { toastr.error(error instanceof Error ? error.message : String(error), '移除失败'); }
  finally { busy.value = false; }
}
function enlarge() { if (src.value && !broken.value) openLightbox({ src: src.value, filename: filename.value }); }
function download() { if (src.value && !broken.value) saveImageFile(src.value, filename.value); }
</script>

<template>
  <section class="workflow-example" aria-label="工作流示例图" :aria-busy="busy">
    <button type="button" class="example-thumb" :disabled="!src || broken" :aria-label="src && !broken ? '放大工作流示例图' : '暂无可用示例图'" @click="enlarge">
      <img v-if="src && !broken" :src="src" :alt="`${preset.name}的工作流示例图`" @error="broken = true" />
      <span v-else class="example-empty"><Icon name="generate" :size="26" />{{ broken ? '图片无法加载' : '暂无示例图' }}</span>
    </button>
    <div class="example-info">
      <h3 class="bbi-field-label">工作流示例图</h3>
      <p class="bbi-field-hint">{{ broken ? '文件可能已移动或删除，请重新上传' : src ? '点击小图查看大图' : '上传一张图片，记录这套工作流的风格' }}</p>
      <div class="example-actions">
        <button type="button" class="bbi-btn" :disabled="busy" @click="pick">{{ busy ? '处理中…' : '上传图片' }}</button>
        <button type="button" class="bbi-btn" :disabled="!src || broken" @click="download">下载图片</button>
        <button v-if="src" type="button" class="bbi-btn" :disabled="busy" @click="remove">移除</button>
      </div>
      <p class="example-status" role="status">{{ status }}</p>
    </div>
    <input ref="input" type="file" accept="image/png,image/jpeg,image/webp" hidden @change="upload" />
  </section>
</template>

<style scoped>
.workflow-example{display:flex;align-items:center;gap:22px;padding:20px 0 12px}
.example-thumb{display:flex;align-items:center;justify-content:center;width:110px;height:140px;flex:none;overflow:hidden;padding:0;border:1px solid var(--bbi-line);border-radius:var(--bbi-radius);background:var(--bbi-surface-2);cursor:zoom-in}
.example-thumb:disabled{cursor:default}.example-thumb:focus-visible{outline:2px solid var(--bbi-accent);outline-offset:3px}
.example-thumb img{width:100%;height:100%;object-fit:contain}.example-empty{display:flex;align-items:center;flex-direction:column;gap:10px;font-size:12px;color:var(--bbi-ink-muted)}
.example-info{min-width:0}.example-info h3{margin:0 0 8px}.example-info .bbi-field-hint{margin:0 0 14px}.example-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.example-status{font-size:12px;color:var(--bbi-accent);min-height:18px;margin:10px 0 0}
@media(max-width:520px){.workflow-example{gap:14px}.example-thumb{width:96px;height:124px}.example-actions{gap:8px}}
</style>
