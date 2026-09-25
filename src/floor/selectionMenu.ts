import { captureSelectionImageSnapshot, requestSelectionImage } from '@/autoTag/runner';
import type { SelectionImageSnapshot } from '@/autoTag/selection';
import { locateSelectionSourceEnd, type SelectionAnchorContext } from '@/floor/selectionAnchor';
import { settings } from '@/state/settings';

const HOST_ID = 'bbi-selection-menu-host';
const TEXT_SELECTOR = '#chat .mes[mesid] .mes_text';
const EXCLUDED_SELECTOR = [
  'input', 'textarea', 'select', 'button', 'iframe', 'object', 'embed', 'img', 'video', 'audio',
  'script', 'style', 'pre', 'code', 'table', '[hidden]', '[aria-hidden="true"]',
  '[contenteditable]:not([contenteditable="false"])', '[data-bbi-slot]',
  '[id^="bbi-"]', '[class^="bbi-"]', '[class*=" bbi-"]', '[role="dialog"]', '[role="menu"]',
  '.TH-render', '.TH-collapse-code-block-button',
].join(',');

export interface SelectionImageMenuActions {
  captureSnapshot: (floor: number) => SelectionImageSnapshot | null;
  requestImage: (floor: number, selectedText: string, snapshot: SelectionImageSnapshot) => Promise<void>;
}

interface SelectedMessage {
  floor: number;
  text: string;
  messageText: HTMLElement;
  range: Range;
  rangeText: string;
  snapshot: SelectionImageSnapshot;
  anchorError?: string;
}

const MENU_CSS = `
:host { all: initial; position: fixed; z-index: 10020; display: block; }
.menu { box-sizing: border-box; width: min(310px, calc(100vw - 16px)); padding: 7px;
  border: 1px solid var(--bbi-line-strong, #d6d4d0); border-radius: 10px;
  background: var(--bbi-surface, #fff); color: var(--bbi-ink, #14213d);
  box-shadow: 0 8px 32px #0003; font: 13px/1.5 var(--bbi-font-sans, system-ui, sans-serif);
  text-align: left; text-shadow: none; letter-spacing: normal; direction: ltr; }
button { box-sizing: border-box; width: 100%; padding: 9px 10px; border: 0; border-radius: 6px;
  color: inherit; background: transparent; font: inherit; text-align: left; cursor: pointer; }
button:hover, button:focus-visible { background: var(--bbi-accent-soft, #ac630419); }
button[aria-disabled="true"] { opacity: .55; cursor: default; }
button:focus-visible { outline: 2px solid var(--bbi-accent, #ac6304); outline-offset: -2px; }
.hint, .preview { display: block; margin: 0; padding: 0 10px 7px;
  color: var(--bbi-ink-soft, #4d586f); font-size: 12px; overflow-wrap: anywhere; }
.preview { border-top: 1px solid var(--bbi-line, #e2e1de); padding-top: 7px;
  max-height: 4.5em; overflow: hidden; white-space: pre-wrap; }
`;

let currentCleanup: (() => void) | null = null;

function elementOf(node: EventTarget | Node | null): Element | null {
  return node instanceof Element ? node : node instanceof Node ? node.parentElement : null;
}

function isExcluded(element: Element | null): boolean {
  return !element || !!element.closest(EXCLUDED_SELECTOR);
}

function isVisible(element: Element): boolean {
  for (let parent: Element | null = element; parent; parent = parent.parentElement) {
    if (parent instanceof HTMLDetailsElement && !parent.open) {
      const summary = parent.querySelector(':scope > summary');
      if (!summary || !summary.contains(element)) return false;
    }
    const style = window.getComputedStyle(parent);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.contentVisibility === 'hidden') return false;
  }
  return true;
}

/** A browser may end a paragraph selection at the next card's offset 0, without selecting the card. */
function normalizeRangeEnd(range: Range, messageText: HTMLElement): void {
  while (range.endOffset === 0 && range.endContainer !== messageText) {
    const boundary = range.endContainer;
    if (!boundary.parentNode || !messageText.contains(boundary.parentNode)) break;
    // Moving an empty leading boundary outside its node preserves the covered content. Stop as soon
    // as the parent has preceding children, so any actually selected card/image content stays covered.
    range.setEndBefore(boundary);
  }
}

/** Count only the same visible narrative nodes used to validate the selection. */
function visibleSelectionText(messageText: HTMLElement, range: Range): { all: string; before: string; selected: string } {
  const prefix = document.createRange();
  prefix.selectNodeContents(messageText);
  prefix.setEnd(range.startContainer, range.startOffset);
  const through = document.createRange();
  through.selectNodeContents(messageText);
  through.setEnd(range.endContainer, range.endOffset);
  const take = (boundary: Range, node: Text) => boundary.endContainer === node
    ? node.data.slice(0, boundary.endOffset)
    : boundary.comparePoint(node, node.length) <= 0 ? node.data : '';
  let all = '', before = '', throughText = '';
  const walker = document.createTreeWalker(messageText, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (isExcluded(node.parentElement) || !isVisible(node.parentElement!)) continue;
    all += node.textContent ?? '';
    before += take(prefix, node as Text);
    throughText += take(through, node as Text);
  }
  return { all, before, selected: throughText.slice(before.length) };
}

/** Adjacent complete paragraphs provide an exact local anchor when other panels are rewritten. */
function paragraphContexts(messageText: HTMLElement, range: Range, beforeText: string): SelectionAnchorContext[] {
  const blockOf = (node: Node) => elementOf(node)?.closest('p') as HTMLElement | null;
  let first = blockOf(range.startContainer), last = blockOf(range.endContainer);
  // Normalizing a paragraph-end selection can put its end on the parent, just after the p.
  if (!last && range.endContainer instanceof Element && range.endOffset > 0) {
    const previous = range.endContainer.childNodes[range.endOffset - 1];
    if (previous instanceof HTMLElement && previous.matches('p')) last = previous;
  }
  if (!first || !last || !messageText.contains(first) || !messageText.contains(last)) return [];
  const contexts: SelectionAnchorContext[] = [];
  const eligible = (node: Element | null): node is HTMLElement => !!node && node.matches('p') &&
    !isExcluded(node) && isVisible(node) && !node.querySelector(EXCLUDED_SELECTOR);
  const addContext = (start: HTMLElement, end: HTMLElement) => {
    const surrounding = document.createRange();
    surrounding.setStartBefore(start);
    surrounding.setEndAfter(end);
    if ([...messageText.querySelectorAll(EXCLUDED_SELECTOR)].some(node => surrounding.intersectsNode(node))) return;
    const context = visibleSelectionText(messageText, surrounding);
    if (context.selected.length > 8_000 || !beforeText.startsWith(context.before)) return;
    if (contexts.some(candidate => candidate.text === context.selected && candidate.beforeSelection === beforeText.slice(context.before.length))) return;
    contexts.push({ text: context.selected, beforeSelection: beforeText.slice(context.before.length) });
  };
  addContext(first, last);
  for (let expansion = 0; expansion < 2; expansion++) {
    // Only immediate sibling paragraphs may extend the context. Never jump across a panel.
    const previous: Element | null = first.previousElementSibling;
    const next: Element | null = last.nextElementSibling;
    // An adjacent paragraph may itself be rewritten: try either side before combining them.
    if (eligible(previous)) addContext(previous, last);
    if (eligible(next)) addContext(first, next);
    let expanded = false;
    if (eligible(previous)) { first = previous; expanded = true; }
    if (eligible(next)) { last = next; expanded = true; }
    if (!expanded) break;
    addContext(first, last);
  }
  return contexts;
}

/** Only a single visible light-DOM message is eligible; UI and hidden text never enter the request. */
function readSelectedMessage(actions: SelectionImageMenuActions): SelectedMessage | null {
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
  const text = selection.toString().trim();
  if (!text) return null;
  const range = selection.getRangeAt(0).cloneRange();
  if (range.startContainer.getRootNode() !== document || range.endContainer.getRootNode() !== document) return null;
  const start = elementOf(range.startContainer);
  const originalEnd = elementOf(range.endContainer);
  if (isExcluded(start)) return null;
  const messageText = start?.closest<HTMLElement>(TEXT_SELECTOR);
  if (!messageText || !messageText.isConnected) return null;
  if (originalEnd?.closest(TEXT_SELECTOR) !== messageText) {
    // Triple-clicking a message's final paragraph may end at the next message's offset 0.
    // Only trim an empty boundary tail; any selected text or media outside this message rejects it.
    if (range.endOffset !== 0) return null;
    const messageEnd = range.cloneRange();
    messageEnd.selectNodeContents(messageText);
    messageEnd.collapse(false);
    if (range.compareBoundaryPoints(Range.END_TO_END, messageEnd) < 0) return null;
    const tail = range.cloneRange();
    tail.setStart(messageText, messageText.childNodes.length);
    if (tail.toString().trim() || tail.cloneContents().querySelector(EXCLUDED_SELECTOR)) return null;
    range.setEnd(messageText, messageText.childNodes.length);
  }
  normalizeRangeEnd(range, messageText);
  if (isExcluded(elementOf(range.endContainer))) return null;
  if (!isVisible(messageText) || !range.getClientRects().length) return null;

  // Reject a range spanning an image card/editor even if both endpoints are ordinary text.
  for (const excluded of messageText.querySelectorAll(EXCLUDED_SELECTOR)) {
    if (range.intersectsNode(excluded)) return null;
  }
  const visibility = new Map<Element, boolean>();
  const walker = document.createTreeWalker(messageText, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent?.trim() || !range.intersectsNode(node)) continue;
    const parent = node.parentElement;
    if (!parent) return null;
    let visible = visibility.get(parent);
    if (visible === undefined) {
      visible = isVisible(parent);
      visibility.set(parent, visible);
    }
    if (!visible) return null;
  }
  const floorValue = messageText.closest('.mes[mesid]')?.getAttribute('mesid');
  if (!floorValue || !/^\d+$/.test(floorValue)) return null;
  const floor = Number(floorValue);
  if (!Number.isSafeInteger(floor)) return null;
  const snapshot = actions.captureSnapshot(floor);
  if (!snapshot) return null;
  const visible = visibleSelectionText(messageText, range);
  const anchor = locateSelectionSourceEnd(snapshot.source, visible.all, visible.before, visible.selected,
    settings.excludes.customStripTags, paragraphContexts(messageText, range, visible.before));
  return {
    floor, text, messageText, range, rangeText: range.toString(),
    snapshot: { ...snapshot, insertionOffset: anchor.offset }, anchorError: anchor.reason,
  };
}

function pointInRange(range: Range, x: number, y: number): boolean {
  return [...range.getClientRects()].some(rect => x >= rect.left - 2 && x <= rect.right + 2 && y >= rect.top - 2 && y <= rect.bottom + 2);
}

function matchesKeyboardFocus(selected: SelectedMessage): boolean {
  const active = document.activeElement;
  return !active || active === document.body || active === document.documentElement ||
    (!isExcluded(active) && active.closest(TEXT_SELECTOR) === selected.messageText);
}

function matchesEvent(selected: SelectedMessage, event: MouseEvent, keyboard = false): boolean {
  const target = elementOf(event.target);
  if (!selected.messageText.isConnected || selected.range.toString() !== selected.rangeText) return false;
  if (event.composedPath().some(node => node instanceof Element && isExcluded(node))) return false;
  if (keyboard) return matchesKeyboardFocus(selected);
  return !!target && target.closest(TEXT_SELECTOR) === selected.messageText && pointInRange(selected.range, event.clientX, event.clientY);
}

function copyTheme(host: HTMLElement): void {
  const root = document.getElementById('bbi-app-host')?.shadowRoot?.querySelector('.bbi-root');
  if (!root) return;
  const style = window.getComputedStyle(root);
  for (const name of ['font-sans', 'surface', 'ink', 'ink-soft', 'line', 'line-strong', 'accent', 'accent-soft']) {
    const variable = `--bbi-${name}`;
    const value = style.getPropertyValue(variable);
    if (value.trim()) host.style.setProperty(variable, value);
  }
}

/** Idempotent binding. Optional actions let the development preview exercise the menu without model calls. */
export function bindSelectionImageMenu(actions: SelectionImageMenuActions = {
  captureSnapshot: captureSelectionImageSnapshot,
  requestImage: requestSelectionImage,
}): () => void {
  if (currentCleanup) return currentCleanup;
  let menu: HTMLElement | null = null;
  let previousFocus: HTMLElement | null = null;
  let prepared: { selected: SelectedMessage; at: number } | null = null;
  let keyboardContextMenuUntil = 0;
  let disposed = false;

  const closeMenu = (restoreFocus = false) => {
    const focusWasInside = !!menu && document.activeElement === menu;
    menu?.remove();
    menu = null;
    prepared = null;
    keyboardContextMenuUntil = 0;
    if (restoreFocus && focusWasInside && previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    previousFocus = null;
  };

  const showMenu = (selected: SelectedMessage, event: Pick<MouseEvent, 'clientX' | 'clientY'>, keyboard: boolean) => {
    closeMenu();
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const host = document.createElement('div');
    host.id = HOST_ID;
    copyTheme(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = MENU_CSS;
    const panel = document.createElement('div');
    panel.className = 'menu';
    panel.setAttribute('role', 'menu');
    panel.setAttribute('aria-label', '选中文字生图');
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'menuitem');
    button.textContent = '用选中文字生图（1张）';
    const hint = document.createElement('span');
    hint.id = 'selection-image-hint';
    hint.className = 'hint';
    hint.textContent = selected.anchorError ?? '图片插在选区后的安全位置，必要时顺延到格式末尾；后文保留';
    if (selected.anchorError) button.setAttribute('aria-disabled', 'true');
    const preview = document.createElement('span');
    preview.className = 'preview';
    const previewText = selected.text.replace(/\s+/g, ' ');
    preview.textContent = previewText.length > 110 ? `${previewText.slice(0, 110)}…` : previewText;
    button.setAttribute('aria-describedby', hint.id);
    panel.append(button, hint, preview);
    shadow.append(style, panel);
    document.body.appendChild(host);
    menu = host;

    const rect = selected.range.getBoundingClientRect();
    const x = keyboard ? rect.left : event.clientX;
    const y = keyboard ? rect.bottom : event.clientY;
    const bounds = host.getBoundingClientRect();
    host.style.left = `${Math.max(8, Math.min(x, window.innerWidth - bounds.width - 8))}px`;
    host.style.top = `${Math.max(8, Math.min(y, window.innerHeight - bounds.height - 8))}px`;
    button.focus({ preventScroll: true });
    button.addEventListener('click', () => {
      if (disposed || menu !== host) return;
      closeMenu();
      if (selected.anchorError) {
        toastr.warning(selected.anchorError, '柏宝绘');
        return;
      }
      // Preserve the context-menu snapshot; runner verifies identity again before writing.
      void actions.requestImage(selected.floor, selected.text, selected.snapshot).catch(error => {
        console.error('[柏宝绘] 选中文字生图失败', error);
        toastr.error(error instanceof Error ? error.message : '选中文字生图失败,请重试', '柏宝绘');
      });
    });
  };

  const onMouseDown = (event: MouseEvent) => {
    if (menu && event.composedPath().includes(menu)) return;
    closeMenu();
    if (event.button !== 2) return;
    const selected = readSelectedMessage(actions);
    if (selected && matchesEvent(selected, event)) prepared = { selected, at: Date.now() };
  };

  const onContextMenu = (event: MouseEvent) => {
    // Some browsers still emit contextmenu after the explicit keyboard shortcut moved focus into our menu.
    if (menu && Date.now() < keyboardContextMenuUntil) {
      keyboardContextMenuUntil = 0;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const keyboard = event.button !== 2 && event.clientX === 0 && event.clientY === 0;
    let selected = readSelectedMessage(actions);
    const liveSelection = document.getSelection();
    const selectionWasCleared = !liveSelection || liveSelection.isCollapsed || liveSelection.rangeCount === 0;
    // The short-lived fallback only repairs a cleared selection, never an invalid/cross-message selection.
    if (!selected && selectionWasCleared && !keyboard && prepared && Date.now() - prepared.at < 1500) selected = prepared.selected;
    if (!selected || !matchesEvent(selected, event, keyboard)) {
      closeMenu();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    showMenu(selected, event, keyboard);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      if (menu && document.activeElement === menu) {
        event.preventDefault();
        event.stopPropagation();
        keyboardContextMenuUntil = Date.now() + 1000;
        menu.shadowRoot?.querySelector('button')?.focus();
        return;
      }
      const selected = readSelectedMessage(actions);
      if (!selected || !matchesKeyboardFocus(selected)) return;
      event.preventDefault();
      event.stopPropagation();
      showMenu(selected, { clientX: 0, clientY: 0 }, true);
      keyboardContextMenuUntil = Date.now() + 1000;
      return;
    }
    if (!menu) return;
    if (event.key === 'Escape' || event.key === 'Tab') {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
      }
      closeMenu(true);
    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      menu.shadowRoot?.querySelector('button')?.focus();
    }
  };
  const onDismiss = () => closeMenu();
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    closeMenu();
    document.removeEventListener('mousedown', onMouseDown, true);
    document.removeEventListener('contextmenu', onContextMenu, true);
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('scroll', onDismiss, true);
    window.removeEventListener('blur', onDismiss);
    window.removeEventListener('resize', onDismiss);
    window.removeEventListener('pagehide', cleanup);
    if (currentCleanup === cleanup) currentCleanup = null;
  };
  document.addEventListener('mousedown', onMouseDown, true);
  document.addEventListener('contextmenu', onContextMenu, true);
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('scroll', onDismiss, true);
  window.addEventListener('blur', onDismiss);
  window.addEventListener('resize', onDismiss);
  window.addEventListener('pagehide', cleanup);
  currentCleanup = cleanup;
  return cleanup;
}
