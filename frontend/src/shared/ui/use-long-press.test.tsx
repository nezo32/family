import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LONG_PRESS_MS, useLongPress } from './use-long-press';

/**
 * §C-gestures/G5: 450ms, cancelled by movement or by a scroll, and it must not
 * also fire the row's own tap.
 *
 * That last rule is the one worth a test. On a task row the whole surface is a
 * link to a detail screen; a long press that opens a sheet *and* navigates
 * underneath it leaves the user looking at a sheet belonging to a screen they
 * are no longer on.
 */

function Row(props: { onLongPress: () => void; onTap: () => void }) {
  const longPress = useLongPress({ onLongPress: props.onLongPress });
  return (
    <div {...longPress.handlers}>
      <button type="button" onClick={props.onTap}>
        Вынести мусор
      </button>
    </div>
  );
}

function touch(node: Element, type: string, x: number, y: number): void {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'touches', {
    value: type === 'touchend' || type === 'touchcancel' ? [] : [{ clientX: x, clientY: y }],
  });
  act(() => {
    node.dispatchEvent(event);
  });
}

function press(): HTMLElement {
  return screen.getByRole('button', { name: 'Вынести мусор' });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('long press', () => {
  it('fires after 450ms and swallows the tap that follows it', () => {
    const onLongPress = vi.fn();
    const onTap = vi.fn();
    render(<Row onLongPress={onLongPress} onTap={onTap} />);

    touch(press(), 'touchstart', 100, 100);
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS - 1);
    });
    expect(onLongPress).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onLongPress).toHaveBeenCalledTimes(1);

    touch(press(), 'touchend', 100, 100);
    act(() => {
      press().click();
    });
    expect(onTap, 'the row must not also open under the sheet').not.toHaveBeenCalled();
  });

  it('swallows exactly one tap, not every tap afterwards', () => {
    const onTap = vi.fn();
    render(<Row onLongPress={vi.fn()} onTap={onTap} />);

    touch(press(), 'touchstart', 100, 100);
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS);
    });
    touch(press(), 'touchend', 100, 100);

    act(() => {
      press().click();
    });
    act(() => {
      press().click();
    });
    expect(onTap).toHaveBeenCalledTimes(1);
  });

  it('is cancelled by more than 10px of movement', () => {
    const onLongPress = vi.fn();
    render(<Row onLongPress={onLongPress} onTap={vi.fn()} />);

    touch(press(), 'touchstart', 100, 100);
    touch(press(), 'touchmove', 100, 120);
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    });

    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('survives a jitter of a few pixels — a thumb is not a mouse', () => {
    const onLongPress = vi.fn();
    render(<Row onLongPress={onLongPress} onTap={vi.fn()} />);

    touch(press(), 'touchstart', 100, 100);
    touch(press(), 'touchmove', 103, 104);
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS);
    });

    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it('is cancelled by a scroll under the finger', () => {
    const onLongPress = vi.fn();
    render(<Row onLongPress={onLongPress} onTap={vi.fn()} />);

    touch(press(), 'touchstart', 100, 100);
    act(() => {
      window.dispatchEvent(new Event('scroll'));
      vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    });

    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('does not fire a second time when a finger is added mid-press', () => {
    const onLongPress = vi.fn();
    render(<Row onLongPress={onLongPress} onTap={vi.fn()} />);

    const node = press();
    touch(node, 'touchstart', 100, 100);
    const pinch = new Event('touchstart', { bubbles: true, cancelable: true });
    Object.defineProperty(pinch, 'touches', {
      value: [
        { clientX: 100, clientY: 100 },
        { clientX: 200, clientY: 200 },
      ],
    });
    act(() => {
      node.dispatchEvent(pinch);
      vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    });

    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('does nothing at all when disabled', () => {
    const onLongPress = vi.fn();
    function Disabled() {
      const longPress = useLongPress({ onLongPress, enabled: false });
      return (
        <div {...longPress.handlers}>
          <button type="button">Вынести мусор</button>
        </div>
      );
    }
    render(<Disabled />);

    touch(press(), 'touchstart', 100, 100);
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    });
    expect(onLongPress).not.toHaveBeenCalled();
  });
});
