import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiChannel } from '@/state/settings';
import { buildRequestBody, CompletionResponseError, extractContent, readSseContent, requestCompletion, requestViaMainApi } from './client';

/** 历史层全部 mock 掉:这里要断的正是「什么时候记成功/失败」 */
const h = vi.hoisted(() => ({
  beginLlm: vi.fn(() => 1),
  finishLlm: vi.fn(),
  failLlm: vi.fn(),
  patchLlmTokens: vi.fn(),
  patchLlmResponse: vi.fn(),
  generateRaw: vi.fn(),
}));

vi.mock('@/state/history', () => ({
  FOLLOW_MAIN_API: '跟随主 API',
  beginLlm: h.beginLlm,
  finishLlm: h.finishLlm,
  failLlm: h.failLlm,
  patchLlmTokens: h.patchLlmTokens,
  patchLlmResponse: h.patchLlmResponse,
  // 与真实实现同语义:吞异常返回 null
  safeHistory: (fn: () => unknown) => {
    try {
      return fn();
    } catch {
      return null;
    }
  },
}));

vi.mock('@/st/context', () => ({
  getContext: () => ({ getRequestHeaders: () => ({}), generateRaw: h.generateRaw }),
}));

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const channel: ApiChannel = {
  id: 'ch1',
  name: '测试渠道',
  url: 'https://api.example.com',
  key: 'k',
  model: 'm',
  temperature: 1,
  maxTokens: 1024,
  timeoutSec: 60,
  stream: false,
  prefill: true,
  excludeParams: [],
  reasoningEffort: '',
};
const messages = [{ role: 'user' as const, content: 'hi' }];
/** 带 usage 的响应:避免触发 token 估算分支(那需要主界面分词器) */
const okPayload = {
  choices: [{ message: { role: 'assistant', content: '  答案文本  ' } }],
  usage: { prompt_tokens: 5, completion_tokens: 7 },
};

/** 造一个最小 Response,可读出给定 SSE 文本 */
function sseResponse(text: string): Response {
  const bytes = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

describe('buildRequestBody:思考强度与两条源分支', () => {
  const msgs = [{ role: 'user' as const, content: 'hi' }];
  const build = (over: Partial<typeof channel> = {}) =>
    buildRequestBody({ ...channel, ...over }, msgs, 'https://api.example.com/v1', false);

  it('未设思考强度 → 走 openai 源,请求体与加功能前逐字节一致', () => {
    expect(build()).toEqual({
      chat_completion_source: 'openai',
      reverse_proxy: 'https://api.example.com/v1',
      proxy_password: 'k',
      model: 'm',
      messages: msgs,
      temperature: 1,
      max_tokens: 1024,
      stream: false,
      presence_penalty: 0,
      frequency_penalty: 0,
    });
  });

  it('设了思考强度 → 切 custom 源,并经 custom_include_body 透传', () => {
    const body = build({ reasoningEffort: 'high' });
    expect(body.chat_completion_source).toBe('custom');
    expect(body.custom_url).toBe('https://api.example.com/v1');
    // 顶层不发 reasoning_effort:openai/custom 源都卡模型名白名单,
    // 模型名恰好命中时会覆盖掉我们真正想发的值
    expect(body.reasoning_effort).toBeUndefined();
    expect(JSON.parse(body.custom_include_body as string)).toEqual({ reasoning_effort: 'high' });
  });

  it('custom 源必须靠 header 带 key:proxy_password 在该源下不被读取', () => {
    const body = build({ reasoningEffort: 'high' });
    expect(body.proxy_password).toBeUndefined();
    expect(JSON.parse(body.custom_include_headers as string)).toEqual({
      Authorization: 'Bearer k',
    });
  });

  it('key 含 YAML 元字符时仍能安全注入(靠 JSON.stringify 转义)', () => {
    // 手拼 YAML 会在这类 key 上解析失败;而 ST 的 mergeObjectWithYaml 是静默忽略,
    // header 注入失败 → 退回读 ST 自己的 Custom 密钥 → 可能把别家的 key 发到本端点。
    const nasty = 'sk-a:b#c{d}e*f "g"';
    const body = build({ reasoningEffort: 'high', key: nasty });
    expect(JSON.parse(body.custom_include_headers as string).Authorization).toBe(`Bearer ${nasty}`);
  });

  it('空白字符串视同未设(不误切 custom 源)', () => {
    expect(build({ reasoningEffort: '   ' }).chat_completion_source).toBe('openai');
  });

  it('取值不做白名单:非常规值原样透传', () => {
    const body = build({ reasoningEffort: '我自己的档位' });
    expect(JSON.parse(body.custom_include_body as string).reasoning_effort).toBe('我自己的档位');
  });

  it('excludeParams 在两条分支下都照常生效', () => {
    expect(build({ excludeParams: ['temperature'] }).temperature).toBeUndefined();
    expect(
      build({ excludeParams: ['temperature'], reasoningEffort: 'high' }).temperature,
    ).toBeUndefined();
  });
});

describe('extractContent:标准响应', () => {
  it('message.content 正常提取', () => {
    const data = { choices: [{ message: { role: 'assistant', content: 'hello' } }] };
    expect(extractContent(data)).toBe('hello');
  });

  it('兼容 choices[0].text 与顶层 content', () => {
    expect(extractContent({ choices: [{ text: 'legacy' }] })).toBe('legacy');
    expect(extractContent({ content: 'top-level' })).toBe('top-level');
  });

  it('content 为 content-parts 数组时拼接各段 text', () => {
    const data = { choices: [{ message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } }] };
    expect(extractContent(data)).toBe('ab');
  });

  it('content 为 null 时返回空串而非抛错', () => {
    const data = { choices: [{ message: { role: 'assistant', content: null, refusal: null } }] };
    expect(extractContent(data)).toBe('');
  });
});

describe('extractContent:推理模型把答案塞进 reasoning', () => {
  it('content 为空时回退 reasoning', () => {
    const data = {
      choices: [{
        message: {
          role: 'assistant',
          content: null,
          reasoning: '思考过程…\n\n{"images":[],"changes":[]}',
        },
      }],
    };
    expect(extractContent(data)).toContain('"images"');
  });

  it('content 为空时回退 reasoning_content(DeepSeek 标准字段)', () => {
    const data = {
      choices: [{
        message: { role: 'assistant', content: null, reasoning_content: '答案在里' },
      }],
    };
    expect(extractContent(data)).toBe('答案在里');
  });

  it('content 为空时回退 thinking', () => {
    const data = { choices: [{ message: { content: null, thinking: 'via thinking' } }] };
    expect(extractContent(data)).toBe('via thinking');
  });

  it('content 非空时绝不混入 reasoning', () => {
    const data = {
      choices: [{
        message: { role: 'assistant', content: 'final answer', reasoning: 'chain of thought' },
      }],
    };
    expect(extractContent(data)).toBe('final answer');
  });
});

describe('readSseContent:流式', () => {
  it('retains the final data line when EOF has no trailing newline', async () => {
    const sse = 'data: {"choices":[{"delta":{"content":"{\\"images\\":[]}"},"finish_reason":"stop"}]}';
    await expect(readSseContent(sseResponse(sse))).resolves.toBe('{"images":[]}');
  });

  it('decodes a multibyte character split across transport chunks before handling the final line', async () => {
    const bytes = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"小雪"}}]}');
    const split = bytes.indexOf(0xe5) + 1;
    const response = new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(bytes.slice(0, split));
      controller.enqueue(bytes.slice(split));
      controller.close();
    } }));
    await expect(readSseContent(response)).resolves.toBe('小雪');
  });

  it('拼接 delta.content', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"Hel"}}]}',
      'data: {"choices":[{"delta":{"content":"lo"}}]}',
      'data: [DONE]',
      '',
    ].join('\n');
    await expect(readSseContent(sseResponse(sse))).resolves.toBe('Hello');
  });

  it('content 全空时回退拼接 reasoning 增量', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"reasoning":"思考"}}]}',
      'data: {"choices":[{"delta":{"reasoning_content":"…{\\"images\\":[]}"}}]}',
      'data: {"choices":[{"delta":{}}]}',
      'data: [DONE]',
      '',
    ].join('\n');
    await expect(readSseContent(sseResponse(sse))).resolves.toContain('"images"');
  });

  it('content 出现后忽略 reasoning,不拼接', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"reasoning":"先想"}}]}',
      'data: {"choices":[{"delta":{"content":"答案"}}]}',
      'data: {"choices":[{"delta":{"content":"!"}}]}',
      'data: [DONE]',
      '',
    ].join('\n');
    await expect(readSseContent(sseResponse(sse))).resolves.toBe('答案!');
  });
});

describe('validate:历史「成功」= 调用方验收通过', () => {
  beforeEach(() => {
    h.beginLlm.mockClear();
    h.finishLlm.mockClear();
    h.failLlm.mockClear();
    h.patchLlmResponse.mockClear();
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(okPayload)));
  });

  it('验收通过 → 返回文本,历史记成功', async () => {
    const seen: string[] = [];
    const text = await requestCompletion(channel, messages, {
      validate: raw => seen.push(raw),
    });
    expect(text).toBe('答案文本');
    expect(seen).toEqual(['答案文本']); // validate 拿到的是提取后的正文
    expect(h.finishLlm).toHaveBeenCalledTimes(1);
    expect(h.failLlm).not.toHaveBeenCalled();
  });

  it('不传 validate → 维持旧行为:拿到文本即记成功', async () => {
    await expect(requestCompletion(channel, messages)).resolves.toBe('答案文本');
    expect(h.finishLlm).toHaveBeenCalledTimes(1);
  });

  it('验收抛错 → 请求按失败抛出,历史记失败而非成功', async () => {
    // 这是「HTTP 成功但协议解析不过」的场景:必须 failLlm,否则重试会在历史里
    // 留下两条绿色成功记录,看历史的人会误以为成功也重复调用。
    await expect(
      requestCompletion(channel, messages, {
        validate: () => {
          throw new Error('协议不合法');
        },
      }),
    ).rejects.toThrow('协议不合法');
    expect(h.finishLlm).not.toHaveBeenCalled();
    expect(h.failLlm).toHaveBeenCalledWith(1, '协议不合法', false);
    expect(h.patchLlmResponse).toHaveBeenCalledWith(1, expect.objectContaining({
      response: '答案文本', promptTokens: 5, completionTokens: 7,
      contentSource: 'content', responseChars: '  答案文本  '.length, reasoningChars: 0,
    }));
    expect(h.patchLlmResponse.mock.invocationCallOrder[0]).toBeLessThan(h.failLlm.mock.invocationCallOrder[0]);
  });

  it('HTTP 失败时 validate 根本不该被调用', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('boom', { status: 500 })),
    );
    const validate = vi.fn();
    await expect(requestCompletion(channel, messages, { validate })).rejects.toThrow('500');
    expect(validate).not.toHaveBeenCalled();
    expect(h.failLlm).toHaveBeenCalledTimes(1);
  });
});

describe('completion diagnostics and explicit upstream failures', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it.each([
    { finish_reason: 'length', reason: 'length' },
    { finish_reason: 'content_filter', reason: 'content_filter' },
    { finish_reason: 'stop', refusal: 'I cannot provide this.', reason: 'refusal' },
  ])('preserves the response and stops before validation on $reason', async ({ finish_reason, refusal, reason }) => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      choices: [{ message: { content: '{"images":[', refusal }, finish_reason }],
      usage: { prompt_tokens: 12, completion_tokens: 9 },
    })));
    const validate = vi.fn();
    const error = await requestCompletion(channel, messages, { validate }).catch(error => error);
    expect(error).toBeInstanceOf(CompletionResponseError);
    expect(error).toMatchObject({ reason, retryable: false });
    expect(validate).not.toHaveBeenCalled();
    expect(h.patchLlmResponse).toHaveBeenCalledWith(1, expect.objectContaining({
      response: '{"images":[', finishReason: finish_reason, promptTokens: 12, completionTokens: 9,
    }));
    expect(h.finishLlm).not.toHaveBeenCalled();
    expect(h.failLlm).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('never validates or persists reasoning-only structured output (stream=%s)', async stream => {
    const reasoning = 'Private analysis followed by {"images":[],"changes":[]}';
    vi.stubGlobal('fetch', vi.fn(async () => stream
      ? sseResponse(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: reasoning }, finish_reason: 'stop' }] })}`)
      : jsonResponse({ choices: [{ message: { content: null, reasoning_content: reasoning }, finish_reason: 'stop' }] })));
    const validate = vi.fn();
    await expect(requestCompletion({ ...channel, stream }, messages, { validate })).rejects.toMatchObject({ reason: 'reasoning_only', retryable: false });
    expect(validate).not.toHaveBeenCalled();
    expect(h.patchLlmResponse).toHaveBeenLastCalledWith(1, expect.objectContaining({
      response: '', contentSource: 'reasoning', responseChars: 0, reasoningChars: reasoning.length, finishReason: 'stop',
    }));
    expect(JSON.stringify(h.patchLlmResponse.mock.calls)).not.toContain(reasoning);
    expect(h.finishLlm).not.toHaveBeenCalled();
  });

  it('keeps ordinary non-validated reasoning fallback while omitting its raw text from history', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ choices: [{ message: { content: null, reasoning: 'legacy plain reply' } }] })));
    await expect(requestCompletion(channel, messages)).resolves.toBe('legacy plain reply');
    expect(h.finishLlm).toHaveBeenCalledWith(1, expect.objectContaining({ response: '' }));
    expect(h.patchLlmResponse).toHaveBeenCalledWith(1, expect.objectContaining({ contentSource: 'reasoning', reasoningChars: 18 }));
  });

  it('does not use reasoning as a workaround when an explicit refusal has no content', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ choices: [{ message: {
      content: null, refusal: 'Request refused.', reasoning_content: '{"images":[]}',
    } }] })));
    await expect(requestCompletion(channel, messages, { validate: vi.fn() })).rejects.toMatchObject({ reason: 'refusal' });
  });

  it('captures stream final reason and usage even without a trailing newline', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"{\\"images\\":["}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"length"}],"usage":{"prompt_tokens":5,"completion_tokens":8}}',
    ].join('\n');
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(sse)));
    await expect(requestCompletion({ ...channel, stream: true }, messages, { validate: vi.fn() })).rejects.toMatchObject({ reason: 'length' });
    expect(h.patchLlmResponse).toHaveBeenLastCalledWith(1, expect.objectContaining({ response: '{"images":[', finishReason: 'length', promptTokens: 5, completionTokens: 8 }));
  });

  it.each([
    { delta: { refusal: 'Request refused.' }, finish_reason: 'stop', reason: 'refusal' },
    { delta: { content: [{ type: 'refusal', refusal: 'Request refused.' }] }, finish_reason: 'stop', reason: 'refusal' },
    { delta: {}, finish_reason: 'content_filter', reason: 'content_filter' },
  ])('recognizes streamed $reason without trying to validate an answer', async ({ delta, finish_reason, reason }) => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(`data: ${JSON.stringify({ choices: [{ delta, finish_reason }] })}`)));
    const validate = vi.fn();
    await expect(requestCompletion({ ...channel, stream: true }, messages, { validate })).rejects.toMatchObject({ reason, retryable: false });
    expect(validate).not.toHaveBeenCalled();
    expect(h.finishLlm).not.toHaveBeenCalled();
    expect(h.patchLlmResponse).toHaveBeenLastCalledWith(1, expect.objectContaining({ finishReason: finish_reason, refusal: reason === 'refusal' }));
  });

  it('captures already received visible chunks when the stream later fails', async () => {
    const releaseLock = vi.fn();
    const read = vi.fn()
      .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial reply","reasoning_content":"private reasoning"}}]}\n') })
      .mockRejectedValueOnce(new Error('stream disconnected'));
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, body: { getReader: () => ({ read, releaseLock }) } }) as unknown as Response));
    const validate = vi.fn();
    await expect(requestCompletion({ ...channel, stream: true }, messages, { validate })).rejects.toThrow('stream disconnected');
    expect(h.patchLlmResponse).toHaveBeenLastCalledWith(1, expect.objectContaining({
      response: 'partial reply', responseChars: 13, reasoningChars: 17, contentSource: 'content',
    }));
    expect(JSON.stringify(h.patchLlmResponse.mock.calls)).not.toContain('private reasoning');
    expect(releaseLock).toHaveBeenCalledOnce();
    expect(validate).not.toHaveBeenCalled();
    expect(h.failLlm).toHaveBeenCalledWith(1, 'stream disconnected', false);
  });

  it('passes visible non-JSON content to the validator even when reasoning contains JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ choices: [{ message: {
      content: 'visible non-JSON answer', reasoning_content: '{"images":[],"changes":[]}',
    }, finish_reason: 'stop' }] })));
    const validate = vi.fn(() => { throw new Error('invalid JSON'); });
    await expect(requestCompletion(channel, messages, { validate })).rejects.toThrow('invalid JSON');
    expect(validate).toHaveBeenCalledWith('visible non-JSON answer');
    expect(h.patchLlmResponse).toHaveBeenCalledWith(1, expect.objectContaining({ response: 'visible non-JSON answer', contentSource: 'content' }));
    expect(h.finishLlm).not.toHaveBeenCalled();
  });

  it('does not invent an assistant prefill when the prompt builder supplies only system/user messages', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(okPayload));
    vi.stubGlobal('fetch', fetchMock);
    const jsonOnlyMessages = [{ role: 'system' as const, content: 'Return JSON only.' }, ...messages];
    await requestCompletion({ ...channel, prefill: true }, jsonOnlyMessages);
    const request = (fetchMock.mock.calls as unknown as [string, RequestInit][])[0][1];
    expect(JSON.parse(request.body as string).messages).toEqual(jsonOnlyMessages);
  });

  it('captures main API visible output before a structured validation failure', async () => {
    h.generateRaw.mockResolvedValue('not JSON');
    await expect(requestViaMainApi(messages, { validate: () => { throw new Error('not json'); } })).rejects.toThrow('not json');
    expect(h.patchLlmResponse).toHaveBeenCalledWith(1, expect.objectContaining({ response: 'not JSON', finishReason: null, responseChars: 8 }));
    expect(h.finishLlm).not.toHaveBeenCalled();
    expect(h.failLlm).toHaveBeenCalled();
  });
});
