import { describe, expect, it } from 'vitest';
import { locateSelectionSourceEnd } from './selectionAnchor';
import { insertSelectionImage, prepareSelectionImageText } from '@/autoTag/selection';

describe('selection source anchor', () => {
  it.each([
    ['<p><strong>她微笑。后文</strong>段尾。</p>', '她微笑。后文段尾。'],
    ['[她微笑。后文](https://example.com)', '她微笑。后文'],
    ['~~她微笑。后文~~', '她微笑。后文'],
    ['<div><content>她微笑。后文</content></div>', '她微笑。后文'],
  ])('keeps partial selection prompts unchanged and inserts outside %s', (formatted, visible) => {
    const existing = '<bbi_image>old prompt<size>portrait</size></bbi_image>';
    const source = `<content>${formatted}\n${existing}\n下一段。</content>`;
    const selected = '她微笑。';
    const anchor = locateSelectionSourceEnd(source, visible + '下一段。', '', selected);
    expect(anchor).toEqual({ offset: '<content>'.length + formatted.length });
    expect(prepareSelectionImageText(selected, []).segments.map(segment => segment.text).join('')).toBe(selected);
    const image = { tag: '1girl', nl: 'A woman smiles.', negative: '', size: 'portrait' as const, characters: [] };
    const inserted = insertSelectionImage(source, source, image, anchor.offset)!;
    expect(inserted.seq).toBe(0);
    expect(inserted.text).toContain(`${formatted}\n<bbi_image>1girl`);
    expect(inserted.text).toContain(existing);
    expect(inserted.text.replace(/\n<bbi_image>1girl[\s\S]*?<\/bbi_image>/, '')).toBe(source);
  });
  it('does not invent a closing boundary for malformed HTML', () => {
    for (const source of ['<p>她微笑。后文', '<div><p>她微笑。后文</div>']) {
      expect(locateSelectionSourceEnd(source, '她微笑。后文', '', '她微笑。').reason).toContain('未闭合');
    }
  });
  it('locates the selected occurrence of repeated text, including a partial sentence', () => {
    const source = '她回头。\n她回头。继续走。';
    expect(locateSelectionSourceEnd(source, '她回头。她回头。继续走。', '她回头。', '她回头。')).toEqual({ offset: 9 });
    expect(locateSelectionSourceEnd(source, '她回头。她回头。继续走。', '', '她回')).toEqual({ offset: 2 });
  });
  it('ignores existing image prompts and preserves the raw insertion coordinate', () => {
    const source = '前段。\n<bbi_image>前段。 secret</bbi_image>\n后段。剩余。';
    expect(locateSelectionSourceEnd(source, '前段。后段。剩余。', '前段。', '后段。')).toEqual({ offset: source.indexOf('后段。') + 3 });
  });
  it('maps Markdown formatting, links, headings and entities without inserting inside closing syntax', () => {
    for (const [source, visible, expected] of [
      ['**她微笑。**后文', '她微笑。后文', '**她微笑。**'.length],
      ['*她微笑。*后文', '她微笑。后文', '*她微笑。*'.length],
      ['[她微笑。](https://example.com)后文', '她微笑。后文', '[她微笑。](https://example.com)'.length],
      ['## 她微笑。\n后文', '她微笑。后文', '## 她微笑。'.length],
      ['<p>她微笑。</p><p>后文</p>', '她微笑。后文', '<p>她微笑。</p>'.length],
    ] as const) expect(locateSelectionSourceEnd(source, visible, '', '她微笑。')).toEqual({ offset: expected });
    expect(locateSelectionSourceEnd('A &amp; B&#x1f600;后文', 'A & B😀后文', '', 'A & B😀')).toEqual({ offset: 'A &amp; B&#x1f600;'.length });
  });
  it('advances partial selections to the closing format boundary', () => {
    expect(locateSelectionSourceEnd('**她微笑。后文**', '她微笑。后文', '', '她微笑。')).toEqual({ offset: '**她微笑。后文**'.length });
    expect(locateSelectionSourceEnd('<p>她微笑。后文</p>', '她微笑。后文', '', '她微笑。')).toEqual({ offset: '<p>她微笑。后文</p>'.length });
  });
  it('requires the whole visible message to agree, refusing regex rewrites and ambiguous omitted copies', () => {
    expect(locateSelectionSourceEnd('她回头。她回头。', '她回头。', '', '她回头。').reason).toBeTruthy();
    expect(locateSelectionSourceEnd('原文。她回头。', '改写。她回头。', '改写。', '她回头。').reason).toBeTruthy();
    expect(locateSelectionSourceEnd('她回头。', '新增她回头。', '新增', '她回头。').reason).toBeTruthy();
  });
  it('excludes hidden blocks, comments and code when the DOM excludes the same content', () => {
    const source = '<think>她回头。</think><!--注释-->正文。\n`代码`\n<private>秘密</private>后文';
    expect(locateSelectionSourceEnd(source, '正文。后文', '', '正文。', ['private'])).toEqual({ offset: source.indexOf('正文。') + 3 });
  });
  it('finishes enclosing HTML layouts but still rejects unmappable tables and text', () => {
    expect(locateSelectionSourceEnd('<div><p>正文。</p><p>后文</p></div>', '正文。后文', '', '正文。')).toEqual({ offset: '<div><p>正文。</p><p>后文</p></div>'.length });
    expect(locateSelectionSourceEnd('|正文|\n|---|\n|内容|', '正文内容', '', '正文').reason).toBeTruthy();
    expect(locateSelectionSourceEnd('正文。后文', '正文。后文', '正文', '错误').reason).toBeTruthy();
  });
  it('does not move an anchor across whitespace and subsequent narrative', () => {
    expect(locateSelectionSourceEnd('正文。\r\n\r\n后文', '正文。后文', '', '正文。')).toEqual({ offset: 3 });
  });
  it('rejects partial headings and single list items without moving the insertion point', () => {
    for (const prefix of ['## ', '- ', '1. ']) {
      const source = `${prefix}她微笑。后文`;
      expect(locateSelectionSourceEnd(source, '她微笑。后文', '', '她微笑。').reason).toContain('格式块末尾');
      expect(locateSelectionSourceEnd(source, '她微笑。后文', '', '她微笑。后文')).toEqual({ offset: source.length });
    }
  });
  it('allows the end of a complete quote but rejects partial and lazy continuation boundaries', () => {
    for (const continuation of ['> 然后转身。', '然后转身。']) {
      const quote = `> 她微笑。\n${continuation}`;
      const source = `${quote}\n\n后文`;
      expect(locateSelectionSourceEnd(source, '她微笑。然后转身。后文', '', '她微笑。').reason).toContain('格式块末尾');
      expect(locateSelectionSourceEnd(source, '她微笑。然后转身。后文', '', '她微笑。然后转身。')).toEqual({ offset: quote.length });
    }
  });
  it('rejects multiline, loose and continued lists without splitting or renumbering the list', () => {
    for (const list of ['1. 前段。\n2. 后段。', '- 前段。\n\n- 后段。', '- 前段。\n  后段。']) {
      const source = `${list}\n\n普通正文。`;
      expect(locateSelectionSourceEnd(source, '前段。后段。普通正文。', '', '前段。').reason).toContain('多行列表');
      expect(locateSelectionSourceEnd(source, '前段。后段。普通正文。', '', '前段。后段。').reason).toContain('多行列表');
      expect(locateSelectionSourceEnd(source, '前段。后段。普通正文。', '前段。后段。', '普通正文。')).toEqual({ offset: source.length });
    }
  });
  it('matches the installed BaiBai Book time hiding syntax only when the displayed message agrees', () => {
    const source = '<bbs_start>2026-09-16 08:00</bbs_start>\n正文。\n<bbs_end>2026-09-16 08:01</bbs_end>';
    expect(locateSelectionSourceEnd(source, '正文。', '', '正文。')).toEqual({ offset: source.indexOf('正文。') + 3 });
    expect(locateSelectionSourceEnd(source, '2026-09-16 08:00正文。2026-09-16 08:01', '2026-09-16 08:00', '正文。').reason).toBeTruthy();
    const multiline = '<bbs_start>仍可见\n的时间</bbs_start>正文。';
    expect(locateSelectionSourceEnd(multiline, '仍可见的时间正文。', '仍可见的时间', '正文。')).toEqual({ offset: multiline.length });
  });

  it('anchors an unchanged complete paragraph between independently rewritten panels', () => {
    const paragraph = '她坐在窗边，左手扶着书页，抬眼望向门口。午后的阳光落在她的黑发上。';
    const selected = '左手扶着书页，抬眼望向门口。';
    const prefix = '她坐在窗边，';
    const source = `<think>内部记录</think>\n${paragraph}\n<UpdateVariable>内部数据</UpdateVariable>`;
    const visible = `查看思考过程${paragraph}查看变量面板`;
    expect(locateSelectionSourceEnd(source, visible, `查看思考过程${prefix}`, selected, [], [
      { text: paragraph, beforeSelection: prefix },
    ])).toEqual({ offset: source.indexOf(selected) + selected.length });
  });

  it('uses unique paragraph context to locate the second repeated sentence', () => {
    const first = '她回头。晨光透过窗户，书桌上的信纸被照得明亮，她放下手中的书。';
    const second = '她回头。傍晚的风吹动窗帘，桌上摆着未读的信件，她走向房门。';
    const source = `${first}\n\n${second}`;
    const visible = `显示状态${first}${second}显示代码块`;
    expect(locateSelectionSourceEnd(source, visible, `显示状态${first}`, '她回头。', [], [
      { text: second, beforeSelection: '' },
    ])).toEqual({ offset: source.lastIndexOf('她回头。') + 4 });
  });

  it('rejects duplicated or overlapping whole contexts on either side', () => {
    const paragraph = '她坐在窗边，左手扶着书页，抬眼望向门口。午后的阳光落在她的黑发上。';
    const context = [{ text: paragraph, beforeSelection: '' }];
    expect(locateSelectionSourceEnd(`${paragraph}${paragraph}`, `面板${paragraph}`, '面板', '她坐', [], context).reason).toBeTruthy();
    expect(locateSelectionSourceEnd(paragraph, `面板${paragraph}${paragraph}`, '面板', '她坐', [], context).reason).toBeTruthy();
    expect(locateSelectionSourceEnd('a'.repeat(25), `面板${'a'.repeat(24)}`, '面板', 'a', [], [
      { text: 'a'.repeat(24), beforeSelection: '' },
    ]).reason).toBeTruthy();
  });

  it('requires exact selected paragraph text and exact DOM-relative context position', () => {
    const paragraph = '她坐在窗边，左手扶着书页，抬眼望向门口。午后的阳光落在她的黑发上。';
    const changed = paragraph.replace('黑发', '金发');
    expect(locateSelectionSourceEnd(paragraph, `面板${changed}`, '面板', '她坐', [], [
      { text: changed, beforeSelection: '' },
    ]).reason).toBeTruthy();
    expect(locateSelectionSourceEnd(paragraph, `面板${paragraph}`, '面板', '她坐', [], [
      { text: paragraph, beforeSelection: '她坐' },
    ]).reason).toBeTruthy();
  });

  it('allows a short repeated sentence only with enough unique surrounding paragraph context', () => {
    const source = '她回头。\n\n窗外传来熟悉的脚步声，木门轻响，走廊里亮起一盏温暖的灯。\n\n她回头。';
    const context = source.slice(source.indexOf('窗外'));
    const prefix = '窗外传来熟悉的脚步声，木门轻响，走廊里亮起一盏温暖的灯。';
    expect(locateSelectionSourceEnd(source, `面板${source}`, `面板她回头。${prefix}`, '她回头。', [], [
      { text: '她回头。', beforeSelection: '' },
      { text: context, beforeSelection: prefix },
    ])).toEqual({ offset: source.length });
  });

  it('retains formatting boundaries after finding a local context', () => {
    const paragraph = '她坐在窗边，左手扶着书页，抬眼望向门口。午后的阳光落在她的黑发上。';
    expect(locateSelectionSourceEnd(`**${paragraph}**`, `面板${paragraph}`, '面板', '她坐', [], [
      { text: paragraph, beforeSelection: '' },
    ])).toEqual({ offset: paragraph.length + 4 });
  });

  it('inserts inside a rolecard narrative section while preserving its delimiters', () => {
    const paragraph = '她坐在窗边，左手扶着书页，抬眼望向门口。午后的阳光落在她的黑发上。';
    const source = `<thinking>内部记录</thinking>\n<content>\n${paragraph}\n后续正文。\n</content>`;
    expect(locateSelectionSourceEnd(source, `思考面板${paragraph}后续正文。`, '思考面板', paragraph, [], [
      { text: paragraph, beforeSelection: '' },
    ])).toEqual({ offset: source.indexOf(paragraph) + paragraph.length });
    const last = `<content>${paragraph}</content>`;
    expect(locateSelectionSourceEnd(last, paragraph, '', paragraph)).toEqual({ offset: last.indexOf('</content>') });
    expect(locateSelectionSourceEnd(`<content style="display:grid">${paragraph}</content>`, paragraph, '', '她坐')).toEqual({ offset: ('<content style="display:grid">' + paragraph + '</content>').length });
  });
});
