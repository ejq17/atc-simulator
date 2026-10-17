/**
 * Configurable push-to-talk.
 *
 * - `hold`: transmit while the key (or bound button) is down.
 * - `toggle`: first press starts, next press ends.
 * - Key events are ignored while typing in inputs/textareas/selects/contenteditable,
 *   unless the key is a function key (F1..F24).
 * - `debounceMs` suppresses accidental *starts* (key chatter). Ends are never dropped.
 */

export type PttMode = 'hold' | 'toggle';

export interface PushToTalkOptions {
  /** `KeyboardEvent.code` (e.g. 'Space', 'KeyT', 'F2') or `KeyboardEvent.key`. */
  key: string;
  mode: PttMode;
  onStart: () => void;
  onEnd: () => void;
  debounceMs?: number;
  /** Where key events are listened for. Defaults to `window`. */
  target?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
  now?: () => number;
}

export interface PushToTalk {
  isTransmitting(): boolean;
  getKey(): string;
  getMode(): PttMode;
  setKey(key: string): void;
  setMode(mode: PttMode): void;
  /** Programmatic press/release (used by on-screen buttons and tests). */
  press(): void;
  release(): void;
  /** Bind pointer (mouse/touch/pen) events on an element. Returns an unbind function. */
  bindButton(el: HTMLElement): () => void;
  destroy(): void;
}

const FUNCTION_KEY = /^F([1-9]|1\d|2[0-4])$/;

export function isFunctionKey(key: string): boolean {
  return FUNCTION_KEY.test(key);
}

function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el !== 'object' || !('tagName' in el)) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return el.isContentEditable === true || el.getAttribute?.('contenteditable') === 'true';
}

function keyMatches(configured: string, e: KeyboardEvent): boolean {
  if (e.code === configured) return true;
  if (e.key === configured) return true;
  if (configured === 'Space' && e.key === ' ') return true;
  return false;
}

export function createPushToTalk(options: PushToTalkOptions): PushToTalk {
  let key = options.key;
  let mode = options.mode;
  const debounceMs = options.debounceMs ?? 25;
  const now = options.now ?? (() => Date.now());
  const target = options.target ?? (typeof window !== 'undefined' ? window : undefined);

  let transmitting = false;
  let lastChange = -Infinity;
  // Key currently physically down for the 'hold' flow (so keyup of other keys is ignored).
  let keyHeld = false;

  function begin() {
    if (transmitting) return;
    if (now() - lastChange < debounceMs) return;
    transmitting = true;
    lastChange = now();
    options.onStart();
  }
  function end() {
    if (!transmitting) return;
    transmitting = false;
    lastChange = now();
    options.onEnd();
  }

  const onKeyDown = (ev: Event) => {
    const e = ev as KeyboardEvent;
    if (!keyMatches(key, e)) return;
    if (isEditable(e.target) && !isFunctionKey(key)) return;
    e.preventDefault();
    if (e.repeat) return;
    keyHeld = true;
    if (mode === 'hold') begin();
    else if (transmitting) end();
    else begin();
  };
  const onKeyUp = (ev: Event) => {
    const e = ev as KeyboardEvent;
    if (!keyMatches(key, e)) return;
    if (isEditable(e.target) && !isFunctionKey(key) && !keyHeld) return;
    e.preventDefault();
    keyHeld = false;
    if (mode === 'hold') end();
  };
  const onBlur = () => {
    keyHeld = false;
    if (mode === 'hold') end();
  };

  target?.addEventListener('keydown', onKeyDown);
  target?.addEventListener('keyup', onKeyUp);
  target?.addEventListener('blur', onBlur);

  const api: PushToTalk = {
    isTransmitting: () => transmitting,
    getKey: () => key,
    getMode: () => mode,
    setKey(next) {
      if (next === key) return;
      if (transmitting && mode === 'hold') end();
      key = next;
      keyHeld = false;
    },
    setMode(next) {
      if (next === mode) return;
      if (transmitting) end();
      mode = next;
    },
    press() {
      if (mode === 'hold') begin();
      else if (transmitting) end();
      else begin();
    },
    release() {
      if (mode === 'hold') end();
    },
    bindButton(el) {
      let pointerId: number | null = null;
      const down = (ev: Event) => {
        const e = ev as PointerEvent;
        e.preventDefault();
        pointerId = e.pointerId ?? 0;
        try {
          el.setPointerCapture?.(pointerId);
        } catch { /* synthetic pointers cannot be captured */ }
        api.press();
      };
      const up = (ev: Event) => {
        const e = ev as PointerEvent;
        if (pointerId === null) return;
        if (e.pointerId !== undefined && pointerId !== e.pointerId) return;
        pointerId = null;
        api.release();
      };
      const ctx = (ev: Event) => ev.preventDefault();
      el.addEventListener('pointerdown', down);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
      el.addEventListener('lostpointercapture', up);
      el.addEventListener('contextmenu', ctx);
      return () => {
        el.removeEventListener('pointerdown', down);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
        el.removeEventListener('lostpointercapture', up);
        el.removeEventListener('contextmenu', ctx);
      };
    },
    destroy() {
      target?.removeEventListener('keydown', onKeyDown);
      target?.removeEventListener('keyup', onKeyUp);
      target?.removeEventListener('blur', onBlur);
      end();
    },
  };
  return api;
}
