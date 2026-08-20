import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { Section } from './section';

/**
 * A section is the anti-`WidgetCard`: the label, the count and the one link sit
 * *outside* the surface at `meta` weight, and the surface holds nothing but
 * rows. The tests below pin the three properties that make nine rows read as
 * one object rather than nine tiles.
 */
describe('Section', () => {
  it('puts the chrome outside the surface', () => {
    render(
      <Section label="Мои дела" count="3" action={<a href="/tasks">все ›</a>}>
        <div>Разобрать посудомойку</div>
      </Section>,
    );

    const body = document.querySelector<HTMLElement>('[data-slot="section-body"]');
    expect(body).not.toBeNull();
    expect(body).not.toContainElement(screen.getByRole('heading', { name: 'Мои дела' }));
    expect(body).not.toContainElement(screen.getByRole('link', { name: 'все ›' }));
    expect(body).toContainElement(screen.getByText('Разобрать посудомойку'));
  });

  it('uppercases the label in CSS, not in the string', () => {
    // §B2: `label` is 12/600 uppercase. Uppercasing the *text* would make a
    // screen reader spell it out and would break any word with a proper noun.
    render(
      <Section label="Мои дела">
        <div>row</div>
      </Section>,
    );
    // jsdom applies no CSS, so the accessible name is the raw string — which
    // is exactly the point: the uppercase is presentation, not content.
    const heading = screen.getByRole('heading', { name: 'Мои дела' });
    expect(heading.textContent).toBe('Мои дела');
    expect(heading.className).toContain('uppercase');
  });

  it('carries no shadow on the L1 surface', () => {
    // §B3: exactly one elevation level casts a shadow, and it is not this one.
    // `card.tsx` shipping `shadow-sm` on everything is what made six equal
    // cards look like six equal tiles.
    render(
      <Section label="Мои дела">
        <div>row</div>
      </Section>,
    );
    const body = document.querySelector<HTMLElement>('[data-slot="section-body"]');
    expect(body?.className).toContain('bg-card');
    expect(body?.className).not.toMatch(/\bshadow-/);
  });

  it('separates rows with an inset hairline, not a border', () => {
    render(
      <Section label="Мои дела">
        <div>a</div>
        <div>b</div>
      </Section>,
    );
    const body = document.querySelector<HTMLElement>('[data-slot="section-body"]');
    // `--hairline` divides rows inside one surface; `--border` outlines the
    // surface. The `ms-4` is the inset that starts the rule under the text.
    expect(body?.className).toContain('before:bg-hairline');
    expect(body?.className).toContain('before:ms-4');
  });

  it('offers the attention ground for the one block per screen that needs you', () => {
    render(
      <Section label="Требует внимания" surface="attention">
        <div>Вынести мусор</div>
      </Section>,
    );
    const body = document.querySelector<HTMLElement>('[data-slot="section-body"]');
    expect(body?.className).toContain('bg-surface-attention');
  });
});
