import { requestCompletion, requestViaMainApi } from '@/api/client';
import { buildAutoTagMessages } from './prompt';
import { prepareTargetText } from './clean';
import { readBookMemory } from './bookMemory';
import { resolveCharAnchors } from './charAnchors';
import { prepareSelectionCharState } from './selection';
import { parseFinalJsonObject, parseImagePlan } from './protocol';
import { assertExplicitAppearance } from './facialDetail';
import { assertSceneNegative, supportsSceneNegative } from './negative';
import { charTagsBeforeFloor, lockedCharTagNames, readCharTagFloorDelta } from '@/state/charTags';
import { settings, activeComfyPreset, getTagGenChannel } from '@/state/settings';
import { normalizePromptMode, assertNaturalPrompt } from '@/promptMode';
import { assertMixedPrompt } from '@/promptContent';
import type { STContext } from '@/st/context';
import type { ImageTagContent } from '@/st/imageTagRegex';
import type { PromptSource } from '@/floor/promptSource';

/** Draft only: neither character changes nor message writes are committed here. */
export async function rewriteImagePrompt(context: STContext, floor: number, source: PromptSource,
  content: ImageTagContent, signal: AbortSignal): Promise<ImageTagContent> {
  signal.throwIfAborted();
  const prepared = prepareTargetText(source.text, settings.excludes.customStripTags);
  if (!prepared.segments.length) throw new Error('本图没有可读取的原正文或选段，请使用“按意见修改”');
  const preset = activeComfyPreset();
  const mode = normalizePromptMode(preset.promptMode);
  const negativeOn = supportsSceneNegative(settings.defaultBackend, preset);
  const locked = lockedCharTagNames();
  const state = prepareSelectionCharState(charTagsBeforeFloor(floor), readCharTagFloorDelta(context.chat[floor]), context.chat[floor].swipe_id ?? 0, locked);
  const anchors = resolveCharAnchors(state.entries, locked);
  const messages = await buildAutoTagMessages(context, floor, {...settings.autoTag,minImages:1,maxImages:1},
    readBookMemory(floor, context.chat[floor].mes, context.name1), prepared, anchors.text, negativeOn, mode);
  const index = messages.findLastIndex(m=>m.role==='user');
  messages.splice(Math.max(0,index),0,{role:'system',content:
    '本次仅重写一张既有图片的提示词。只依据目标正文中的一个明确可见瞬间重新生成恰好一张图，不润色旧提示词，不从历史上下文另选事件。选段以其当时状态为准，后续剧情状态不得提前套用。固定外貌仍按角色资料，但所有实际画面字段直接写完整外貌，不使用 @角色名。忽略其它指令中的建档或更新要求：changes 必须为空数组，不修改角色档案。只返回既定 JSON，不输出解释。'});
  signal.throwIfAborted();
  const parsed: {value: ImageTagContent|null} = {value:null};
  const options = { signal, source:`重写提示词(第 ${floor} 楼 · ${source.kind==='selection'?'原选段':'原正文'})`, validate(raw:string){
    signal.throwIfAborted();
    const response = parseFinalJsonObject(raw);
    if (!Array.isArray(response.images) || response.images.length !== 1) throw new Error('重写必须返回一张图片的提示词');
    const plan = parseImagePlan(raw, prepared.segments, 1, 1, mode);
    if (plan.images.length !== 1) throw new Error('重写必须返回一张图片的提示词');
    const image=plan.images[0];
    const next:ImageTagContent={...content,tag:image.tag,nl:image.nl,negative:negativeOn?image.negative:content.negative,
      characters:settings.defaultBackend==='comfyui'?content.characters:image.characters,promptMode:mode};
    assertExplicitAppearance(next);
    if(mode==='krea2')assertNaturalPrompt(next);else assertMixedPrompt(next);
    if(negativeOn)assertSceneNegative(next.negative);
    parsed.value=next;
  }};
  const channel=getTagGenChannel();
  if(channel)await requestCompletion(channel,messages,options);else await requestViaMainApi(messages,options);
  signal.throwIfAborted();
  if(!parsed.value)throw new Error('重写未返回有效提示词，原草稿已保留');
  return parsed.value;
}
