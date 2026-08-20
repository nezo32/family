import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { mockMediaQuery } from '@/test/media';
import { FormSheet } from './form-sheet';

/**
 * The contract, in one sentence: **«Создать» is reachable without scrolling, at
 * every viewport, no matter how long the form is.**
 *
 * That is not a styling nicety. Measured on the shipped build, «Новое событие»
 * is 358 × 1640 on a 390 × 844 phone and 672 × 1198 in a 1440 × 900 window, and
 * its submit button is below the fold in **both**. So the tests below do not
 * check that the button looks right — they check the property that makes the
 * defect structurally impossible: the submit control is never a descendant of
 * the scroll container.
 *
 * A test that merely rendered a short form and found the button would pass on
 * the broken build too.
 */

const LONG_FORM = Array.from({ length: 60 }, (_, i) => (
  <p key={i} style={{ height: 40 }}>{`Поле ${String(i + 1)}`}</p>
));

function scrollContainer(): HTMLElement {
  const node = document.querySelector<HTMLElement>('[data-slot="responsive-dialog-body"]');
  if (!node) throw new Error('form sheet has no scroll container');
  return node;
}

function surface(): HTMLElement {
  const node = document.querySelector<HTMLElement>('[data-slot="responsive-dialog"]');
  if (!node) throw new Error('form sheet has no surface');
  return node;
}

afterEach(() => {
  window.sessionStorage.clear();
});

describe.each([
  ['coarse pointer (phone sheet)', ['(pointer: coarse)']],
  ['fine pointer (desktop dialog)', [] as string[]],
])('FormSheet — %s', (_name, queries) => {
  it('keeps the submit control outside the scroll container', () => {
    mockMediaQuery(queries);
    render(
      <FormSheet open onOpenChange={vi.fn()} title="Новое событие" onSubmit={vi.fn()}>
        {LONG_FORM}
      </FormSheet>,
    );

    const submit = screen.getByRole('button', { name: 'Создать' });
    const body = scrollContainer();

    // The point of the whole component: the button is a *sibling* of the
    // scroller, not a descendant, so no amount of content can push it away.
    expect(body).not.toContainElement(submit);
    expect(surface()).toContainElement(submit);
  });

  it('makes the body — and only the body — the scroller', () => {
    mockMediaQuery(queries);
    render(
      <FormSheet open onOpenChange={vi.fn()} title="Новое событие" onSubmit={vi.fn()}>
        {LONG_FORM}
      </FormSheet>,
    );

    const body = scrollContainer();
    expect(body.className).toContain('overflow-y-auto');
    // `min-h-0` is what actually lets a flex child scroll instead of growing;
    // without it the body expands and takes the surface with it.
    expect(body.className).toContain('min-h-0');
    expect(body.className).toContain('flex-1');

    // The surface itself must not scroll, or the header would leave with it.
    expect(surface().className).toContain('overflow-hidden');
    expect(surface().className).toContain('flex-col');
  });

  it('keeps a disabled submit in place, with its label', () => {
    mockMediaQuery(queries);
    render(
      <FormSheet
        open
        onOpenChange={vi.fn()}
        title="Новое событие"
        onSubmit={vi.fn()}
        submitDisabled
      >
        <p>Поле</p>
      </FormSheet>,
    );

    const submit = screen.getByRole('button', { name: 'Создать' });
    expect(submit).toBeDisabled();
    // §F3: disabled, not hidden and not relabelled. A control that disappears
    // when it cannot be used teaches nobody what to do next.
    expect(scrollContainer()).not.toContainElement(submit);
  });

  it('submits the named form rather than a click handler when formId is given', async () => {
    mockMediaQuery(queries);
    const onSubmit = vi.fn((event: React.FormEvent) => {
      event.preventDefault();
    });
    render(
      <FormSheet open onOpenChange={vi.fn()} title="Новое дело" formId="task-form">
        <form id="task-form" onSubmit={onSubmit}>
          <input aria-label="Название" defaultValue="Вынести мусор" />
        </form>
      </FormSheet>,
    );

    const submit = screen.getByRole('button', { name: 'Создать' });
    expect(submit).toHaveAttribute('type', 'submit');
    // The button lives outside the <form> by construction, so `form="…"` is the
    // only thing keeping it a real submit button.
    expect(submit).toHaveAttribute('form', 'task-form');
    await userEvent.click(submit);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('asks before discarding unsaved input, and only when there is any', async () => {
    mockMediaQuery(queries);
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <FormSheet open onOpenChange={onOpenChange} title="Новое событие" onSubmit={vi.fn()}>
        <p>Поле</p>
      </FormSheet>,
    );

    // Nothing typed: Отмена closes immediately. A confirm on an empty form is
    // a dialog that teaches people to dismiss dialogs.
    await userEvent.click(screen.getAllByRole('button', { name: 'Отмена' })[0] as HTMLElement);
    expect(onOpenChange).toHaveBeenCalledWith(false);

    onOpenChange.mockClear();
    rerender(
      <FormSheet open onOpenChange={onOpenChange} title="Новое событие" onSubmit={vi.fn()} dirty>
        <p>Поле</p>
      </FormSheet>,
    );

    await userEvent.click(screen.getAllByRole('button', { name: 'Отмена' })[0] as HTMLElement);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(await screen.findByText('Не сохранять?')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Не сохранять' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe('FormSheet — the phone header', () => {
  it('reads Отмена · title · Создать, in that order', () => {
    mockMediaQuery(['(pointer: coarse)']);
    render(
      <FormSheet open onOpenChange={vi.fn()} title="Новое событие" onSubmit={vi.fn()}>
        {LONG_FORM}
      </FormSheet>,
    );

    const header = document.querySelector<HTMLElement>('[data-slot="form-sheet-header"]');
    expect(header).not.toBeNull();
    // Order matters: the escape is on the left where a thumb rests, the commit
    // is on the right where iOS puts it, and the title says which form this is.
    expect(header?.textContent).toBe('ОтменаНовое событиеСоздать');
  });

  it('does not put a second copy of the actions in a footer', () => {
    mockMediaQuery(['(pointer: coarse)']);
    render(
      <FormSheet open onOpenChange={vi.fn()} title="Новое событие" onSubmit={vi.fn()}>
        <p>Поле</p>
      </FormSheet>,
    );
    expect(document.querySelector('[data-slot="form-sheet-footer"]')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Создать' })).toHaveLength(1);
  });
});

describe('FormSheet — the desktop dialog', () => {
  it('puts the actions in a fixed footer and does not duplicate them in the header', () => {
    mockMediaQuery([]);
    render(
      <FormSheet open onOpenChange={vi.fn()} title="Новое событие" onSubmit={vi.fn()}>
        {LONG_FORM}
      </FormSheet>,
    );

    const footer = document.querySelector<HTMLElement>('[data-slot="form-sheet-footer"]');
    const header = document.querySelector<HTMLElement>('[data-slot="form-sheet-header"]');
    expect(footer).not.toBeNull();
    expect(footer).toContainElement(screen.getByRole('button', { name: 'Создать' }));
    expect(header?.textContent).toBe('Новое событие');
    expect(footer?.className).toContain('shrink-0');
  });
});

describe('FormSheet — drafts survive an iOS background kill', () => {
  function hide(): void {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    document.dispatchEvent(new Event('visibilitychange'));
  }

  it('writes on visibilitychange → hidden and restores on the next open', async () => {
    mockMediaQuery(['(pointer: coarse)']);
    const restore = vi.fn();

    const sheet = (open: boolean) => (
      <FormSheet
        open={open}
        onOpenChange={vi.fn()}
        title="Новое событие"
        onSubmit={vi.fn()}
        dirty
        draft={{ key: 'draft:test', read: () => ({ title: 'ужин у бабушки' }), restore }}
      >
        <p>Поле</p>
      </FormSheet>
    );

    const { rerender } = render(sheet(true));
    hide();
    expect(window.sessionStorage.getItem('draft:test')).toBe('{"title":"ужин у бабушки"}');

    // The cold start: iOS killed the app, the sheet is gone, and the next
    // opening has to find the half-typed event where it was left. (A normal
    // close clears the key, so it is re-seeded here the way a fresh page load
    // would find it.)
    rerender(sheet(false));
    window.sessionStorage.setItem('draft:test', '{"title":"ужин у бабушки"}');
    rerender(sheet(true));
    await waitFor(() => {
      expect(restore).toHaveBeenCalledWith({ title: 'ужин у бабушки' });
    });
  });

  it('clears the draft when the sheet is closed deliberately', async () => {
    mockMediaQuery(['(pointer: coarse)']);
    window.sessionStorage.setItem('draft:test', '{"title":"старое"}');

    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <FormSheet
          open={open}
          onOpenChange={setOpen}
          title="Новое событие"
          onSubmit={vi.fn()}
          draft={{ key: 'draft:test', read: () => ({ title: 'x' }), restore: vi.fn() }}
        >
          <p>Поле</p>
        </FormSheet>
      );
    }

    render(<Harness />);
    await userEvent.click(screen.getAllByRole('button', { name: 'Отмена' })[0] as HTMLElement);
    await waitFor(() => {
      expect(window.sessionStorage.getItem('draft:test')).toBeNull();
    });
  });
});
