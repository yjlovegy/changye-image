export interface StoryRange { start: number; end: number }

/** Offsets refer to the original message. Only complete, paired containers qualify. */
export function storyRanges(source: string, names: string[] = []): StoryRange[] {
  const allowed = new Set(names.map(name => name.toLowerCase()));
  if (!allowed.size) return [{ start: 0, end: source.length }];
  // Examples in hidden metadata must never become selectable story containers.
  const scanned = source.replace(/<!--[\s\S]*?-->|<(think|thinking|script|style|horae|bbs_items|bbs_vars)(?=[\s>])[^>]*>[\s\S]*?<\/\1\s*>/gi,
    block => block.replace(/[^\r\n]/g, ' '));
  const stacks = new Map<string, number[]>();
  const ranges: StoryRange[] = [];
  const tokens = /<!--[\s\S]*?-->|<\/?([\p{L}\p{N}_-]+)(?=[\s/>])(?:"[^"]*"|'[^']*'|[^'">])*?>/gu;
  for (const match of scanned.matchAll(tokens)) {
    const name = match[1]?.toLowerCase();
    if (!name || !allowed.has(name) || /\/\s*>$/.test(match[0])) continue;
    const stack = stacks.get(name) ?? [];
    stacks.set(name, stack);
    if (match[0].startsWith('</')) {
      const start = stack.pop();
      if (start !== undefined) ranges.push({ start, end: match.index! });
    } else stack.push(match.index! + match[0].length);
  }
  return ranges.sort((a, b) => a.start - b.start).reduce<StoryRange[]>((out, range) => {
    const last = out.at(-1);
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else out.push({ ...range });
    return out;
  }, []);
}

export function outsideStoryRanges(source: string, names: string[]): StoryRange[] {
  const ranges = storyRanges(source, names), excluded: StoryRange[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (cursor < range.start) excluded.push({ start: cursor, end: range.start });
    cursor = range.end;
  }
  if (cursor < source.length) excluded.push({ start: cursor, end: source.length });
  return excluded;
}
