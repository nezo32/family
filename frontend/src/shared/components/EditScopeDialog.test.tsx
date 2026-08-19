import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { CALENDAR_RU } from '@/features/calendar/locale';
import { TASKS_RU } from '@/features/tasks/locale';
import { EditScopeDialog, type EditScopeStrings } from './EditScopeDialog';

/**
 * Tasks and the calendar each had their own copy of this dialog, and the safety
 * default was **inverted between them**: tasks pre-selected nothing and kept
 * confirm disabled, the calendar defaulted to `'this'` with confirm always
 * enabled — so on the calendar a double-tap committed a single-occurrence edit
 * with the user never having answered the question. Its own header comment
 * claimed there was no default.
 *
 * These run the same assertions over both features' copy, which is the point:
 * one component, one behaviour, whichever screen you are on.
 */

const FEATURES: readonly (readonly [string, EditScopeStrings])[] = [
  ['tasks', TASKS_RU.scope],
  ['calendar', CALENDAR_RU.scope],
];

function setup(strings: EditScopeStrings, intent: 'edit' | 'delete' = 'edit') {
  const onConfirm = vi.fn();
  render(
    <EditScopeDialog
      open
      onOpenChange={() => undefined}
      intent={intent}
      strings={strings}
      onConfirm={onConfirm}
    />,
  );
  return { onConfirm };
}

describe.each(FEATURES)('EditScopeDialog (%s copy)', (_feature, strings) => {
  it('offers all three scopes with a consequence spelled out', async () => {
    setup(strings);
    const dialog = await screen.findByTestId('edit-scope-dialog');
    for (const label of [strings.this, strings.thisAndFuture, strings.all]) {
      expect(within(dialog).getByRole('radio', { name: new RegExp(label) })).toBeInTheDocument();
    }
    expect(within(dialog).getByText(strings.thisHint)).toBeInTheDocument();
  });

  it('pre-selects nothing', async () => {
    setup(strings);
    const dialog = await screen.findByTestId('edit-scope-dialog');
    for (const radio of within(dialog).getAllByRole('radio')) {
      expect(radio).toHaveAttribute('aria-checked', 'false');
    }
  });

  it('keeps confirm disabled until the user has actually answered', async () => {
    const user = userEvent.setup();
    const { onConfirm } = setup(strings);
    const dialog = await screen.findByTestId('edit-scope-dialog');
    const confirm = within(dialog).getByRole('button', { name: new RegExp(strings.confirm) });

    // The calendar copy used to reach this point already armed, so the second
    // tap of a double-tap silently edited a single occurrence.
    expect(confirm).toBeDisabled();
    await user.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('radio', { name: new RegExp(strings.all) }));
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith('all');
  });

  it('reports the scope the user picked, not the first option', async () => {
    const user = userEvent.setup();
    const { onConfirm } = setup(strings);
    const dialog = await screen.findByTestId('edit-scope-dialog');

    await user.click(
      within(dialog).getByRole('radio', { name: new RegExp(strings.thisAndFuture) }),
    );
    await user.click(within(dialog).getByRole('button', { name: new RegExp(strings.confirm) }));
    expect(onConfirm).toHaveBeenCalledWith('this_and_future');
  });

  it('titles the delete variant with its own question and label', async () => {
    setup(strings, 'delete');
    const dialog = await screen.findByTestId('edit-scope-dialog');
    expect(within(dialog).getByText(strings.deleteTitle)).toBeInTheDocument();
    expect(within(dialog).getByText(strings.deleteDescription)).toBeInTheDocument();
    expect(
      within(dialog).getByRole('button', {
        name: new RegExp(strings.deleteConfirm ?? strings.confirm),
      }),
    ).toBeInTheDocument();
  });

  it('disables everything while the mutation is in flight', async () => {
    render(
      <EditScopeDialog
        open
        onOpenChange={() => undefined}
        intent="delete"
        strings={strings}
        isPending
        onConfirm={() => undefined}
      />,
    );
    const dialog = await screen.findByTestId('edit-scope-dialog');
    for (const radio of within(dialog).getAllByRole('radio')) expect(radio).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: /Отмена/ })).toBeDisabled();
    expect(
      within(dialog).getByRole('button', {
        name: new RegExp(strings.deleteConfirm ?? strings.confirm),
      }),
    ).toBeDisabled();
    // The dialog's own dismiss (×) stays live on purpose: a pending mutation is
    // a reason to stop offering choices, not a reason to trap the user.
  });
});

/**
 * The two locale tables had title and description swapped relative to each
 * other, so a shared component would have read one screen's title as the
 * other's description. They are normalised: the title asks, the description
 * explains.
 */
describe('scope copy', () => {
  it.each(FEATURES)('%s asks the question in the title', (_feature, strings) => {
    expect(strings.editTitle).toMatch(/\?$/);
    expect(strings.deleteTitle).toMatch(/\?$/);
    expect(strings.editDescription.length).toBeGreaterThan(strings.editTitle.length);
    expect(strings.deleteDescription.length).toBeGreaterThan(strings.deleteTitle.length);
  });
});
