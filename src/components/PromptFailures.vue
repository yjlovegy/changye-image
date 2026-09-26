<script setup lang="ts">
import { ref } from 'vue';
import Icon from './Icon.vue';
import ModalMask from './ModalMask.vue';
import { promptFailures, dismissPromptFailure, type PromptFailure } from '@/state/promptFailures';
const viewing = ref<PromptFailure | null>(null);
async function retry(item: PromptFailure) {
  dismissPromptFailure(item.id);
  try { await item.retry(); }
  catch (error) { toastr.warning(error instanceof Error ? error.message : String(error), '无法重试'); }
}
</script>
<template>
  <div class="prompt-failures" aria-label="提示词生成通知">
    <section v-for="item in promptFailures" :key="item.id" class="prompt-failure" role="alert">
      <header><strong>提示词生成失败</strong><button class="bbi-icon-mini" title="关闭通知" @click="dismissPromptFailure(item.id)"><Icon name="close" /></button></header>
      <p class="source">{{ item.source }}</p><p class="reason">{{ item.reason }}</p>
      <div class="actions"><button class="bbi-btn bbi-btn-sm" @click="retry(item)"><Icon name="refresh" />重试</button><button class="bbi-btn bbi-btn-sm" @click="viewing=item">查看详情</button></div>
    </section>
  </div>
  <ModalMask :open="!!viewing" top-layer @close="viewing=null">
    <div v-if="viewing" class="bbi-modal" role="dialog" aria-modal="true" aria-label="错误详情">
      <header class="bbi-modal-head"><span class="bbi-modal-title">错误详情</span><button class="bbi-icon-mini" title="关闭错误详情" @click="viewing=null"><Icon name="close" /></button></header>
      <p>{{ viewing.source }}</p><pre class="error-detail">{{ viewing.reason }}</pre>
      <footer class="bbi-modal-foot"><button class="bbi-btn" @click="viewing=null">关闭</button></footer>
    </div>
  </ModalMask>
</template>
<style scoped>
.bbi-icon-mini{display:inline-flex;align-items:center;justify-content:center;flex:0 0 32px;width:32px;height:32px;border:1px solid var(--bbi-line);border-radius:var(--bbi-radius-sm);background:var(--bbi-surface);color:var(--bbi-ink);cursor:pointer}
.prompt-failures{position:fixed;right:24px;bottom:24px;z-index:10001;width:420px;max-width:calc(100vw - 32px);max-height:calc(100dvh - 48px);overflow:auto;display:grid;gap:12px;pointer-events:auto}.prompt-failure{padding:20px;border:1px solid var(--bbi-line);border-radius:12px;background:var(--bbi-bg);color:var(--bbi-ink);box-shadow:var(--bbi-shadow)}header,.actions{display:flex;align-items:center;gap:12px}header{justify-content:space-between}header strong{color:var(--bbi-danger)}.source{color:var(--bbi-ink-muted);font-size:12px;margin:8px 0}.reason{white-space:pre-wrap;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}.actions{margin-top:14px}.error-detail{white-space:pre-wrap;overflow-wrap:anywhere;max-height:55vh;overflow:auto;font:inherit}
</style>
