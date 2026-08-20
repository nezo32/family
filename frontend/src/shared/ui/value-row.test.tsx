import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ValueRow } from './value-row';

/**
 * Two rules this primitive exists to hold, both of which came back repeatedly
 * when they lived only in a document:
 *
 * 1. **A row is never wider than 720px** (§C2). The shipped build renders a
 *    1024px-wide shopping row with «Картошка» at x=386 and its delete button at
 *    x=1325 — about 900px of nothing between an item and the control that
 *    removes it. jsdom cannot measure that, but it can assert the cap is on the
 *    element, which is the thing that gets deleted by accident.
 * 2. **An unset value says «—»**, not nothing. A blank right-hand column reads
 *    as a rendering failure; an em dash reads as "not set yet".
 */
describe('ValueRow', () => {
  it('caps its content at the 720px measure while the surface stays full width', () => {
    render(<ValueRow label="Место" value="Ул. Садовая, 12" onClick={vi.fn()} />);

    const row = screen.getByRole('button');
    expect(row.className).toContain('w-full');

    const content = row.firstElementChild;
    // `--spacing-row-measure` is 45rem = 720px. The content is capped and
    // left-aligned — not centred — so the trailing chevron lands next to the
    // value instead of at the far edge of the column.
    expect(content?.className).toContain('max-w-row-measure');
    expect(content?.className).not.toContain('mx-auto');
  });

  it('renders «—» for an unset value', () => {
    render(<ValueRow label="Место" value={null} onClick={vi.fn()} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('omits the value column entirely when the row has no value to state', () => {
    render(<ValueRow label="Уведомления" onClick={vi.fn()} />);
    expect(screen.queryByText('—')).not.toBeInTheDocument();
  });

  it('is a real button when it opens something, and calls back once', async () => {
    const onClick = vi.fn();
    render(<ValueRow label="Повторение" value="не повторяется" onClick={onClick} />);

    const row = screen.getByRole('button', { name: /Повторение/ });
    expect(row).toHaveAttribute('type', 'button');
    await userEvent.click(row);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('is not a button when it only displays', () => {
    render(<ValueRow label="Часовой пояс" value="Europe/Moscow" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('drops the chevron when something else owns the trailing edge', () => {
    // A row with a switch does not claim to open anything, so it must not show
    // the affordance that says it does.
    const { container } = render(
      <ValueRow label="Push" trailing={<span data-testid="switch" />} onClick={vi.fn()} />,
    );
    expect(screen.getByTestId('switch')).toBeInTheDocument();
    expect(container.querySelector('svg')).toBeNull();
  });

  it('meets the 44px tap minimum with room to spare', () => {
    render(<ValueRow label="Имя" value="Павел" onClick={vi.fn()} />);
    // 56px row (§B3), expressed as a minimum so a two-line value can grow it.
    expect(screen.getByRole('button').firstElementChild?.className).toContain('min-h-14');
  });
});
