/** Source offsets are UTF-16 offsets, like DOM Range. Never find the first matching sentence. */
export type SelectionAnchorResult = { offset: number; reason?: never } | { offset?: never; reason: string };

/** Complete DOM paragraphs surrounding the selection, counted with the same narrative filter. */
export interface SelectionAnchorContext { text: string; beforeSelection: string }

const compact = (text: string) => text.replace(/\s/g, '');
const ENTITY_NAMES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/**
 * A conservative projection for narrative text, common Markdown, and HTML paragraphs.
 * Every projected character retains its source end. Prefer a whole-message match. Display
 * extensions may rewrite unrelated panels; then require a complete surrounding paragraph
 * that occurs exactly once in both source and display. Never guess the first matching sentence.
 */
export function locateSelectionSourceEnd(
  source: string,
  renderedText: string,
  beforeText: string,
  selectedText: string,
  stripTags: string[] = [],
  contexts: SelectionAnchorContext[] = [],
): SelectionAnchorResult {
  const fail = (reason: string): SelectionAnchorResult => ({ reason });
  if (source.length > 250_000) return fail('这条消息过长，暂时无法可靠定位选区');
  const hidden = new Uint8Array(source.length);
  const closing = new Map<number, number>();
  const containers: Array<{ start: number; end: number }> = [];
  const markdownBlocks: Array<{ start: number; end: number; multilineList: boolean }> = [];
  const hide = (start: number, end: number) => hidden.fill(1, start, end);
  const matches = (pattern: RegExp, visit: (match: RegExpMatchArray, start: number) => void) => {
    for (const match of source.matchAll(pattern)) visit(match, match.index!);
  };
  matches(/<!--[\s\S]*?(?:-->|$)/g, (m, i) => hide(i, i + m[0].length));
  const hiddenTags = new Set(['bbi_image', 'script', 'style', 'think', 'thinking', 'horae', 'bbs_items', 'bbs_vars', ...stripTags]);
  for (const name of hiddenTags) {
    if (!/^[\p{L}\p{N}_-]+$/u.test(name)) continue;
    matches(new RegExp(`<${name}(?=[\\s/>])[^>]*>[\\s\\S]*?<\\/${name}\\s*>`, 'gi'), (m, i) => hide(i, i + m[0].length));
  }
  // Match BaiBai Book's display-only time regex: complete same-line metadata, not arbitrary blocks.
  matches(/<bbs_start\b[^>\r\n]*>[^<\r\n]*<\/bbs_start>|<bbs_end\b[^>\r\n]*>[^<\r\n]*<\/bbs_end>/gi, (m, i) => hide(i, i + m[0].length));
  // Code and Markdown images are not narrative selection targets.
  matches(/^([ \t]*)(`{3,}|~{3,})[^\r\n]*[\s\S]*?^\1\2[ \t]*$/gm, (m, i) => hide(i, i + m[0].length));
  matches(/(`+)[^`\r\n]+\1/g, (m, i) => hide(i, i + m[0].length));
  matches(/!\[[^\]\r\n]*\]\([^\r\n]*?\)/g, (m, i) => hide(i, i + m[0].length));
  matches(/<(pre|code)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, (m, i) => hide(i, i + m[0].length));
  // A newline inserted inside a Markdown block changes the scope of the remaining text.
  // Keep whole headings and closed quotes usable; do not split lists or guess continuation syntax.
  const lines = [...source.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/g)]
    .filter(match => match[0].length)
    .map(match => {
      const text = match[0].replace(/(?:\r\n|\r|\n)$/, '');
      return { text, start: match.index!, end: match.index! + text.length };
    });
  const listStart = /^[ \t]{0,3}(?:[-+*][ \t]+|\d+[.)][ \t]+)/;
  const quoteStart = /^[ \t]{0,3}>/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (hidden[line.start]) continue;
    const heading = /^[ \t]{0,3}#{1,6}[ \t]+/.test(line.text);
    const list = listStart.test(line.text);
    if (!heading && !list && !quoteStart.test(line.text)) continue;
    let last = i;
    let nonemptyLines = 1;
    if (!heading) {
      for (let next = i + 1; next < lines.length; next++) {
        if (!lines[next].text.trim()) {
          while (next < lines.length && !lines[next].text.trim()) next++;
          if (next >= lines.length) break;
          const continuation = list
            ? listStart.test(lines[next].text) || /^(?: {2,}|\t)/.test(lines[next].text)
            : quoteStart.test(lines[next].text);
          if (!continuation) break;
        }
        last = next;
        nonemptyLines++;
      }
    }
    markdownBlocks.push({ start: line.start, end: lines[last].end, multilineList: list && nonemptyLines > 1 });
    i = last;
  }
  matches(/^[ \t]{0,3}(?:#{1,6}[ \t]+|(?:>[ \t]*)+|[-+*][ \t]+|\d+[.)][ \t]+)/gm, (m, i) => hide(i, i + m[0].length));
  matches(/^[ \t]*(?:\*[ \t]*){3,}$|^[ \t]*(?:-[ \t]*){3,}$|^[ \t]*(?:_[ \t]*){3,}$/gm, (m, i) => hide(i, i + m[0].length));
  matches(/\[([^\]\r\n]+)\]\([^\r\n]*?\)/g, (m, i) => {
    if (hidden[i]) return;
    hide(i, i + 1);
    const close = i + m[1].length + 1;
    hide(close, i + m[0].length);
    closing.set(close, i + m[0].length);
    containers.push({ start: i, end: i + m[0].length });
  });
  // Paired formatting only; literal unmatched punctuation remains visible.
  for (const pattern of [/\*\*(?=\S)([\s\S]*?\S)\*\*/g, /__(?=\S)([\s\S]*?\S)__/g, /~~(?=\S)([\s\S]*?\S)~~/g, /(?<!\*)\*(?!\*)(?=\S)([^*]*?\S)\*(?!\*)/g, /(?<![\w_])_(?!_)(?=\S)([^_]*?\S)_(?![\w_])/g]) {
    matches(pattern, (m, i) => {
      if (hidden[i]) return;
      const width = (m[0].length - m[1].length) / 2;
      const close = i + m[0].length - width;
      hide(i, i + width); hide(close, close + width);
      closing.set(close, close + width);
      containers.push({ start: i, end: close + width });
    });
  }
  const stack: Array<{ name: string; start: number }> = [];
  matches(/<\/?([a-zA-Z][\w:-]*)(?:\s[^<>]*?)?\s*\/?>/g, (m, i) => {
    if (hidden[i]) return;
    hide(i, i + m[0].length);
    const name = m[1].toLowerCase();
    // Rolecards use bare <content> as a narrative section marker, not an HTML layout.
    // Keep an inserted image inside this section so the card's display regex retains it.
    if (name === 'content' && /^<\/?content\s*>$/i.test(m[0])) return;
    if (m[0].startsWith('</')) {
      closing.set(i, i + m[0].length);
      const open = stack.at(-1);
      if (open?.name === name) {
        stack.pop();
        containers.push({ start: open.start, end: i + m[0].length });
      }
    } else if (!m[0].endsWith('/>') && !['br', 'hr', 'img', 'input', 'wbr', 'meta', 'link'].includes(name)) {
      stack.push({ name, start: i });
    }
  });
  for (const open of stack) containers.push({ start: open.start, end: source.length + 1 });
  let projected = '';
  const ends: number[] = [];
  const emit = (value: string, end: number) => {
    for (let i = 0; i < value.length; i++) if (!/\s/.test(value[i])) { projected += value[i]; ends.push(end); }
  };
  for (let i = 0; i < source.length;) {
    if (hidden[i]) { i++; continue; }
    const entity = source[i] === '&' ? source.slice(i).match(/^&(#x[\da-f]+|#\d+|[a-z]+);/i) : null;
    if (entity) {
      const key = entity[1];
      const code = key[0] === '#' ? Number.parseInt(key.slice(/^#x/i.test(key) ? 2 : 1), /^#x/i.test(key) ? 16 : 10) : NaN;
      const decoded = Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ENTITY_NAMES[key];
      if (decoded !== undefined) { emit(decoded, i + entity[0].length); i += entity[0].length; continue; }
    }
    if (source[i] === '\\' && /[\\`*_{}\[\]()#+\-.!>]/.test(source[i + 1] ?? '')) { emit(source[i + 1], i + 2); i += 2; continue; }
    emit(source[i], i + 1); i++;
  }
  const visible = compact(renderedText);
  const before = compact(beforeText);
  const selected = compact(selectedText);
  if (!selected || !visible.startsWith(before + selected)) {
    return fail('显示文字与消息原文无法准确对应，请选择普通剧情正文后重试');
  }
  let projectedEnd = before.length + selected.length;
  if (projected !== visible) {
    projectedEnd = -1;
    const uniqueIndex = (text: string, needle: string) => {
      const first = text.indexOf(needle);
      return first >= 0 && text.indexOf(needle, first + 1) < 0 ? first : -1;
    };
    for (const context of contexts.slice(0, 7)) {
      const text = compact(context.text), prefix = compact(context.beforeSelection);
      if (text.length < 12 || text.length > 8_000 || !text.startsWith(prefix + selected)) continue;
      const displayStart = uniqueIndex(visible, text);
      if (displayStart < 0 || displayStart + prefix.length !== before.length) continue;
      const sourceStart = uniqueIndex(projected, text);
      if (sourceStart < 0) continue;
      projectedEnd = sourceStart + prefix.length + selected.length;
      break;
    }
    if (projectedEnd < 0) return fail('选区所在段落无法唯一对应原文，请多选相邻正文后重试');
  }
  let offset = ends[projectedEnd - 1];
  if (offset === undefined) return fail('无法定位选区，请重新选择');
  // Include closing emphasis/HTML/link syntax without moving past any narrative text.
  while (true) {
    let next = offset;
    while (/\s/.test(source[next] ?? '') && next < source.length) next++;
    const end = closing.get(next);
    if (end === undefined) break;
    offset = end;
  }
  if (containers.some(container => offset > container.start && offset < container.end)) {
    return fail('选区结束在文字格式内部，请选到该段格式结束处');
  }
  if (markdownBlocks.some(block => block.multilineList && offset > block.start && offset <= block.end)) {
    return fail('多行列表暂不支持插图，请选择列表外的普通剧情正文');
  }
  if (markdownBlocks.some(block => offset > block.start && offset < block.end)) {
    return fail('选区结束在标题、列表或引用内部，请选到完整格式块末尾');
  }
  return { offset };
}
