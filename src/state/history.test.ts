import { beforeEach, describe, expect, it } from 'vitest';

import {
  beginImage,
  beginLlm,
  clearHistory,
  failImage,
  failLlm,
  finishLlm,
  patchLlmResponse,
  patchLlmTokens,
  records,
  resetHistory,
  roughTokens,
  safeHistory,
  truncate,
  HISTORY_LIMITS,
  type ImageRecord,
  type LlmRecord,
} from './history';

const { MAX_RECORDS, MAX_CONTENT } = HISTORY_LIMITS;

function llm(source = 'test'): number {
  return beginLlm({
    source,
    channelName: 'ch',
    model: 'm',
    stream: false,
    messages: [{ role: 'user', content: 'hi' }],
  });
}

beforeEach(() => {
  resetHistory();
});

describe('环形缓冲', () => {
  it('新记录在前', () => {
    llm('第一条');
    llm('第二条');
    expect((records[0] as LlmRecord).source).toBe('第二条');
    expect((records[1] as LlmRecord).source).toBe('第一条');
  });

  it('超出封顶时丢弃最旧的', () => {
    for (let i = 0; i < MAX_RECORDS + 10; i++) llm(`#${i}`);
    expect(records.length).toBe(MAX_RECORDS);
    // 最新的在前,最旧的 10 条应已被挤出
    expect((records[0] as LlmRecord).source).toBe(`#${MAX_RECORDS + 9}`);
    expect((records[records.length - 1] as LlmRecord).source).toBe('#10');
  });

  it('被挤出后 finish/fail 是安全空操作', () => {
    const id = llm('会被挤出');
    for (let i = 0; i < MAX_RECORDS; i++) llm(`填充${i}`);
    expect(records.some(r => r.id === id)).toBe(false);
    expect(() =>
      finishLlm(id, { response: 'x', promptTokens: 1, completionTokens: 1, tokensEstimated: false }),
    ).not.toThrow();
    expect(() => failLlm(id, 'boom')).not.toThrow();
  });

  it('clearHistory 清空但保持同一数组引用(reactive 不断链)', () => {
    llm();
    const ref = records;
    clearHistory();
    expect(records.length).toBe(0);
    expect(records).toBe(ref);
  });
});

describe('截断', () => {
  it('短文本原样返回', () => {
    expect(truncate('abc')).toBe('abc');
  });

  it('超长文本截断并标注原长', () => {
    const long = 'x'.repeat(MAX_CONTENT + 500);
    const out = truncate(long);
    expect(out.length).toBeLessThan(long.length);
    expect(out.startsWith('x'.repeat(100))).toBe(true);
    expect(out).toContain(`原长 ${MAX_CONTENT + 500} 字符`);
  });

  it('登记时对每条 message 都截断', () => {
    const id = beginLlm({
      source: 's',
      channelName: 'c',
      model: 'm',
      stream: false,
      messages: [
        { role: 'system', content: 'y'.repeat(MAX_CONTENT + 1) },
        { role: 'user', content: '短的' },
      ],
    });
    const record = records.find(r => r.id === id) as LlmRecord;
    expect(record.messages[0].content).toContain('已截断');
    expect(record.messages[1].content).toBe('短的');
  });

  it('返回正文同样截断', () => {
    const id = llm();
    finishLlm(id, {
      response: 'z'.repeat(MAX_CONTENT + 1),
      promptTokens: null,
      completionTokens: null,
      tokensEstimated: true,
    });
    expect((records[0] as LlmRecord).response).toContain('已截断');
  });
});

describe('状态流转', () => {
  it('finish 记成功并算耗时', () => {
    const id = llm();
    finishLlm(id, { response: 'ok', promptTokens: 12, completionTokens: 3, tokensEstimated: false });
    const record = records[0] as LlmRecord;
    expect(record.status).toBe('ok');
    expect(record.promptTokens).toBe(12);
    expect(record.tokensEstimated).toBe(false);
    expect(record.durationMs).not.toBeNull();
  });

  it('取消与失败分开:aborted 不带错误信息', () => {
    const a = llm();
    failLlm(a, '被取消了', true);
    expect(records[0].status).toBe('aborted');
    expect(records[0].error).toBe('');

    const b = llm();
    failLlm(b, '500 炸了');
    expect(records[0].status).toBe('error');
    expect(records[0].error).toBe('500 炸了');
  });

  it('生图记录同样区分取消与失败', () => {
    const id = beginImage({
      backend: 'nai',
      model: 'nai-diffusion-4',
      prompt: '1girl',
      nl: '',
      negative: '',
      characters: [{ name: 'A', tag: '1girl, black hair', nl: 'left' }],
      seed: 42,
      size: 'portrait',
      floor: 3,
      seq: 0,
    });
    failImage(id, '', true);
    const record = records[0] as ImageRecord;
    expect(record.status).toBe('aborted');
    expect(record.characters).toEqual([
      { name: 'A', tag: '1girl, black hair', nl: 'left' },
    ]);
  });
});

describe('token 补录', () => {
  it('估算结果可补录进已完成的记录', () => {
    const id = llm();
    finishLlm(id, { response: 'r', promptTokens: null, completionTokens: null, tokensEstimated: true });
    patchLlmTokens(id, 88, 9);
    const record = records[0] as LlmRecord;
    expect(record.promptTokens).toBe(88);
    expect(record.tokensEstimated).toBe(true);
  });

  it('已有真实 usage 时不被估算值覆盖', () => {
    const id = llm();
    finishLlm(id, { response: 'r', promptTokens: 100, completionTokens: 20, tokensEstimated: false });
    patchLlmTokens(id, 999, 999);
    const record = records[0] as LlmRecord;
    expect(record.promptTokens).toBe(100);
    expect(record.tokensEstimated).toBe(false);
  });
});

describe('校验前响应捕获', () => {
  it('保存原始正文和诊断时仍在进行中，后续格式失败不会丢失响应', () => {
    const id = llm();
    const response = '{"images":[{"tag":"unfinished';
    patchLlmResponse(id, {
      response,
      promptTokens: 120,
      completionTokens: 40,
      tokensEstimated: false,
      finishReason: 'length',
      contentSource: 'content',
      responseChars: response.length,
      reasoningChars: 25,
      refusal: false,
    });
    const record = records[0] as LlmRecord;
    expect(record.status).toBe('running');
    expect(record.durationMs).toBeNull();
    failLlm(id, 'JSON 格式无效');
    expect(record).toMatchObject({
      status: 'error', error: 'JSON 格式无效', response, responseCaptured: true,
      promptTokens: 120, completionTokens: 40, tokensEstimated: false,
      finishReason: 'length', contentSource: 'content', responseChars: response.length,
      reasoningChars: 25, refusal: false,
    });
    expect(record.durationMs).not.toBeNull();
  });

  it('失败响应同样遵守正文上限，并保留截断前字符数', () => {
    const id = llm();
    patchLlmResponse(id, { response: 'x'.repeat(MAX_CONTENT + 300), contentSource: 'content' });
    failLlm(id, '格式错误');
    const record = records[0] as LlmRecord;
    expect(record.response).toBe(truncate('x'.repeat(MAX_CONTENT + 300)));
    expect(record.responseChars).toBe(MAX_CONTENT + 300);
  });

  it('只保留额外思考的字符数，防止把思考原文当最终正文保存', () => {
    const id = llm();
    patchLlmResponse(id, {
      response: '额外思考原文不应留存', contentSource: 'reasoning',
      responseChars: 0, reasoningChars: 600, finishReason: 'stop', refusal: false,
    });
    failLlm(id, '没有最终正文');
    expect(records[0]).toMatchObject({
      response: '', responseCaptured: true, contentSource: 'reasoning',
      responseChars: 0, reasoningChars: 600,
    });
    expect(JSON.stringify(records[0])).not.toContain('额外思考原文不应留存');
  });

  it('未捕获记录与明确的空响应保持可区分，不补造旧诊断', () => {
    const old = llm();
    failLlm(old, '此前格式失败');
    expect(records[0]).toMatchObject({
      responseCaptured: false, finishReason: null, contentSource: null,
      responseChars: null, reasoningChars: null, refusal: null,
    });
    const fresh = llm();
    patchLlmResponse(fresh, {
      response: '', contentSource: 'none', responseChars: 0, reasoningChars: 0, refusal: true,
    });
    failLlm(fresh, '没有正文');
    expect(records[0]).toMatchObject({ responseCaptured: true, responseChars: 0, refusal: true });
  });

  it('成功收尾和分次补录保留先前响应诊断与 usage', () => {
    const id = llm();
    patchLlmResponse(id, {
      response: '{}', contentSource: 'content', finishReason: 'stop',
      reasoningChars: 500, refusal: false, promptTokens: 120, completionTokens: 10,
    });
    patchLlmResponse(id, { responseChars: 2 });
    expect(records[0]).toMatchObject({ response: '{}', promptTokens: 120, completionTokens: 10 });
    finishLlm(id, { response: '{}', promptTokens: 120, completionTokens: 10, tokensEstimated: false });
    expect(records[0]).toMatchObject({
      status: 'ok', response: '{}', responseChars: 2, finishReason: 'stop', reasoningChars: 500, refusal: false,
    });
  });

  it('成功收尾移除首尾空白后仍保留校验前捕获的原始字符数', () => {
    const id = llm();
    const raw = ' \n  {"images": []}\n\t ';
    patchLlmResponse(id, { response: raw, contentSource: 'content', responseChars: raw.length });
    finishLlm(id, { response: raw.trim(), promptTokens: 12, completionTokens: 5, tokensEstimated: false });
    expect(records[0]).toMatchObject({
      status: 'ok', response: raw.trim(), responseChars: raw.length,
    });
  });

  it('补录只接受白名单字段和安全标量，不复制未知 HTTP/凭据字段', () => {
    const id = llm();
    const input = {
      response: '{}', contentSource: 'content' as const, finishReason: '{"upstream":"body"}',
      responseChars: -1, reasoningChars: Number.NaN, promptTokens: Number.POSITIVE_INFINITY,
      apiKey: 'credential-must-not-be-stored', httpBody: { reasoning: 'unretained-body' },
    };
    patchLlmResponse(id, input);
    expect(records[0]).toMatchObject({ finishReason: null, responseChars: null, reasoningChars: null, promptTokens: null });
    expect(JSON.stringify(records[0])).not.toContain('credential-must-not-be-stored');
    expect(JSON.stringify(records[0])).not.toContain('unretained-body');
  });

  it('已清空或被挤出的请求晚到响应不恢复记录', () => {
    const cleared = llm();
    clearHistory();
    patchLlmResponse(cleared, { response: 'late' });
    expect(records).toHaveLength(0);
    const evicted = llm();
    for (let i = 0; i < MAX_RECORDS; i++) llm();
    expect(() => patchLlmResponse(evicted, { response: 'late' })).not.toThrow();
    expect(records).toHaveLength(MAX_RECORDS);
    expect(records.some(record => record.id === evicted)).toBe(false);
  });
});

describe('roughTokens 粗估', () => {
  it('空串为 0', () => {
    expect(roughTokens('')).toBe(0);
  });

  it('中日韩按 1 字 1 token', () => {
    expect(roughTokens('你好世界')).toBe(4);
    expect(roughTokens('こんにちは')).toBe(5);
  });

  it('拉丁文按 4 字符 1 token', () => {
    expect(roughTokens('a'.repeat(40))).toBe(10);
  });

  it('中英混排两段分别计入', () => {
    // 4 个汉字 + 8 个 ASCII → 4 + 2
    expect(roughTokens('你好世界abcdefgh')).toBe(6);
  });

  it('代理对(emoji)按一个字符算,不重复计数', () => {
    // '🎨' 的 length 是 2,但按码点只应算 1 个字符 → 1/4 → 四舍五入 0
    expect(roughTokens('🎨')).toBe(0);
    expect(roughTokens('🎨'.repeat(4))).toBe(1);
  });

  it('结果随文本变长而单调不减(段间比大小是它唯一的用途)', () => {
    const short = roughTokens('短文本');
    const long = roughTokens('短文本'.repeat(50));
    expect(long).toBeGreaterThan(short);
  });
});

describe('safeHistory', () => {
  it('吞掉异常并返回 null,不连累主流程', () => {
    expect(
      safeHistory(() => {
        throw new Error('store 炸了');
      }),
    ).toBeNull();
  });

  it('正常时原样返回结果', () => {
    expect(safeHistory(() => 42)).toBe(42);
  });
});
