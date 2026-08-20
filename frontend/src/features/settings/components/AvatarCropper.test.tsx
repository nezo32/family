import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { AvatarCropper, CROP_VIEWPORT } from './AvatarCropper';
import {
  clampTransform,
  DEFAULT_TRANSFORM,
  MAX_ZOOM,
  type CropSource,
  type CropTransform,
} from '../crop-geometry';

/**
 * The cropper as a *control*, not as a picture.
 *
 * The arithmetic is covered in `crop-geometry.test.ts`; what is left to prove
 * here is that a person who cannot pinch can still frame their face. That is
 * not a nicety — the slider exists specifically because this app's own seed
 * data contains a grandmother, and a zoom that only responds to a two-finger
 * gesture on a touchscreen is a zoom she does not have.
 *
 * So: the slider is a real, labelled, focusable control; the keyboard moves it;
 * and the reset gets back to the default framing.
 */

/** A 3024×4032 phone photo — tall, which is where framing actually matters. */
const PORTRAIT: CropSource = { width: 3024, height: 4032 };

function Harness(props: { initial?: CropTransform }) {
  const [transform, setTransform] = useState<CropTransform>(props.initial ?? DEFAULT_TRANSFORM);
  const image = { src: 'blob:fake' } as HTMLImageElement;
  return (
    <>
      <AvatarCropper
        image={image}
        source={PORTRAIT}
        transform={transform}
        onChange={setTransform}
      />
      {/* Exposes the state the component does not render, so assertions can
          talk about the transform rather than about pixel styles. */}
      <output data-testid="state">
        {`${transform.zoom.toFixed(3)}|${transform.offsetX.toFixed(1)}|${transform.offsetY.toFixed(1)}`}
      </output>
    </>
  );
}

const stateOf = (): { zoom: number; offsetX: number; offsetY: number } => {
  const [zoom, offsetX, offsetY] = screen.getByTestId('state').textContent!.split('|').map(Number);
  return { zoom: zoom!, offsetX: offsetX!, offsetY: offsetY! };
};

describe('AvatarCropper', () => {
  it('exposes the zoom as a labelled, focusable slider', () => {
    render(<Harness />);
    const slider = screen.getByRole('slider', { name: 'Масштаб фотографии' });

    expect(slider).toBeInTheDocument();
    slider.focus();
    expect(slider).toHaveFocus();
  });

  it('is operable from the keyboard alone', () => {
    render(<Harness />);
    const slider = screen.getByRole('slider', { name: 'Масштаб фотографии' });

    // A native range input: arrows and End are the browser's own behaviour, and
    // that is exactly why this is a range input and not a bespoke div.
    fireEvent.change(slider, { target: { value: '25' } });
    expect(stateOf().zoom).toBeGreaterThan(1);

    fireEvent.change(slider, { target: { value: '100' } });
    expect(stateOf().zoom).toBeCloseTo(MAX_ZOOM, 5);
  });

  it('gives the crop surface an accessible name and a description', () => {
    render(<Harness />);
    const surface = screen.getByRole('application', { name: 'Область обрезки фотографии' });
    expect(surface).toHaveAccessibleDescription(/Перетащите фотографию/);
  });

  it('disables the browser’s own touch handling on the surface', () => {
    // Without `touch-action: none` the browser claims the gesture and scrolls
    // the settings page while the member is dragging their face into the
    // circle. This is the one style worth asserting on.
    // Asserted on the class rather than the computed style: jsdom implements
    // no `touch-action` property, so it silently drops it from any inline
    // style — the utility class is the only form of this that is observable.
    render(<Harness />);
    expect(screen.getByTestId('avatar-crop-surface')).toHaveClass('touch-none');
  });

  it('returns to the default framing on reset', () => {
    render(<Harness initial={clampTransform(PORTRAIT, CROP_VIEWPORT, { zoom: 3, offsetX: 0, offsetY: 90 })} />);
    expect(stateOf().zoom).toBeCloseTo(3, 5);

    fireEvent.click(screen.getByRole('button', { name: 'Вернуть как было' }));

    expect(stateOf()).toEqual({ zoom: 1, offsetX: 0, offsetY: 0 });
  });

  it('never lets the slider push the image out of the mask', () => {
    // Zoomed in and panned to the vertical limit, then zoomed back out: the
    // offset that was legal at 3× is off the edge at 1×, and the control has to
    // correct it rather than leave a gap in the circle.
    render(
      <Harness initial={clampTransform(PORTRAIT, CROP_VIEWPORT, { zoom: 3, offsetX: 0, offsetY: 999 })} />,
    );
    expect(stateOf().offsetY).toBeGreaterThan(48);

    fireEvent.change(screen.getByRole('slider', { name: 'Масштаб фотографии' }), {
      target: { value: '0' },
    });

    const state = stateOf();
    expect(state.zoom).toBe(1);
    // 4032/3024 × 288 = 384 on screen; (384 − 288) / 2 = 48 is all the room a
    // portrait photo has at zoom 1.
    expect(Math.abs(state.offsetY)).toBeLessThanOrEqual(48);
  });
});
