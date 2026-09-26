import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindAutoTagging, captureSelectionImageSnapshot, requestFloorTags, requestSelectionImage } from '@/autoTag/runner';
import { requestCompletion, requestViaMainApi } from '@/api/client';
import { buildAutoTagMessages } from '@/autoTag/prompt';
import { applyMessageText } from '@/st/messageEdit';
import { backendStatus } from '@/generate';
import { clearAutoGenerateFlags, consumeAutoGenerate, markForAutoGenerate } from '@/floor/autoGenerate';
import { parseImageTags } from '@/st/imageTagRegex';
import { promptFailures } from '@/state/promptFailures';
import { stopPromptTasks, activePromptTasks } from '@/state/promptTasks';
import { sourceForPrompt } from '@/floor/promptSource';
import { settings } from '@/state/settings';
import { SCENE_NEGATIVE_RETRY_INSTRUCTION } from '@/autoTag/negative';
import { EXPLICIT_APPEARANCE_RETRY_INSTRUCTION } from '@/autoTag/facialDetail';
import type { STContext, STMessage } from '@/st/context';
import { beginGen, clearAllGen, clearGen, isGenerationFloorLocked, slotKey } from '@/floor/genState';
import { latestEntry, promptHash, readStore } from '@/floor/storage';
import { isCollapsed, setCollapsed } from '@/floor/collapseState';
import { charTagLib, createCharTagNewOp, createCharTagSetOp, emptyCharFields, hydrateCharTags, readCharTagFloorDelta, setGlobalCharTagSource, type CharTagEntry } from '@/state/charTags';

const state = vi.hoisted(() => ({
  context: null as STContext | null,
  preset: { mode: 'custom', promptMode: 'anima', workflow: '', simple: { template: 'checkpoint' } },
}));
vi.mock('@/st/context', () => ({
  getContext: () => state.context,
  isStoryMessage: (message: STMessage | undefined) => Boolean(message?.mes && !(message.is_system && message.extra?.type)),
  isAiStoryMessage: (message: STMessage | undefined) => Boolean(message?.mes && !message.is_user),
}));
vi.mock('@/api/client', () => ({ requestCompletion: vi.fn(), requestViaMainApi: vi.fn() }));
vi.mock('@/autoTag/bookMemory', () => ({ readBookMemory: vi.fn(() => null) }));
vi.mock('@/autoTag/prompt', () => ({ buildAutoTagMessages: vi.fn() }));
vi.mock('@/st/messageEdit', () => ({ applyMessageText: vi.fn() }));
vi.mock('@/generate', () => ({ backendStatus: vi.fn() }));
vi.mock('@/state/settings', () => ({
  settings: {
    enabled: true, defaultBackend: 'nai', nai: { model: 'nai-diffusion-4-5-full' },
    excludes: { customStripTags: [] },
    autoTag: { enabled: false, autoGenerate: false, minImages: 0, maxImages: 5, retryCount: 0, contextMessages: 2 },
  },
  activeComfyPreset: vi.fn(() => state.preset),
  getTagGenChannel: vi.fn(() => null),
  isCurrentChatExcluded: vi.fn(() => false),
}));

const modelOutput = JSON.stringify({
  images: [
    { position: 'P1', tag: '1girl, holding a book', nl: 'The girl holds an open book, her eyes lowered toward the page.' },
    { position: 'P1', tag: '1girl, looking away', nl: 'The girl turns her head to look toward the nearby window.' },
  ],
  changes: [],
});

function snapshotAt(offset?: number) {
  return captureSelectionImageSnapshot(0, offset ?? state.context!.chat[0].mes.length)!;
}

it('stops selection generation and discards late output without a retry or write', async () => {
  let resolve!: (s:string)=>void;
  vi.mocked(requestViaMainApi).mockImplementation(() => new Promise<string>(r=>{resolve=r;}));
  settings.autoTag.retryCount=2;
  const pending=requestSelectionImage(0,'她翻开书。',snapshotAt());
  await vi.waitFor(()=>expect(requestViaMainApi).toHaveBeenCalledTimes(1));
  expect(activePromptTasks.value).toBe(1);
  stopPromptTasks(); resolve(modelOutput);
  await pending;
  expect(applyMessageText).not.toHaveBeenCalled();
  expect(requestViaMainApi).toHaveBeenCalledTimes(1);
  expect(promptFailures).toHaveLength(0);
  expect(activePromptTasks.value).toBe(0);
});

it('saves the exact original selection for later rewrites', async () => {
  await requestSelectionImage(0,'她翻开书。',snapshotAt());
  const message=state.context!.chat[0];
  const tag=parseImageTags(message.mes).at(-1)!;
  expect(sourceForPrompt(message,tag,0)).toEqual({text:'她翻开书。',kind:'selection',legacy:false});
});

beforeEach(() => {
  vi.clearAllMocks();
  promptFailures.splice(0);
  stopPromptTasks();
  clearAutoGenerateFlags();
  clearAllGen();
  settings.enabled = true;
  settings.defaultBackend = 'nai';
  state.preset.mode = 'custom';
  state.preset.promptMode = 'anima';
  state.preset.workflow = '';
  state.preset.simple.template = 'checkpoint';
  settings.autoTag.retryCount = 0;
  const message: STMessage = {
    name: '用户', is_user: true, is_system: false,
    mes: '她翻开书。\n<bbi_image>old image</bbi_image>',
    swipes: ['她翻开书。\n<bbi_image>old image</bbi_image>'], swipe_id: 0,
    extra: { bbiCharChanges: { v: 1, swipe: 0, ops: [] } },
  };
  state.context = { chat: [message], getCurrentChatId: () => 'chat-a', name1: '用户' } as STContext;
  setGlobalCharTagSource(() => []);
  hydrateCharTags();
  vi.stubGlobal('toastr', { warning: vi.fn(), info: vi.fn(), success: vi.fn(), error: vi.fn() });
  vi.mocked(backendStatus).mockReturnValue({ backend: 'nai', configured: true, model: 'test', supportsCharacters: true, reason: '' });
  vi.mocked(buildAutoTagMessages).mockImplementation(async (_context, _floor, _options, _memory, prepared) => [
    { role: 'system', content: '基础规则' },
    { role: 'user', content: `--- 目标正文 ---\n${prepared!.promptText}` },
  ]);
  vi.mocked(requestViaMainApi).mockImplementation(async (_messages, options) => {
    options?.validate?.(modelOutput);
    return modelOutput;
  });
  vi.mocked(applyMessageText).mockImplementation(async (floor, buildNext, _chatId, _swipeId, _message, extraUpdate, beforeRefresh) => {
    const message = state.context!.chat[floor];
    const next = buildNext(message.mes);
    if (next === null) return 'build-failed';
    message.mes = next;
    if (extraUpdate) {
      for (const update of Array.isArray(extraUpdate) ? extraUpdate : [extraUpdate]) {
        message.extra = { ...message.extra, [update.key]: update.value };
      }
    }
    beforeRefresh?.(true);
    return 'saved';
  });
});

afterEach(() => {
  clearAutoGenerateFlags();
  clearAllGen();
  vi.unstubAllGlobals();
});

describe('manual selection image request', () => {
  it.each(['selection', 'automatic'])('corrects a placeholder omission within the existing retry budget for %s', async mode => {
    settings.autoTag.retryCount = 1;
    let attempt = 0;
    vi.mocked(requestViaMainApi).mockImplementation(async (messages, options) => {
      attempt++;
      const bad = JSON.stringify({ images: [{ position: 'P1', tag: '@画家, reading', nl: '@画家 reads a book.' }], changes: [] });
      if (attempt === 2) expect(messages.filter(message => message.content === EXPLICIT_APPEARANCE_RETRY_INSTRUCTION)).toHaveLength(1);
      const raw = attempt === 1 ? bad : modelOutput;
      options?.validate?.(raw);
      return raw;
    });
    if (mode === 'automatic') {
      state.context!.chat[0].is_user = false;
      await requestFloorTags(0, { replace: true });
    } else await requestSelectionImage(0, '她翻开书。', snapshotAt());
    expect(requestViaMainApi).toHaveBeenCalledTimes(2);
    expect(applyMessageText).toHaveBeenCalledTimes(1);
    expect(state.context!.chat[0].mes).not.toContain('@画家');
  });
  it.each(['selection', 'automatic'])('rejects new %s AI output that relies on a cached @ appearance description', async mode => {
    vi.mocked(requestViaMainApi).mockImplementation(async (_messages, options) => {
      const raw = JSON.stringify({ images: [{ position: 'P1', tag: '@画家, reading', nl: '@画家 reads an open book beside a window.' }], changes: [] });
      options?.validate?.(raw);
      return raw;
    });
    if (mode === 'automatic') {
      state.context!.chat[0].is_user = false;
      await requestFloorTags(0, { replace: true });
    } else await requestSelectionImage(0, '她翻开书。', snapshotAt());
    expect(applyMessageText).not.toHaveBeenCalled();
    expect(promptFailures[0]?.reason).toEqual(expect.stringContaining('@角色名'));
  });

  it.each(['selection', 'automatic'])('requires a real scene negative and retries with a targeted correction before saving %s', async mode => {
    settings.defaultBackend = 'comfyui';
    state.preset.workflow = JSON.stringify({ '1': { class_type: 'CLIPTextEncode', inputs: { text: '%negative_prompt%' } } });
    settings.autoTag.retryCount = 1;
    const requestMessages: string[][] = [];
    vi.mocked(requestViaMainApi).mockImplementation(async (messages, options) => {
      requestMessages.push(messages.map(message => message.content));
      const raw = JSON.stringify({ images: [{ position: 'P1', tag: '1girl, reading', nl: 'The woman reads an open book beside a window.', negative: requestMessages.length === 1 ? ', ;' : 'duplicate character' }], changes: [] });
      options?.validate?.(raw);
      return raw;
    });
    if (mode === 'automatic') {
      state.context!.chat[0].is_user = false;
      await requestFloorTags(0, { replace: true });
    } else await requestSelectionImage(0, '她翻开书。', snapshotAt());
    expect(requestViaMainApi).toHaveBeenCalledTimes(2);
    expect(requestMessages[0]).not.toContain(SCENE_NEGATIVE_RETRY_INSTRUCTION);
    expect(requestMessages[1].filter(text => text === SCENE_NEGATIVE_RETRY_INSTRUCTION)).toHaveLength(1);
    expect(applyMessageText).toHaveBeenCalledTimes(1);
    expect(state.context!.chat[0].mes).toContain('<negative>duplicate character</negative>');
    expect(vi.mocked(buildAutoTagMessages).mock.calls[0][6]).toBe(true);
  });


  it('keeps optional assistant prefill last when adding a negative correction', async () => {
    settings.defaultBackend = 'comfyui';
    state.preset.mode = 'simple';
    settings.autoTag.retryCount = 1;
    vi.mocked(buildAutoTagMessages).mockImplementation(async (_context, _floor, _options, _memory, prepared) => [
      { role: 'system', content: '基础规则' }, { role: 'user', content: prepared!.promptText },
      { role: 'assistant', content: 'custom prefill' },
    ]);
    const sequences: string[][] = [];
    vi.mocked(requestViaMainApi).mockImplementation(async (messages, options) => {
      sequences.push(messages.map(message => message.role + ':' + message.content));
      options?.validate?.(modelOutput);
      return modelOutput;
    });
    await requestSelectionImage(0, '她翻开书。', snapshotAt());
    expect(sequences).toHaveLength(2);
    expect(sequences[1].at(-1)).toBe('assistant:custom prefill');
    expect(sequences[1].at(-2)).toBe('system:' + SCENE_NEGATIVE_RETRY_INSTRUCTION);
  });

  it.each(['selection', 'automatic'])('does not save or generate when %s exhausts retries with an empty negative', async mode => {
    settings.defaultBackend = 'comfyui';
    state.preset.mode = 'simple';
    state.preset.simple.template = 'anima';
    settings.autoTag.retryCount = 2;
    const correctionCounts: number[] = [];
    vi.mocked(requestViaMainApi).mockImplementation(async (messages, options) => {
      correctionCounts.push(messages.filter(message => message.content === SCENE_NEGATIVE_RETRY_INSTRUCTION).length);
      options?.validate?.(modelOutput);
      return modelOutput;
    });
    if (mode === 'automatic') {
      state.context!.chat[0].is_user = false;
      await requestFloorTags(0, { replace: true });
    } else await requestSelectionImage(0, '她翻开书。', snapshotAt());
    expect(requestViaMainApi).toHaveBeenCalledTimes(3);
    expect(correctionCounts).toEqual([0, 1, 1]);
    expect(applyMessageText).not.toHaveBeenCalled();
    expect(consumeAutoGenerate('chat-a', 0, 0, 0)).toBeNull();
    expect(promptFailures[0]?.reason).toEqual(expect.stringContaining('缺少本画面负面提示词'));
  });

  it.each(['nai', 'flux', 'custom-no-negative'])('keeps missing scene negatives compatible with %s', async capability => {
    settings.defaultBackend = capability === 'nai' ? 'nai' : 'comfyui';
    state.preset.mode = capability === 'flux' ? 'simple' : 'custom';
    state.preset.simple.template = 'flux';
    state.preset.workflow = JSON.stringify({ '1': { class_type: 'CLIPTextEncode', inputs: { text: '%prompt%' } } });
    await requestSelectionImage(0, '她翻开书。', snapshotAt());
    expect(applyMessageText).toHaveBeenCalledTimes(1);
    expect(vi.mocked(buildAutoTagMessages).mock.calls[0][6]).toBe(false);
  });

  it.each([true, false])('keeps the request-start negative requirement %s when the workflow changes while building messages', async required => {
    settings.defaultBackend = 'comfyui';
    const workflow = (negative: boolean) => JSON.stringify({ '1': { class_type: 'CLIPTextEncode', inputs: { text: negative ? '%negative_prompt%' : '%prompt%' } } });
    state.preset.workflow = workflow(required);
    vi.mocked(buildAutoTagMessages).mockImplementation(async (_context, _floor, _options, _memory, prepared, _library, snapshot) => {
      expect(snapshot).toBe(required);
      state.preset.workflow = workflow(!required);
      return [{ role: 'system', content: '基础规则' }, { role: 'user', content: prepared!.promptText }];
    });
    await requestSelectionImage(0, '她翻开书。', snapshotAt());
    expect(applyMessageText).toHaveBeenCalledTimes(required ? 0 : 1);
  });

  it.each(['refusal', 'content_filter', 'length', 'reasoning_only'])('stops a definitive %s response without retrying or writing', async reason => {
    settings.autoTag.retryCount = 2;
    const error = Object.assign(new Error('completion blocked: ' + reason), { retryable: false, reason });
    vi.mocked(requestViaMainApi).mockRejectedValue(error);
    await requestSelectionImage(0, '她翻开书。', snapshotAt());
    expect(requestViaMainApi).toHaveBeenCalledTimes(1);
    expect(applyMessageText).not.toHaveBeenCalled();
    expect(promptFailures[0]?.reason).toEqual(error.message);
    vi.mocked(requestViaMainApi).mockClear();
    vi.mocked(toastr.error).mockClear();
    state.context!.chat[0].is_user = false;
    await requestFloorTags(0, { replace: true });
    expect(requestViaMainApi).toHaveBeenCalledTimes(1);
    expect(applyMessageText).not.toHaveBeenCalled();
    expect(promptFailures[0]?.reason).toEqual(error.message);
  });

  it('keeps configured retries for ordinary malformed output and reports the actual count', async () => {
    settings.autoTag.retryCount = 2;
    vi.mocked(requestViaMainApi).mockRejectedValue(new Error('malformed JSON'));
    state.context!.chat[0].is_user = false;
    await requestFloorTags(0, { replace: true });
    expect(requestViaMainApi).toHaveBeenCalledTimes(3);
    expect(applyMessageText).not.toHaveBeenCalled();
    expect(promptFailures[0]?.reason).toEqual('malformed JSON(已自动重试 2 次)');
    expect(vi.mocked(requestViaMainApi).mock.calls.every(([messages]) => messages.every(message => message.content !== SCENE_NEGATIVE_RETRY_INSTRUCTION))).toBe(true);
  });

  it('refuses a tag-only new image before saving or requesting actual image generation', async () => {
    vi.mocked(requestViaMainApi).mockImplementation(async (_messages, options) => {
      const raw = JSON.stringify({ images: [{ position: 'P1', tag: '1girl, reading' }] });
      options?.validate?.(raw);
      return raw;
    });
    await requestSelectionImage(0, '她翻开书。', snapshotAt());
    expect(applyMessageText).not.toHaveBeenCalled();
    expect(promptFailures[0]?.reason).toEqual(expect.stringContaining('完整英文自然语言'));
  });

  it('removes only the selection marker if an awaited refresh invalidates the target', async () => {
    const snapshot = snapshotAt('她翻开书。'.length);
    markForAutoGenerate('chat-a', 1, 0, 0, 'auto');
    vi.mocked(applyMessageText).mockImplementation(async (floor, buildNext, _chatId, _swipeId, _message, _extra, beforeRefresh, onRefreshInvalidated) => {
      const message = state.context!.chat[floor];
      message.mes = buildNext(message.mes)!;
      beforeRefresh?.(true);
      onRefreshInvalidated?.();
      return 'saved';
    });
    await requestSelectionImage(0, '她翻开书。', snapshot);
    expect(consumeAutoGenerate('chat-a', 0, 0, 0)).toBeNull();
    expect(consumeAutoGenerate('chat-a', 1, 0, 0)).toBe('auto');
    expect(toastr.success).not.toHaveBeenCalled();
  });

  it('holds the insertion lock until save settles and migrates static state without restarting generation after leaving', async () => {
    const snapshot = snapshotAt('她翻开书。'.length);
    setCollapsed(slotKey('chat-a', 0, 0, 0), true);
    let finish!: () => void;
    let entered!: () => void;
    const saving = new Promise<void>(resolve => { entered = resolve; });
    vi.mocked(applyMessageText).mockImplementation(async (floor, buildNext, _chatId, _swipeId, _message, _extra, beforeRefresh) => {
      const message = state.context!.chat[floor];
      const next = buildNext(message.mes);
      expect(next).not.toBeNull();
      message.mes = next!;
      entered();
      await new Promise<void>(resolve => { finish = resolve; });
      beforeRefresh?.(false);
      return 'saved';
    });
    const request = requestSelectionImage(0, '她翻开书。', snapshot);
    await saving;
    expect(isGenerationFloorLocked('chat-a', 0)).toBe(true);
    expect(consumeAutoGenerate('chat-a', 0, 0, 0)).toBeNull();
    finish();
    await request;
    expect(isGenerationFloorLocked('chat-a', 0)).toBe(false);
    expect(consumeAutoGenerate('chat-a', 0, 0, 0)).toBeNull();
    expect(isCollapsed(slotKey('chat-a', 0, 0, 1), false)).toBe(true);
    expect(isCollapsed(slotKey('chat-a', 0, 0, 0), false)).toBe(false);
    expect(toastr.success).not.toHaveBeenCalled();
  });

  it('inserts a Krea2 nl-only image below selected text and keeps the captured mode across a workflow switch', async () => {
    settings.defaultBackend = 'comfyui';
    state.preset.promptMode = 'krea2';
    vi.mocked(requestViaMainApi).mockImplementation(async (_messages, options) => {
      state.preset.promptMode = 'anima';
      const raw = JSON.stringify({ images: [{ position: 'P1', tag: '', nl: 'The woman holds an open book beside a window.' }], changes: [] });
      options?.validate?.(raw); return raw;
    });
    await requestSelectionImage(0, '她翻开书。', snapshotAt('她翻开书。'.length));
    const result = parseImageTags(state.context!.chat[0].mes)[0];
    expect(result).toContain('<nl>The woman holds an open book beside a window.</nl>');
    expect(result).toContain('<prompt_mode>krea2</prompt_mode>');
    expect(result).not.toContain('1girl');
  });
  it('works with automatic switches off, inserts below the selection and migrates the original image history', async () => {
    const snapshot = snapshotAt('她翻开书。'.length);
    const oldDelta = state.context!.chat[0].extra!.bbiCharChanges;
    const oldHash = promptHash('<bbi_image>old image</bbi_image>');
    state.context!.chat[0].extra!.bbiImage = { '0': { [oldHash]: [{
      generationId: 'old', path: '/old.png', prompt: '<bbi_image>old image</bbi_image>',
      seed: 1, status: 'ready', createdAt: 1, slotSeq: 0,
    }] } };
    await requestSelectionImage(0, '她翻开书。', snapshot);
    expect(requestViaMainApi).toHaveBeenCalledTimes(1);
    expect(requestCompletion).not.toHaveBeenCalled();
    expect(buildAutoTagMessages).toHaveBeenCalledWith(
      expect.anything(), 0, expect.objectContaining({ minImages: 1, maxImages: 1 }), null,
      expect.objectContaining({ promptText: '她翻开书。 ⟦P1⟧' }), null, false, undefined,
    );
    expect(parseImageTags(state.context!.chat[0].mes)).toEqual([
      '<bbi_image>1girl, holding a book<nl>The girl holds an open book, her eyes lowered toward the page.</nl><size>portrait</size></bbi_image>',
      '<bbi_image>old image</bbi_image>',
    ]);
    expect(consumeAutoGenerate('chat-a', 0, 0, 0)).toBe('force');
    expect(consumeAutoGenerate('chat-a', 0, 0, 1)).toBeNull();
    expect(consumeAutoGenerate('chat-a', 0, 0, 2)).toBeNull();
    expect(state.context!.chat[0].extra!.bbiCharChanges).toBe(oldDelta);
    expect(latestEntry(readStore(state.context!.chat[0]), 0, oldHash, 1)?.path).toBe('/old.png');
    expect(latestEntry(readStore(state.context!.chat[0]), 0, oldHash, 0)).toBeNull();
    expect(isGenerationFloorLocked('chat-a', 0)).toBe(false);
    expect(settings.autoTag.enabled).toBe(false);
    expect(settings.autoTag.autoGenerate).toBe(false);
  });

  it('refuses stale snapshots and missing backend before making a model request', async () => {
    const snapshot = snapshotAt();
    state.context!.chat[0].mes += '已经编辑';
    await requestSelectionImage(0, '她翻开书。', snapshot);
    expect(requestViaMainApi).not.toHaveBeenCalled();
    const current = snapshotAt();
    vi.mocked(backendStatus).mockReturnValue({ backend: 'nai', configured: false, model: '', supportsCharacters: true, reason: '未配置' });
    await requestSelectionImage(0, '她翻开书。', current);
    expect(requestViaMainApi).not.toHaveBeenCalled();
  });

  it('rejects an unclosed existing image tag before spending a model request', async () => {
    state.context!.chat[0].mes = '她翻开书。\n<bbi_image>unfinished';
    await requestSelectionImage(0, '她翻开书。', snapshotAt());
    expect(requestViaMainApi).not.toHaveBeenCalled();
    expect(applyMessageText).not.toHaveBeenCalled();
    expect(toastr.warning).toHaveBeenCalledWith(expect.stringContaining('未正确闭合'), '长夜的绘图器');
  });

  it('rejects @ references for a character changed within this floor instead of applying a late profile', async () => {
    state.context!.chat[0].extra!.bbiCharChanges = {
      v: 1, swipe: 0,
      ops: [{ kind: 'set', name: '小雪', field: 'hair', value: 'red hair', reason: '后来染发', at: 1 }],
    };
    vi.mocked(requestViaMainApi).mockImplementation(async (_messages, options) => {
      const raw = JSON.stringify({ images: [{ position: 'P1', tag: '@小雪, holding a book', nl: 'The girl holds a book with her eyes lowered toward the page.' }] });
      options?.validate?.(raw);
      return raw;
    });
    await requestSelectionImage(0, '她翻开书。', snapshotAt());
    expect(applyMessageText).not.toHaveBeenCalled();
    expect(promptFailures[0]?.reason).toEqual(expect.stringContaining('不能使用 @角色名'));
  });

  it('does not insert if the text changes during generation', async () => {
    const snapshot = snapshotAt();
    vi.mocked(requestViaMainApi).mockImplementation(async (_messages, options) => {
      options?.validate?.(modelOutput);
      state.context!.chat[0].mes = '用户的新正文';
      return modelOutput;
    });
    await requestSelectionImage(0, '她翻开书。', snapshot);
    expect(applyMessageText).not.toHaveBeenCalled();
    expect(state.context!.chat[0].mes).toBe('用户的新正文');
    expect(consumeAutoGenerate('chat-a', 0, 0, 1)).toBeNull();
  });

  it('serializes duplicate clicks on the same floor and removes only its own flag when saving fails', async () => {
    const snapshot = snapshotAt();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(requestViaMainApi).mockImplementation(async (_messages, options) => {
      await held;
      options?.validate?.(modelOutput);
      return modelOutput;
    });
    vi.mocked(applyMessageText).mockResolvedValue('build-failed');
    markForAutoGenerate('chat-a', 1, 0, 0, 'auto');
    const first = requestSelectionImage(0, '她翻开书。', snapshot);
    await requestSelectionImage(0, '她翻开书。', snapshot);
    release();
    await first;
    expect(requestViaMainApi).toHaveBeenCalledTimes(1);
    expect(consumeAutoGenerate('chat-a', 1, 0, 0)).toBe('auto');
    expect(isGenerationFloorLocked('chat-a', 0)).toBe(false);
    expect(consumeAutoGenerate('chat-a', 0, 0, 1)).toBeNull();
    expect(isGenerationFloorLocked('chat-a', 0)).toBe(false);
  });

  it('does not call the model without a verified offset or while existing images are queued or pending hydration', async () => {
    await requestSelectionImage(0, '她翻开书。', captureSelectionImageSnapshot(0)!);
    expect(requestViaMainApi).not.toHaveBeenCalled();
    const key = slotKey('chat-a', 0, 0, 0);
    const job = beginGen(key, 'old', 'queued');
    await requestSelectionImage(0, '她翻开书。', snapshotAt());
    expect(requestViaMainApi).not.toHaveBeenCalled();
    clearGen(key, job.token);
    markForAutoGenerate('chat-a', 0, 0, 0);
    await requestSelectionImage(0, '她翻开书。', snapshotAt());
    expect(requestViaMainApi).not.toHaveBeenCalled();
    expect(consumeAutoGenerate('chat-a', 0, 0, 0)).toBe('auto');
  });

  it('rechecks active image jobs after the LLM and never shifts an in-flight result', async () => {
    vi.mocked(requestViaMainApi).mockImplementation(async (_messages, options) => {
      options?.validate?.(modelOutput);
      beginGen(slotKey('chat-a', 0, 0, 0), 'old', 'generating');
      return modelOutput;
    });
    await requestSelectionImage(0, '她翻开书。', snapshotAt());
    expect(applyMessageText).not.toHaveBeenCalled();
    expect(isGenerationFloorLocked('chat-a', 0)).toBe(false);
  });

  it('keeps a newer selection lock when an aborted older request finishes after switching back', async () => {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    let chatId = 'chat-a';
    Object.assign(state.context!, {
      getCurrentChatId: () => chatId,
      eventTypes: { GENERATION_STARTED: 'start', CHARACTER_MESSAGE_RENDERED: 'rendered', CHAT_CHANGED: 'changed' },
      eventSource: { on: (name: string, handler: (...args: unknown[]) => void) => handlers.set(name, handler) },
    });
    state.context!.chat[0].is_user = false;
    state.context!.chat[0].mes = '她翻开书。';
    bindAutoTagging();
    const releases: Array<() => void> = [];
    vi.mocked(requestViaMainApi).mockImplementation(async (_messages, options) => {
      if (releases.length < 2) await new Promise<void>(resolve => releases.push(resolve));
      options?.validate?.(modelOutput);
      return modelOutput;
    });
    const first = requestSelectionImage(0, '她翻开书。', snapshotAt());
    await vi.waitFor(() => expect(requestViaMainApi).toHaveBeenCalledTimes(1));
    chatId = 'chat-b';
    handlers.get('changed')!();
    chatId = 'chat-a';
    const second = requestSelectionImage(0, '她翻开书。', snapshotAt());
    await vi.waitFor(() => expect(requestViaMainApi).toHaveBeenCalledTimes(2));
    releases[0]();
    await first;
    // 新选段仍持有保护；旧任务的 finally 不得让整楼生成中断它。
    await requestFloorTags(0);
    expect(requestViaMainApi).toHaveBeenCalledTimes(2);
    releases[1]();
    await second;
    expect(parseImageTags(state.context!.chat[0].mes)).toHaveLength(1);
  });
});


function prepareCharacterCompletionCase() {
  const entry = (name: string): CharTagEntry => ({ name, fields: { ...emptyCharFields(), hair: 'brown hair', face: 'oval face' }, raw: '', nl: '', source: 'manual', desc: '', history: [] });
  const existingOps = [
    createCharTagNewOp({ ...entry('本楼新人'), source: 'ai' }, '本楼建档', 1)!,
    createCharTagSetOp('已变化角色', 'hair', 'silver hair', '本楼后期染发', 2)!,
  ];
  const context = state.context!;
  Object.assign(context, {
    chatMetadata: { baibai_image_char_tags: { version: 3, entries: [entry('画家'), entry('已变化角色')] } },
    saveChat: vi.fn(async () => undefined),
    eventSource: { emit: vi.fn(async () => undefined) },
    eventTypes: { MESSAGE_EDITED: 'edited', MESSAGE_UPDATED: 'updated' },
  });
  setGlobalCharTagSource(() => [entry('锁定角色')]);
  const oldHash = promptHash('<bbi_image>old image</bbi_image>');
  context.chat[0].extra = {
    untouched: 'keep',
    bbiCharChanges: { v: 1, swipe: 0, ops: existingOps },
    bbiImage: { '0': { [oldHash]: [{ generationId: 'old', path: '/old.png', prompt: '<bbi_image>old image</bbi_image>', seed: 1, status: 'ready', createdAt: 1, slotSeq: 0 }] } },
  };
  hydrateCharTags();
  vi.stubGlobal('document', { querySelector: vi.fn(() => null) });
  const fill = (name: string, field: string, value: string) => ({ name, field, value, fillOnly: true, reason: '五官补全设计', position: 'P1' });
  const raw = JSON.stringify({
    images: [{ position: 'P1', tag: 'adult artist, oval face, straight nose, almond-shaped eyes, reading', nl: 'An adult artist with an oval face, almond-shaped eyes and a straight nose reads a book.' }],
    changes: [
      fill('画家', 'face', 'round face'), fill('画家', 'nose', 'straight nose'), fill('画家', 'eyeShape', 'almond-shaped eyes'),
      { name: '画家', field: 'hair', value: 'red hair', position: 'P1' },
      fill('画家', 'raw', 'replace whole appearance'), fill('画家', 'nl', 'Replace old natural language.'),
      fill('已变化角色', 'nose', 'upturned nose'), fill('锁定角色', 'mouth', 'full lips'),
      { name: '本楼新人', field: 'new', fields: { face: 'round face' }, position: 'P1' },
      { name: '摄影师', field: 'new', fields: { hair: 'black hair', face: 'angular face', nose: 'straight nose' }, reason: '相容设计', position: 'P1' },
    ],
  });
  vi.mocked(requestViaMainApi).mockImplementation(async (_messages, options) => { options?.validate?.(raw); return raw; });
  return { existingOps, oldHash, context };
}

describe('selection character completion transaction', () => {
  it('atomically appends only safe designs and shifts image history without changing existing character operations', async () => {
    const { existingOps, oldHash, context } = prepareCharacterCompletionCase();
    const actual = await vi.importActual<typeof import('@/st/messageEdit')>('@/st/messageEdit');
    vi.mocked(applyMessageText).mockImplementation(actual.applyMessageText);
    await requestSelectionImage(0, '她翻开书。', snapshotAt('她翻开书。'.length));
    expect(context.saveChat).toHaveBeenCalledTimes(1);
    const delta = readCharTagFloorDelta(context.chat[0])!;
    expect(delta.ops.slice(0, existingOps.length)).toEqual(existingOps);
    expect(delta.ops.slice(existingOps.length).map(op => op.kind === 'new' ? 'new:' + op.name : op.name + ':' + op.field)).toEqual(['画家:nose', '画家:eyeShape', 'new:摄影师']);
    expect(delta.ops.slice(existingOps.length).map(op => op.reason)).toEqual(['五官补全设计', '五官补全设计', '相容设计']);
    expect(charTagLib.entries.find(entry => entry.name === '画家')?.fields).toMatchObject({ face: 'oval face', hair: 'brown hair', nose: 'straight nose', eyeShape: 'almond-shaped eyes' });
    expect(charTagLib.entries.find(entry => entry.name === '已变化角色')?.fields.nose).toBe('');
    expect(charTagLib.entries.find(entry => entry.name === '锁定角色')?.fields.mouth).toBe('');
    expect(charTagLib.entries.some(entry => entry.name === '摄影师')).toBe(true);
    expect(context.chat[0].extra!.untouched).toBe('keep');
    expect(latestEntry(readStore(context.chat[0]), 0, oldHash, 1)?.path).toBe('/old.png');
    expect(latestEntry(readStore(context.chat[0]), 0, oldHash, 0)).toBeNull();
    expect(consumeAutoGenerate('chat-a', 0, 0, 0)).toBe('force');
    const messages = vi.mocked(requestViaMainApi).mock.calls[0][0];
    const selectionRule = messages.find(message => message.content.includes('本任务唯一允许的角色档案操作'))!.content;
    expect(selectionRule).toContain('fillOnly:true');
    expect(selectionRule).toContain('五官补全设计');
    expect(selectionRule).toContain('禁止补档的角色：已变化角色');
  });

  it('refuses to merge a delta containing valid and unknown operations without dropping the original records', async () => {
    const { context } = prepareCharacterCompletionCase();
    const delta = readCharTagFloorDelta(context.chat[0])!;
    const unknown = { kind: 'future-character-op', name: '画家', value: 'keep this opaque record' };
    context.chat[0].extra!.bbiCharChanges = { ...delta, ops: [...delta.ops, unknown] };
    const source = context.chat[0].mes;
    const extra = context.chat[0].extra;
    const record = extra!.bbiCharChanges;
    await requestSelectionImage(0, '她翻开书。', snapshotAt('她翻开书。'.length));
    expect(applyMessageText).not.toHaveBeenCalled();
    expect(context.saveChat).not.toHaveBeenCalled();
    expect(context.chat[0].mes).toBe(source);
    expect(context.chat[0].extra).toBe(extra);
    expect(context.chat[0].extra!.bbiCharChanges).toBe(record);
    expect(consumeAutoGenerate('chat-a', 0, 0, 0)).toBeNull();
    expect(promptFailures[0]?.reason).toEqual('本楼角色记录格式无法安全合并，本次未保存');
  });

  it('rolls back message, character delta and image history together if save fails', async () => {
    const { context } = prepareCharacterCompletionCase();
    const source = context.chat[0].mes;
    const extra = context.chat[0].extra;
    const originalLibrary = JSON.stringify(charTagLib.entries);
    const actual = await vi.importActual<typeof import('@/st/messageEdit')>('@/st/messageEdit');
    vi.mocked(applyMessageText).mockImplementation(actual.applyMessageText);
    vi.mocked(context.saveChat).mockRejectedValue(new Error('save failed'));
    await requestSelectionImage(0, '她翻开书。', snapshotAt('她翻开书。'.length));
    expect(context.chat[0].mes).toBe(source);
    expect(context.chat[0].swipes![0]).toBe(source);
    expect(context.chat[0].extra).toBe(extra);
    expect(JSON.stringify(charTagLib.entries)).toBe(originalLibrary);
    expect(consumeAutoGenerate('chat-a', 0, 0, 0)).toBeNull();
    expect(isGenerationFloorLocked('chat-a', 0)).toBe(false);
    expect(promptFailures[0]?.reason).toEqual('save failed');
  });


  it('merges the current message delta when an identity-preserving message clone replaced the snapshot object', async () => {
    const { context } = prepareCharacterCompletionCase();
    context.chat[0].send_date = 'stable-date';
    const snapshot = snapshotAt('她翻开书。'.length);
    const delta = readCharTagFloorDelta(context.chat[0])!;
    const preexisting = createCharTagSetOp('画家', 'mouth', 'thin lips', '点击前已有补全', 3, true)!;
    context.chat[0] = { ...context.chat[0], extra: { ...context.chat[0].extra, bbiCharChanges: { ...delta, ops: [...delta.ops, preexisting] } } };
    const actual = await vi.importActual<typeof import('@/st/messageEdit')>('@/st/messageEdit');
    vi.mocked(applyMessageText).mockImplementation(actual.applyMessageText);
    await requestSelectionImage(0, '她翻开书。', snapshot);
    expect(context.saveChat).toHaveBeenCalledTimes(1);
    expect(readCharTagFloorDelta(context.chat[0])!.ops).toContainEqual(preexisting);
    expect(charTagLib.entries.find(entry => entry.name === '画家')?.fields.mouth).toBe('thin lips');
  });

  it('does not overwrite character operations added by another task while the AI request is running', async () => {
    const { context } = prepareCharacterCompletionCase();
    const original = vi.mocked(requestViaMainApi).getMockImplementation()!;
    vi.mocked(requestViaMainApi).mockImplementation(async (...args) => {
      const result = await original(...args);
      const delta = readCharTagFloorDelta(context.chat[0])!;
      context.chat[0].extra!.bbiCharChanges = { ...delta, ops: [...delta.ops, createCharTagSetOp('画家', 'mouth', 'thin lips', '并发补全', 3, true)!] };
      return result;
    });
    await requestSelectionImage(0, '她翻开书。', snapshotAt());
    expect(applyMessageText).not.toHaveBeenCalled();
    expect(readCharTagFloorDelta(context.chat[0])!.ops.at(-1)).toMatchObject({ field: 'mouth', value: 'thin lips' });
    expect(toastr.warning).toHaveBeenCalledWith(expect.stringContaining('角色档案已变化'), '长夜的绘图器');
  });
});
