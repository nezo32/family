import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ArchiveToggle } from './ArchiveToggle';

/**
 * The shared «Показать архив» control (§D5).
 *
 * Копилки and Покупки rendered two different controls for one job — one a
 * 128 × 18 text link, the other a 44px ghost button — so the things worth
 * pinning here are the ones that differed or that a layout change can quietly
 * break: the pressed state, the 44px target, what the control says when the
 * archive turns out to be empty, and — since the control now shares a row with
 * the scope tabs and drops its label below 420px — that the **accessible name
 * survives the collapse**. An icon-only button whose name went with its label
 * would be a button with no name at all.
 */
describe('ArchiveToggle', () => {
  const labels = { showLabel: 'Показать архив', hideLabel: 'Скрыть архив' };

  it('is a toggle, not a link: the label and aria-pressed move together', () => {
    const onToggle = vi.fn();
    const { rerender } = render(<ArchiveToggle expanded={false} onToggle={onToggle} {...labels} />);

    const collapsed = screen.getByRole('button', { name: 'Показать архив' });
    expect(collapsed).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(collapsed);
    expect(onToggle).toHaveBeenCalledTimes(1);

    rerender(<ArchiveToggle expanded onToggle={onToggle} {...labels} />);
    expect(screen.getByRole('button', { name: 'Скрыть архив' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  /**
   * jsdom has no layout, so the floor can only be asserted as the class that
   * sets it. The regression it guards was measured in a browser: the Копилки
   * copy of this control rendered 128 × 18, against §F1's 44px minimum.
   */
  it('keeps a 44px touch target in both axes', () => {
    render(<ArchiveToggle expanded={false} onToggle={vi.fn()} {...labels} />);
    const button = screen.getByRole('button', { name: 'Показать архив' });
    expect(button).toHaveClass('min-h-11');
    // `min-w-11` is the half that the icon-only form depends on: with the label
    // at `text-[0px]` the width comes from nothing else.
    expect(button).toHaveClass('min-w-11');
  });

  /**
   * §D5: tabs on the left, archive on the right, one row. Both screens get this
   * from the one component, which is the only thing that stopped them drifting
   * apart the last two times.
   */
  it('seats the tabs on the same row, with the control after them', () => {
    render(
      <ArchiveToggle
        expanded={false}
        onToggle={vi.fn()}
        tabs={<div data-testid="tabs">Все</div>}
        {...labels}
      />,
    );

    const tabs = screen.getByTestId('tabs');
    const button = screen.getByRole('button', { name: 'Показать архив' });
    expect(tabs.parentElement).toBe(button.parentElement);
    expect(tabs.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // `ml-auto` is what pushes it to the right of whatever the tabs measure.
    expect(button).toHaveClass('ml-auto');
  });

  /**
   * The label collapses to zero width below 420px — it must not leave the DOM,
   * or the button loses its accessible name on precisely the pointer where an
   * unnamed icon is least recoverable.
   */
  it('keeps its accessible name when the label collapses next to the tabs', () => {
    render(<ArchiveToggle expanded={false} onToggle={vi.fn()} tabs={<div>Все</div>} {...labels} />);

    const button = screen.getByRole('button', { name: 'Показать архив' });
    const label = screen.getByText('Показать архив');
    expect(label).toHaveClass('max-[419px]:text-[0px]');
    expect(button).toContainElement(label);
  });

  it('keeps the label at every width when it owns the row alone', () => {
    render(<ArchiveToggle expanded={false} onToggle={vi.fn()} {...labels} />);
    expect(screen.getByText('Показать архив')).not.toHaveClass('max-[419px]:text-[0px]');
  });

  it('explains an empty archive only once the archive has been asked for', () => {
    const hint = 'В архиве пока пусто';
    const { rerender } = render(
      <ArchiveToggle expanded={false} onToggle={vi.fn()} emptyHint={hint} {...labels} />,
    );
    expect(screen.queryByText(hint)).not.toBeInTheDocument();

    rerender(<ArchiveToggle expanded onToggle={vi.fn()} emptyHint={hint} {...labels} />);
    expect(screen.getByText(hint)).toBeInTheDocument();
  });

  it('says nothing extra when the archive has something in it', () => {
    render(<ArchiveToggle expanded onToggle={vi.fn()} {...labels} />);
    expect(screen.getByRole('button', { name: 'Скрыть архив' })).toBeInTheDocument();
    expect(screen.queryByText(/пусто/)).not.toBeInTheDocument();
  });
});
