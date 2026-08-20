import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ArchiveToggle } from './ArchiveToggle';

/**
 * The shared «Показать архив» control (§C2 band 4, §D5).
 *
 * Копилки and Покупки rendered two different controls for one job — one a
 * 128 × 18 text link at the bottom of the page, the other a 44px ghost button
 * above the first row — so the three things worth pinning here are the ones
 * that differed: the pressed state, the 44px target, and what the control says
 * when the archive turns out to be empty.
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
  it('keeps a 44px touch target', () => {
    render(<ArchiveToggle expanded={false} onToggle={vi.fn()} {...labels} />);
    expect(screen.getByRole('button', { name: 'Показать архив' })).toHaveClass('min-h-11');
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
