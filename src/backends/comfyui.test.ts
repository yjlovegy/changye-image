import { afterEach, describe, expect, it, vi } from 'vitest';

import { simpleDefaults } from '@/backends/comfyTemplates';
import {
  generateComfyImage,
  prepareApiOutputNodes,
  ComfyUIError,
  parseWorkflowTemplate,
  randomSeed,
  renderWorkflowTemplate,
  type ComfyWorkflow,
} from '@/backends/comfyui';

const TEMPLATE = JSON.stringify({
  '3': {
    class_type: 'KSampler',
    inputs: { seed: '%seed%', text: '%prompt%', neg: '%negative_prompt%' },
  },
});

describe('LoRA Manager API output compatibility', () => {
  afterEach(() => vi.unstubAllGlobals());
  const workflow: ComfyWorkflow = {
    '1': { class_type: 'PrimitiveStringMultiline', inputs: { value: '%prompt%' } },
    '2': { class_type: 'Save Image (LoraManager)', inputs: { images: ['3', 0], embed_workflow: true, save_with_metadata: true, file_format: 'png', filename_prefix: 'test', quality: 100 } },
    '3': { class_type: 'EmptyImage', inputs: { width: 64, height: 64, color: 0, batch_size: 1 } },
    '4': { class_type: 'UnrelatedNode', inputs: { embed_workflow: true } },
  };
  it('keeps user preset and generation metadata; only removes unsupported UI workflow embedding', () => {
    const before = JSON.stringify(workflow);
    const prepared = prepareApiOutputNodes(workflow);
    expect(JSON.stringify(workflow)).toBe(before);
    expect(prepared['2'].inputs).toEqual({ ...(workflow['2'].inputs as object), embed_workflow: false });
    expect(prepared['4']).toBe(workflow['4']);
    expect(prepareApiOutputNodes(prepared)).toBe(prepared);
    const ordinary = { '1': { class_type: 'SaveImage', inputs: { images: ['3', 0] } } };
    expect(prepareApiOutputNodes(ordinary)).toBe(ordinary);
  });
  function conn() {
    return { url: 'http://127.0.0.1:8188', mode: 'custom' as const, workflow: JSON.stringify(workflow),
      simple: simpleDefaults(), portraitSize: '64×64', landscapeSize: '64×64' };
  }
  it('submits corrected flag and reports a remaining empty saver without retrying generation', async () => {
    const fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).endsWith('/prompt')) {
        const body = JSON.parse(String(init?.body));
        expect(body.prompt['2'].inputs.embed_workflow).toBe(false);
        expect(body.prompt['2'].inputs.save_with_metadata).toBe(true);
        return new Response(JSON.stringify({ prompt_id: 'test' }));
      }
      return new Response(JSON.stringify({ test: { status: { completed: true, status_str: 'success' }, outputs: { '2': { images: [] } } } }));
    });
    vi.stubGlobal('fetch', fetch);
    await expect(generateComfyImage(conn(), { prompt: 'neutral test' })).rejects.toThrow(/Save Image.*返回了空图片列表/);
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('/prompt'))).toHaveLength(1);
  });
  it('passes the same correction to the ST fallback transport', async () => {
    vi.stubGlobal('window', { SillyTavern: { getContext: () => ({ getRequestHeaders: () => ({ 'Content-Type': 'application/json' }) }) } });
    const fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).endsWith('/prompt')) throw new TypeError('network');
      expect(String(url)).toBe('/api/sd/comfy/generate');
      const body = JSON.parse(String(init?.body));
      expect(JSON.parse(body.prompt).prompt['2'].inputs.embed_workflow).toBe(false);
      return new Response(JSON.stringify({ format: 'png', data: 'test' }));
    });
    vi.stubGlobal('fetch', fetch);
    const result = await generateComfyImage(conn(), { prompt: 'neutral test' });
    expect(result.format).toBe('png');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

function seedOf(workflow: ComfyWorkflow): unknown {
  return (workflow['3'] as { inputs: { seed: unknown } }).inputs.seed;
}

afterEach(() => vi.restoreAllMocks());

describe('randomSeed', () => {
  it('returns an integer in [0, 2**53)', () => {
    const seed = randomSeed();
    expect(Number.isInteger(seed)).toBe(true);
    expect(seed).toBeGreaterThanOrEqual(0);
    expect(seed).toBeLessThan(2 ** 53);
  });

  it('is derived from Math.random (range = Python random.randint(0, 2**53 - 1))', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    expect(randomSeed()).toBe(Math.floor(0.5 * 2 ** 53));
  });

  it('produces different seeds across calls', () => {
    const seeds = new Set(Array.from({ length: 50 }, () => randomSeed()));
    expect(seeds.size).toBeGreaterThan(1);
  });
});

describe('parseWorkflowTemplate', () => {
  it('hints that placeholders must be quoted strings when JSON parse fails on %', () => {
    try {
      parseWorkflowTemplate('{"3":{"class_type":"KSampler","inputs":{"seed":%seed%}}}');
      expect.unreachable('should throw');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain('占位符必须写成字符串形式');
      expect(message).toContain('"%seed%"');
    }
  });
});

describe('renderWorkflowTemplate with %seed%', () => {
  it('replaces exact %seed% with a number (not string)', () => {
    const workflow = renderWorkflowTemplate(TEMPLATE, { prompt: '1girl' });
    expect(seedOf(workflow)).toBeTypeOf('number');
    expect(seedOf(workflow)).toBeGreaterThanOrEqual(0);
    expect(seedOf(workflow)).toBeLessThan(2 ** 53);
  });

  it('uses the explicitly passed seed when provided', () => {
    const workflow = renderWorkflowTemplate(TEMPLATE, { prompt: '1girl', seed: 42 });
    expect(seedOf(workflow)).toBe(42);
  });

  it('uses the passed seed even when it is 0', () => {
    const workflow = renderWorkflowTemplate(TEMPLATE, { prompt: '1girl', seed: 0 });
    expect(seedOf(workflow)).toBe(0);
  });

  it('replaces every %seed% across all nodes with the same value', () => {
    const multi = JSON.stringify({
      '3': { class_type: 'KSampler', inputs: { seed: '%seed%', text: '%prompt%' } },
      '7': { class_type: 'RandomNoise', inputs: { noise_seed: '%seed%', note: 'seed=%seed% here' } },
      '9': { class_type: 'SomeNode', inputs: { value: 3 } },
    });
    const workflow = renderWorkflowTemplate(multi, { prompt: '1girl', seed: 12345 });
    const n3 = workflow['3'] as { inputs: { seed: unknown } };
    const n7 = workflow['7'] as { inputs: { noise_seed: unknown; note: unknown } };
    expect(n3.inputs.seed).toBe(12345);
    expect(n7.inputs.noise_seed).toBe(12345);
    // 嵌在字符串里的 %seed% 也被替换成同一个值
    expect(n7.inputs.note).toBe('seed=12345 here');
  });

  it('replaces every %seed% with the same generated value when not passed', () => {
    const multi = JSON.stringify({
      '3': { class_type: 'KSampler', inputs: { seed: '%seed%', text: '%prompt%' } },
      '7': { class_type: 'RandomNoise', inputs: { noise_seed: '%seed%' } },
    });
    const workflow = renderWorkflowTemplate(multi, { prompt: '1girl' });
    const a = (workflow['3'] as { inputs: { seed: unknown } }).inputs.seed;
    const b = (workflow['7'] as { inputs: { noise_seed: unknown } }).inputs.noise_seed;
    expect(a).toBeTypeOf('number');
    expect(a).toBe(b);
  });
});

describe('renderWorkflowTemplate with %nl%', () => {
  it.each(['prompt', 'nl'])('sends both parts through the sole positive %s placeholder', placeholder => {
    const workflow = renderWorkflowTemplate(JSON.stringify({
      '3': { class_type: 'CLIPTextEncode', inputs: { text: `%${placeholder}%` } },
      '4': { class_type: 'CLIPTextEncode', inputs: { text: '%negative_prompt%' } },
    }), { prompt: '1girl, silver hair', nl: 'The girl sits beside the window.', negative_prompt: 'extra people' });
    expect(workflow['3'].inputs).toEqual({ text: '1girl, silver hair\nThe girl sits beside the window.' });
    expect(workflow['4'].inputs).toEqual({ text: 'extra people' });
  });

  it('writes nl only into explicit %nl% placeholders, never into %prompt%', () => {
    const template = JSON.stringify({
      '3': { class_type: 'CLIPTextEncode', inputs: { text: '%prompt%' } },
      '5': { class_type: 'CLIPTextEncode', inputs: { text: '%nl%' } },
    });
    const workflow = renderWorkflowTemplate(template, { prompt: '1girl', nl: 'A girl.' });
    expect((workflow['3'] as { inputs: { text: unknown } }).inputs.text).toBe('1girl');
    expect((workflow['5'] as { inputs: { text: unknown } }).inputs.text).toBe('A girl.');
  });

  it('substitutes an empty string for %nl% when nl is absent', () => {
    const template = JSON.stringify({
      '5': { class_type: 'CLIPTextEncode', inputs: { text: 'caption: %nl%', prompt: '%prompt%' } },
    });
    const workflow = renderWorkflowTemplate(template, { prompt: '1girl' });
    expect((workflow['5'] as { inputs: { text: unknown } }).inputs.text).toBe('caption: ');
  });
});

describe('renderWorkflowTemplate with %negative_prompt%', () => {
  it('writes the per-image negative prompt into the workflow template', () => {
    const workflow = renderWorkflowTemplate(TEMPLATE, {
      prompt: '1girl',
      negative_prompt: 'extra people, duplicate character',
      seed: 1,
    });
    const inputs = (workflow['3'] as { inputs: { neg: unknown } }).inputs;
    expect(inputs.neg).toBe('extra people, duplicate character');
  });
});

describe('renderWorkflowTemplate with %width% / %height%', () => {
  const SIZED = JSON.stringify({
    '3': { class_type: 'CLIPTextEncode', inputs: { text: '%prompt%' } },
    '5': { class_type: 'EmptyLatentImage', inputs: { width: '%width%', height: '%height%' } },
  });

  it('renders width/height as numbers (EmptyLatentImage rejects strings)', () => {
    const workflow = renderWorkflowTemplate(SIZED, { prompt: '2girls', width: 1216, height: 832 });
    const inputs = (workflow['5'] as { inputs: { width: unknown; height: unknown } }).inputs;
    expect(inputs.width).toBe(1216);
    expect(inputs.height).toBe(832);
    expect(inputs.width).toBeTypeOf('number');
  });

  it('throws when the workflow uses the placeholders but no size was resolved', () => {
    expect(() => renderWorkflowTemplate(SIZED, { prompt: '1girl' })).toThrow(ComfyUIError);
    expect(() => renderWorkflowTemplate(SIZED, { prompt: '1girl' })).toThrow('%width%');
  });

  it('ignores a missing size entirely when the workflow hardcodes its own dimensions', () => {
    // 存量工作流(尺寸写死)必须零影响——画幅是 opt-in 特性
    const legacy = JSON.stringify({
      '3': { class_type: 'CLIPTextEncode', inputs: { text: '%prompt%' } },
      '5': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512 } },
    });
    const workflow = renderWorkflowTemplate(legacy, { prompt: '1girl' });
    const inputs = (workflow['5'] as { inputs: { width: unknown; height: unknown } }).inputs;
    expect(inputs.width).toBe(512);
    expect(inputs.height).toBe(512);
  });
});

/**
 * 取消路径:必须按任务在队列里的位置分流。
 * 旧实现无脑 POST /interrupt——并发出图时取消排在后面的任务会打断**正在跑的别的任务**。
 */
describe('generateComfyImage 取消', () => {
  const CONN = {
    url: 'http://127.0.0.1:8188',
    workflow: TEMPLATE,
    qualityTags: '',
    negativePrompt: '',
    resolution: '',
    portraitSize: '',
    landscapeSize: '',
  } as unknown as Parameters<typeof generateComfyImage>[0];

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** 记录取消阶段打到哪些端点、带什么 body。 */
  function stubFetch(queueBody: unknown) {
    const calls: Array<{ url: string; body: unknown }> = [];
    const json = (data: unknown) => ({ ok: true, json: async () => data, text: async () => '' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: { body?: string }) => {
        const url = String(input);
        const body = init?.body ? JSON.parse(init.body) : undefined;
        calls.push({ url, body });
        if (url.endsWith('/prompt')) return json({ prompt_id: 'pid-1' });
        if (url.includes('/queue')) return json(queueBody);
        // history 永远返回空:任务「未完成」,轮询会一直等,直到 abort
        if (url.includes('/history/')) return json({});
        return json({});
      }),
    );
    return calls;
  }

  /**
   * 等到轮询真正开始(出现 /history 请求)再取消。
   * 不能只等 /prompt:那时 queueDirect 可能还没返回,取消监听尚未注册。
   */
  async function waitForPolling(calls: Array<{ url: string }>): Promise<void> {
    await vi.waitFor(() => expect(calls.some(c => c.url.includes('/history/'))).toBe(true));
  }

  it('stopping during submission rejects immediately, then removes the late accepted task by ID', async () => {
    let accepted!: (value: Response) => void;
    const calls: Array<{url:string;body:unknown}> = [];
    vi.stubGlobal('fetch', vi.fn((input: unknown, init?: RequestInit) => {
      const url = String(input), body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({url, body});
      if (url.endsWith('/prompt')) return new Promise<Response>(resolve => { accepted = resolve; });
      return Promise.resolve(new Response(JSON.stringify({queue_running:[[0,'other']],queue_pending:[[1,'late-id']]})));
    }));
    const controller = new AbortController();
    const job = generateComfyImage(CONN, {prompt:'a vase'}, controller.signal);
    controller.abort();
    await expect(job).rejects.toMatchObject({name:'AbortError'});
    accepted(new Response(JSON.stringify({prompt_id:'late-id'})));
    await vi.waitFor(() => expect(calls.find(c => c.url.endsWith('/queue') && c.body)?.body).toEqual({delete:['late-id']}));
    expect(calls.some(c => c.url.includes('/history/') || c.url.endsWith('/interrupt'))).toBe(false);
  });

  it('does not dispatch an already aborted workflow', async () => {
    const fetch = vi.fn();vi.stubGlobal('fetch', fetch);
    const controller = new AbortController();controller.abort();
    await expect(generateComfyImage(CONN, {prompt:'a vase'}, controller.signal)).rejects.toMatchObject({name:'AbortError'});
    expect(fetch).not.toHaveBeenCalled();
  });

  it('interrupts its own task if it starts running just before queue deletion', async () => {
    let deleted = false;
    const interrupt = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/prompt')) return new Response(JSON.stringify({prompt_id:'race-id'}));
      if (url.endsWith('/interrupt')) interrupt(JSON.parse(String(init?.body)));
      if (url.endsWith('/queue') && init?.body) deleted = true;
      return new Response(JSON.stringify(url.endsWith('/queue')
        ? {queue_running:deleted ? [[0,'race-id']] : [],queue_pending:deleted ? [] : [[1,'race-id']]}
        : {}));
    }));
    const controller = new AbortController();
    let polling!:()=>void; const started = new Promise<void>(resolve=>{polling=resolve;});
    const job = generateComfyImage(CONN, {prompt:'a vase'}, controller.signal, {onQueue:polling});
    await started;controller.abort();
    await expect(job).rejects.toMatchObject({name:'AbortError'});
    await vi.waitFor(()=>expect(interrupt).toHaveBeenCalledWith({prompt_id:'race-id'}));
  });

  it('任务仍在排队 → 用 /queue delete 摘除,不 interrupt', async () => {
    const calls = stubFetch({
      queue_running: [[0, 'other-running-task']],
      queue_pending: [[1, 'pid-1']],
    });
    const controller = new AbortController();
    const promise = generateComfyImage(CONN, { prompt: '1girl' }, controller.signal);
    await waitForPolling(calls);
    controller.abort();
    await expect(promise).rejects.toThrow();

    await vi.waitFor(() => {
      const cancelCall = calls.find(c => c.url.includes('/queue') && c.body);
      expect(cancelCall?.body).toEqual({ delete: ['pid-1'] });
    });
    // 关键:没有打断正在跑的那个任务
    expect(calls.some(c => c.url.includes('/interrupt'))).toBe(false);
  });

  it('任务正在执行 → interrupt 且带自己的 prompt_id', async () => {
    const calls = stubFetch({ queue_running: [[0, 'pid-1']], queue_pending: [] });
    const controller = new AbortController();
    const promise = generateComfyImage(CONN, { prompt: '1girl' }, controller.signal);
    await waitForPolling(calls);
    controller.abort();
    await expect(promise).rejects.toThrow();

    await vi.waitFor(() => {
      const interrupt = calls.find(c => c.url.includes('/interrupt'));
      // 带 prompt_id:新版 ComfyUI 据此校验,旧版无视 body 但我们已确认在跑的就是自己
      expect(interrupt?.body).toEqual({ prompt_id: 'pid-1' });
    });
    // 排队中的任务才用 delete,这里不该发
    expect(calls.some(c => c.url.includes('/queue') && c.body)).toBe(false);
  });

  it('onQueue 上报排队位置(正在跑的也算在前面)', async () => {
    stubFetch({
      queue_running: [[0, 'other']],
      queue_pending: [
        [1, 'ahead-1'],
        [2, 'pid-1'],
      ],
    });
    const reported: Array<number | null> = [];
    const controller = new AbortController();
    const promise = generateComfyImage(CONN, { prompt: '1girl' }, controller.signal, {
      onQueue: ahead => reported.push(ahead),
    });
    // 前面 1 个 pending(ahead-1)+ 1 个 running = 2
    await vi.waitFor(() => expect(reported).toContain(2));
    controller.abort();
    await expect(promise).rejects.toThrow();
  });

  it('队列位置查不到时两条都发(否则「在跑但查不到」会漏中断、白烧 GPU)', async () => {
    // 队列返回不可解析的形状 → fetchQueuePosition 得到 null(位置未知)
    const calls = stubFetch({ nonsense: true });
    const controller = new AbortController();
    const promise = generateComfyImage(CONN, { prompt: '1girl' }, controller.signal);
    await waitForPolling(calls);
    controller.abort();
    await expect(promise).rejects.toThrow();

    await vi.waitFor(() => {
      expect(calls.find(c => c.url.includes('/queue') && c.body)?.body).toEqual({
        delete: ['pid-1'],
      });
      expect(calls.find(c => c.url.includes('/interrupt'))?.body).toEqual({ prompt_id: 'pid-1' });
    });
  });
});

/**
 * 简易模式:预设不带 JSON,由 comfyTemplates 按模板组装。
 * 与 custom 模式在「拿到可提交 JSON」处汇合,故这里只验提交体是组装结果。
 */
describe('generateComfyImage 简易模式', () => {
  const SIMPLE_CONN = {
    url: 'http://127.0.0.1:8188',
    workflow: '',
    mode: 'simple',
    simple: {
      ...simpleDefaults(),
      model: 'illustrious.safetensors',
      positive: 'masterpiece',
      negative: 'worst quality',
    },
    portraitSize: '832×1216',
    landscapeSize: '1216×832',
  } as unknown as Parameters<typeof generateComfyImage>[0];

  afterEach(() => vi.unstubAllGlobals());

  function stubSuccessFetch() {
    const calls: Array<{ url: string; body: unknown }> = [];
    const json = (data: unknown) => ({ ok: true, json: async () => data, text: async (): Promise<string> => '' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: { body?: string }) => {
        const url = String(input);
        const body = init?.body ? JSON.parse(init.body) : undefined;
        calls.push({ url, body });
        if (url.endsWith('/prompt')) return json({ prompt_id: 'pid-1' });
        if (url.includes('/history/')) {
          return json({
            'pid-1': {
              status: { completed: true },
              outputs: { '8': { images: [{ filename: 'BaiBai_00001_.png', type: 'output' }] } },
            },
          });
        }
        if (url.includes('/view')) {
          return { ok: true, blob: async () => new Blob(['png'], { type: 'image/png' }), text: async (): Promise<string> => '' };
        }
        return json({});
      }),
    );
    return calls;
  }

  it('提交的是组装出的工作流(固定词+生成词拼接,尺寸取自预设)', async () => {
    const calls = stubSuccessFetch();
    const result = await generateComfyImage(SIMPLE_CONN, {
      prompt: '1girl',
      negative_prompt: 'extra people',
      seed: 42,
      size: 'portrait',
    });
    expect(result.filename).toBe('BaiBai_00001_.png');

    const submit = calls.find(c => c.url.endsWith('/prompt'));
    const prompt = (submit?.body as { prompt: Record<string, { class_type: string; inputs: Record<string, unknown> }> }).prompt;
    expect(prompt['1'].class_type).toBe('CheckpointLoaderSimple');
    expect(prompt['1'].inputs.ckpt_name).toBe('illustrious.safetensors');
    expect(prompt['3'].inputs.text).toBe('masterpiece, 1girl');
    expect(prompt['4'].inputs.text).toBe('worst quality, extra people');
    expect(prompt['5'].inputs).toMatchObject({ width: 832, height: 1216 });
    expect(prompt['6'].inputs.seed).toBe(42);
    result.revoke();
  });

  it.each(['simple', 'custom'] as const)('passes per-workflow fixed text through %s submission', async mode => {
    const calls = stubSuccessFetch();
    const result = await generateComfyImage({
      ...SIMPLE_CONN, mode,
      fixedPrompts: { positivePrefix: 'first', positiveSuffix: 'last', negative: 'fixed negative' },
      workflow: JSON.stringify({
        '3': { class_type: 'CLIPTextEncode', inputs: { text: 'masterpiece, %prompt%' } },
        '4': { class_type: 'CLIPTextEncode', inputs: { text: 'worst quality, %negative_prompt%' } },
      }),
    }, { prompt: 'a tree', nl: 'A tree on a hill.', negative_prompt: 'extra tree', seed: 42 });
    const submit = calls.find(c => c.url.endsWith('/prompt'));
    const prompt = (submit?.body as { prompt: Record<string, { inputs: Record<string, unknown> }> }).prompt;
    expect(prompt['3'].inputs.text).toBe('first, masterpiece, a tree\nA tree on a hill., last');
    expect(prompt['4'].inputs.text).toBe('fixed negative, worst quality, extra tree');
    result.revoke();
  });

  it.each(['simple','custom'] as const)('submits workflow defaults and per-image overrides in %s mode', async mode => {
    const calls=stubSuccessFetch();
    const conn={...SIMPLE_CONN,mode,defaultSize:'1080×1920',workflow:JSON.stringify({'3':{class_type:'CLIPTextEncode',inputs:{text:'%prompt%'}},'5':{class_type:'EmptyLatentImage',inputs:{width:'%width%',height:'%height%'}}})};
    const first=await generateComfyImage(conn,{prompt:'a vase',size:'landscape'}); first.revoke();
    const second=await generateComfyImage(conn,{prompt:'a vase',width:1536,height:1024}); second.revoke();
    const sent=calls.filter(c=>c.url.endsWith('/prompt')).map(c=>(c.body as any).prompt['5'].inputs);
    expect(sent[0]).toMatchObject({width:1080,height:1920});
    expect(sent[1]).toMatchObject({width:1536,height:1024});
  });

  it('配置不齐(未选模型)时走 ComfyUIError,不发请求', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const conn = {
      ...SIMPLE_CONN,
      simple: { ...simpleDefaults(), model: '' },
    } as unknown as Parameters<typeof generateComfyImage>[0];
    await expect(generateComfyImage(conn, { prompt: '1girl' })).rejects.toThrow(ComfyUIError);
    await expect(generateComfyImage(conn, { prompt: '1girl' })).rejects.toThrow('模型');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});


describe('workflow fixed prompt fields', () => {
  const fixed = { positivePrefix: '(watercolor:1.2)', positiveSuffix: 'soft lighting', negative: 'low resolution' };
  const values = { prompt: 'a tree', nl: 'A tree stands on a hill.', negative_prompt: 'extra tree', seed: 7 };

  it('wraps the completed positive field once, outside static text and both placeholders', () => {
    const template = JSON.stringify({
      '1': { class_type: 'CLIPTextEncode', inputs: { text: 'template start %prompt%\n%nl% template end' } },
      '2': { class_type: 'CLIPTextEncode', inputs: { text: 'negative base, %negative_prompt%' } },
      '3': { class_type: 'KSampler', inputs: { seed: '%seed%' }, _meta: { title: 'Unchanged' } },
    });
    const rendered = renderWorkflowTemplate(template, values, fixed);
    expect((rendered['1'].inputs as Record<string, unknown>).text).toBe('(watercolor:1.2), template start a tree\nA tree stands on a hill. template end, soft lighting');
    expect((rendered['2'].inputs as Record<string, unknown>).text).toBe('low resolution, negative base, extra tree');
    expect((rendered['3'].inputs as Record<string, unknown>).seed).toBe(7);
    expect(rendered['3']._meta).toEqual({ title: 'Unchanged' });
    expect(JSON.parse(template)['1'].inputs.text).toContain('%prompt%');
  });

  it.each(['prompt', 'nl'])('keeps tag and description through the sole positive %s field', placeholder => {
    const template = JSON.stringify({ '1': { class_type: 'Text', inputs: { text: '%' + placeholder + '%' } } });
    const rendered = renderWorkflowTemplate(template, values, { ...fixed, negative: '' });
    expect((rendered['1'].inputs as Record<string, unknown>).text).toBe('(watercolor:1.2), a tree\nA tree stands on a hill., soft lighting');
  });

  it('wraps independent positive fields individually without putting negative words into either', () => {
    const template = JSON.stringify({
      '1': { class_type: 'Text', inputs: { text: '%prompt%', other: ['%nl%'] } },
      '2': { class_type: 'Text', inputs: { text: '%negative_prompt%' } },
    });
    const rendered = renderWorkflowTemplate(template, values, fixed);
    expect(rendered['1'].inputs).toEqual({
      text: '(watercolor:1.2), a tree, soft lighting',
      other: ['(watercolor:1.2), A tree stands on a hill., soft lighting'],
    });
    expect((rendered['2'].inputs as Record<string, unknown>).text).toBe('low resolution, extra tree');
  });

  it('keeps quotes, newlines and percent text literal without recursively expanding user content', () => {
    const tricky = { positivePrefix: 'style "ink"\n%seed%', positiveSuffix: '%negative_prompt%', negative: '' };
    const template = JSON.stringify({ '1': { class_type: 'Text', inputs: { text: '%prompt%' } } });
    const rendered = renderWorkflowTemplate(template, { prompt: '100% tree, %nl%' }, tricky);
    expect((rendered['1'].inputs as Record<string, unknown>).text).toBe('style "ink"\n%seed%, 100% tree, %nl%, %negative_prompt%');
  });

  it('empty fixed fields leave legacy output unchanged, including template whitespace', () => {
    const template = JSON.stringify({ '1': { class_type: 'Text', inputs: { text: '  %prompt%  ', n: '%seed%' } } });
    expect(renderWorkflowTemplate(template, values, { positivePrefix: ' ', positiveSuffix: '\n', negative: '' }))
      .toEqual(renderWorkflowTemplate(template, values));
  });

  it('refuses a configured negative when the workflow has no negative placeholder', () => {
    const template = JSON.stringify({ '1': { class_type: 'Text', inputs: { text: '%prompt%' } } });
    expect(() => renderWorkflowTemplate(template, values, fixed)).toThrow('没有 %negative_prompt% 输入');
  });

  it('refuses ambiguous mixed positive/negative fields without changing legacy empty-fixed behavior', () => {
    const template = JSON.stringify({ '1': { class_type: 'Text', inputs: { text: '%prompt% / %negative_prompt%' } } });
    expect(() => renderWorkflowTemplate(template, values, fixed)).toThrow('正面和负面占位符');
    expect(() => renderWorkflowTemplate(template, values)).not.toThrow();
  });

  it('does not submit any real request when the fixed negative has no destination', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const conn = {
      url: 'http://example.invalid', mode: 'custom' as const, simple: simpleDefaults(),
      portraitSize: '512×512', landscapeSize: '512×512', fixedPrompts: fixed,
      workflow: JSON.stringify({ '1': { class_type: 'Text', inputs: { text: '%prompt%' } } }),
    };
    await expect(generateComfyImage(conn, values)).rejects.toThrow('没有 %negative_prompt% 输入');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
