import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { mockMediaQuery } from '@/test/media';
import { Button } from '@/shared/ui/button';
import { PickerSurface } from './field-shell';

/**
 * `PickerSurface` chooses a *component*, not a layout — a bottom sheet or a
 * popover — so the choice cannot be a media query in a class list and has to be
 * tested by rendering.
 *
 * The two surfaces are told apart by the title: the sheet shows it as a
 * heading, because a sheet that slides over the screen needs to say what it is,
 * while the popover renders only the picker.
 */

function renderPicker() {
  return render(
    <PickerSurface
      open
      onOpenChange={() => {}}
      trigger={<Button>Открыть</Button>}
      title="Выберите дату"
      description="Календарь для выбора даты."
    >
      <div>содержимое</div>
    </PickerSurface>,
  );
}

describe('PickerSurface picks its surface', () => {
  it('opens a sheet for a thumb, even on a wide screen', () => {
    // The bug this replaced: gating on width alone handed a 1024px tablet a
    // month grid inside a popover, to be operated with a finger.
    mockMediaQuery(['(pointer: coarse)']);
    renderPicker();

    expect(screen.getByRole('heading', { name: 'Выберите дату' })).toBeInTheDocument();
    expect(screen.getByText('содержимое')).toBeInTheDocument();
  });

  it('opens a sheet on a narrow window regardless of pointer', () => {
    mockMediaQuery(['(max-width: 639px)']);
    renderPicker();

    expect(screen.getByRole('heading', { name: 'Выберите дату' })).toBeInTheDocument();
  });

  it('opens a popover for a mouse on a wide screen', () => {
    mockMediaQuery([]);
    renderPicker();

    expect(screen.queryByRole('heading', { name: 'Выберите дату' })).not.toBeInTheDocument();
    expect(screen.getByText('содержимое')).toBeInTheDocument();
  });
});
