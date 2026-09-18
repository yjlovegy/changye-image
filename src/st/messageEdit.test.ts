import { afterEach, describe, expect, it, vi } from 'vitest';

import { applyMessageText } from '@/st/messageEdit';

function installContext(context: Record<string, unknown>): void {
  vi.stubGlobal('window', {
    SillyTavern: { getContext: () => context },
  });
  vi.stubGlobal('document', { querySelector: vi.fn(() => null) });
}

afterEach(() => vi.unstubAllGlobals());

describe('safe message editing', () => {
  it.each([false, true])('saves or rolls back picture history and facial profiles together (failure=%s)', async failure => {
    const originalExtra = { keep: true, obsolete: 'old', bbiImage: { old: true }, bbiCharChanges: { old: true } };
    const message = { name: 'Artist', is_user: false, is_system: false, mes: 'Original.', swipes: ['Original.'], swipe_id: 0, extra: originalExtra };
    const nextImage = { migrated: true };
    const nextProfiles = { eyeShape: 'almond-shaped eyes' };
    const beforeRefresh = vi.fn();
    const saveChat = vi.fn(async () => {
      expect(message.mes).toBe('Original. Image.');
      expect(message.extra).toEqual({ keep: true, bbiImage: nextImage, bbiCharChanges: nextProfiles });
      if (failure) throw new Error('disk failed');
    });
    installContext({ chat: [message], getCurrentChatId: () => 'chat-a', saveChat,
      eventSource: { emit: vi.fn() }, eventTypes: { MESSAGE_EDITED: 'edited', MESSAGE_UPDATED: 'updated' } });
    const result = applyMessageText(0, text => `${text} Image.`, 'chat-a', 0, message, [
      { key: 'bbiImage', value: nextImage },
      { key: 'bbiCharChanges', value: nextProfiles },
      { key: 'obsolete', value: undefined },
    ], beforeRefresh);
    if (failure) {
      await expect(result).rejects.toThrow('disk failed');
      expect(message.mes).toBe('Original.');
      expect(message.swipes[0]).toBe('Original.');
      expect(message.extra).toBe(originalExtra);
      expect(beforeRefresh).not.toHaveBeenCalled();
    } else {
      await expect(result).resolves.toBe('saved');
      expect(message.extra.bbiImage).toBe(nextImage);
      expect(message.extra.bbiCharChanges).toBe(nextProfiles);
      expect(beforeRefresh).toHaveBeenCalledExactlyOnceWith(true);
    }
    expect(saveChat).toHaveBeenCalledTimes(1);
  });
  it.each(['typed', 'opened', 'replaced'])('preserves an unsubmitted editor draft %s while saving', async change => {
    const message = { name: 'Char', is_user: false, is_system: false, mes: '原文' };
    let editor: { value: string } | null = change === 'opened' ? null : { value: '原文' };
    const cancel = vi.fn();
    const emit = vi.fn(async () => undefined);
    const updateMessageBlock = vi.fn(async () => undefined);
    const beforeRefresh = vi.fn();
    let finish!: () => void;
    installContext({
      chat: [message], getCurrentChatId: () => 'chat-a',
      saveChat: vi.fn(() => new Promise<void>(resolve => { finish = resolve; })),
      eventSource: { emit }, eventTypes: { MESSAGE_EDITED: 'edited', MESSAGE_UPDATED: 'updated' }, updateMessageBlock,
    });
    vi.stubGlobal('document', { querySelector: () => ({
      querySelector: (selector: string) => selector === '#curEditTextarea' ? editor : { click: cancel },
    }) });
    const saving = applyMessageText(0, text => `${text}和新图`, 'chat-a', null, message, undefined, beforeRefresh);
    if (change === 'typed') editor!.value = '用户还在写的草稿';
    else editor = { value: '原文' }; // 内容相同也不能覆盖新打开/替换的编辑框。
    const draft = editor!.value;
    finish();
    await expect(saving).resolves.toBe('saved');
    expect(message.mes).toBe('原文和新图');
    expect(editor!.value).toBe(draft);
    expect(beforeRefresh).toHaveBeenCalledExactlyOnceWith(false);
    expect(cancel).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    expect(updateMessageBlock).not.toHaveBeenCalled();
  });

  it('preserves draft edits made by an awaited listener and invalidates its unconsumed generation flag', async () => {
    const message = { name: 'Char', is_user: false, is_system: false, mes: '原文' };
    const editor = { value: '原文' };
    const cancel = vi.fn();
    const beforeRefresh = vi.fn();
    const onRefreshInvalidated = vi.fn();
    let finish!: () => void;
    let entered!: () => void;
    const eventStarted = new Promise<void>(resolve => { entered = resolve; });
    const emit = vi.fn(async () => {
      entered();
      await new Promise<void>(resolve => { finish = resolve; });
    });
    const updateMessageBlock = vi.fn(async () => undefined);
    installContext({
      chat: [message], getCurrentChatId: () => 'chat-a', saveChat: vi.fn(async () => undefined),
      eventSource: { emit }, eventTypes: { MESSAGE_EDITED: 'edited', MESSAGE_UPDATED: 'updated' }, updateMessageBlock,
    });
    vi.stubGlobal('document', { querySelector: () => ({
      querySelector: (selector: string) => selector === '#curEditTextarea' ? editor : { click: cancel },
    }) });
    const saving = applyMessageText(0, () => '新正文', 'chat-a', null, message, undefined, beforeRefresh, onRefreshInvalidated);
    await eventStarted;
    editor.value = '事件等待时的新草稿';
    finish();
    await expect(saving).resolves.toBe('saved');
    expect(beforeRefresh).toHaveBeenCalledExactlyOnceWith(true);
    expect(onRefreshInvalidated).toHaveBeenCalledOnce();
    expect(editor.value).toBe('事件等待时的新草稿');
    expect(cancel).not.toHaveBeenCalled();
    expect(updateMessageBlock).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it.each(['chat', 'swipe', 'message', 'text'])('keeps the saved result but skips live UI if %s changes while saving', async change => {
    const message = {
      name: 'Char', is_user: false, is_system: false, mes: '原文', swipes: ['原文', '另一页'], swipe_id: 0,
    };
    let chatId = 'chat-a';
    let finish!: () => void;
    const emit = vi.fn(async () => undefined);
    const updateMessageBlock = vi.fn(async () => undefined);
    const beforeRefresh = vi.fn();
    const context = {
      chat: [message], getCurrentChatId: () => chatId,
      saveChat: vi.fn(() => new Promise<void>(resolve => { finish = resolve; })),
      eventSource: { emit }, eventTypes: { MESSAGE_EDITED: 'edited', MESSAGE_UPDATED: 'updated' }, updateMessageBlock,
    };
    installContext(context);
    const saving = applyMessageText(0, () => '插入后的正文', 'chat-a', 0, message, undefined, beforeRefresh);
    if (change === 'chat') chatId = 'chat-b';
    if (change === 'swipe') message.swipe_id = 1;
    if (change === 'message') context.chat[0] = { ...message };
    if (change === 'text') message.mes = '保存期间用户又改过';
    finish();
    await expect(saving).resolves.toBe('saved');
    expect(message.swipes[0]).toBe('插入后的正文');
    expect(beforeRefresh).toHaveBeenCalledExactlyOnceWith(false);
    expect(emit).not.toHaveBeenCalled();
    expect(updateMessageBlock).not.toHaveBeenCalled();
  });

  it('stops refreshing when an awaited edit listener switches chats', async () => {
    const message = { name: 'Char', is_user: false, is_system: false, mes: '原文' };
    let chatId = 'chat-a';
    const updateMessageBlock = vi.fn(async () => undefined);
    const emit = vi.fn(async () => { chatId = 'chat-b'; });
    installContext({
      chat: [message], getCurrentChatId: () => chatId, saveChat: vi.fn(async () => undefined),
      eventSource: { emit }, eventTypes: { MESSAGE_EDITED: 'edited', MESSAGE_UPDATED: 'updated' }, updateMessageBlock,
    });
    const querySelector = vi.fn(() => null);
    vi.stubGlobal('document', { querySelector });
    await expect(applyMessageText(0, () => '新正文', 'chat-a', null, message)).resolves.toBe('saved');
    expect(emit).toHaveBeenCalledExactlyOnceWith('edited', 0);
    expect(querySelector).toHaveBeenCalledTimes(2); // 提交前与保存后核对原楼编辑框；切聊天后不再访问。
    expect(updateMessageBlock).not.toHaveBeenCalled();
  });

  it('commits the inserted text and migrated image history before releasing state for hydration', async () => {
    const originalStore = { '0': { same: [{ slotSeq: 0 }] } };
    const migratedStore = { '0': { same: [{ slotSeq: 1 }] } };
    const delta = { v: 1, swipe: 0, ops: [] };
    const message = {
      name: 'Char', is_user: false, is_system: false, mes: '原文', swipes: ['原文'], swipe_id: 0,
      extra: { bbiImage: originalStore, bbiCharChanges: delta },
    };
    const order: string[] = [];
    installContext({
      chat: [message], getCurrentChatId: () => 'chat-a',
      saveChat: vi.fn(async () => { order.push('saved'); }),
      eventSource: { emit: vi.fn(async () => { order.push('hydration'); }) },
      eventTypes: { MESSAGE_EDITED: 'edited', MESSAGE_UPDATED: 'updated' },
    });
    await applyMessageText(0, () => '插入图后的正文', 'chat-a', 0, message,
      { key: 'bbiImage', value: migratedStore }, () => {
        expect(message.mes).toBe('插入图后的正文');
        expect(message.extra.bbiImage).toBe(migratedStore);
        expect(message.extra.bbiCharChanges).toBe(delta);
        order.push('release');
      });
    expect(order).toEqual(['saved', 'release', 'hydration', 'hydration']);
  });

  it('rolls back both text and migrated history without changing live slot state when save fails', async () => {
    const store = { '0': { same: [{ slotSeq: 0 }] } };
    const delta = { v: 1, swipe: 0, ops: [] };
    const message = {
      name: 'Char', is_user: false, is_system: false, mes: '原文', swipes: ['原文'], swipe_id: 0,
      extra: { bbiImage: store, bbiCharChanges: delta },
    };
    const beforeRefresh = vi.fn();
    installContext({
      chat: [message], getCurrentChatId: () => 'chat-a',
      saveChat: vi.fn(async () => { throw new Error('disk'); }), eventSource: {}, eventTypes: {},
    });
    await expect(applyMessageText(0, () => '插图后的正文', 'chat-a', 0, message,
      { key: 'bbiImage', value: { '0': { same: [{ slotSeq: 1 }] } } }, beforeRefresh)).rejects.toThrow('disk');
    expect(message.mes).toBe('原文');
    expect(message.swipes[0]).toBe('原文');
    expect(message.extra.bbiImage).toBe(store);
    expect(message.extra.bbiCharChanges).toBe(delta);
    expect(beforeRefresh).not.toHaveBeenCalled();
  });

  it('updates mes and the active swipe, then emits edit/update events', async () => {
    const message = {
      name: 'Char',
      is_user: false,
      is_system: false,
      mes: '原文',
      swipes: ['旧页', '原文'],
      swipe_id: 1,
    };
    const emit = vi.fn(async () => undefined);
    const saveChat = vi.fn(async () => undefined);
    installContext({
      chat: [message],
      getCurrentChatId: () => 'chat-a',
      saveChat,
      eventSource: { emit },
      eventTypes: { MESSAGE_EDITED: 'edited', MESSAGE_UPDATED: 'updated' },
    });

    await expect(
      applyMessageText(0, text => `${text}\n<bbi_image>scene</bbi_image>`, 'chat-a', 1),
    ).resolves.toBe('saved');
    expect(message.mes).toContain('<bbi_image>scene</bbi_image>');
    expect(message.swipes[1]).toBe(message.mes);
    expect(saveChat).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenNthCalledWith(1, 'edited', 0);
    expect(emit).toHaveBeenNthCalledWith(2, 'updated', 0);
  });

  it('builds on the current text so another plugin\'s edit survives the write', async () => {
    const message = {
      name: 'Char',
      is_user: false,
      is_system: false,
      mes: '别的插件刚改过的正文',
      swipes: ['别的插件刚改过的正文'],
      swipe_id: 0,
    };
    const saveChat = vi.fn(async () => undefined);
    installContext({
      chat: [message],
      getCurrentChatId: () => 'chat-a',
      saveChat,
      eventSource: {},
      eventTypes: {},
    });

    const buildNext = vi.fn((text: string) => `${text}\n<bbi_image>scene</bbi_image>`);
    await expect(applyMessageText(0, buildNext, 'chat-a', 0)).resolves.toBe('saved');
    // 基底是落盘那一刻的正文,不是请求开始时的快照
    expect(buildNext).toHaveBeenCalledWith('别的插件刚改过的正文');
    expect(message.mes).toBe('别的插件刚改过的正文\n<bbi_image>scene</bbi_image>');
    expect(saveChat).toHaveBeenCalledOnce();
  });

  it('abandons the write when buildNext returns null', async () => {
    const message = {
      name: 'Char',
      is_user: false,
      is_system: false,
      mes: '整篇换掉的正文',
      swipes: ['整篇换掉的正文'],
      swipe_id: 0,
    };
    const saveChat = vi.fn(async () => undefined);
    installContext({
      chat: [message],
      getCurrentChatId: () => 'chat-a',
      saveChat,
      eventSource: {},
      eventTypes: {},
    });

    await expect(applyMessageText(0, () => null, 'chat-a', 0)).resolves.toBe('build-failed');
    expect(message.mes).toBe('整篇换掉的正文');
    expect(saveChat).not.toHaveBeenCalled();
  });

  it('does not write into another swipe with identical text', async () => {
    const message = {
      name: 'Char',
      is_user: false,
      is_system: false,
      mes: '相同正文',
      swipes: ['相同正文', '相同正文'],
      swipe_id: 1,
    };
    const saveChat = vi.fn(async () => undefined);
    installContext({
      chat: [message],
      getCurrentChatId: () => 'chat-a',
      saveChat,
      eventSource: {},
      eventTypes: {},
    });

    await expect(
      applyMessageText(0, () => '新正文', 'chat-a', 0),
    ).resolves.toBe('swipe-changed');
    expect(saveChat).not.toHaveBeenCalled();
  });

  it('accepts a replaced message object with the same identity', async () => {
    const original = {
      name: 'Char',
      is_user: false,
      is_system: false,
      mes: '原文',
      swipes: ['原文'],
      swipe_id: 0,
      send_date: '2026-08-27 10:00:00',
      extra: {},
    };
    // 别的插件整体换壳(chat[i] = {...chat[i], mes}):同一条消息,不该判成楼层变化
    const replacement = { ...original, mes: '别的插件改写后的正文', extra: {} };
    const context = {
      chat: [replacement],
      getCurrentChatId: () => 'chat-a',
      saveChat: vi.fn(async () => undefined),
      eventSource: {},
      eventTypes: {},
    };
    installContext(context);

    await expect(
      applyMessageText(0, text => `${text}!`, 'chat-a', 0, original),
    ).resolves.toBe('saved');
    expect(replacement.mes).toBe('别的插件改写后的正文!');
    expect(context.saveChat).toHaveBeenCalledOnce();
  });

  it('rejects a different message in the slot (floor deleted, index shifted)', async () => {
    const original = {
      name: 'Char',
      is_user: false,
      is_system: false,
      mes: '原文',
      swipes: ['原文'],
      swipe_id: 0,
      send_date: '2026-08-27 10:00:00',
      extra: {},
    };
    const other = { ...original, send_date: '2026-08-27 11:22:33', extra: {} };
    const context = {
      chat: [other],
      getCurrentChatId: () => 'chat-a',
      saveChat: vi.fn(async () => undefined),
      eventSource: {},
      eventTypes: {},
    };
    installContext(context);

    await expect(
      applyMessageText(
        0,
        () => '新正文',
        'chat-a',
        0,
        original,
        { key: 'bbiCharChanges', value: { v: 1, swipe: 0, ops: [] } },
      ),
    ).resolves.toBe('floor-changed');
    expect(other.mes).toBe('原文');
    expect(other.extra).toEqual({});
    expect(context.saveChat).not.toHaveBeenCalled();
  });

  it('rolls back message extra when saving fails', async () => {
    const message = {
      name: 'Char',
      is_user: false,
      is_system: false,
      mes: '原文',
      swipes: ['原文'],
      swipe_id: 0,
      extra: { keep: true },
    };
    installContext({
      chat: [message],
      getCurrentChatId: () => 'chat-a',
      saveChat: vi.fn(async () => {
        throw new Error('save failed');
      }),
      eventSource: {},
      eventTypes: {},
    });

    await expect(
      applyMessageText(
        0,
        () => '新正文',
        'chat-a',
        0,
        message,
        { key: 'bbiCharChanges', value: { v: 1, swipe: 0, ops: [] } },
      ),
    ).rejects.toThrow('save failed');
    expect(message.mes).toBe('原文');
    expect(message.extra).toEqual({ keep: true });
  });
});
