/** Fixed prompt text belongs to one workflow and is never sent to the tag-planning model. */
export interface ComfyFixedPrompts {
  positivePrefix: string;
  positiveSuffix: string;
  negative: string;
}

/** Returns an independent value, including for absent or malformed legacy settings. */
export function normalizeComfyFixedPrompts(raw?: unknown): ComfyFixedPrompts {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Partial<ComfyFixedPrompts> : {};
  return {
    positivePrefix: typeof source.positivePrefix === 'string' ? source.positivePrefix : '',
    positiveSuffix: typeof source.positiveSuffix === 'string' ? source.positiveSuffix : '',
    negative: typeof source.negative === 'string' ? source.negative : '',
  };
}

/** Empty additions preserve the old rendered text exactly; weighting syntax stays untouched. */
export function composeComfyPositive(text: string, fixed?: ComfyFixedPrompts): string {
  const prefix = fixed?.positivePrefix.trim() ?? '';
  const suffix = fixed?.positiveSuffix.trim() ?? '';
  if (!prefix && !suffix) return text;
  return [prefix, text.trim(), suffix].filter(Boolean).join(', ');
}

export function composeComfyNegative(text: string, fixed?: ComfyFixedPrompts): string {
  const negative = fixed?.negative.trim() ?? '';
  if (!negative) return text;
  return [negative, text.trim()].filter(Boolean).join(', ');
}
