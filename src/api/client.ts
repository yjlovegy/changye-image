import { abortable } from '@/state/promptTasks';
import { getContext } from '@/st/context';
import type { ApiChannel } from '@/state/settings';
import {
  beginLlm,
  failLlm,
  finishLlm,
  patchLlmTokens,
  patchLlmResponse,
  safeHistory,
  FOLLOW_MAIN_API,
} from '@/state/history';

/**
 * 通过 SillyTavern 的服务端代理调用任意 OpenAI 兼容端点。
 * (与角色记忆插件 src/api/client.ts 同源,行为保持一致。)
 *
 * 关键:以 chat_completion_source='openai' + reverse_proxy(base url)+ proxy_password(key)
 * 走 /api/backends/chat-completions/generate。请求由 ST 服务端转发,
 * 因此没有浏览器 CORS 问题,也无需把密钥存进 ST 的 secrets。
 */

const GENERATE_URL = '/api/backends/chat-completions/generate';
const DEFAULT_TIMEOUT_SEC = 180;

export interface ChatMsg {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export class ApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'ApiError';
  }
}

export type CompletionFailureReason = 'refusal' | 'content_filter' | 'length' | 'reasoning_only';

/** 上游已明确说明为什么没有可用最终答案，同参数盲重试不会修复这些状态。 */
export class CompletionResponseError extends ApiError {
  readonly retryable = false;
  constructor(readonly reason: CompletionFailureReason, message: string) {
    super(message);
    this.name = 'CompletionResponseError';
  }
}

interface CompletionResponse {
  content: string;
  reasoning: string;
  finishReason: string | null;
  refused: boolean;
  usage: { prompt: number | null; completion: number | null };
}

function captureResponse(historyId: number | null, result: CompletionResponse): void {
  if (historyId === null) return;
  safeHistory(() => patchLlmResponse(historyId, {
    response: result.content.trim(),
    promptTokens: result.usage.prompt,
    completionTokens: result.usage.completion,
    tokensEstimated: false,
    finishReason: result.finishReason,
    contentSource: result.content.trim() ? 'content' : result.reasoning.trim() ? 'reasoning' : 'none',
    responseChars: result.content.length,
    reasoningChars: result.reasoning.length,
    refusal: result.refused || result.finishReason === 'refusal',
  }));
}

function usableResponse(result: CompletionResponse, structured: boolean): string {
  if (result.refused || result.finishReason === 'refusal') {
    throw new CompletionResponseError('refusal', '模型明确拒绝了本次请求，本次未生成图片提示词');
  }
  if (result.finishReason === 'content_filter') {
    throw new CompletionResponseError('content_filter', '模型服务的内容过滤阻止了完整回答（finish_reason=content_filter）');
  }
  if (result.finishReason === 'length') {
    throw new CompletionResponseError('length', '模型达到输出长度上限，回答可能被截断（finish_reason=length）；已保留收到的正文供检查');
  }
  if (structured && !result.content.trim() && result.reasoning.trim()) {
    throw new CompletionResponseError('reasoning_only', '模型只返回了思考内容，没有最终正文；未将思考内容当作 JSON 答案');
  }
  const content = result.content.trim() || result.reasoning.trim();
  if (!content) throw new ApiError('副 API 返回空内容');
  return content;
}

/**
 * 规范化 OpenAI 兼容 base url:
 * - 用户填完整 /chat/completions 时只去掉端点后缀;
 * - 纯域名自动补 /v1;
 * - 已带路径的地址原样保留,避免破坏 /v2/coding 等自定义路由。
 */
function normalizeUrl(url: string): string {
  const u = url.trim().replace(/\/+$/, '');
  if (!u) return u;
  if (/\/chat\/completions$/i.test(u)) return u.replace(/\/chat\/completions$/i, '');
  if (/^https?:\/\/[^/?#]+$/i.test(u)) return `${u}/v1`;
  return u;
}

/** 测试渠道时备用的 /v1 形式。只在首个地址明确返回 404/405 时才会尝试。 */
function alternateUrl(url: string): string {
  return /\/v1$/i.test(url) ? url.replace(/\/v1$/i, '') : `${url}/v1`;
}

export interface RequestOptions {
  signal?: AbortSignal;
  /**
   * 用途标签,只用于请求历史页的展示(如「自动 tag」)。
   * 不传也不影响请求本身,历史里显示为「未标注」。
   */
  source?: string;
  /**
   * 调用方验收回调:拿到文本并保存响应诊断后、记为成功前执行。
   *
   * 历史里「成功」的口径是「调用方验收通过」,不是「HTTP 拿到了文本」——
   * 否则「返回了但协议解析不过 → 调用方重试」会留下两条绿色成功记录,
   * 看历史的人会误以为成功也重复调用。验收抛错 = 记为失败并把错误原样抛出,
   * 由调用方决定重试/放弃。
   */
  validate?: (content: string) => void;
}

/* ============ 请求历史埋点(纯辅助,绝不允许影响主流程) ============ */

/** 从响应体取 OpenAI 标准 usage。ST 代理非流式分支原样透传上游 JSON,故这里拿到的是真值。 */
function readUsage(data: any): { prompt: number | null; completion: number | null } {
  const usage = data?.usage;
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
  return {
    prompt: num(usage?.prompt_tokens),
    completion: num(usage?.completion_tokens),
  };
}

/**
 * 本地估算 token(拿不到真值时的兜底):部分流式服务不返回 usage，「跟随主 API」只返回文本。
 *
 * 用 ST 的 getTokenCountAsync —— 但它用的是**主界面当前模型**的分词器,
 * 与副 API 渠道的模型未必同源,所以结果只能当估算,UI 上以 ≈ 标注。
 * 任何失败都降级为 null(不显示数字),不抛。
 */
async function estimateTokens(id: number, messages: ChatMsg[], response: string): Promise<void> {
  try {
    const count = getContext()?.getTokenCountAsync;
    if (typeof count !== 'function') return;
    const promptText = messages.map(m => m.content).join('\n');
    const prompt = await count(promptText);
    const completion = response ? await count(response) : 0;
    safeHistory(() =>
      patchLlmTokens(
        id,
        typeof prompt === 'number' ? prompt : null,
        typeof completion === 'number' ? completion : null,
      ),
    );
  } catch (e) {
    console.debug('[长夜的绘图器] token 估算失败(已忽略)', e);
  }
}

function validTimeoutSec(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : DEFAULT_TIMEOUT_SEC;
}

/**
 * 给完整请求生命周期套超时:不仅覆盖 fetch 建连,也覆盖非流式 JSON 读取和流式 SSE 读取。
 * 外部 signal 仍可提前取消;只有本定时器触发时才转换成明确的超时报错。
 */
async function withTimeout<T>(
  timeoutSec: number,
  externalSignal: AbortSignal | undefined,
  label: string,
  task: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const ctrl = new AbortController();
  let timedOut = false;
  const onExternalAbort = () => ctrl.abort();
  if (externalSignal?.aborted) onExternalAbort();
  else externalSignal?.addEventListener('abort', onExternalAbort, { once: true });

  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, Math.max(1000, timeoutSec * 1000));

  try {
    return await task(ctrl.signal);
  } catch (e) {
    if (timedOut) throw new ApiError(`${label}超时(>${timeoutSec}秒)`);
    throw e;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
}

/**
 * 发起一次补全请求,返回文本内容。
 */
export async function requestCompletion(
  channel: ApiChannel,
  messages: ChatMsg[],
  opts: RequestOptions = {},
): Promise<string> {
  return requestCompletionAtUrl(channel, messages, normalizeUrl(channel.url), opts);
}

/**
 * 构造发给 ST 代理的请求体(纯函数,便于测两条分支的产物)。
 *
 * 两条分支,按渠道有没有设思考强度二选一:
 *
 * ① 未设(reasoningEffort 为空 = auto):走 `chat_completion_source: 'openai'`,
 *    与加本功能之前**逐字节一致**——存量用户零变化。
 *
 * ② 已设:走 `'custom'`。因为 ST 代理对 openai 源的 reasoning_effort 卡**模型名白名单**
 *    (src/constants.js 的 OPENAI_REASONING_EFFORT_MODELS,精确匹配 o1/o3/gpt-5 那批),
 *    模型名对不上就静默丢弃、还照样返回 200(实测确认),用户设了却无效且看不出来。
 *    custom 源的 custom_include_body 由服务端 mergeObjectWithYaml 直接并进上游请求体,
 *    不过任何白名单,任意字段/嵌套对象都能透传。
 *
 * 两条路都仍然走 ST 服务端转发(同一个 /generate 端点),没有浏览器直连,
 * 因此 CORS、密钥不落浏览器、SSE 转发等性质完全不变。
 *
 * custom 源的两个坑(都已规避):
 * - 它**不读 proxy_password**,只读 ST 自己存的 Custom 密钥,所以 key 必须靠
 *   custom_include_headers 注入 Authorization(服务端 `...headers` 排在默认
 *   Authorization 之后,覆盖成立);
 * - custom_include_* 是 YAML 字符串且**解析失败会静默忽略**(util.js 的 catch 是空的)。
 *   key 里带 `:` `#` `{` 或以 `*` 开头都会让 YAML 解析炸 → header 没注入 →
 *   退回用 ST 的 Custom 密钥,可能把用户另一个服务商的 key 发到本端点。
 *   故一律用 JSON.stringify 生成(YAML 是 JSON 的超集),转义交给它,不手拼。
 */
export function buildRequestBody(
  channel: ApiChannel,
  messages: ChatMsg[],
  reverseProxy: string,
  stream: boolean,
): Record<string, unknown> {
  const effort = channel.reasoningEffort?.trim() ?? '';
  const common = {
    model: channel.model,
    messages,
    temperature: channel.temperature ?? 1.0,
    max_tokens: channel.maxTokens ?? 65535,
    stream,
    // 静默:不影响主对话状态
    presence_penalty: 0,
    frequency_penalty: 0,
  };

  const body: Record<string, unknown> = effort
    ? {
        chat_completion_source: 'custom',
        custom_url: reverseProxy,
        custom_include_headers: JSON.stringify({ Authorization: `Bearer ${channel.key || ''}` }),
        custom_include_body: JSON.stringify({ reasoning_effort: effort }),
        ...common,
      }
    : {
        chat_completion_source: 'openai',
        reverse_proxy: reverseProxy,
        proxy_password: channel.key || '',
        ...common,
      };

  // 排除参数:把用户指定的字段从 body 删掉,规避不接受这些参数的兼容端点报错。
  for (const p of channel.excludeParams ?? []) {
    const key = p.trim();
    if (key) delete body[key];
  }
  return body;
}

async function requestCompletionAtUrl(
  channel: ApiChannel,
  messages: ChatMsg[],
  reverseProxy: string,
  opts: RequestOptions = {},
): Promise<string> {
  const ctx = getContext();
  if (!ctx) throw new ApiError('SillyTavern 上下文不可用');
  if (!channel.url || !channel.model) throw new ApiError('副 API 渠道未配置完整(缺 url 或 model)');

  const stream = channel.stream ?? false;
  // 预填充开关(默认开):关闭时丢掉末尾那条 assistant 预填充消息。
  // 对不支持预填充(不续写)的端点形同浪费、个别端点还要求「最后一条须为 user」。
  const outMessages =
    channel.prefill === false && messages[messages.length - 1]?.role === 'assistant'
      ? messages.slice(0, -1)
      : messages;
  const body = buildRequestBody(channel, outMessages, reverseProxy, stream);

  const timeoutSec = validTimeoutSec(channel.timeoutSec);

  // 历史埋点:登记在真正发请求之前,失败/超时也留痕(排查时要看的往往正是失败那次)。
  const historyId = safeHistory(() =>
    beginLlm({
      source: opts.source || '未标注',
      channelName: channel.name || channel.model || '(未命名渠道)',
      model: channel.model,
      stream,
      messages: outMessages,
    }),
  );

  try {
    const result = await withTimeout(timeoutSec, opts.signal, '副 API 请求', async signal => {
      const resp = await fetch(GENERATE_URL, {
        method: 'POST',
        headers: ctx.getRequestHeaders(),
        body: JSON.stringify(body),
        signal,
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new ApiError(`副 API 请求失败 (${resp.status}): ${text.slice(0, 300)}`, resp.status);
      }

      // 流式:按 SSE 增量拼接;非流式:直接解析 JSON。
      if (stream) {
        // 完成或流中断都保存已经收到的可见正文，思考只留长度。
        return readSseResponse(resp, partial => captureResponse(historyId, partial));
      }

      const data = await resp.json();
      if (data?.error) {
        throw new ApiError(data.error.message || '副 API 返回错误');
      }

      return extractResponse(data);
    });

    // 先保存诊断，不改状态；验收失败仍由 catch 记失败，完整返回不再丢失。
    captureResponse(historyId, result);
    const content = usableResponse(result, Boolean(opts.validate));
    opts.validate?.(content);

    if (historyId !== null) {
      const hasReal = result.usage.prompt !== null;
      safeHistory(() =>
        finishLlm(historyId, {
          response: result.content.trim(),
          promptTokens: result.usage.prompt,
          completionTokens: result.usage.completion,
          tokensEstimated: false,
        }),
      );
      // 上游未返回真值时才估算。估算是异步的，不 await，避免拖慢主流程。
      if (!hasReal) void estimateTokens(historyId, outMessages, result.content);
    }
    return content;
  } catch (e) {
    if (historyId !== null) {
      const aborted = e instanceof DOMException && e.name === 'AbortError';
      safeHistory(() => failLlm(historyId, e instanceof Error ? e.message : String(e), aborted));
    }
    throw e;
  }
}

/**
 * 读取 SSE 流(text/event-stream),拼接 delta.content。
 * ST 的 generate 端点在 stream=true 时透传上游 SSE:每行 `data: {json}`,以 `data: [DONE]` 结束。
 * 保留纯提取接口的旧兼容行为；带 validate 的请求使用 readSseResponse，拒绝只有思考的结果。
 */
export async function readSseContent(resp: Response): Promise<string> {
  const result = await readSseResponse(resp);
  return result.content.trim() || result.reasoning.trim();
}

async function readSseResponse(
  resp: Response,
  capture?: (result: CompletionResponse) => void,
): Promise<CompletionResponse> {
  const reader = resp.body?.getReader();
  if (!reader) {
    const data = await resp.json().catch(() => null);
    return extractResponse(data);
  }
  const decoder = new TextDecoder();
  let buf = '';
  const result: CompletionResponse = {
    content: '', reasoning: '', finishReason: null, refused: false,
    usage: { prompt: null, completion: null },
  };
  const readLine = (line: string) => {
    const t = line.trim();
    if (!t.startsWith('data:')) return;
    const payload = t.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    let json: any;
    try { json = JSON.parse(payload); }
    catch { return; } // 注释/心跳和不合法事件不能拼成伪答案。
    if (json?.error) throw new ApiError(json.error.message || '副 API 返回错误');
    const choice = json?.choices?.[0];
    const src = choice?.delta ?? choice?.message;
    result.content += textOf(src?.content) || textOf(choice?.text);
    result.reasoning += textOf(src?.reasoning) || textOf(src?.reasoning_content) || textOf(src?.thinking);
    result.refused ||= isRefusal(src?.refusal) || hasRefusalPart(src?.content);
    if (typeof choice?.finish_reason === 'string' && choice.finish_reason.trim()) result.finishReason = choice.finish_reason.trim();
    const usage = readUsage(json);
    if (usage.prompt !== null) result.usage.prompt = usage.prompt;
    if (usage.completion !== null) result.usage.completion = usage.completion;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) readLine(line);
    }
    buf += decoder.decode(); // flush UTF-8 decoder even when the last transport chunk splits a character.
    if (buf.trim()) readLine(buf); // SSE EOF may terminate the last data line without a trailing newline.
    return result;
  } finally {
    capture?.(result);
    reader.releaseLock();
  }
}

/** 把可能是 string / content-parts 数组 / 其他类型的值转成文本;非字符串成分一律丢弃。 */
function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    let out = '';
    for (const part of value) {
      if (typeof part === 'string') out += part;
      else if (part && typeof part === 'object') {
        const text = (part as Record<string, unknown>).text;
        if (typeof text === 'string') out += text;
      }
    }
    return out;
  }
  return '';
}

function isRefusal(value: unknown): boolean {
  return value === true || Boolean(textOf(value).trim());
}

function hasRefusalPart(value: unknown): boolean {
  return Array.isArray(value) && value.some(part => part && typeof part === 'object' && part.type === 'refusal');
}

/** 分开提取最终正文和思考，避免结构化请求从思考中捞出 JSON 当作最终答案。 */
function extractResponse(data: any): CompletionResponse {
  const msg = data?.choices?.[0]?.message;
  const firstText = (...values: unknown[]) => values.map(textOf).find(text => text.trim()) ?? '';
  const finishReason = data?.choices?.[0]?.finish_reason;
  return {
    content: firstText(msg?.content, data?.choices?.[0]?.text, data?.content),
    reasoning: firstText(msg?.reasoning, msg?.reasoning_content, msg?.thinking),
    finishReason: typeof finishReason === 'string' && finishReason.trim() ? finishReason.trim() : null,
    refused: isRefusal(msg?.refusal) || hasRefusalPart(msg?.content),
    usage: readUsage(data),
  };
}

/** 纯提取函数保留普通调用的 reasoning fallback；结构化请求另用 usableResponse 严格区分。 */
export function extractContent(data: any): string {
  const result = extractResponse(data);
  return result.content.trim() || result.reasoning.trim();
}

/* ============ 跟随主 API(主界面当前在用的 API 设置) ============ */

/** 跟随主 API 时的响应上限:够装下思维链 + 输出,避免被主 API 默认 max tokens 截断。 */
const MAIN_API_RESPONSE_LENGTH = 65535;

/**
 * 是否具备「跟随主 API」的条件:ST 暴露了 generateRaw(稳定 API)即可。
 * 不再依赖连接管理/连接档——直接借用主界面当前正在用的 API。
 */
export function mainApiAvailable(): boolean {
  return typeof getContext()?.generateRaw === 'function';
}

/**
 * 用「当前主 API」(主界面正在用的聊天补全/文本补全设置)发一次补全。
 * 走 ST 的 generateRaw:只发我们给的这几条消息,不带聊天历史/角色卡;无需连接档。
 * quiet 类型内部强制非流式,返回清洗后的整段文本;失败抛 ApiError。
 */
export async function requestViaMainApi(messages: ChatMsg[], opts: RequestOptions = {}): Promise<string> {
  const ctx = getContext();
  if (typeof ctx?.generateRaw !== 'function') {
    throw new ApiError('当前 ST 版本不支持 generateRaw,无法跟随主 API');
  }

  // 历史埋点。跟随主 API 走 ST 内部黑盒,拿不到 usage,token 一律靠估算。
  const historyId = safeHistory(() =>
    beginLlm({
      source: opts.source || '未标注',
      channelName: FOLLOW_MAIN_API,
      model: '',
      stream: false,
      messages,
    }),
  );

  try {
    const raw = (await abortable(() => ctx.generateRaw!({ prompt: messages, responseLength: MAIN_API_RESPONSE_LENGTH }), opts.signal)) ?? '';
    const content = raw.trim();
    // 宿主只提供最终字符串，无法取得 finish_reason/隐藏思考字段；仍先保存可见响应。
    captureResponse(historyId, {
      content: raw, reasoning: '', finishReason: null, refused: false,
      usage: { prompt: null, completion: null },
    });
    if (!content) throw new ApiError('主 API 返回空内容');
    // 与副 API 同口径:验收不过记失败,不记「成功」
    opts.validate?.(content);
    if (historyId !== null) {
      safeHistory(() =>
        finishLlm(historyId, {
          response: content,
          promptTokens: null,
          completionTokens: null,
          tokensEstimated: true,
        }),
      );
      void estimateTokens(historyId, messages, content);
    }
    return content;
  } catch (e) {
    if (historyId !== null) {
      const aborted = e instanceof DOMException && e.name === 'AbortError';
      safeHistory(() => failLlm(historyId, e instanceof Error ? e.message : String(e), aborted));
    }
    throw e;
  }
}

/** 连通性测试:发一条极短请求 */
export async function testChannel(channel: ApiChannel): Promise<{ ok: boolean; message: string }> {
  const primaryUrl = normalizeUrl(channel.url);
  try {
    const reply = await requestCompletionAtUrl(
      channel,
      [{ role: 'user', content: '回复"ok"两个字符即可。' }],
      primaryUrl,
      { source: '连通性测试' },
    );
    const changed = channel.url.trim().replace(/\/+$/, '') !== primaryUrl;
    if (changed) channel.url = primaryUrl;
    return {
      ok: true,
      message: `连通正常${changed ? `,已采用:${primaryUrl}` : ''},返回:${reply.slice(0, 40)}`,
    };
  } catch (e) {
    if (!(e instanceof ApiError) || (e.status !== 404 && e.status !== 405)) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }

    const fallbackUrl = alternateUrl(primaryUrl);
    if (!fallbackUrl || fallbackUrl === primaryUrl) {
      return { ok: false, message: e.message };
    }
    try {
      const reply = await requestCompletionAtUrl(
        channel,
        [{ role: 'user', content: '回复"ok"两个字符即可。' }],
        fallbackUrl,
        { source: '连通性测试(备用地址)' },
      );
      channel.url = fallbackUrl;
      return {
        ok: true,
        message: `连通正常,已自动改用:${fallbackUrl},返回:${reply.slice(0, 40)}`,
      };
    } catch {
      // 备用地址也失败时保留首个错误,避免把模型名等真实问题掩盖成路径错误。
      return { ok: false, message: e.message };
    }
  }
}

const STATUS_URL = '/api/backends/chat-completions/status';

/**
 * 拉取渠道可用的模型列表(走 ST 的 /status 代理,标准 /v1/models)。
 * 只需 url + key,不需要先填 model。
 */
export async function fetchModels(
  channel: Pick<ApiChannel, 'url' | 'key'> & Partial<Pick<ApiChannel, 'timeoutSec'>>,
): Promise<string[]> {
  const ctx = getContext();
  if (!ctx) throw new ApiError('SillyTavern 上下文不可用');
  if (!channel.url) throw new ApiError('请先填写 API 地址');

  const body = {
    chat_completion_source: 'openai',
    reverse_proxy: normalizeUrl(channel.url),
    proxy_password: channel.key || '',
  };

  const timeoutSec = validTimeoutSec(channel.timeoutSec);
  return withTimeout(timeoutSec, undefined, '拉取模型', async signal => {
    const resp = await fetch(STATUS_URL, {
      method: 'POST',
      headers: ctx.getRequestHeaders(),
      body: JSON.stringify(body),
      signal,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new ApiError(`拉取模型失败 (${resp.status}): ${text.slice(0, 200)}`);
    }

    const data = await resp.json();
    if (data?.error && !Array.isArray(data?.data)) {
      throw new ApiError(data?.message || '拉取模型失败');
    }

    const list: unknown = data?.data ?? data?.models ?? [];
    if (!Array.isArray(list)) return [];
    return list
      .map((m: any) => (typeof m === 'string' ? m : m?.id))
      .filter((x: unknown): x is string => typeof x === 'string' && x.length > 0)
      .sort();
  });
}
