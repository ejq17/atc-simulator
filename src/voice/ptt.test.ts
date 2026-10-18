// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPushToTalk } from './ptt.ts';
import type { PushToTalk } from './ptt.ts';

function key(type: 'keydown' | 'keyup', code: string, init: KeyboardEventInit = {}, target: EventTarget = window) {
  const e = new KeyboardEvent(type, { code, key: code === 'Space' ? ' ' : code, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
}

describe('push-to-talk', () => {
  let ptt: PushToTalk;
  const onStart = vi.fn();
  const onEnd = vi.fn();

  beforeEach(() => {
    onStart.mockClear();
    onEnd.mockClear();
  });
  afterEach(() => {
    ptt?.destroy();
    document.body.innerHTML = '';
  });

  it('hold mode: transmits while key is down', () => {
    ptt = createPushToTalk({ key: 'Space', mode: 'hold', onStart, onEnd, debounceMs: 0 });
    const down = key('keydown', 'Space');
    expect(down.defaultPrevented).toBe(true);
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(ptt.isTransmitting()).toBe(true);
    key('keydown', 'Space', { repeat: true });
    expect(onStart).toHaveBeenCalledTimes(1);
    key('keyup', 'Space');
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(ptt.isTransmitting()).toBe(false);
  });

  it('toggle mode: press starts, next press ends, release ignored', () => {
    ptt = createPushToTalk({ key: 'KeyT', mode: 'toggle', onStart, onEnd, debounceMs: 0 });
    key('keydown', 'KeyT');
    key('keyup', 'KeyT');
    expect(ptt.isTransmitting()).toBe(true);
    expect(onEnd).not.toHaveBeenCalled();
    key('keydown', 'KeyT');
    key('keyup', 'KeyT');
    expect(ptt.isTransmitting()).toBe(false);
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('ignores other keys', () => {
    ptt = createPushToTalk({ key: 'Space', mode: 'hold', onStart, onEnd, debounceMs: 0 });
    key('keydown', 'KeyA');
    expect(onStart).not.toHaveBeenCalled();
  });

  it('ignores typing in inputs but not function keys', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    ptt = createPushToTalk({ key: 'Space', mode: 'hold', onStart, onEnd, debounceMs: 0 });
    const e = key('keydown', 'Space', {}, input);
    expect(e.defaultPrevented).toBe(false);
    expect(onStart).not.toHaveBeenCalled();
    ptt.destroy();

    ptt = createPushToTalk({ key: 'F2', mode: 'hold', onStart, onEnd, debounceMs: 0 });
    key('keydown', 'F2', {}, input);
    expect(onStart).toHaveBeenCalledTimes(1);
    key('keyup', 'F2', {}, input);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('ignores textarea and contenteditable', () => {
    const ta = document.createElement('textarea');
    const div = document.createElement('div');
    div.setAttribute('contenteditable', 'true');
    document.body.append(ta, div);
    ptt = createPushToTalk({ key: 'Space', mode: 'hold', onStart, onEnd, debounceMs: 0 });
    key('keydown', 'Space', {}, ta);
    key('keydown', 'Space', {}, div);
    expect(onStart).not.toHaveBeenCalled();
  });

  it('supports changing the key at runtime and ends an active hold', () => {
    ptt = createPushToTalk({ key: 'Space', mode: 'hold', onStart, onEnd, debounceMs: 0 });
    key('keydown', 'Space');
    ptt.setKey('KeyV');
    expect(onEnd).toHaveBeenCalledTimes(1);
    key('keydown', 'Space');
    expect(onStart).toHaveBeenCalledTimes(1);
    key('keydown', 'KeyV');
    expect(onStart).toHaveBeenCalledTimes(2);
    expect(ptt.getKey()).toBe('KeyV');
  });

  it('debounces key chatter on start but never drops an end', () => {
    vi.useFakeTimers();
    try {
      ptt = createPushToTalk({ key: 'Space', mode: 'hold', onStart, onEnd, debounceMs: 50 });
      vi.setSystemTime(1000);
      key('keydown', 'Space');
      key('keyup', 'Space');
      key('keydown', 'Space'); // 0 ms later: chatter
      expect(onStart).toHaveBeenCalledTimes(1);
      expect(onEnd).toHaveBeenCalledTimes(1);
      vi.setSystemTime(1100);
      key('keydown', 'Space');
      expect(onStart).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ends a hold when the window loses focus', () => {
    ptt = createPushToTalk({ key: 'Space', mode: 'hold', onStart, onEnd, debounceMs: 0 });
    key('keydown', 'Space');
    window.dispatchEvent(new Event('blur'));
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('bindButton: pointer down/up in hold mode', () => {
    ptt = createPushToTalk({ key: 'Space', mode: 'hold', onStart, onEnd, debounceMs: 0 });
    const btn = document.createElement('button');
    const unbind = ptt.bindButton(btn);
    btn.dispatchEvent(new Event('pointerdown', { cancelable: true }));
    expect(ptt.isTransmitting()).toBe(true);
    btn.dispatchEvent(new Event('pointerup'));
    expect(ptt.isTransmitting()).toBe(false);
    unbind();
    btn.dispatchEvent(new Event('pointerdown'));
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it('bindButton: toggle mode', () => {
    ptt = createPushToTalk({ key: 'Space', mode: 'toggle', onStart, onEnd, debounceMs: 0 });
    const btn = document.createElement('button');
    ptt.bindButton(btn);
    btn.dispatchEvent(new Event('pointerdown'));
    btn.dispatchEvent(new Event('pointerup'));
    expect(ptt.isTransmitting()).toBe(true);
    btn.dispatchEvent(new Event('pointerdown'));
    expect(ptt.isTransmitting()).toBe(false);
  });

  it('attachTarget: the same key works on a pop-out window, and detaching stops it', () => {
    ptt = createPushToTalk({ key: 'Space', mode: 'hold', onStart, onEnd, debounceMs: 0 });
    const popup = new EventTarget();
    const detach = ptt.attachTarget(popup);
    key('keydown', 'Space', {}, popup);
    expect(onStart).toHaveBeenCalledTimes(1);
    key('keyup', 'Space', {}, popup);
    expect(onEnd).toHaveBeenCalledTimes(1);
    detach();
    key('keydown', 'Space', {}, popup);
    expect(onStart).toHaveBeenCalledTimes(1);
    // the main window still works, and destroy() detaches every target
    key('keydown', 'Space');
    expect(onStart).toHaveBeenCalledTimes(2);
    key('keyup', 'Space');
    const again = ptt.attachTarget(popup);
    ptt.destroy();
    key('keydown', 'Space', {}, popup);
    expect(onStart).toHaveBeenCalledTimes(2);
    again();
  });
});
