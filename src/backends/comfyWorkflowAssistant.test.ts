import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  applyWorkflowBindings,
  configureWorkflowWithAi,
  parseWorkflowBindings,
} from '@/backends/comfyWorkflowAssistant';

const requests = vi.hoisted(() => ({ main: vi.fn(), channelRequest: vi.fn(), channel: vi.fn() }));
vi.mock('@/api/client', () => ({ requestViaMainApi: requests.main, requestCompletion: requests.channelRequest }));
vi.mock('@/state/settings', () => ({ getTagGenChannel: requests.channel }));

const WORKFLOW = JSON.stringify({
  '3': {
    class_type: 'KSampler',
    inputs: {
      seed: 123,
      positive: ['6', 0],
      negative: ['7', 0],
    },
  },
  '5': {
    class_type: 'EmptyLatentImage',
    inputs: { width: 832, height: 1216 },
  },
  '6': {
    class_type: 'CLIPTextEncode',
    inputs: { text: 'masterpiece, best quality' },
  },
  '7': {
    class_type: 'CLIPTextEncode',
    inputs: { text: 'worst quality, bad hands' },
  },
});

describe('configureWorkflowWithAi request validation', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it.each([false, true])('validates JSON and bindings before request success (channel=%s)', async useChannel => {
    requests.channel.mockReturnValue(useChannel ? { id: 'configured' } : null);
    const succeeded = vi.fn();
    (useChannel ? requests.channelRequest : requests.main).mockImplementation(async (...args: unknown[]) => {
      const options = args.at(-1) as { validate?: (raw: string) => void };
      expect(options.validate).toBeTypeOf('function');
      options.validate?.('plain response');
      succeeded();
      return 'plain response';
    });
    await expect(configureWorkflowWithAi(WORKFLOW)).rejects.toThrow('可解析的工作流定位 JSON');
    expect(succeeded).not.toHaveBeenCalled();
  });

  it('rejects valid JSON pointing to a nonexistent input before request success', async () => {
    requests.channel.mockReturnValue(null);
    const succeeded = vi.fn();
    requests.main.mockImplementation(async (_messages, options) => {
      const raw = '{"bindings":[{"node":"404","input":"text","purpose":"positive_tag"}]}';
      options.validate(raw);
      succeeded();
      return raw;
    });
    await expect(configureWorkflowWithAi(WORKFLOW)).rejects.toThrow('节点 404 不存在');
    expect(succeeded).not.toHaveBeenCalled();
  });

  it.each([false, true])('preserves normal fragment normalization and workflow assembly (channel=%s)', async useChannel => {
    requests.channel.mockReturnValue(useChannel ? { id: 'configured' } : null);
    (useChannel ? requests.channelRequest : requests.main).mockImplementation(async (...args: unknown[]) => {
      const options = args.at(-1) as { validate: (raw: string) => void };
      const raw = '{"bindings":[{"node":"6","input":"text","purpose":"positive_combined","keep":["f1","F2"]}]}';
      options.validate(raw);
      return raw;
    });
    const result = await configureWorkflowWithAi(WORKFLOW);
    expect(JSON.parse(result.workflow)['6'].inputs.text).toBe('masterpiece, best quality, %prompt%\n%nl%');
    expect(result.nlMode).toBe('combined');
  });
});

describe('parseWorkflowBindings', () => {
  it('reads a fenced response and merges tag/nl on the same input into combined mode', () => {
    const raw = `说明
\`\`\`json
{"bindings":[
  {"node":"6","input":"text","purpose":"positive_tag","keep":["F1"]},
  {"node":"6","input":"text","purpose":"positive_nl","keep":["F2"]}
]}
\`\`\``;
    expect(parseWorkflowBindings(raw)).toEqual([
      { node: '6', input: 'text', purpose: 'positive_combined', keep: ['F1', 'F2'] },
    ]);
  });

  it('rejects conflicting purposes on the same input', () => {
    expect(() =>
      parseWorkflowBindings(
        '{"bindings":[{"node":"6","input":"text","purpose":"positive_tag"},{"node":"6","input":"text","purpose":"negative"}]}',
      ),
    ).toThrow('互相冲突');
  });
});

describe('applyWorkflowBindings', () => {
  it('preserves fixed prompt text and appends local macros', () => {
    const result = applyWorkflowBindings(WORKFLOW, [
      { node: '6', input: 'text', purpose: 'positive_combined', keep: ['F1', 'F2'] },
      { node: '7', input: 'text', purpose: 'negative', keep: ['F1', 'F2'] },
      { node: '3', input: 'seed', purpose: 'seed' },
      { node: '5', input: 'width', purpose: 'width' },
      { node: '5', input: 'height', purpose: 'height' },
    ]);
    const workflow = JSON.parse(result.workflow);

    expect(workflow['6'].inputs.text).toBe('masterpiece, best quality, %prompt%\n%nl%');
    expect(workflow['7'].inputs.text).toBe('worst quality, bad hands, %negative_prompt%');
    expect(workflow['3'].inputs.seed).toBe('%seed%');
    expect(workflow['5'].inputs.width).toBe('%width%');
    expect(workflow['5'].inputs.height).toBe('%height%');
    expect(result.nlMode).toBe('combined');
    expect(result.hasNegative).toBe(true);
  });

  it('does not duplicate placeholders in an already configured text input', () => {
    const configured = JSON.stringify({
      '6': {
        class_type: 'CLIPTextEncode',
        inputs: { text: 'quality, %prompt%\n%nl%' },
      },
    });
    const result = applyWorkflowBindings(configured, [
      { node: '6', input: 'text', purpose: 'positive_combined', keep: ['F1'] },
    ]);

    expect(result.changes).toEqual([]);
    expect(JSON.parse(result.workflow)['6'].inputs.text).toBe('quality, %prompt%\n%nl%');
  });

  it('rejects linked inputs instead of overwriting graph connections', () => {
    expect(() =>
      applyWorkflowBindings(WORKFLOW, [
        { node: '3', input: 'positive', purpose: 'positive_tag' },
      ]),
    ).toThrow('不是可直接替换');
  });

  it('requires a positive prompt binding when the workflow has no existing %prompt%', () => {
    expect(() =>
      applyWorkflowBindings(WORKFLOW, [
        { node: '7', input: 'text', purpose: 'negative' },
      ]),
    ).toThrow('没有找到正向提示词');
  });

  it('keeps only selected fixed fragments and removes exported sample scene content', () => {
    const sample = JSON.stringify({
      '11': {
        class_type: 'CLIPTextEncode',
        inputs: {
          text: 'masterpiece, best quality, @style, 2girls, cherry blossom tree, cheek to cheek, two girls smiling under pink petals',
        },
      },
      '12': {
        class_type: 'CLIPTextEncode',
        inputs: {
          text: 'worst quality, bad hands, mature female, short hair',
        },
      },
    });
    const result = applyWorkflowBindings(sample, [
      {
        node: '11',
        input: 'text',
        purpose: 'positive_combined',
        keep: ['F1', 'F2', 'F3'],
      },
      {
        node: '12',
        input: 'text',
        purpose: 'negative',
        keep: ['F1', 'F2'],
      },
    ]);
    const workflow = JSON.parse(result.workflow);

    expect(workflow['11'].inputs.text).toBe('masterpiece, best quality, @style, %prompt%\n%nl%');
    expect(workflow['11'].inputs.text).not.toContain('2girls');
    expect(workflow['11'].inputs.text).not.toContain('cherry blossom');
    expect(workflow['12'].inputs.text).toBe('worst quality, bad hands, %negative_prompt%');
    expect(workflow['12'].inputs.text).not.toContain('mature female');
  });

  it('rejects fragment IDs that do not exist in the original input', () => {
    expect(() =>
      applyWorkflowBindings(WORKFLOW, [
        { node: '6', input: 'text', purpose: 'positive_tag', keep: ['F99'] },
      ]),
    ).toThrow('不存在的片段');
  });
});
