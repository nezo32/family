import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ColorField, PALETTE_COLORS } from './color-field';
import { DateField } from './date-field';
import { DateTimeField } from './date-time-field';
import { TimeField } from './time-field';

/**
 * The contract these components have to keep is narrow and absolute: **what the
 * user picks is exactly what the form submits.**
 *
 * They replaced `<input type="date">` and `<input type="time">`, which handed
 * the form a `YYYY-MM-DD` and a `HH:mm`. If the replacements ever hand back a
 * `Date`, an ISO instant, or the same wall clock a day out, every appointment in
 * the family's calendar moves and nothing on screen says so (D2). So every test
 * below asserts the emitted **string**, never a parsed date.
 */

/** Controlled wrapper: the component under test drives real state, as in a form. */
function Harness(props: {
  initial: string;
  onValue: (value: string) => void;
  children: (value: string, setValue: (next: string) => void) => React.ReactNode;
}) {
  const [value, setValue] = useState(props.initial);
  return (
    <>
      {props.children(value, (next) => {
        setValue(next);
        props.onValue(next);
      })}
      <output data-testid="value">{value}</output>
    </>
  );
}

describe('DateTimeField — value round trip', () => {
  it('emits the floating local datetime for the day the user tapped', async () => {
    const user = userEvent.setup();
    const onValue = vi.fn();

    render(
      <Harness initial="2026-09-07T09:00:00" onValue={onValue}>
        {(value, setValue) => <DateTimeField value={value} onChange={setValue} />}
      </Harness>,
    );

    await user.click(screen.getByRole('button', { name: /^Дата:/ }));
    await user.click(within(await screen.findByRole('grid')).getByText('15'));

    expect(onValue).toHaveBeenLastCalledWith('2026-09-15T09:00:00');
    expect(screen.getByTestId('value')).toHaveTextContent('2026-09-15T09:00:00');
  });

  it('keeps the time exactly as typed, with mandatory seconds and no offset', async () => {
    const user = userEvent.setup();
    const onValue = vi.fn();

    render(
      <Harness initial="2026-09-07T09:00:00" onValue={onValue}>
        {(value, setValue) => <DateTimeField value={value} onChange={setValue} />}
      </Harness>,
    );

    const time = screen.getByRole('textbox', { name: 'Время' });
    await user.clear(time);
    await user.type(time, '1845');
    await user.tab();

    expect(onValue).toHaveBeenLastCalledWith('2026-09-07T18:45:00');
    const submitted = onValue.mock.calls.at(-1)?.[0] as string;
    expect(submitted).not.toMatch(/[Z+]/);
    expect(submitted).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/);
  });

  it('does not move the date when only the time changes, or vice versa', async () => {
    const user = userEvent.setup();
    const onValue = vi.fn();

    render(
      <Harness initial="2026-12-31T23:00:00" onValue={onValue}>
        {(value, setValue) => <DateTimeField value={value} onChange={setValue} />}
      </Harness>,
    );

    const time = screen.getByRole('textbox', { name: 'Время' });
    await user.clear(time);
    await user.type(time, '00:30');
    await user.tab();

    // 31 декабря, not 1 января: a wall clock has no rollover (D2).
    expect(screen.getByTestId('value')).toHaveTextContent('2026-12-31T00:30:00');
  });

  it('shows the date the way the rest of the app writes dates', () => {
    render(<DateTimeField value="2026-09-07T09:00:00" onChange={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Дата: 7 сентября 2026 г.' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Время' })).toHaveValue('09:00');
  });

  it('clears to an empty string rather than half a value', async () => {
    const user = userEvent.setup();
    const onValue = vi.fn();

    render(
      <Harness initial="2026-09-07T09:00:00" onValue={onValue}>
        {(value, setValue) => <DateTimeField value={value} onChange={setValue} clearable />}
      </Harness>,
    );

    await user.click(screen.getByRole('button', { name: 'Очистить дату' }));

    expect(onValue).toHaveBeenLastCalledWith('');
    expect(screen.getByRole('textbox', { name: 'Время' })).toBeDisabled();
  });
});

describe('DateField', () => {
  it('names itself for a screen reader with its current value', () => {
    render(<DateField label="День рождения" value="1988-04-12" onChange={vi.fn()} />);

    expect(
      screen.getByRole('button', { name: 'День рождения: 12 апреля 1988 г.' }),
    ).toBeInTheDocument();
  });

  it('says so when nothing is chosen instead of reading out an empty name', () => {
    render(<DateField label="Срок" value="" onChange={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Срок: не выбрана' })).toBeInTheDocument();
    expect(screen.getByText('Выберите дату')).toBeInTheDocument();
  });

  it('is reachable and operable from the keyboard alone', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<DateField label="Дата" value="2026-09-07" onChange={onChange} />);

    await user.tab();
    expect(screen.getByRole('button', { name: /^Дата:/ })).toHaveFocus();

    await user.keyboard('{Enter}');
    await user.click(within(await screen.findByRole('grid')).getByText('21'));

    expect(onChange).toHaveBeenCalledWith('2026-09-21');
  });
});

describe('TimeField', () => {
  it('accepts every shape a phone keyboard produces', async () => {
    const user = userEvent.setup();

    for (const [typed, expected] of [
      ['9', '09:00'],
      ['930', '09:30'],
      ['9:05', '09:05'],
    ] as const) {
      const onChange = vi.fn();
      const view = render(<TimeField label="Время" value="08:00" onChange={onChange} />);
      const input = screen.getByRole('textbox', { name: 'Время' });
      await user.clear(input);
      await user.type(input, typed);
      await user.tab();
      expect(onChange).toHaveBeenCalledWith(expected);
      view.unmount();
    }
  });

  it('reverts an unparseable draft instead of inventing a time', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TimeField label="Время" value="09:00" onChange={onChange} />);

    const input = screen.getByRole('textbox', { name: 'Время' });
    await user.clear(input);
    await user.type(input, '99:99');
    await user.tab();

    expect(onChange).not.toHaveBeenCalled();
    expect(input).toHaveValue('09:00');
  });

  it('picks from the list without disturbing the other half of the clock', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TimeField label="Время" value="09:07" onChange={onChange} />);

    await user.click(screen.getByRole('button', { name: /Выбрать из списка/ }));
    await user.click(within(screen.getByRole('listbox', { name: 'Часы' })).getByText('14'));

    // Minutes are 07 — off the 5-minute grid, and kept exactly.
    expect(onChange).toHaveBeenLastCalledWith('14:07');
  });

  it('keeps an off-grid minute selectable in the list', async () => {
    const user = userEvent.setup();
    render(<TimeField label="Время" value="09:07" onChange={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /Выбрать из списка/ }));
    const minutes = within(screen.getByRole('listbox', { name: 'Минуты' }));

    expect(minutes.getByRole('option', { selected: true })).toHaveTextContent('07');
    expect(minutes.getAllByRole('option')).toHaveLength(13); // 12 on the grid + 07
  });
});

describe('ColorField', () => {
  it('emits a palette hex, not whatever an OS colour wheel returned', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ColorField label="Цвет" value={PALETTE_COLORS[0]} onChange={onChange} />);

    const options = screen.getAllByRole('radio');
    expect(options).toHaveLength(PALETTE_COLORS.length);

    await user.click(options[3] as HTMLElement);
    expect(onChange).toHaveBeenCalledWith(PALETTE_COLORS[3]);
  });

  it('keeps a colour saved before the palette existed', () => {
    render(<ColorField label="Цвет" value="#2563eb" onChange={vi.fn()} />);

    const options = screen.getAllByRole('radio');
    expect(options).toHaveLength(PALETTE_COLORS.length + 1);
    expect(options.at(-1)).toBeChecked();
  });
});
