import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PageHeader } from '@/shared/components/PageHeader';
import { PageSlotsContext, type PageSlots } from './page-slots';
import { SideColumn } from './SideColumn';

/**
 * The two shell slots (§C4).
 *
 * These are worth a test because both failure modes are silent: a portal that
 * never fires renders *nothing at all* rather than something wrong, and a
 * `PageHeader` that keeps its title while the app bar also shows one renders
 * the page name twice down the left edge — which is the exact defect §C4 exists
 * to remove.
 */

function slots(overrides: Partial<PageSlots>): PageSlots {
  return {
    inShell: true,
    side: null,
    appBarTitle: null,
    appBarActions: null,
    desktop: false,
    barTitle: false,
    pageTitle: false,
    registerPageTitle: () => () => undefined,
    setSide: () => undefined,
    setAppBarTitle: () => undefined,
    setAppBarActions: () => undefined,
    ...overrides,
  };
}

describe('the side column', () => {
  it('renders into the shell aside when there is one', () => {
    const aside = document.createElement('aside');
    document.body.append(aside);

    render(
      <PageSlotsContext.Provider value={slots({ side: aside })}>
        <SideColumn>
          <p>Фильтры</p>
        </SideColumn>
      </PageSlotsContext.Provider>,
    );

    expect(aside.textContent).toBe('Фильтры');
    aside.remove();
  });

  it('renders in place outside the shell, so nothing vanishes from a screen test', () => {
    render(
      <SideColumn>
        <p>Фильтры</p>
      </SideColumn>,
    );

    expect(screen.getByText('Фильтры')).toBeInTheDocument();
  });
});

describe('band 1', () => {
  it('moves the title and the action into the app bar and leaves no empty header', () => {
    const titleSlot = document.createElement('div');
    const actionSlot = document.createElement('div');
    document.body.append(titleSlot, actionSlot);

    const { container } = render(
      <PageSlotsContext.Provider
        value={slots({ appBarTitle: titleSlot, appBarActions: actionSlot })}
      >
        <PageHeader title="Задачи" actions={<button type="button">Новое дело</button>} />
      </PageSlotsContext.Provider>,
    );

    expect(titleSlot.querySelector('h1')?.textContent).toBe('Задачи');
    expect(actionSlot.textContent).toBe('Новое дело');
    // Nothing but a title and an action: the in-page band would be an empty box.
    expect(container.querySelector('header')).toBeNull();
    titleSlot.remove();
    actionSlot.remove();
  });

  it('still renders the description in place', () => {
    const titleSlot = document.createElement('div');
    document.body.append(titleSlot);

    const { container } = render(
      <PageSlotsContext.Provider value={slots({ appBarTitle: titleSlot })}>
        <PageHeader title="Задачи" description="Кто и что делает" />
      </PageSlotsContext.Provider>,
    );

    expect(screen.getByText('Кто и что делает')).toBeInTheDocument();
    // The `<h1>` exists exactly once, and it is in the bar rather than the page.
    expect(container.querySelector('h1')).toBeNull();
    expect(titleSlot.querySelector('h1')?.textContent).toBe('Задачи');
    titleSlot.remove();
  });

  it('hoists on a phone too — the page must not repeat the bar title', () => {
    const titleSlot = document.createElement('div');
    document.body.append(titleSlot);

    const { container } = render(
      <PageSlotsContext.Provider value={slots({ desktop: false, appBarTitle: titleSlot })}>
        <PageHeader title="Задачи" />
      </PageSlotsContext.Provider>,
    );

    expect(titleSlot.querySelector('h1')?.textContent).toBe('Задачи');
    expect(container.querySelector('h1')).toBeNull();
    titleSlot.remove();
  });

  it('keeps a display title in the page below md, and claims it as such', () => {
    const titleSlot = document.createElement('div');
    document.body.append(titleSlot);
    const claimed: string[] = [];

    render(
      <PageSlotsContext.Provider
        value={slots({
          desktop: false,
          appBarTitle: titleSlot,
          registerPageTitle: (where) => {
            claimed.push(where);
            return () => undefined;
          },
        })}
      >
        <PageHeader displayTitle title="Доброе утро, Павел" />
      </PageSlotsContext.Provider>,
    );

    // §D1: the greeting is the screen's display line on a phone, so it stays in
    // the main column — and the claim tells the bar to stand its `<h1>` down.
    expect(
      screen.getByRole('heading', { level: 1, name: 'Доброе утро, Павел' }),
    ).toBeInTheDocument();
    expect(titleSlot.textContent).toBe('');
    expect(claimed).toEqual(['page']);
    titleSlot.remove();
  });

  it('hoists the same display title from md up', () => {
    const titleSlot = document.createElement('div');
    document.body.append(titleSlot);

    const { container } = render(
      <PageSlotsContext.Provider value={slots({ desktop: true, appBarTitle: titleSlot })}>
        <PageHeader displayTitle title="Доброе утро, Павел" />
      </PageSlotsContext.Provider>,
    );

    expect(titleSlot.querySelector('h1')?.textContent).toBe('Доброе утро, Павел');
    expect(container.querySelector('h1')).toBeNull();
    titleSlot.remove();
  });

  it('keeps everything in the page outside the shell', () => {
    render(<PageHeader title="Задачи" actions={<button type="button">Новое дело</button>} />);

    expect(screen.getByRole('heading', { level: 1, name: 'Задачи' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Новое дело' })).toBeInTheDocument();
  });
});
