import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openPromptEditor, type PromptEditorOptions } from '@/floor/promptEditor';
import { reviseImagePrompt } from '@/autoTag/promptRevision';
import { markForAutoGenerate, consumeAutoGenerate } from '@/floor/autoGenerate';
import { hydrateMessage } from '@/floor/hydrate';
import { clearAllGen, isGenerationFloorLocked } from '@/floor/genState';
import { parseImageTags, serializeImageTag, type ImageTagContent } from '@/st/imageTagRegex';
import type { STContext, STMessage } from '@/st/context';

interface EditorProps {
  content: ImageTagContent;
  busy: boolean;
  closing: boolean;
  revise(content: ImageTagContent, instruction: string, signal: AbortSignal): Promise<ImageTagContent>;
  onApply(content: ImageTagContent, regenerate: boolean): void;
  onClose(): void;
  onDirty(dirty: boolean): void;
}

const state = vi.hoisted(() => ({
  context: null as STContext | null,
  chatId: 'chat-a',
  props: null as EditorProps | null,
  order: [] as string[],
  preset: {
    id: 'workflow-a', name: 'A', mode: 'custom',
    workflow: JSON.stringify({ '1': { class_type: 'CLIPTextEncode', inputs: { text: '%negative_prompt%' } } }),
    simple: { template: 'checkpoint' }, fixedPrompts: { positivePrefix: '', positiveSuffix: '', negative: '' },
  },
}));

vi.mock('vue', async importOriginal => {
  const actual = await importOriginal<typeof import('vue')>();
  return {
    ...actual,
    h: vi.fn((_component, props) => ({ props })),
    render: vi.fn((node: { props: EditorProps } | null) => { if (node) state.props = node.props; }),
  };
});
vi.mock('@/floor/PromptEditor.vue', () => ({ default: {} }));
vi.mock('@/autoTag/promptRevision', () => ({ reviseImagePrompt: vi.fn() }));
vi.mock('@/st/context', () => ({ getContext: () => state.context }));
vi.mock('@/floor/hydrate', () => ({ hydrateMessage: vi.fn() }));
vi.mock('@/floor/autoGenerate', () => ({
  markForAutoGenerate: vi.fn(() => { state.order.push('mark'); }),
  consumeAutoGenerate: vi.fn(),
}));
vi.mock('@/components/confirm', () => ({ confirmDialog: vi.fn(async () => true) }));
vi.mock('@/generate', () => ({ backendStatus: vi.fn(() => ({ configured: true })) }));
vi.mock('@/state/settings', () => ({
  settings: { defaultBackend: 'comfyui', nai: { model: 'nai-diffusion-4-5-full' } },
  activeComfyPreset: () => state.preset,
}));

const original: ImageTagContent = {
  tag: 'adult artist, brown hair, blue shirt, studio',
  nl: 'An adult artist in a blue shirt reads an open sketchbook beside the studio window.',
  negative: 'duplicate person', characters: [], size: 'portrait',
};
const revised: ImageTagContent = {
  ...original,
  tag: 'adult artist, brown hair, green shirt, studio',
  nl: 'An adult artist in a green shirt reads an open sketchbook beside the studio window.',
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  // Controller intentionally returns void from event callbacks; drain their bounded save/event chain.
  for (let index = 0; index < 20; index++) await Promise.resolve();
}

function editor(): EditorProps {
  if (!state.props) throw new Error('editor was not mounted');
  return state.props;
}

function open(overrides: Partial<PromptEditorOptions> = {}): EditorProps {
  const tags = parseImageTags(state.context!.chat[0].mes);
  openPromptEditor({
    at: { chatId: state.chatId, messageId: 0, swipeId: 0, seq: 1, rawTag: tags[1], tagLayout: tags },
    content: { ...original, characters: [] }, historyCount: 1, configured: true, revisionMode: true,
    ...overrides,
  });
  return editor();
}

type Change = 'chat' | 'text' | 'swipe' | 'message' | 'workflow';
function changeTarget(change: Change): void {
  const message = state.context!.chat[0];
  if (change === 'chat') state.chatId = 'chat-b';
  if (change === 'text') message.mes += '\n用户补充了一句正文。';
  if (change === 'swipe') message.swipe_id = 1;
  if (change === 'message') state.context!.chat[0] = { ...message, send_date: 'different-message' };
  if (change === 'workflow') state.preset.fixedPrompts.positivePrefix = 'new workflow preference';
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  clearAllGen();
  state.chatId = 'chat-a';
  state.props = null;
  state.order = [];
  state.preset.fixedPrompts.positivePrefix = '';
  const first = serializeImageTag({ ...original, tag: 'still life, paintbrushes' });
  const target = serializeImageTag(original);
  const last = serializeImageTag({ ...original, tag: 'studio exterior, evening' });
  const source = `画家准备画具。\n${first}\n画家翻开画册。\n${target}\n工作室的窗外渐暗。\n${last}`;
  const message: STMessage = {
    name: '画家', send_date: 'message-created-at', is_user: false, is_system: false,
    mes: source, swipes: [source, '另一条回复'], swipe_id: 0,
  };
  state.context = {
    chat: [message], getCurrentChatId: () => state.chatId,
    saveChat: vi.fn(async () => { state.order.push('saved'); }),
    eventSource: { emit: vi.fn(async () => { state.order.push('event'); }) },
    eventTypes: { MESSAGE_EDITED: 'edited', MESSAGE_UPDATED: 'updated' },
  } as unknown as STContext;
  vi.stubGlobal('document', {
    getElementById: vi.fn(() => ({ shadowRoot: { appendChild: vi.fn() } })),
    createElement: vi.fn(() => ({ remove: vi.fn() })),
    querySelector: vi.fn(() => null),
  });
  vi.stubGlobal('toastr', { warning: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn() });
  vi.mocked(reviseImagePrompt).mockImplementation(async () => ({ ...revised, characters: [] }));
});

afterEach(async () => {
  state.props?.onDirty(false);
  state.props?.onClose();
  await flush();
  vi.runOnlyPendingTimers();
  clearAllGen();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('prompt editor revision controller', () => {
  it('returns an AI revision as a draft without writing, hydrating, or generating', async () => {
    const source = state.context!.chat[0].mes;
    const props = open();
    const signal = new AbortController().signal;
    await expect(props.revise(original, '把衬衫改成绿色', signal)).resolves.toEqual(revised);
    expect(reviseImagePrompt).toHaveBeenCalledWith(original, '把衬衫改成绿色', expect.any(AbortSignal));
    expect(state.context!.chat[0].mes).toBe(source);
    expect(state.context!.saveChat).not.toHaveBeenCalled();
    expect(markForAutoGenerate).not.toHaveBeenCalled();
    expect(hydrateMessage).not.toHaveBeenCalled();
  });

  it('replaces only the selected image after confirmation and marks it only after save resolves', async () => {
    const context = state.context!;
    const message = context.chat[0];
    const source = message.mes;
    const tags = parseImageTags(source);
    const saved = deferred<void>();
    vi.mocked(context.saveChat).mockImplementation(async () => { await saved.promise; state.order.push('saved'); });
    const props = open();
    const draft = await props.revise(original, '把衬衫改成绿色', new AbortController().signal);
    expect(context.saveChat).not.toHaveBeenCalled();
    props.onApply(draft, true);
    expect(context.saveChat).toHaveBeenCalledTimes(1);
    expect(markForAutoGenerate).not.toHaveBeenCalled();
    expect(isGenerationFloorLocked('chat-a', 0)).toBe(true);
    saved.resolve();
    await flush();
    expect(message.mes).toBe(source.replace(tags[1], serializeImageTag(revised)));
    expect(message.swipes![0]).toBe(message.mes);
    expect(parseImageTags(message.mes)).toEqual([tags[0], serializeImageTag(revised), tags[2]]);
    expect(markForAutoGenerate).toHaveBeenCalledExactlyOnceWith('chat-a', 0, 0, 1, 'force', expect.any(Function));
    expect(state.order.slice(0, 3)).toEqual(['saved', 'mark', 'event']);
    expect(isGenerationFloorLocked('chat-a', 0)).toBe(false);
    expect(editor().closing).toBe(true);
    // 正常关窗不能让已确认图片的懒加载生成标记过期。
    expect(vi.mocked(markForAutoGenerate).mock.calls[0][5]?.()).toBe(true);
  });

  it('can confirm a draft for a message without a swipes array', async () => {
    delete state.context!.chat[0].swipes;
    delete state.context!.chat[0].swipe_id;
    const props = open();
    props.onApply(revised, true);
    await flush();
    expect(state.context!.saveChat).toHaveBeenCalledTimes(1);
    expect(parseImageTags(state.context!.chat[0].mes)[1]).toBe(serializeImageTag(revised));
    expect(markForAutoGenerate).toHaveBeenCalledExactlyOnceWith('chat-a', 0, 0, 1, 'force', expect.any(Function));
  });

  it.each<Change>(['chat', 'text', 'swipe', 'message', 'workflow'])('rejects a %s change before sending an AI revision', async change => {
    const props = open();
    changeTarget(change);
    await expect(props.revise(original, '把衬衫改成绿色', new AbortController().signal)).rejects.toThrow('已变化');
    expect(reviseImagePrompt).not.toHaveBeenCalled();
    expect(state.context!.saveChat).not.toHaveBeenCalled();
    expect(markForAutoGenerate).not.toHaveBeenCalled();
  });

  it.each<Change>(['chat', 'text', 'swipe', 'message', 'workflow'])('rejects an AI response when %s changes during the request', async change => {
    const response = deferred<ImageTagContent>();
    vi.mocked(reviseImagePrompt).mockReturnValue(response.promise);
    const props = open();
    const request = props.revise(original, '把衬衫改成绿色', new AbortController().signal);
    const rejected = expect(request).rejects.toThrow('已变化');
    changeTarget(change);
    response.resolve(revised);
    await rejected;
    expect(state.context!.saveChat).not.toHaveBeenCalled();
    expect(markForAutoGenerate).not.toHaveBeenCalled();
  });

  it.each<Change>(['chat', 'text', 'swipe', 'message', 'workflow'])('preserves the draft without committing if %s changes before confirmation', async change => {
    const props = open();
    const draft = await props.revise(original, '把衬衫改成绿色', new AbortController().signal);
    changeTarget(change);
    props.onApply(draft, true);
    await flush();
    expect(state.context!.saveChat).not.toHaveBeenCalled();
    expect(markForAutoGenerate).not.toHaveBeenCalled();
    expect(editor().closing).toBe(false);
    expect(toastr.warning).toHaveBeenCalledWith(expect.stringContaining('已变化'), '长夜的绘图器');
  });

  it.each(['cancel', 'close'])('aborts on %s and rejects a response even if the request ignores cancellation', async action => {
    const response = deferred<ImageTagContent>();
    vi.mocked(reviseImagePrompt).mockReturnValue(response.promise);
    const props = open();
    const caller = new AbortController();
    const request = props.revise(original, '把衬衫改成绿色', caller.signal);
    const rejected = expect(request).rejects.toMatchObject({ name: 'AbortError' });
    const requestSignal = vi.mocked(reviseImagePrompt).mock.calls[0][2]!;
    if (action === 'cancel') caller.abort();
    else props.onClose();
    expect(requestSignal.aborted).toBe(true);
    response.resolve(revised);
    await rejected;
    expect(state.context!.saveChat).not.toHaveBeenCalled();
    expect(markForAutoGenerate).not.toHaveBeenCalled();
  });

  it('ignores an obsolete response after a newer revision has started', async () => {
    const response = deferred<ImageTagContent>();
    vi.mocked(reviseImagePrompt).mockReturnValueOnce(response.promise).mockResolvedValueOnce(revised);
    const props = open();
    const first = props.revise(original, '修改衬衫颜色', new AbortController().signal);
    const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    const second = props.revise(original, '把衬衫改成绿色', new AbortController().signal);
    await expect(second).resolves.toEqual(revised);
    response.resolve(original);
    await rejected;
    expect(state.context!.saveChat).not.toHaveBeenCalled();
    expect(markForAutoGenerate).not.toHaveBeenCalled();
  });

  it('rolls back the selected tag on save failure and never starts generation', async () => {
    const source = state.context!.chat[0].mes;
    vi.mocked(state.context!.saveChat).mockRejectedValue(new Error('save failed'));
    open().onApply(revised, true);
    await flush();
    expect(state.context!.chat[0].mes).toBe(source);
    expect(state.context!.chat[0].swipes![0]).toBe(source);
    expect(markForAutoGenerate).not.toHaveBeenCalled();
    expect(hydrateMessage).not.toHaveBeenCalled();
    expect(editor().busy).toBe(false);
    expect(editor().closing).toBe(false);
    expect(isGenerationFloorLocked('chat-a', 0)).toBe(false);
    expect(toastr.error).toHaveBeenCalledWith('save failed', '长夜的绘图器');
  });

  it.each<Change>(['chat', 'text', 'swipe', 'message', 'workflow'])('does not mark generation when %s changes while saving', async change => {
    const saved = deferred<void>();
    vi.mocked(state.context!.saveChat).mockReturnValue(saved.promise);
    open().onApply(revised, true);
    expect(markForAutoGenerate).not.toHaveBeenCalled();
    changeTarget(change);
    saved.resolve();
    await flush();
    expect(markForAutoGenerate).not.toHaveBeenCalled();
    expect(hydrateMessage).not.toHaveBeenCalled();
    expect(isGenerationFloorLocked('chat-a', 0)).toBe(false);
    expect(toastr.warning).toHaveBeenCalledWith(expect.stringContaining('本次未启动生图'), '长夜的绘图器');
  });


  it('invalidates the consumption guard and revokes the mark when workflow changes during an awaited refresh', async () => {
    const refreshed = deferred<void>();
    vi.mocked(state.context!.eventSource.emit!).mockImplementationOnce(async () => { await refreshed.promise; });
    open().onApply(revised, true);
    await flush();
    expect(markForAutoGenerate).toHaveBeenCalledExactlyOnceWith('chat-a', 0, 0, 1, 'force', expect.any(Function));
    const isCurrent = vi.mocked(markForAutoGenerate).mock.calls[0][5]!;
    expect(isCurrent()).toBe(true);
    changeTarget('workflow');
    // 即使异步刷新还未返回，后续卡片消费标记时也不能使用新工作流。
    expect(isCurrent()).toBe(false);
    refreshed.resolve();
    await flush();
    expect(consumeAutoGenerate).toHaveBeenCalledExactlyOnceWith('chat-a', 0, 0, 1);
    expect(hydrateMessage).not.toHaveBeenCalled();
    expect(toastr.warning).toHaveBeenCalledWith(expect.stringContaining('本次未启动生图'), '长夜的绘图器');
  });

  it('revokes its unconsumed generation mark if a refresh listener changes the chat', async () => {
    const refreshed = deferred<void>();
    vi.mocked(state.context!.eventSource.emit!).mockImplementationOnce(async () => { await refreshed.promise; });
    open().onApply(revised, true);
    await flush();
    expect(markForAutoGenerate).toHaveBeenCalledExactlyOnceWith('chat-a', 0, 0, 1, 'force', expect.any(Function));
    state.chatId = 'chat-b';
    refreshed.resolve();
    await flush();
    expect(consumeAutoGenerate).toHaveBeenCalledExactlyOnceWith('chat-a', 0, 0, 1);
    expect(hydrateMessage).not.toHaveBeenCalled();
  });
});
