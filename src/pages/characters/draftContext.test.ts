import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import { compileScript, parse } from 'vue/compiler-sfc';
import ts from 'typescript';
import * as CharTags from '@/state/charTags';
import { appearanceContextKey, type AppearanceCompletion } from '@/autoTag/charCompletion';
import type { STContext } from '@/st/context';

// Exercise the real SFC setup functions without a browser or any model/storage implementation.
const descriptor = parse(readFileSync(new URL('./index.vue', import.meta.url), 'utf8')).descriptor;
const compiled = compileScript(descriptor, { id: 'character-draft-context-test' });
const javascript = ts.transpileModule(compiled.content, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

const originalContext = {
  chat: [], name1: '玩家', name2: '小雪', characterId: 0,
  characters: [{ name: '小雪', avatar: 'snow.png' }, { name: '其他角色', avatar: 'other.png' }],
  getCurrentChatId: () => 'chat-a',
} as unknown as STContext;
let currentContext: STContext;
let unmount: () => void;
const writes = {
  upsertCharTag: vi.fn(), removeCharTag: vi.fn(), rollbackCharTag: vi.fn(),
  upsertGlobalCharTag: vi.fn(), removeGlobalCharTag: vi.fn(),
  promoteCharTagToGlobal: vi.fn(), copyGlobalCharTagToChat: vi.fn(),
};
const completion = vi.fn();
const completionResult: AppearanceCompletion = {
  fields: { nose: 'straight nose' }, evidence: { nose: { source: '角色卡', quote: '鼻梁挺直' } },
  status: 'completed', sourceLabels: ['角色卡'],
};

interface Controller {
  draft: Vue.Ref<{ fields: Record<CharTags.CharTagField, string> } | null>;
  openEntry: (entry: CharTags.CharTagEntry, scope: 'chat' | 'global') => void;
  confirmEntry: () => void;
  completeFromReferences: () => Promise<void>;
  askRemove: () => void;
  confirmRemove: () => void;
  askPromote: () => void;
  confirmPromote: () => void;
  copyToChat: () => void;
  askRollback: (record: CharTags.CharTagChangeRecord) => void;
  confirmRollback: () => void;
}

function createController(): Controller {
  const modules: Record<string, unknown> = {
    vue: { ...Vue, onUnmounted: (callback: () => void) => { unmount = callback; } },
    '@/autoTag/charCompletion': { appearanceContextKey, completeCharacterAppearance: completion },
    '@/state/charTags': { ...CharTags, ...writes },
    '@/state/globalCharTags': { globalCharTagLib: Vue.reactive({ entries: [] }), ...writes },
    '@/st/context': { getContext: () => currentContext },
  };
  const output = { exports: {} as { default?: { setup: (props: object, context: object) => Controller } } };
  new Function('require', 'module', 'exports', javascript)(
    (name: string) => name.endsWith('.vue') ? { default: {} } : modules[name], output, output.exports,
  );
  return output.exports.default!.setup({}, { expose: vi.fn() });
}

function entry(): CharTags.CharTagEntry {
  return { name: '小雪', fields: { ...CharTags.emptyCharFields(), hair: 'black hair' }, raw: '', nl: '', source: 'manual', desc: '', history: [] };
}

beforeEach(() => {
  vi.clearAllMocks();
  currentContext = originalContext;
  completion.mockResolvedValue(completionResult);
  vi.stubGlobal('toastr', { warning: vi.fn(), info: vi.fn(), success: vi.fn(), error: vi.fn() });
});
afterEach(() => vi.unstubAllGlobals());

describe('character draft context ownership', () => {
  it('keeps a completed A draft from saving into B, while allowing a deliberate return to A', async () => {
    const controller = createController();
    controller.openEntry(entry(), 'chat');
    await controller.completeFromReferences();
    expect(controller.draft.value?.fields.nose).toBe('straight nose');
    currentContext = { ...originalContext, characterId: 1, getCurrentChatId: () => 'chat-b' };
    controller.confirmEntry();
    expect(writes.upsertCharTag).not.toHaveBeenCalled();
    currentContext = originalContext;
    controller.confirmEntry();
    expect(writes.upsertCharTag).toHaveBeenCalledOnce();
  });

  it('guards completion startup, delete, promote and rollback after changing context', async () => {
    const controller = createController();
    controller.openEntry(entry(), 'chat');
    controller.askRemove();
    controller.askPromote();
    controller.askRollback({ field: 'hair', from: 'black hair', to: 'red hair', at: 1, floor: 0, reason: '染发' });
    currentContext = { ...originalContext, characterId: 1 };
    await controller.completeFromReferences();
    controller.confirmRemove();
    controller.confirmPromote();
    controller.confirmRollback();
    expect(completion).not.toHaveBeenCalled();
    expect(Object.values(writes).every(write => write.mock.calls.length === 0)).toBe(true);
  });

  it('also guards global save, deletion and copy-to-chat against a stale opened context', () => {
    const controller = createController();
    controller.openEntry(entry(), 'global');
    currentContext = { ...originalContext, characterId: 1 };
    controller.confirmEntry();
    controller.confirmRemove();
    controller.copyToChat();
    expect(Object.values(writes).every(write => write.mock.calls.length === 0)).toBe(true);
  });

  it('aborts the request when the page unmounts and ignores its late completion', async () => {
    let finish!: (result: AppearanceCompletion) => void;
    completion.mockImplementationOnce(() => new Promise<AppearanceCompletion>(resolve => { finish = resolve; }));
    const controller = createController();
    controller.openEntry(entry(), 'chat');
    const pending = controller.completeFromReferences();
    const signal = completion.mock.calls[0][3] as AbortSignal;
    unmount();
    expect(signal.aborted).toBe(true);
    finish(completionResult);
    await pending;
    expect(controller.draft.value).toBeNull();
    expect(Object.values(writes).every(write => write.mock.calls.length === 0)).toBe(true);
  });
});
