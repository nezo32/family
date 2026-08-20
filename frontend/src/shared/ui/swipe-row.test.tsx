import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Check } from 'lucide-react';

import { mockMediaQuery } from '@/test/media';
import { SwipeRow, SWIPE_DEAD_ZONE_PX, type SwipeAction } from './swipe-row';

/**
 * The gesture rules of §C-gestures/G3–G4, as tests.
 *
 * These drive real `touchstart`/`touchmove`/`touchend` sequences at DOM level
 * rather than poking at internal state, because every rule here is about what
 * the *event stream* is allowed to do: which touches are refused outright
 * (the left-edge dead zone), which never engage (a scroll, a rightward drag),
 * and which of the two resting positions a release lands on. A test that
 * called a handler directly would pass while the component ignored the dead
 * zone entirely.
 *
 * The Playwright suite covers what jsdom structurally cannot — that the page
 * still scrolls while a swipeable list is under the finger.
 */

const toastSpy = vi.fn();
vi.mock('sonner', () => ({
  toast: (...args: unknown[]) => {
    toastSpy(...args);
  },
}));

interface ToastOptions {
  id?: string;
  duration?: number;
  action?: { label: string; onClick: () => void };
}

function lastToast(): [string, ToastOptions] {
  const call = toastSpy.mock.calls.at(-1);
  expect(call, 'no toast was raised').toBeDefined();
  return call as [string, ToastOptions];
}

/** A row 320px wide, so the 45 % commit threshold is a real 144px. */
const ROW_WIDTH = 320;

function stubWidth(): void {
  Element.prototype.getBoundingClientRect = vi.fn(
    () =>
      ({
        width: ROW_WIDTH,
        height: 56,
        top: 0,
        left: 0,
        right: ROW_WIDTH,
        bottom: 56,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect,
  );
}

/**
 * jsdom has no `TouchEvent` constructor, and Testing Library's `fireEvent`
 * cannot make one either. A plain `Event` carrying a `touches` array is what
 * every handler in `swipe-row.tsx` actually reads, and it dispatches through
 * both the native listeners and React's synthetic system.
 */
function touch(node: Element, type: string, x: number, y: number): void {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'touches', {
    value: type === 'touchend' || type === 'touchcancel' ? [] : [{ clientX: x, clientY: y }],
  });
  act(() => {
    node.dispatchEvent(event);
  });
}

function panel(): HTMLElement {
  const node = document.querySelector('[data-slot="swipe-row-panel"]');
  expect(node).not.toBeNull();
  return node as HTMLElement;
}

function offset(): number {
  const transform = panel().style.transform;
  const match = /translate3d\((-?\d+(?:\.\d+)?)px/.exec(transform);
  return match?.[1] === undefined ? 0 : -Number(match[1]);
}

function renderRow(overrides: Partial<SwipeAction> = {}, props: { collapse?: boolean } = {}) {
  const onCommit = vi.fn();
  const onUndo = vi.fn();
  const action: SwipeAction = {
    label: 'Куплено',
    icon: <Check />,
    tone: 'primary',
    onCommit,
    onUndo,
    ...overrides,
  };
  render(
    <SwipeRow action={action} collapse={props.collapse ?? false}>
      <div>Молоко</div>
    </SwipeRow>,
  );
  return { onCommit, onUndo };
}

beforeEach(() => {
  toastSpy.mockClear();
  // A phone, and no reduced-motion preference.
  mockMediaQuery(['(pointer: coarse)']);
  stubWidth();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('swipe left', () => {
  it('commits past 45 % of the row width and offers a six-second undo', () => {
    const { onCommit, onUndo } = renderRow();

    touch(panel(), 'touchstart', 200, 20);
    touch(panel(), 'touchmove', 180, 20);
    touch(panel(), 'touchmove', 40, 22);
    expect(offset(), 'the row tracks the finger once the axis lock engages').toBeGreaterThan(0);

    touch(panel(), 'touchend', 0, 0);
    expect(onCommit).toHaveBeenCalledTimes(1);

    const [message, options] = lastToast();
    expect(message).toBe('Куплено');
    expect(options.duration, '§G4: six seconds').toBe(6000);
    expect(options.id, 'a fixed id is what keeps it to one toast at a time').toBeTruthy();

    options.action?.onClick();
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  it('rests at 88px and commits when the revealed button is tapped', () => {
    const { onCommit } = renderRow();

    touch(panel(), 'touchstart', 300, 20);
    touch(panel(), 'touchmove', 280, 20);
    // 100px of travel: past the 88px rest stop, well short of the 144px commit.
    touch(panel(), 'touchmove', 200, 20);
    touch(panel(), 'touchend', 0, 0);

    expect(onCommit, 'a short swipe reveals, it does not fire').not.toHaveBeenCalled();
    expect(offset()).toBe(88);

    const button = screen.getByRole('button', { name: 'Куплено' });
    act(() => {
      button.click();
    });
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('snaps back below the rest stop without firing anything', () => {
    const { onCommit } = renderRow();

    touch(panel(), 'touchstart', 300, 20);
    touch(panel(), 'touchmove', 280, 20);
    touch(panel(), 'touchmove', 260, 20);
    touch(panel(), 'touchend', 0, 0);

    expect(onCommit).not.toHaveBeenCalled();
    expect(offset()).toBe(0);
    expect(toastSpy).not.toHaveBeenCalled();
  });
});

describe('what the row must refuse', () => {
  it('ignores a touch that starts inside the 32px left edge, however far it travels', () => {
    const { onCommit } = renderRow();

    touch(panel(), 'touchstart', SWIPE_DEAD_ZONE_PX - 1, 20);
    touch(panel(), 'touchmove', 10, 20);
    touch(panel(), 'touchmove', -200, 20);
    touch(panel(), 'touchend', 0, 0);

    expect(offset(), 'the row must not move at all — that is the back gesture').toBe(0);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('takes a touch that starts one pixel outside the dead zone', () => {
    const { onCommit } = renderRow();

    touch(panel(), 'touchstart', SWIPE_DEAD_ZONE_PX, 20);
    touch(panel(), 'touchmove', 0, 20);
    touch(panel(), 'touchmove', -200, 20);
    touch(panel(), 'touchend', 0, 0);

    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('never engages on a rightward drag — that direction belongs to the system', () => {
    const { onCommit } = renderRow();

    touch(panel(), 'touchstart', 100, 20);
    touch(panel(), 'touchmove', 140, 20);
    touch(panel(), 'touchmove', 300, 20);
    touch(panel(), 'touchend', 0, 0);

    expect(offset()).toBe(0);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('gives a mostly-vertical drag to the scroller and never takes it back', () => {
    const { onCommit } = renderRow();

    touch(panel(), 'touchstart', 200, 100);
    // Down first…
    touch(panel(), 'touchmove', 198, 60);
    // …then hard left. Once abandoned, a gesture stays abandoned.
    touch(panel(), 'touchmove', 20, 60);
    touch(panel(), 'touchend', 0, 0);

    expect(offset()).toBe(0);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('does not engage before 12px of travel', () => {
    renderRow();

    touch(panel(), 'touchstart', 200, 20);
    touch(panel(), 'touchmove', 190, 20);

    expect(offset()).toBe(0);
  });
});

describe('the gesture is an affordance of the input device', () => {
  it('renders no action button and refuses every touch on a fine pointer', () => {
    mockMediaQuery([]);
    const { onCommit } = renderRow();

    expect(screen.queryByRole('button', { name: 'Куплено' })).toBeNull();

    touch(panel(), 'touchstart', 200, 20);
    touch(panel(), 'touchmove', 10, 20);
    touch(panel(), 'touchend', 0, 0);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('turns itself off when the row has no action', () => {
    render(
      <SwipeRow action={null}>
        <div>Молоко</div>
      </SwipeRow>,
    );
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('undo is offered only when the action can actually be reversed', () => {
  it('drops «Отменить» from the toast when no reversal was supplied', () => {
    render(
      <SwipeRow
        action={{
          label: 'Прочитано',
          icon: <Check />,
          tone: 'secondary',
          onCommit: vi.fn(),
        }}
      >
        <div>Уведомление</div>
      </SwipeRow>,
    );

    touch(panel(), 'touchstart', 300, 20);
    touch(panel(), 'touchmove', 280, 20);
    touch(panel(), 'touchmove', 20, 20);
    touch(panel(), 'touchend', 0, 0);

    const [, options] = lastToast();
    expect(options.action, 'a button that cannot do what it says is worse than none').toBeUndefined();
  });
});

describe('reduced motion', () => {
  it('commits on the same frame instead of waiting out the collapse', () => {
    mockMediaQuery(['(pointer: coarse)', '(prefers-reduced-motion: reduce)']);
    const { onCommit } = renderRow({}, { collapse: true });

    touch(panel(), 'touchstart', 300, 20);
    touch(panel(), 'touchmove', 280, 20);
    touch(panel(), 'touchmove', 20, 20);
    touch(panel(), 'touchend', 0, 0);

    expect(onCommit).toHaveBeenCalledTimes(1);
  });
});
