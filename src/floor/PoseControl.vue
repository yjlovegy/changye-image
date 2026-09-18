<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { poseImageUrl, uploadPose, type ComfyPose } from '@/backends/comfyPose';
import BbiSelect from '@/components/BbiSelect.vue';
import { settings } from '@/state/settings';

const props = defineProps<{ modelValue?: ComfyPose; disabled?: boolean }>();
const emit = defineEmits<{ (e: 'update:modelValue', value: ComfyPose | undefined): void; (e: 'busy', value: boolean): void }>();
const busy = ref(false);
const error = ref('');
const expanded = ref(Boolean(props.modelValue));
const preview = computed(() => props.modelValue ? poseImageUrl(props.modelValue) : '');
let controller: AbortController | null = null;
function update(patch: Partial<ComfyPose>) {
  if (props.modelValue) emit('update:modelValue', { ...props.modelValue, ...patch });
}
async function select(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file || props.disabled || busy.value) return;
  const url = settings.comfyui.url;
  controller = new AbortController();
  const current = controller;
  busy.value = true;
  emit('busy', true);
  error.value = '';
  try {
    const uploaded = await uploadPose(url, file, current.signal);
    if (current.signal.aborted) return;
    if (settings.comfyui.url !== url) throw new Error('ComfyUI 地址已变化，请重新上传参考图');
    emit('update:modelValue', { ...uploaded, kind: props.modelValue?.kind ?? 'photo', strength: props.modelValue?.strength ?? 1 });
  } catch (failure) {
    if (!current.signal.aborted) error.value = failure instanceof Error ? failure.message : String(failure);
  } finally {
    busy.value = false;
    emit('busy', false);
  }
}
onBeforeUnmount(() => controller?.abort());
</script>

<template>
  <section v-if="settings.defaultBackend === 'comfyui' || modelValue" class="bbi-pose" aria-label="本图姿态控制">
    <button class="bbi-btn" type="button" :aria-expanded="expanded" @click="expanded = !expanded">本图姿态参考{{ modelValue?.enabled ? ' · 已开启' : '' }}</button>
    <fieldset v-if="expanded" :disabled="disabled || busy">
      <p>仅用于这张配图。选择 PNG、JPG 或 WebP（最多 10 MB），上传至当前 ComfyUI；确认后生效。</p>
      <label class="bbi-modal-field">上传 / 替换姿态参考图<input type="file" accept="image/png,image/jpeg,image/webp" @change="select" /></label>
      <span v-if="busy" role="status">正在上传参考图…</span>
      <template v-if="modelValue">
        <img :src="preview" alt="本图姿态参考" class="bbi-pose-preview" />
        <label><input type="checkbox" :checked="modelValue.enabled" @change="update({ enabled: ($event.target as HTMLInputElement).checked })" /> 启用姿态控制</label>
        <label class="bbi-modal-field">参考图类型
          <BbiSelect style="width:100%" :model-value="modelValue.kind" :disabled="disabled || busy" aria-label="参考图类型" @update:model-value="update({ kind: $event as ComfyPose['kind'] })" :options="[{ value: 'photo', label: '人物参考图（DWPose 提取身体骨架）' }, { value: 'skeleton', label: '已绘制的彩色骨架图（直接使用）' }]" />
        </label>
        <label class="bbi-modal-field">控制强度：{{ modelValue.strength.toFixed(2) }}
          <input type="range" min="0" max="2" step="0.05" :value="modelValue.strength" @input="update({ strength: Number(($event.target as HTMLInputElement).value) })" />
        </label>
        <p>建议从 1 开始；0 关闭。仅支持 Anima 单阶段文生图工作流。参考图会缩放到出图尺寸，请尽量使用相同画幅，避免身体比例被拉伸。骨架主要约束肢体位置，五官、物体接触和遮挡仍需提示词配合。</p>
        <button class="bbi-btn" type="button" @click="emit('update:modelValue', undefined)">移除本图参考</button>
      </template>
      <p v-if="error" class="bbi-pose-error" role="alert">{{ error }}</p>
    </fieldset>
  </section>
</template>

<style scoped>
.bbi-pose { padding: 12px; border: 1px solid var(--bbi-line); border-radius: var(--bbi-radius-sm); }
fieldset { display: flex; flex-direction: column; gap: 12px; padding: 12px 0 0; border: 0; min-width: 0; }
p { margin: 0; font-size: 12px; line-height: 1.6; color: var(--bbi-ink-soft); }
.bbi-pose-preview { width: 100%; max-height: 240px; object-fit: contain; background: var(--bbi-surface-2); }
.bbi-pose-error { color: var(--bbi-danger); }
input[type=file] { max-width: 100%; }
</style>
