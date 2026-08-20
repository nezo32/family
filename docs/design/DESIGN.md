# Design specification — «Наша семья»

Status: **binding for frontend work.** Read with `docs/DECISIONS.md`
(D5, D7, **D13–D15**), `docs/architecture/frontend.md` and
`docs/research/ios-pwa-push.md` §8–§12. §D7.14 additionally carries iOS media
claims verified from WebKit source on **2026‑08‑20**; re-verify before trusting
them in a year.

This document is the design direction and the implementable spec. It does not
contain application code. Where it names a file, that is the file to change.

Everything below was written against screenshots of the running build (see
§0.2). Where a claim has a number in it, that number was measured.

---

## 0. Preamble

### 0.1 What is already fixed — do not redo it

Two agents were working while this was written, and their work has landed:

- **`/settings` is already rebuilt** into grouped sections with quiet headings
  (УВЕДОМЛЕНИЯ / АККАУНТ / ПРИЛОЖЕНИЕ). The old "three 165px rows and a chevron
  950px from its label" is gone. §D8 builds on the new structure; it does not
  re-litigate it.
- **`shared/ui/date-field.tsx`, `time-field.tsx`, `date-time-field.tsx`,
  `field-shell.tsx`** now exist and replace the raw `<input type="date">` /
  `<input type="time">` controls. The "native controls dropped between styled
  ones" defect is solved at the field level. §D-forms therefore specs the
  _arrangement_ of those fields, not their appearance — with one change:
  `PickerSurface` must open a sheet on touch (§E).
- **Points / баллы are being deleted.** Nothing in this document renders a
  point, a score, a streak or a rank. `PLURALS.point` has already been removed
  from `RU_PLURALS`, which is why `/family` and the Сегодня load widget crash in
  the current build — that is a known in-flight breakage, not a design problem.

### 0.2 Screenshot inventory

Captured from `frontend/dist` (build of 20 Aug 01:39) served on a local static
server, driven by Playwright with the API stubbed by fixtures, `ru-RU`,
`Europe/Moscow`. Phone = 390×844 @2x, Desktop = 1440×900, plus 320×800 and
1024×800 checks.

| File                                                  | Screen                  | Viewport / theme  |
| ----------------------------------------------------- | ----------------------- | ----------------- |
| `today-phone-light/dark`                              | Сегодня                 | 390 both themes   |
| `today-desktop-light/dark`                            | Сегодня                 | 1440 both themes  |
| `today-320`                                           | Сегодня                 | 320 light         |
| `today-empty-phone`                                   | Сегодня, no data        | 390 light         |
| `today-loading-phone`                                 | Сегодня, pending        | 390 light         |
| `tasks-phone-dark`                                    | Задачи                  | 390 dark          |
| `tasks-desktop-light`, `tasks-desktop1024`            | Задачи                  | 1440 / 1024 light |
| `tasks-empty-phone`, `tasks-loading-phone`            | Задачи                  | 390 light         |
| `calendar-phone-dark`, `calendar-phone-light`         | Календарь               | 390               |
| `calendar-desktop-light`                              | Календарь               | 1440              |
| `goals-phone-light`, `goals-desktop-light`            | Копилки                 | 390 / 1440        |
| `shopping-phone-light`, `shopping-desktop-light`      | Покупки (списки)        | 390 / 1440        |
| `shopping-empty-phone`                                | Покупки, no lists       | 390               |
| `list-phone-light`, `list-phone-dark`                 | Покупки → список        | 390               |
| `list-phone-typed`                                    | список, «хлеб» typed    | 390 dark          |
| `list-desktop-light`                                  | список                  | 1440              |
| `list-320`                                            | список                  | 320               |
| `wall-phone-dark`, `wall-desktop-light`               | Стена                   | 390 / 1440        |
| `family-phone-light`, `family-desktop-light`          | Семья (crashes: points) | 390 / 1440        |
| `settings-phone-light`, `settings-desktop-light/dark` | Настройки               | 390 / 1440        |
| `settings-notifications-phone/-desktop`               | Уведомления             | 390 / 1440        |
| `settings-profile-phone`, `settings-accounts-phone`   | Профиль / Способы входа | 390               |
| `admin-members-desktop`                               | Участники               | 1440              |
| `task-create-phone-dark`, `task-create-desktop`       | «Новое дело» modal      | 390 / 1440        |
| `event-create-phone-dark`, `event-create-desktop`     | «Новое событие» modal   | 390 / 1440        |
| `goal-create-phone-dark`                              | «Новая копилка» modal   | 390               |
| `notif-panel-phone`                                   | Notifications panel     | 390               |
| `login-anon-phone/-desktop`, `register-anon-phone`    | Вход / Регистрация      | 390 / 1440        |

Measured facts used below:

```
tab bar background     oklab(0.9905 0.00068 0.00646 / 0.95)
page background        oklch(0.9905 0.0065  84)        ← the same colour
phone content column   x=16  w=358      (page gutter 16)
desktop sidebar        240px
desktop <main>         x=240 w=1200,  content column x=328 w=1024
«Новое дело»   phone   dialog 358 × 1326, top 63     (viewport 844)
«Новое дело»   desktop dialog 512 × 1030, top 68     (viewport 900)
«Новое событие» phone  dialog 358 × 1640, top 34     (viewport 844)
«Новое событие» desktop dialog 672 × 1198, top 36    (viewport 900)
/settings/notifications  4820px tall on phone, 3774px on desktop
/tasks                   2232px tall on phone
```

---

## A. Direction

> **«Кухонная доска» — the kitchen board: the app is the note surface by the
> front door, not a dashboard of the household.**

A dashboard's job is to display state. A board's job is to hold _the next thing
someone has to do_, at a size you can read while putting your shoes on. Five
people share this app — two parents, a teenager, a ten-year-old and a
grandmother — and none of them opened it to review metrics. They opened it to
find out whether anything needs them, and to add one thing.

The current build is a dashboard. On Сегодня it stacks six white cards of near
identical weight and height (1661px on an 844px screen) each with its own icon,
its own count and its own «Все задачи ›» footer — the phrase «Все задачи»
appears **twice on one screen**. Nothing is louder than anything else, so
nothing is answered in three seconds. That is the thing to fix.

**What the board implies**

1. **One loud thing per screen.** At most one block may use the tinted ground,
   the display face and a filled primary button. Everything else is quiet rows.
   A screen where six things shout is a screen where nothing was decided.
2. **Rows, not tiles.** A board holds notes of different sizes pinned to one
   surface; a dashboard holds equal tiles in a grid. Sections get a quiet
   uppercase label and hairline-separated rows — the move the settings rebuild
   already made, and it visibly worked. `WidgetCard` per widget goes away.
3. **Paper, not glass.** Surfaces are opaque. No `backdrop-blur` over content,
   no `/95` alphas, no shadow on an in-page card. Translucency is not a style
   choice here, it is the direct cause of two live bugs: the shopping composer
   shows the list bleeding through it, and the tab bar is literally the page
   background at 95 % opacity, which is why it does not read as a bar.
4. **Legible from arm's length, by a child and by a grandmother.** Body rows at
   17px/500, never a weight below 400, never uppercase for content, never a
   grey-on-grey caption carrying information you need. If a label must be small
   it must also be optional.
5. **The fast path is the design.** Adding «ужин у бабушки» is two taps and one
   typed line (§D-forms). Anything that cannot be defaulted goes behind one
   «Подробнее» row.

**What it rules out**

- Data-dashboard furniture: sparklines, stat tiles in a row, percentage rings
  paired with a second progress bar for the same number (Копилки does this
  today — two indicators, one value, per card).
- Anything competitive. D5 already bans points and ranking; this direction also
  bans the _shape_ of it — leaderboards, medals, "лучший", ordering people by
  effort.
- Chrome that repeats. One «все задачи» link per screen, on the section header,
  not a footer row on every card.
- Skeuomorphism. No cork texture, no paper grain, no tape. The board is a way of
  thinking about hierarchy, not a picture of a board.
- Gestures as the only path to a feature (§C-gestures, rule 1).

**The signature: the day rail.**

Every list screen in this app is a list of things with a time. Сегодня, Задачи,
Календарь and the week view all share exactly one axis, and only Календарь uses
it. Promote it: a fixed 56px left rail down every time-ordered list carrying the
time («19:00»), the day marker («СЕГОДНЯ», «ЗАВТРА», «сб 22») and a 3px vertical
tick in the responsible member's colour. Rows hang off it. The rail is what
makes Сегодня, Задачи and Календарь read as three views of one board rather than
three separate products, and on desktop it becomes a real column instead of an
indent. It carries information (when, and whose), so it earns its place —
unlike the numbered eyebrows and icon chips it replaces.

**The second device: the member disc.** A 24px circle with the member's initial
in their own colour, used identically for assignee, attendee, contributor,
requester and author. See §B4 — this is also what finally puts `--chart-1..5` to
work.

---

## B. Foundations

Keep `src/index.css` as the single source. Everything below is a change to that
file plus the token names implementers use.

### B1. Palette — keep it, with three additions

The «Тёплый дом» ramp stays exactly as it is. It was chosen with reasons that
still hold, the AA contrast work on `--primary` is real, and the dark mode is
genuinely warm rather than blue-black. Re-picking it would burn work for
nothing.

Three additions:

```css
:root {
  /* Tinted ground for the one "needs you now" block per screen.
     Not --card: it must read as a different KIND of surface, not a lighter one. */
  --surface-attention: oklch(0.9705 0.0225 42); /* clay wash        */
  --surface-attention-fg: oklch(0.3585 0.0985 34);
  --surface-calm: oklch(0.9645 0.0265 150); /* sage wash, "done"*/
  --surface-calm-fg: oklch(0.3285 0.0525 150);
  /* The rail / hairline that separates rows inside one surface.
     Lighter than --border, which is for the outline of a surface. */
  --hairline: oklch(0.9285 0.0125 80);
}
.dark {
  --surface-attention: oklch(0.2685 0.0345 38);
  --surface-attention-fg: oklch(0.8585 0.0705 40);
  --surface-calm: oklch(0.2585 0.0285 152);
  --surface-calm-fg: oklch(0.8785 0.0505 150);
  --hairline: oklch(1 0 0 / 8%);
}
```

Expose all five through `@theme inline` as `--color-surface-attention`,
`--color-surface-attention-foreground`, `--color-surface-calm`,
`--color-surface-calm-foreground`, `--color-hairline`.

Add `--font-display` (§B2) and `--spacing-rail: 3.5rem` (the day rail, §C3).

### B2. Type

**Two faces.** Body and UI stay **Inter** — it has real Cyrillic, it is already
the stack, and an installed PWA should not wait on a font to render a chore.

Display becomes **Onest** (SIL OFL, self-hosted, `cyrillic` + `latin` subsets,
weights 600 and 700 only, `font-display: swap`, precached by the service
worker). Onest is drawn Cyrillic-first — «д», «з», «я», «ф» are designed rather
than adapted from a Latin skeleton — its terminals are slightly rounded, which
sits with `--radius: .75rem`, and at 600/700 it gives a heading enough weight
contrast to actually be a heading. Two weights, cyrillic subset, ≈ 40 KB total.

This is the one aesthetic risk in this document, and the fallback is exact:

```css
--font-display: 'Onest', 'Inter var', 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
```

If Onest is not shipped, everything degrades to today's appearance. It is never
load-bearing for legibility.

**Scale.** Sizes are px, `rem`-authored. Line heights are absolute.

| Token     | Size / LH                           | Weight                  | Face  | Used for                                                                            |
| --------- | ----------------------------------- | ----------------------- | ----- | ----------------------------------------------------------------------------------- |
| `display` | 28 / 34                             | 700                     | Onest | The greeting on Сегодня; a goal's saved amount. **Max one per screen.**             |
| `h1`      | 22 / 28                             | 700                     | Onest | Page title (`PageHeader`), sheet title                                              |
| `h2`      | 17 / 24                             | 600                     | Onest | Section heading inside a screen; the title of a detail sheet's group                |
| `row`     | 17 / 24                             | 500                     | Inter | **The tappable line of a row** — task title, item name, event title, settings label |
| `body`    | 15 / 22                             | 400                     | Inter | Descriptions, notes, empty-state copy                                               |
| `meta`    | 13 / 18                             | 500                     | Inter | Time, quantity, category, counts, "3 задачи"                                        |
| `label`   | 12 / 16                             | 600, +0.06em, uppercase | Inter | Section labels only (ОВОЩИ, СЕГОДНЯ, УВЕДОМЛЕНИЯ). **Never for content.**           |
| `input`   | 17 / 24 touch, 15 / 22 pointer:fine | 400                     | Inter | Every text control. Never below 16 on coarse.                                       |

Rules:

- No weight below 400 anywhere. The current build has `text-xs
text-muted-foreground` doing real work (the shopping quick-add hint, the
  «Начисляются тому, кто…» help text); at 12/400 muted that is decoration.
  Promote to `meta` 13/500 or delete it.
- `row` is **17px, not 16.** This is the iOS body size and this app is read by a
  ten-year-old and a grandmother. It costs about one row per screen and buys
  the whole audience.
- Numbers that are compared (money, quantities, times) use
  `font-variant-numeric: tabular-nums`.
- Never centre more than two lines of text. The current `EmptyState` centres a
  three-line description inside `max-w-xs`; cap it at two lines or left-align.

### B3. Spacing, radius, elevation

**Spacing scale**: `4 · 8 · 12 · 16 · 24 · 32 · 48`. Nothing else. No 6, no 10,
no 14, no 20.

- Page gutter: **16** (< md) · **24** (md–lg) · **40** (≥ xl).
- Row vertical padding: **12** → 56px row. **16** → 68px row in «я в магазине».
- Gap between rows in one group: **0** (hairline separated).
- Gap between groups in one section: **8**.
- Gap between sections: **24**.
- Gap between a section label and its first row: **8**.

**Radius**: `8` inputs, chips, small buttons · `12` rows, cards, panels ·
`16` sheets, dialogs, popovers · `full` avatars, member discs, the active tab
pill. Nothing else. Delete `--radius-2xl` usage.

**Elevation — exactly three levels, and only one of them casts a shadow.**

| Level       | Surface        | Border                    | Shadow                               | What                                                       |
| ----------- | -------------- | ------------------------- | ------------------------------------ | ---------------------------------------------------------- |
| L0 ground   | `--background` | —                         | none                                 | The page                                                   |
| L1 surface  | `--card`       | 1px `--border`, radius 12 | **none**                             | Every in-page card, list panel, row group                  |
| L2 floating | `--popover`    | 1px `--border`, radius 16 | `0 12px 32px -12px rgb(0 0 0 / .28)` | Dialogs, sheets, popovers, toasts, the notifications panel |

`shared/ui/card.tsx` currently ships `shadow-sm` on every card. Remove it. The
whole point of the warm palette is that white `--card` on sand `--background`
already separates; adding a shadow to that is belt, braces and a third belt, and
it is what makes six equal cards look like six equal tiles.

Inside an L1 surface, rows are separated by a **1px `--hairline`, inset by the
row's left padding** so it starts under the text, not under the tick — the
standard iOS list rule, and it makes a 9-row list read as one object.

### B4. Colour that means something

Today the app uses `--primary` for every affordance and `--chart-1..5` for
nothing. Fix both.

**One filled primary per view.** `--primary` marks the single action the user
came to this screen to perform. On Покупки that is _not_ «Новый список» (a
full-width clay button is currently the loudest thing on a screen whose job is
to show you three lists) — it is opening a list. Everything else is
`variant="ghost"` or `variant="secondary"`.

**Status colours, and what they are allowed to tint.**

| Meaning                      | Token                           | Applied to                                                                                                                   |
| ---------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Просрочено                   | `--destructive`                 | The row's 3px left rail + the word «Просрочено». **Not the row background.** Four overdue tasks must not be four pink boxes. |
| Скоро (< 2 ч), не отправлено | `--warning`                     | The meta line only                                                                                                           |
| Сделано / куплено / собрано  | `--success` on `--surface-calm` | The tick fill; a done group's ground                                                                                         |
| Требует решения              | `--surface-attention`           | The one attention block per screen (§C2)                                                                                     |
| Удалить                      | `--destructive`                 | Text + icon of the destructive action, never a filled button except inside a confirm dialog                                  |

**Member identity — this is what `--chart-1..5` is for.**

The family has five people and the theme has five chart colours: clay, sage,
honey, plum, sky, both light and dark ramps, already perceptually spaced. Assign
`chart-{(sortOrder % 5) + 1}` to each member and use it _everywhere a person
appears_:

- the **member disc** — 24px circle, member colour at 18 % as ground, member
  colour at full as the initial, used for assignee, attendee, contributor,
  requester, wall author;
- the **day-rail tick** on a task row assigned to someone;
- the event bar in the calendar agenda.

(There were fairness bars on Семья in this list. They are gone — see §C4 and
D5. Nothing draws a split of the housework any more, so nothing needs a member
colour for one.)

Stop rendering `users.color` for these. The seeded values (`#2563eb`,
`#db2777`, `#16a34a`, `#f59e0b`, `#7c3aed`) are stock cold Tailwind hues that
fight the warm palette on every screen they appear on — visible in
`today-desktop-light`, where a pink «БН» disc sits on a sand card. Keep the
column (a member may still pick one, and it is used for the ICS feed), but the
UI renders from the ramp. If the family wants to choose, let them choose _one of
the five_.

**Never colour alone.** Overdue also says «Просрочено». Done also has a tick.
A member disc also has an initial. Assume one of the five is colour-blind.

---

## C. Layout system

This is the part to get right.

### C1. Breakpoints and the container

Tailwind defaults, used properly.

| Range                | Shell                      | Content                                                                                            |
| -------------------- | -------------------------- | -------------------------------------------------------------------------------------------------- |
| **< 768** (`base`)   | Top bar + bottom tab bar   | One column. Gutter 16. Full width.                                                                 |
| **768–1023** (`md`)  | Sidebar rail 240 + top bar | One column, **max 640, left-aligned**, gutter 32. Not centred in a void.                           |
| **1024–1279** (`lg`) | Sidebar 240 + top bar      | **Two columns**: main `minmax(420px, 720px)` + side `320px`, gap 24, gutter 32                     |
| **≥ 1280** (`xl`)    | Sidebar 240 + top bar      | Two columns: main `minmax(480px, 760px)` + side `360px`, gap 32, gutter 40, container max **1360** |
| **≥ 1536**           | as `xl`                    | Do **not** grow the columns. Grow the gutters.                                                     |

Today `AppShell` uses one `mx-auto max-w-3xl xl:max-w-5xl`, which at 1440
produces a 1024px column centred inside 1200px of `<main>` — measured. That is
the "stretched phone" the review named, and it is the same mistake at every
width: one column, wider.

### C2. How a screen is composed

Every screen is the same four bands, in this order:

```
┌─────────────────────────────────────────┐
│ 1 TITLE      h1 + one primary action    │  ≤ 88px, never scrolls away on ≥md
├─────────────────────────────────────────┤
│ 2 ATTENTION  at most ONE block          │  --surface-attention; omitted when nothing needs you
├─────────────────────────────────────────┤
│ 3 BODY       sections of hairline rows  │  the screen
├─────────────────────────────────────────┤
│ 4 QUIET      counts, links, hints       │  meta, no box
└─────────────────────────────────────────┘
```

Band 2 is the rule that fixes Сегодня. There is exactly one attention block per
screen and it is chosen by a fixed precedence: **overdue tasks → pending member
approvals → urgent shopping → nothing.** Everything that does not win is a
normal section in band 3.

**Content measures.**

- Prose: max **68ch**.
- **A row is never wider than 720px.** If the column is wider, the row's
  _surface_ may be full-bleed but its content is capped at 720 and left-aligned,
  so the trailing chevron / switch / delete sits at content-right.

  This is the single rule that kills the "label at x=378, chevron at x=1326"
  class of defect, and it is not hypothetical — `list-desktop-light` shows a
  shopping row 1024px wide with «Картошка» at x=386 and its 🗑 at x=1325.
  **≈ 900px of nothing between an item and its delete button.**

- Anything that is genuinely a table (the notification matrix, the members
  admin list) is exempt and may use the full column.

### C3. The day rail

Any list whose rows have a time renders inside a rail:

```
 56px │  rest of the row
──────┼───────────────────────────────────
      │  СЕГОДНЯ  20 августа        3 дела     ← section header (label + count)
19:00 ┃  Ужин у бабушки                        ← ┃ = 3px tick, member/event colour
      │  Ул. Садовая, 12
──────┼───────────────────────────────────
18:00 ┃  Родительское собрание
      │  Школа №4
```

- Rail width `--spacing-rail: 3.5rem` (56px) at every breakpoint. It does not
  grow; the content column does.
- Rail content is `meta` 13/500, `tabular-nums`, right-aligned, top-aligned with
  the row title's cap height.
- The tick is 3px wide, full row height minus 8px, radius full.
- All-day rows put «весь день» in the rail instead of a time.
- Rows without a time (a shopping item, a settings row) do not use the rail.

### C4. What fills a 1440px screen

The side column is not filler. Each screen already _has_ the content — it is
currently stacked below the fold or crammed above the list on a phone.

| Screen           | Main column                                      | Side column (≥ lg)                                                   |
| ---------------- | ------------------------------------------------ | -------------------------------------------------------------------- |
| Сегодня          | Attention block + Мои дела + Сегодня в календаре | Неделя (7 compact day rows) · Копилка · Заявки                       |
| Задачи           | The task list                                    | **Фильтры** (moved out of the phone chip wall)                       |
| Календарь        | Agenda or month grid                             | Mini month grid · «Подписаться на календарь»                         |
| Копилки          | Goal rows                                        | Сводка (накоплено / в работе / достигнуто)                           |
| Покупки → список | Items                                            | «Часто покупаем» · «Уже куплено» (collapsed)                         |
| Стена            | The feed: compose row · head · the stream        | «Что решили» · «Спасибо» — **≥ lg only** (§D7.3a)                    |
| Семья            | Members                                          | — the fairness panel was removed (D5); nothing replaced it           |
| Настройки        | The selected section                             | The section nav — Профиль / Уведомления / Способы входа / Оформление |
| Участники        | The queue                                        | Roles legend + counts                                                |

Two consequences worth stating:

1. **On desktop the top bar earns its keep.** Today `TopAppBar` is 1200px wide
   and holds a section title on the left and a bell + avatar on the right, with
   ~1000px of nothing between. On ≥ md it should carry the **page title and the
   screen's one primary action**, and `PageHeader` then renders only its
   description and filters. Measured: `topbar` is 1200×57 at x=240 with two
   controls in it.
2. **The side column collapses, it does not disappear.** Below `lg` its contents
   move to the bottom of the main column in the same order, except Фильтры,
   which becomes a single «Фильтры · 3» row that opens a sheet.

### C5. Density targets

A phone screen should answer its question inside **1.5 viewports** (≈ 1260px).
Measured today:

| Screen           | Now  | Target                                        |
| ---------------- | ---- | --------------------------------------------- |
| Сегодня          | 1661 | ≤ 1100                                        |
| Задачи           | 2232 | ≤ 1300 (filters into a sheet, rows 56 not 96) |
| Уведомления      | 4820 | ≤ 1400 (matrix, §D9)                          |
| Покупки → список | 1280 | ≤ 1280 (fine; fix the overlap instead)        |

---

## D. Screens

Common conventions for every spec below: **loading** = a skeleton with the same
shape and count as the real content, minimum 250 ms on screen so it cannot
flash, and on a _refetch_ the old data stays visible with a 2px `--primary`
progress bar under the app bar instead of blanking. **Error** = `ErrorState`
with a retry. **Empty** = `EmptyState` with **a required action** — an empty
screen is an invitation, and `EmptyState.action` becomes non-optional (§E).

---

### D1. Сегодня — the home screen

**What the user came for:** "does anything need me before I put my shoes on?"

**Hierarchy.** One attention block, then my day, then the family's day, then
quiet links. The word «Все задачи» appears at most once.

**Phone**

```
┌────────────────────────────────────────┐
│ Сегодня                        🔔²  (П)│  app bar, pt-safe
├────────────────────────────────────────┤
│ 🌙 Доброе утро, Павел                  │  display 28/700
│ четверг, 20 августа                    │  meta
│                                        │
│ ┏━━ требует внимания ━━━━━━━━━━━━━━━┓  │  --surface-attention, radius 12
│ ┃ ⏰ Просрочено                    1 ┃  │  h2 + count
│ ┃ ○ Вынести мусор                   ┃  │  row 17/500, tick 32px
│ ┃   срок был в 08:00 · Саша         ┃  │  meta, destructive
│ ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛  │  ← swipe row = сделано
│                                        │
│ МОИ ДЕЛА                    3 · все ›  │  label + count + ONE link
│ ┌────────────────────────────────────┐ │
│ │ ○  Разобрать посудомойку           │ │  56px rows, hairline separated
│ │    до 10:00 · Кухня                │ │
│ │ ○  Забрать Лизу из садика          │ │
│ │ ○  Полить цветы                    │ │
│ └────────────────────────────────────┘ │
│ Сегодня в семье закрыли 2 дела.        │  meta, quiet
│                                        │
│ СЕГОДНЯ И ЗАВТРА          3 · всё ›    │
│ ┌────────────────────────────────────┐ │
│ │ 19:00 ┃ Ужин у бабушки             │ │  ← day rail
│ │       │ Ул. Садовая, 12            │ │
│ │ 18:00 ┃ Родительское собрание      │ │
│ │ ЗАВТРА                             │ │
│ │ 17:00 ┃ Тренировка Саши            │ │
│ └────────────────────────────────────┘ │
│                                        │
│ НАДО КУПИТЬ                  10 · ›    │
│ ┌────────────────────────────────────┐ │
│ │ ⚠ Хлеб бородинский  1 шт           │ │  urgent only, max 3
│ └────────────────────────────────────┘ │
│                                        │
│ КОПИЛКА                                │
│ ┌────────────────────────────────────┐ │
│ │ Домик · Поездка в Карелию          │ │
│ │ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░  94 %          │ │  ONE indicator
│ │ 112 500 ₽   осталось 7 500 ₽       │ │  tabular-nums
│ └────────────────────────────────────┘ │
└────────────────────────────────────────┘
```

Changes from today: no per-widget `WidgetCard`; no per-card footer link row (six
of them today, ~330px of pure chrome); the events widget merges «сегодня» and
«завтра» into one railed list; the goal card loses its duplicate ring; the
approvals block only appears when the attention slot is not already taken by
something more urgent, otherwise it becomes a plain section.

**Desktop (≥ lg)**: main = attention + Мои дела + Календарь; side = Неделя (7
compact rows: `пн 17 · 2 дела · 1 событие`) then Копилка then Заявки. The
greeting moves into the top bar on ≥ md; the display line stays in the main
column only below md.

**Empty**: keep «Сегодня свободно 🎉» on `--surface-calm` — it is the best copy
in the app. Add the missing invitation: two ghost buttons «Добавить дело» /
«Записать событие» under it, and delete the residual «Ближайшая цель / Пока нет
активных копилок» card, which currently occupies a whole surface to say nothing.

**Loading**: greeting renders immediately from `useMe` (no skeleton on a name we
already have), then one 120px attention-shaped block and 3 × 56px row skeletons.

---

### D2. Задачи

**What the user came for:** "what is mine, and what is late."

**Hierarchy.** Overdue → today → this week → later. Filters are not content and
must not be the first 200px of the screen.

The current phone screen is 2232px and opens with a full-width clay button and
**12 filter chips across four wrapped rows**. Task cards are ~96px with a green
band across the bottom holding a floating avatar — it reads as an unfinished
element, and it must go.

**Phone**

```
┌────────────────────────────────────────┐
│ ‹ Задачи                    ⊕     🔔  │  primary action moves to the app bar
├────────────────────────────────────────┤
│ [ Мои ] [ Все ]            Фильтры · 2 │  segmented + ONE filter row → sheet
│                                        │
│ ПРОСРОЧЕНО                        1    │
│ ┌────────────────────────────────────┐ │
│ │ ○ ┃ Вынести мусор            (С) › │ │  56px; ┃ member colour;
│ │   ┃ 08:00 · Кухня · просрочено     │ │  member disc replaces the green band
│ └────────────────────────────────────┘ │
│ СЕГОДНЯ                           3    │
│ ┌────────────────────────────────────┐ │
│ │ ○ ┃ Разобрать посудомойку     (П) ›│ │
│ │ ○ ┃ Забрать Лизу из садика    (М) ›│ │
│ │ ○ ┃ Полить цветы              (Л) ›│ │
│ └────────────────────────────────────┘ │
│ НА НЕДЕЛЕ                         5    │
│ …                                      │
└────────────────────────────────────────┘
```

- The row: 32px tick · 3px member tick · title `row` · meta `13` · member disc ·
  chevron. **56px**, not 96. Nine tasks ≈ 520px instead of ≈ 1000.
- Swipe left on a row = «сделано» with undo (§C-gestures). Long-press = the
  action sheet (изменить / назначить / пропустить / попросить подмениться /
  удалить), which is the same sheet the chevron opens as a detail.
- Filters: a `Мои / Все` segmented control (the only filter used daily) plus one
  «Фильтры · N» row that opens a sheet with assignee, category and «показывать
  выполненные». The count on the row is the discoverability.

**Desktop**: main = the grouped list, rows 56px, full 720 measure. Side =
Фильтры expanded as a real panel (this is where 12 chips are fine), and nothing
else. «Нагрузка за неделю» used to sit under it as neutral bars; the owner asked
for it gone («убери "нагрузку" - это не нужно») and D5 records why it is not
coming back — not as a bar, not as a number, not in an `aria-label`. **Do not**
put task cards in a 3-column grid — `task-create-desktop` shows the current grid
producing 215px cards with «Убрать в комнате» wrapping onto three lines.

**Empty**: «Дел пока нет» + «Добавить дело». Filtered-empty is a different
message: «Ничего не нашлось» + «Сбросить фильтры».

**Loading**: 3 section headers + 3/3/5 row skeletons at 56px.

---

### D3. Календарь

**What the user came for:** "what is happening, and when."

The current phone screen spends **~370px (44 % of the viewport)** on chrome
before the first event: title, subtitle, a full-width «+ Событие» button, a
month stepper with «Сегодня», and a Список/Месяц segmented control. Then, at the
very bottom of the page, a loose ICS-subscription paragraph that also exists in
Настройки.

**Phone**

```
┌────────────────────────────────────────┐
│ ‹ Август 2026            ⊕      🔔    │  month is the title; ⊕ creates
├────────────────────────────────────────┤
│ [ Список ]  [ Месяц ]        Сегодня   │  one control row, 44px
│                                        │
│ СЕГОДНЯ  20 августа                    │
│ 19:00 ┃ Ужин у бабушки                 │
│       │ Ул. Садовая, 12                │
│ 18:00 ┃ Родительское собрание          │
│ ЗАВТРА                                 │
│ 17:00 ┃ Тренировка Саши                │
│ СУББОТА, 22 АВГУСТА                    │
│ 15:00 ┃ Кино с Лизой                   │
└────────────────────────────────────────┘
```

- Month navigation moves into the app-bar title: `‹ Август 2026 ›`, with
  «Сегодня» appearing only when you are not on the current month.
- Delete the `SubscribePanel` from this page. It already lives at
  Настройки → «Календарь на телефоне», which is where a once-per-device setup
  belongs.
- Month grid: keep, but each day cell shows **up to two 3px colour ticks and a
  count**, never truncated event titles at 390px.

**Desktop**: main = month grid at full measure (cells ≥ 96px, event titles
readable), side = today's agenda + «Подписаться». On `lg` and above the two
views are simultaneous, so the Список/Месяц control is phone-only.

**Empty**: «В календаре пусто» + «Записать событие».

---

### D4. Копилки

**What the user came for:** "how close are we."

Current desktop uses 570 of 900px of height and 1024 of 1200px of width for
three cards, and each card carries **two indicators for one number** (a
percentage ring at top-left and a progress bar glued to the card's bottom edge),
with «Пополнить» floating at a different height in each card because the titles
wrap differently.

**Phone** — rows, not cards:

```
│ НАКОПЛЕНО                              │
│ 178 500 ₽        2 в работе · 1 готова │  display 28/700 + meta
│                                        │
│ ┌────────────────────────────────────┐ │
│ │ 🏕  Поездка в Карелию          63 %│ │  row 17/500 + tabular meta
│ │    ▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░             │ │  6px bar, goal colour
│ │    112 500 из 180 000 ₽   до 01.06 │ │  meta
│ │                        (П)(М)   ›  │ │  contributor discs
│ └────────────────────────────────────┘ │
│ │ 🧊  Новый холодильник          28 %│ │
│ │ 🚲  Велосипед Саше  ✓ собрана      │ │  --surface-calm ground
```

- **One indicator per goal**: the bar. The ring survives only on the goal detail
  screen, where it is the hero and there is no bar.
- «Пополнить» is not on the row. It is the primary action on the goal detail
  screen and a long-press/swipe action on the row. One filled primary per view.
- Reached goals move to a `--surface-calm` group at the bottom under «СОБРАНО».

**Desktop**: main = the rows at 720 measure; side = the summary block (which is
currently a full-width three-stat bar eating the top of the page). At `xl` the
rows may go two-up **only if** each stays ≥ 340px — otherwise one column. Never
three-up.

**Empty**: «Пока не копим» + «Новая копилка».

---

### D5. Покупки — списки

**What the user came for:** "open the list I am about to shop from."

Small changes only; this screen is close.

- «Новый список» stops being a full-width filled button. It becomes the app-bar
  `⊕` on phone and a `variant="secondary"` button in the top bar on desktop.
  Opening a list is the primary action here.
- «Показать архив» is currently a right-aligned orphan above the first row. Move
  it to the bottom of the list as a quiet `meta` link.
- Row: icon tile 44 · name `row` · «7 из 11» `meta` · needed-count badge ·
  `⋯`. Keep.
- Fix the pluralisation: the build renders «3 из 3 позиции». Route it through
  `RU_PLURALS.lineItem`.
- Desktop: rows at 720 measure, not 1024. Two-up at `xl`.

**Empty**: «Списков пока нет» + «Новый список» + one line explaining that lists
are shared and work offline.

---

### D6. Покупки → список — the screen that is broken

**What the user came for:** to add three things in ten seconds, or to walk round
a shop ticking them off.

**Root cause of the reported "chopped" composer**, confirmed in
`list-desktop-light` and `list-phone-typed`:

`ListPage.tsx` wraps `QuickAddBar` in

```
sticky bottom-0 z-20 -mx-4 border-t bg-background/95 px-4 pt-3 pb-safe backdrop-blur-sm
```

Three defects compound:

1. **`bottom: 0` is the viewport bottom, and the viewport bottom is behind the
   fixed tab bar.** On a phone the bar is 56px + `env(safe-area-inset-bottom)`
   ≈ 34px = 90px of the composer covered. The textarea is the tallest element in
   the block, so it is what gets cut — «хлеб» sliced through the middle. The
   hint line and the suggestion chips end up entirely underneath.
2. **On desktop it parks mid-list.** `list-desktop-light` shows the composer
   sitting on top of the «МЯСО» group with «Куриное филе» ghosted behind the
   «ЧТО КУПИТЬ» label and «Кофе молотый» stranded below it.
3. **`bg-background/95 backdrop-blur-sm`** lets the list bleed through, which is
   why it reads as a broken box rather than a bar.

**Fix.**

```
< md :  position: sticky;
        bottom: calc(var(--spacing-tabbar) + env(safe-area-inset-bottom, 0px));
        background: var(--card);          /* opaque */
        border-top: 1px solid var(--border);
        box-shadow: 0 -8px 24px -18px rgb(0 0 0 / .35);
        /* no pb-safe — the offset above already clears the indicator */
≥ md :  not sticky at all. The composer moves to the TOP of the list,
        directly under the title. There is no thumb and no software keyboard
        on a desktop; the input belongs where the list begins.
```

And a structural rule so it can never grow into the bar again: **the composer is
at most three rows tall.** `textarea` `max-height: 96px` (≈ 4 lines, then it
scrolls internally); the «Добавим N позиций» hint sits inline on the right of
the composer, not on its own line; the suggestion chips move **above** the
composer, between the list and the input, so growth pushes into the list.

**Phone**

```
┌────────────────────────────────────────┐
│ ‹ Пятёрочка          [я в магазине] ⋯ │  app bar; switch as a 44px control
├────────────────────────────────────────┤
│ ЧАСТО ПОКУПАЕМ                         │  horizontal scroller,
│ ‹ +Хлеб  +Яйца  +Масло  +Сыр  →       │  WITH an edge fade + a › affordance
│                                        │  (today «Масло сливочное» is clipped
│ ОВОЩИ                                  │   and a bare «+» hangs off-screen)
│ ○ Картошка            3 кг         🗑 │  56px, hairline separated
│ ФРУКТЫ                                 │
│ ○ Яблоки              1,5 кг       🗑 │
│ ХЛЕБ                                   │
│ ○ Хлеб бородинский ┃  1 шт · срочно 🗑│  ┃ destructive rail for urgent
│ …                                      │
│ › УЖЕ КУПЛЕНО                       4  │  collapsed group, --surface-calm
├────────────────────────────────────────┤
│  Молоко   Хлеб   Яйца   Картошка       │  suggestions ABOVE the composer
│ ┌──────────────────────────────┐  ┌──┐│
│ │ Например, 2 кг картошки      │  │ +││  composer, opaque, ≤96px
│ └──────────────────────────────┘  └──┘│
│           Добавим 1 позицию            │  inline meta
└────────────────────────────────────────┘
   ↑ bottom = tabbar + safe-area
```

- Swipe left on an item = «куплено» (reversible, so it is safe on a gesture).
  **Delete is never on a swipe** — it stays on the visible 🗑 and in the
  long-press sheet.
- «я в магазине» keeps its 68px rows and 44px ticks and hides the 🗑.

**Desktop**: composer at the top; items at 720 measure so the 🗑 sits 24px right
of the quantity instead of 900px away; side column carries «Часто покупаем» as a
vertical list and «Уже куплено» expanded.

**Empty**: «Список пуст» + the composer, focused. Do not render an `EmptyState`
illustration above a composer that is already the invitation.

---

### D7. Стена — the feed

**What the user came for:** "what did the family say, and does anything need me."

#### D7.0 This section reverses the one it replaces, on purpose

Until this pass Стена was a **board**: twelve notes on one surface, ordered by
meaning (open questions → pinned → what happened), a «Что было раньше» tail, and
no composer anywhere on screen. The principle was the README's line —
_deliberately not a chat, Telegram already exists_ — made structural.

The owner has asked for the opposite shape, in these words:

> «она должна быть как у VK или instagram, не делить явно на секции и тп»

So Стена becomes **one continuous stream of cards**, and every explicit section
header on this screen is deleted. That is the direction, and the rest of this
section builds it.

But the board was not decoration, and three of its refusals were load-bearing.
They are restated below as feed mechanics rather than as sections, because the
failures they prevented are still available in a feed — more available, in fact.
A future reader must not conclude the reversal was carelessness: it was a change
of _shape_, and D7.1 is the list of what was carried across intact.

**Consequence of getting this wrong:** the family gets an infinite scroll they
feel behind on, an unanswered question buried under «Лиза полила цветы», and a
worse Telegram with fewer people in it. All three are one decision away at every
point below, which is why each one is named where it can be lost.

#### D7.1 What the board was protecting, and where it now lives

| The board's refusal                    | Why it existed                                                                                       | Where it lives in the feed                                                                                                             |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Finite — twelve notes, then a tail** | An unbounded feed creates obligation. Six people must not feel behind on their own kitchen wall.     | **The feed ends, and it says so** (D7.9). Auto-load is bounded to four pages, then asks. No unread badge on the tab, ever.             |
| **Ordered by meaning, not by clock**   | An unanswered poll and «Лиза полила цветы» are not the same kind of object.                          | **A floating head** (D7.4) and **card size** (D7.6). What needs answering never scrolls away; activity coalesces instead of competing. |
| **No composer on screen**              | A text field at the bottom of a stream is the one feature that turns a noticeboard into a messenger. | **A compose row that cannot receive text** (D7.5), at the top, opening the same one door.                                              |

**And the part that genuinely does not survive, stated plainly.** Below the
floating head, the stream is ordered by `createdAt` descending and by nothing
else. The board's «open questions → pinned → what happened» is gone as an
_ordering_; it survives only as a _pinning rule_ for the head. That is a real
loss and it was accepted deliberately: a stream that reorders itself by meaning
while you read is not the shape the owner asked for, and a reader who scrolls
past a card cannot find it again by any rule but the clock. The compensation is
that the only two things the old ordering protected — an unanswered question and
a pinned announcement — are exactly the two things that never enter the
chronological body at all.

#### D7.2 What "like VK or Instagram" is allowed to mean

Taken specifically, not as an aesthetic. **Kept, because they are what makes a
stream a stream:**

- one column of cards flowing with no headers, labels or dividers between them;
- author, time, content, reactions and comments inline on every card, in that
  order, at the same coordinates on every card type;
- a persistent, obvious way to add something, at the top of the stream;
- media given the full width of the card, edge to edge on a phone (§D7.14);
- paged loading that continues as you scroll.

**Refused, because they are the scoreboard this project spent the day removing,
or because they are engineering for a goal a family does not share:**

| Convention                                 | Why not                                                                                                                                                                                                                                                                 |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Like **counts** — the digit, not the like  | The like itself is built, as one tap (D7.7a). What is refused is the numeral: six people, and a «3» under Мама's note beside a «1» under Лизы's is a comparison, and in a feed those two cards are adjacent. The faces say it better and they say **who** (D7.7b, D14). |
| Follower counts, «в сети», last-seen       | There are six of them and they live together.                                                                                                                                                                                                                           |
| Algorithmic or "recommended" ordering      | The clock is a rule a nine-year-old can hold in their head. An algorithm is a thing the app does to you.                                                                                                                                                                |
| Stories                                    | A 24-hour expiry is an urgency mechanic. Pins already expire, by a date somebody chose.                                                                                                                                                                                 |
| Infinite scroll                            | Bounded instead (D7.9). Infinite scroll is engineered to keep you there; nothing in a family noticeboard wants that.                                                                                                                                                    |
| An unread count on the «Стена» tab         | A number that rises until you clear it is the purest form of the obligation the board existed to prevent. **Never add one.**                                                                                                                                            |
| Typing indicators, read receipts, presence | Chat furniture. Their absence is what keeps «ок» out of the stream.                                                                                                                                                                                                     |
| Share / repost                             | There is one audience and everybody is already in it.                                                                                                                                                                                                                   |

> **Rule.** Any number rendered on Стена must be the **only** way to say the
> thing it says. A count of replies on a thread you are about to open passes —
> nothing else tells you a conversation is in there. A count of reactions does
> not: the faces say it better, and they say _who_. A per-person total never
> passes, under any heading, in any tooltip, in any `aria-label` (D5).

**Consequence of getting it wrong:** every one of the refused conventions arrives
looking like a small, reasonable, obviously-standard addition. That is what they
looked like everywhere else too.

#### D7.3 Composition, per breakpoint

The shell's rules are unchanged; only what fills them is new.

| Range                | Стена                                                                                                                                                                                                |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **< 640** (`base`)   | One column. The feed surface is **full-bleed** — `-mx-4`, no side border, no radius — so a card is the full 390px and media has the whole screen. Cards separated by an inset hairline, never a gap. |
| **640–767** (`sm`)   | The feed becomes an ordinary L1 surface: `--card`, 1px `--border`, radius 12. Still one column, gutter 16.                                                                                           |
| **768–1023** (`md`)  | Sidebar rail 240. One column, max 640, left-aligned, gutter 32. `TopAppBar` carries the title and «Написать» (§C4).                                                                                  |
| **1024–1279** (`lg`) | Main `minmax(420px, 720px)` + side `320px`, gap 24. The side column appears (D7.3a).                                                                                                                 |
| **≥ 1280** (`xl`)    | Main still caps at **720** — a card is a row, and §C2 caps a row at 720. Grow the gutters and the side column; never the card.                                                                       |

One tree at every width. The rule that retired `useTwoColumn` on this screen
stands and is now easier to keep rather than harder: **no panel on Стена owns a
composer**, every create flow is mounted once by the page behind `BoardCompose`,
and panels are pure functions of server state.

##### D7.3a The side column, and whether a feed should have one

The old objection was decisive and is worth restating, because a feed makes it
strictly worse: **everything the shell puts after the main column is unreachable
under a scroll that grows.** On a board that fact forced tabs. On a feed it is
simply true, and no arrangement of the grid fixes it.

So the side column changes _status_ rather than contents. It is no longer a route
to anything. It holds two panels, both of which are **indexes into the stream**,
and everything either one offers also exists as a card in the feed:

- **«Что решили»** — the last five closed polls, each stating its question and
  what was decided, a tie reported _as a tie_. This is the one panel that earns
  its place in a feed: a closed poll falls back to its own timestamp and is gone,
  and «мы же решили ехать на дачу» is a thing families look up.
- **«Спасибо»** — the roster, alphabetical, with the «спасибо есть» /
  «пока без спасибо» chip and no count of any kind (D5, D7.7).

> **Rule.** Below `lg` the side column on Стена **does not render at all**. Not
> collapsed to the foot of the page — not rendered. Content at the bottom of an
> unbounded stream is dead weight that still costs two requests, and every item
> in it is redundant with a card the reader scrolls past anyway.

Both panels are stateless, so hiding them is a CSS decision (`hidden lg:block`
around `SideColumn`'s children), not a second component tree. That property is
exactly what the previous pass bought by hoisting the composers, and it is why
this is cheap now.

**Consequence of getting it wrong:** put anything actionable in that column and
it is reachable only by a reader who scrolls to the end of a growing list, which
is nobody.

#### D7.4 The head of the feed — pinned, not sectioned

The stream begins with the compose row, and then with a small **head** of cards
that do not move as the feed grows. There is no header, no label and no divider
above or below the head: same surface, same card anatomy, same hairlines. What
marks a card as part of the head is what the card **says**, in Russian, on its
own eyebrow line.

Head order, top to bottom:

1. **At most one card in the attention treatment.** Precedence, evaluated live:
   an open poll the reader has not answered → a live pin → nothing. It carries
   `bg-surface-attention text-surface-attention-foreground` on the `<article>`
   itself — the same mechanism a system post already uses for `--surface-calm` —
   plus an eyebrow line: «Вас спрашивают», or 📌 «Закреплено до 25 августа».
2. **The remaining live pins**, ordinary card ground, each still carrying its
   📌 «Закреплено до …» line.
3. **The remaining open polls**, ordinary card ground, eyebrow «Открытый опрос».
4. Then the stream.

Rules that make this work:

- **§C2 band 2 is intact: exactly one tinted card per screen.** Two washes
  stacked is two loud things. The precedence re-evaluates every render, so
  answering the poll moves the wash to the pin in the same frame.
- **Colour is never the only signal** (§B4). Every head card states its status in
  words, so the head is legible in greyscale and to a screen reader taking the
  cards in order.
- **A card is never in two places.** An open poll is in the head or nowhere; when
  it closes it leaves the head and takes its chronological position in the
  stream, which may be far down — which is what «Что решили» is for.
- **The head is capped at five cards.** Beyond that, excess pins stay in
  chronological position. This is a guard, not a feature: a head that fills the
  first viewport has become a section with the label filed off.

**Consequence of getting it wrong:** put a «ЗАКРЕПЛЕНО» header above these cards
and the screen is a board again, with worse ordering than the board had. The
instruction was «не делить явно на секции», and this is the clause it is about.

#### D7.5 The compose entry — a row that cannot receive text

The first thing in the feed surface, above the head, at every width:

```
┌────────────────────────────────────────┐
│ (П)  Что повесить на доску?         ⊕ │  56px, one row, card ground
├────────────────────────────────────────┤
│ … the head, then the stream            │
```

It is shaped exactly like VK's composer and it is a `<button>`. There is no
`<input>`, no `contenteditable`, no autofocus, and nothing on this screen ever
raises the software keyboard. Tapping it opens the existing one door —
«Что повесим на доску?»: Объявление · Опрос · Спасибо, each gated by `useCan()`
(`post:create`, `poll:create`, `kudos:give`), skipping the menu when the reader
holds exactly one, rendering nothing at all when they hold none.

> **Rule.** The compose affordance on Стена is prominent, permanent and at the
> **top** of a newest-first stream, and it is never a field. The extra tap before
> any character can be typed is not friction to be optimised away — it is the
> whole mechanism that keeps «ок», «ага» and «в 10» out of the feed.

Why this is not the thing the board refused. The refusal was a field pinned to
the **bottom** of the page, which is the messenger gesture: type, send, repeat,
with the newest thing at your thumb. A button at the top of a newest-first stream
inverts every part of that, and the sheet it opens has a title, a body field and
the verb «Повесить» — not «Отправить». The vocabulary rules at the head of
`features/wall/locale.ts` stay exactly as they are; «Лента», «Опубликовать» and
«Отправить» are still not this screen's words.

Two consequences to implement:

- **The app bar's `⊕` on Стена goes away below `md`.** The compose row is the
  door. In exchange, **tapping the tab of the route you are already on scrolls
  the document to top** (`BottomTabBar.tsx`) — the standard iOS behaviour, which
  this app should have anyway, and which is what keeps the door one tap away from
  the bottom of a long scroll.
- **At `≥ md` the top bar carries «Написать»** as the screen's one primary action
  (§C4), because there is no tab bar up there and therefore no scroll-to-top
  gesture. This is the single deliberate duplication on the screen, and it exists
  only at the widths where the mitigation does not.

The app bar's trailing slot on Стена instead holds a `⋯` overflow, which has
exactly one item and only for `settings:manage` (D7.11).

#### D7.6 Card anatomy

Every card is an `<article>` on the shared feed surface. **No card draws its own
border, radius, shadow or ground** — with the two exceptions already named, the
attention wash and the system post's `--surface-calm`. The rule between cards is
a 1px `--hairline` inset by the card's 16px left padding, exactly as `Section`
already renders it. Twelve bordered boxes with gaps between them is a grid of
tiles (§A2); one surface carrying differently-sized cards is a stream.

Every card that has an author opens with the same 44px line and closes with the
same 44px line. The middle is what differs, and the difference in **height** is
the hierarchy: if an activity line ever grows to the size of an announcement,
this screen has stopped working.

**Common head line** — `AuthorLine` at `size="md"` (32px disc, up from the
board's 24: in a feed the author has more presence, and the photo on the disc is
real now):

```
(М) Мама · 35 минут назад                                            ⋯
```

**Common foot line** — one 44px row, reactions left, thread toggle right; this
is what `CommentThread` already renders. Two stacked rows of chrome per card is
≈88px per card, and on a phone that becomes most of the feed.

##### Объявление

```
(М) Мама · 35 минут назад                                            ⋯
В субботу едем к бабушке                        ← h2, display face, optional
Выезжаем в 10:00, не проспите.                  ← body 15/22, clamp 4 + «ещё»
[ media, full card width, edge-to-edge ]        ← see below
❤️ (М)(Л)  👍 (П)   ☺+                     Обсуждение · 3
```

- The body clamps at four lines with «ещё» / «свернуть». A 2000-character post
  otherwise owns the viewport and the reader never learns there was anything
  below it.
- The body keeps `select-text` and `-webkit-touch-callout: default` while the
  card as a whole is `.no-callout` — the address and the time are the things
  people actually copy, and the long-press belongs to the action sheet.
- **The media slot is here**, between the body and the foot line, and it is now
  specified in full: §D7.14. Full card width (edge-to-edge below `sm`),
  `aspect-ratio` boxed from server-supplied dimensions so nothing reflows on
  load, `max-height: 60dvh`, radius 0 below `sm` and 8 above. Never a URL hung
  off `body`: `attachmentIds` on the way in, an `attachments` array on the way
  out (§D7.14.10).
- **A card may have media and no text.** `body` stops being required when an
  attachment is present, and nothing is drawn in place of the missing sentence —
  no «без описания», no placeholder. §D7.14.4 draws it.

##### Системный пост

No author disc — the app wrote it, and a face beside «Семейный бот» claims a
person did. `Sparkles` glyph, «Семейный бот», `--surface-calm` ground on the
card. Reactions and comments as normal: the family does congratulate the goal
that filled up.

##### Опрос

Behaviour is unchanged, and this pass re-ratifies the rule that matters most:

> **Rule.** Shares and bars render only once the reader has answered, or once the
> poll is closed. The card used to draw «На дачу 67 %» on first paint, so the
> first thing a ten-year-old saw was the parents' answer — and a family is
> precisely the group where that anchoring bites hardest.

Who has answered is drawn as **member discs, never «Проголосовали: 3»**. A closed
poll renders its result and never a form (voting past the deadline is a
server-side `409`, and a dead radio button followed by an error toast is a small
betrayal every time). The foot line is the common one, so a poll takes comments
like everything else — which is where «а почему на дачу?» goes instead of
Telegram.

##### Спасибо

New as a card, and the warmest thing this app renders. A kudos is a note
addressed from one person to another, so the card draws both:

```
(П) Павел сказал спасибо · 2 часа назад                              ⋯
(Л) Лизе                                        ← recipient disc + name, row 17/500
🙏  спасибо, что полила цветы                   ← the chosen emoji, then the message
❤️ (М)                                     Обсудить
```

No total, no history, no «7 спасибо» — nowhere, including the accessible name.
The card is the whole record; the roster panel says only _whether_.

##### Активность — one card per run, not one card per line

This is the mechanic that makes a chronological feed survivable, and it is the
direct answer to "recency ordering treats an unanswered poll and «Лиза полила
цветы» identically".

> **Rule.** A run of **consecutive** activity items — nothing else between them
> in the stream — renders as **one** card, not as one card each.

```
(Л) Лиза полила цветы · 55 минут назад
(П) Павел выполнил задачу „Вынести мусор" · час назад
(М) Мама купила 4 позиции в «Пятёрочке» · час назад
и ещё 4                                          ← quiet, expands in place
```

- Three lines shown, then «и ещё N», which expands **in place**: the items are
  already in the page, so this fetches nothing and navigates nowhere.
- Each line is the server's frozen Russian `summary`, rendered verbatim, with the
  timestamp **inside** the sentence rather than beside it. Measured at 320px, a
  right-aligned time next to a wrapping summary reads as «Лиза выполнила ·
  55 минут назад · задачу „Полить цветы"» — the clock interrupts the clause.
- Muted, 15/22, no title, **no reactions, no thread, no `⋯`**. An activity line is
  a scribble in the margin; a foot line would give it the weight of an
  announcement.
- A single activity item between two announcements still renders as a one-line
  card of this kind. The rule is about runs, not about a minimum.

**Consequence of getting it wrong:** without coalescing, a Saturday of chores
produces twenty near-identical muted lines and the announcement about Sunday sits
below all of them. That is exactly the burial the board's ordering prevented, and
the digest is what replaces it.

#### D7.7 Лайк и реакции — one control, and no digit on it

The owner asked for likes:

> «ставить лайки на посты и сообщения в обсуждениях»

and named the two products a like comes from:

> «мы делаем чтото типо Instagram или даже более похожее Threads»

Both of those draw a like as a **number under a photo**. This project spent the
whole of 20 August removing every accumulating per-person number in the app —
points, streaks, kudos totals, the weekly load bar, the `fairness` object on the
dashboard, the digest's «Вы закрыли N дел» — on the owner's own instruction that
_«the family members will compete for points thats not good»_. So the request
and the constraint meet here, and this section resolves it explicitly rather
than letting an implementer settle it by picking a component.

Two questions, in order, because the second only makes sense after the first.

##### D7.7a Is a like a different thing from the emoji reaction? No — it is the ❤️ reaction, promoted to one tap.

Read literally, the owner's sentences name the two separately: «добавлять
реакции на сообщения в обсуждениях» in one clause, «ставить лайки на посты и
сообщения» in the next. The natural reading of that is not "build two systems" —
it is "I want the one-tap heart _and_ the other faces", which is exactly how
Instagram, Threads, VK and Telegram all feel from the outside: a heart you hit
without thinking, and a menu for everything else.

Building it as two systems is the mistake available here. It means two rows of
state, two endpoints, two optimistic patches that can disagree, a card where ❤️
appears twice — once as _the_ like and once inside the picker — and the
permanent question of whether a heart and a ❤️ reaction from the same person are
one act or two. Nobody in this family would ever be able to say which.

The opposite failure is just as available. Leaving the picker as the only door
makes a like cost **two taps and a popover**, and a like that costs a popover is
not a like. The previous pass made that worse than it sounds: it specified that
a chip with nobody on it is **not drawn at all**, so on a fresh card the only
thing on the foot line is `☺+`. There is no heart on screen to press.

> **Rule.** A like **is** the ❤️ reaction. One `reactions` row, one idempotent
> toggle endpoint, one optimistic patch — nothing new in the schema, nothing new
> in the contract, no second table and no `likes` count column. What changes is
> the **drawing**: the ❤️ chip is rendered on every card and every comment
> **whether or not anybody has used it** — an outline heart, `aria-pressed="false"`,
> 44px, one tap. Every other emoji still appears only once somebody has used it.

```
♡   ☺+                                            Обсудить      ← nobody yet
❤️ (М)(Л)   👍 (П)   ☺+                     Обсуждение · 3      ← after
```

- The heart is the **first** chip, always, at the same x on every card. That
  fixed position is what makes it a control you learn once. It is also, in the
  next subsection, exactly what would make a digit dangerous.
- `☺+` keeps its «Добавить реакцию» label and its popover, and the popover still
  contains ❤️ with `aria-pressed` set. The promoted chip is a **shortcut, not an
  exclusion**: a member who reaches for the picker must not find the heart
  missing from it and conclude the app has two kinds of heart.
- `REACTION_EMOJI` already leads with ❤️ in `features/wall/locale.ts`. That order
  becomes load-bearing rather than incidental: `REACTION_EMOJI[0]` **is** the
  like. Export it as `LIKE_EMOJI` from `@family/shared` so the client, a future
  digest and any future notification rule cannot drift apart on what «лайк»
  means.
- **Double-tap-the-photo-to-like is not added.** §G1 requires every gesture to
  have a visible twin; the twin here is a heart that is now permanently on
  screen, so the gesture buys nothing. And a double-tap on a photo already means
  "zoom" on every operating system in this family.

##### D7.7b Does a like show a number? No — and the number is not withheld, it is drawn as faces.

The previous pass's argument still holds, and the feed strengthened it rather
than weakening it: cards by different authors are now adjacent, in one column,
with the foot line at a fixed position on every card. «❤️ 3» under Мама's note
sitting 120px above «❤️ 1» under Лизы's is a comparison the reader performs for
free, and the child reading the smaller number learns the thing D5 removed the
points to prevent. A like count is not a per-person total — but on Стена every
card has exactly one author whose face sits ~100px above the number, so in
practice it is read as one.

That argument is inherited. Here is the one that actually settles it, and it is
why this is not a refusal of what the owner asked for:

> **In a family of six, faces are not _less_ information than a count. They are
> strictly more, at the same width.** «❤️ (М)(Л)» says _two_ — the reader can see
> two discs — and it also says _which two_. The digit adds exactly one property
> to the drawing: it puts a comparable quantity at a fixed x-coordinate on every
> card in a single column. That property is the entire harm, and it is the only
> thing the digit contributes.

So the like the owner asked for gets built. One tap, a heart, where Instagram
puts it, optimistic and instant, and it tells you who. The count is not hidden
behind a tap or a tooltip — it is on the card, rendered as people. What is not
drawn is the numeral.

> **Rule.** No digit on a like or a reaction, anywhere: not on the chip, not
> beside it, not in a `title`, not in an `aria-label`, not in the accessible
> name, not on hover, not in the weekly digest, not in a push. `MemberDiscGroup`
> renders with `max` set to the family size so «+N» never appears — the same
> trick, for the same reason, as the four-attachment cap in §D7.14.

**This clarifies the scoreboard rule for a new surface. It does not narrow it.**
D5 forbids _a number attached to a person that goes up when they do something_.
A like count is a per-object quantity that never totals, so a purely literal
reading of D5 would have permitted it. It is refused anyway, on the adjacency
argument above — a **separate** argument, already recorded in D13 for reactions,
which likes now inherit unchanged. `DECISIONS.md` **D14** says exactly that, in
those words, because the next reader must not conclude that some previously
legal class of number has just been outlawed, and must equally not conclude that
a fresh coat of paint on a number makes it legal.

**Consequence of getting it wrong.** The digit arrives looking like a two-line
change to one component — and it is one. `reactionSummarySchema.count` is
already on the wire (it is `userIds.length`, kept for the OpenAPI surface and
for consumers that are not this screen). Rendering it is a single JSX
expression. That is precisely why this rule is written at the level of the drawn
pixel rather than at the level of the contract: the contract cannot stop it, and
a code review six months from now will not remember why it should.

##### D7.7c The one thing that is the owner's to decide, and what it costs either way

This is a design call made on a design argument, and it is honest to say that
the owner named two products where the number is visible. If they look at the
built screen and say _«а где цифры?»_, that is not a bug report to argue with —
it is the answer to a question this document could not answer on their behalf.

So the question is posed once, with both consequences priced.

| Option                             | What the family sees                      | What it costs to change afterwards                                                                                                                                                                | If the choice was wrong                                                                                               |
| ---------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **A — faces. This spec. Ship it.** | `❤️ (М)(Л)` — who, and therefore how many | **One component.** `count` is already on the wire; drawing it is a JSX expression in `ReactionBar.tsx` plus one deleted assertion in `wall.test.tsx`.                                             | The owner waits a day and gets digits.                                                                                |
| **B — digits.**                    | `❤️ 3` at a fixed position on every card  | **Not one component.** D5's argument has to be narrowed in writing, `wall.test.tsx`'s no-digit assertion deleted, and the boundary that has held all day redrawn from scratch by whoever is next. | The family has the comparison, and the guard that was catching this class of regression is gone rather than adjusted. |

The asymmetry is the whole reason A is the default: **pick the option whose
reversal is cheap**, ship it, and let the owner judge a real screen — a far
better input than a paragraph in a design document. If they choose B, D14 names
exactly which lines move, and names the five invariants that survive B
regardless:

1. no per-person totals, anywhere, under any heading;
2. no ordering or ranking by likes, and no «самое популярное»;
3. no like count in the weekly digest or in any notification;
4. no like count on a tab, a badge or the app icon;
5. no likes on a **person** — only on a post or a comment.

##### D7.7d Mechanics

- **Permission.** Liking and reacting need `kudos:give`. A reader without it (a
  `guest`) gets the heart and the discs as **static text, not disabled buttons** —
  a control that can be focused and pressed to no effect is worse than no
  control. Unchanged.
- **Optimism.** The toggle stays optimistic with rollback; the endpoint is
  idempotent and answers with the fresh summary, so an offline double-tap
  converges rather than oscillating. What changes is the load: a heart at a fixed
  position is tapped far more often than a picker is opened. D12's rule that
  **the change feed never invalidates while a mutation is in flight** is what
  stops a like flickering off and back on; it was written for the shopping tick,
  and this is now its second-heaviest user.
- **A like raises no notification. Ever.** Not a push, not a Telegram message,
  not an in-app inbox row. Six people, a one-tap control, and
  `docs/architecture/notifications.md` already names notification flood as the
  thing that kills these apps. A **comment** notifies the note's author; a like
  does not. This is the rule most likely to be added later by accident, because
  every social product has it.
- **Live sync.** A like is a write under the `wall` prefix, which `ROUTE_DOMAINS`
  already covers. No new domain, no new mapping, nothing to change in D12.
- **The test.** `wall.test.tsx` already asserts that a rendered wall subtree
  contains no per-person digit. Extend it to the always-drawn heart, the comment
  foot line (§D7.8), and every `aria-label` and `title` in the subtree rather
  than only its visible text — a screen-reader-only regression is exactly how
  this crept back last time, when a load bar read «40 % (своя доля 33 %)» aloud
  while drawing no numbers at all.

#### D7.8 Обсуждения — the thread, and the two things the owner added to it

The owner asked for two changes inside a discussion:

> «в обсуждениях должна быть возможность делать то же самое + добавлять реакции
> на сообщения в обсуждениях»

— the same media as on a post, and reactions on individual messages. Both are
built. Everything the thread already refused stays refused, and the reason is
that both additions push in the same direction: **towards a messenger**, which is
the one thing this screen exists not to be.

**What does not change, and now matters more.**

- Comments are the one place on Стена where a text field is allowed to exist,
  and it appears only inside a thread somebody deliberately opened. Closed is the
  default, and closed is what the feed looks like.
- Foot-line toggle: «Обсудить» when empty, «Обсуждение · 3» when not. **This
  count survives the D7.2 rule** because it is the only way to say the thing: it
  describes the object you are about to open, it is not attached to a person, and
  nothing sorts by it. Without it every card looks identical and a live
  conversation is invisible.
- **No inline "last comment" preview**, though VK, Instagram and Threads all
  have one. It is the convention that most turns a feed into a chat: the preview
  _is_ a reply, a visible reply invites a reply, and now the stream is a
  conversation with a scroll bar. The thread is one tap away and that is enough.
  A media attachment makes this worse, not better — a thumbnail preview under
  every card is a second feed inside the first one.
- Comments fetch only when a thread opens, so a page of fifteen cards fires one
  request and not fifteen.
- No typing indicator, no read receipt, no presence, no threads of threads.

##### D7.8a Reactions and the like on a message

`reactions` is already polymorphic and `commentResponseSchema` already carries a
`reactions` array, so the data has been there the whole time. What was missing
was the drawing, and the drawing is the hard part: a comment is a **row inside a
card**, and the post's foot line — heart, up to four more chips, a picker, and a
thread toggle — is 44px of chrome that would land under every message. Five
messages in a thread is 220px of controls under 5 lines of text.

> **Rule.** A comment's foot is **one 44px row with two things on it**: the ❤️
> chip with its reactors' discs, and a `⋯`. Any other emoji somebody has used
> appears on the same row, after the heart. There is **no `☺+` picker on a
> comment** — the picker lives inside the `⋯` sheet.

```
(Л) Лиза · 12 минут назад
    и я тоже так думаю
    ❤️ (М)                                                    ⋯
```

- `⋯` opens the comment's `ActionSheet`: «Поставить реакцию» (which opens the
  same emoji picker the post uses), «Удалить» where the reader holds
  `comment:delete:own` / `comment:delete:any`. **Long-press opens the identical
  sheet**, built from one list, so the two doors cannot drift (§G5).
- This is what keeps §G1 intact. The picker is reachable by a **visible** control
  and by a gesture, never by the gesture alone.
- The foot row is drawn only when the reader may react **or** somebody already
  has. A guest reading a thread of plain messages sees no control row at all,
  and a thread of five messages stays five rows tall.
- Same no-digit rule as §D7.7b. Same test.

##### D7.8b Media in a thread — one, and one only

A post may carry four photos (§D7.14). A comment may carry **one** attachment of
any kind, and this is not a resource limit — it is the line between a reply and
a post.

> **Rule.** One attachment per comment. Its rendered box is capped at **240px
> tall** — noticeably shorter than a post's — and it is inset by the comment's
> left padding rather than bled to the card edge. A comment is nested inside a
> card, and a full-bleed photo inside a nested row destroys the containment that
> tells the reader they are inside a discussion.

- The attach control is a single 📎 button on the **existing** comment composer,
  to the left of «Отправить», 44px. It is not a new field, not a new bar, and not
  a second row: the composer already exists, and adding a button to a field is
  not the same as adding a field.
- Once one file is attached the 📎 button is replaced by the thumbnail tile with
  its ✕, so there is never a control offering a second attachment that would then
  be refused.
- A comment may be **media-only** — a photo with no words is a legitimate reply
  («вот, купила») and forcing a caption produces «вот» five hundred times.
  `createCommentSchema.body` therefore relaxes to allow empty **when an
  attachment is present**, and not otherwise.
- **Nothing else about the composer changes.** No voice-message-hold-to-record
  button, no camera shutter beside the send button, no sticker tray, no GIF
  search. Each of those is a messenger affordance that would arrive looking like
  a natural completion of this feature.

**Consequence of getting it wrong.** A 📎, a 🎤 and a 😊 beside a text field with
a send button is Telegram, pixel for pixel. The family has Telegram. What
protects this screen is not the absence of media — the owner asked for media —
it is that the field exists only inside a thread somebody opened, that there is
exactly one attachment, and that the compose door on the feed itself still
cannot receive a character.

#### D7.9 Ordering, pagination, and the fact that the feed ends

- **Order** is `createdAt` descending over the merged stream, cursor-paged with
  the existing opaque base64url keyset token. Nothing on the client constructs a
  cursor.
- **Page size 15** (`FEED_PAGE_SIZE`), up from the board's 12. After activity
  coalescing that is roughly two phone viewports of mixed content.
- **Auto-load is bounded.** An `IntersectionObserver` sentinel fetches the next
  page automatically for **four pages**. Then it stops and renders one quiet row
  — «Показать ещё» — which grants another four. The reader is asked, roughly every
  sixty items, whether they actually want to keep going.

> **Rule.** The feed ends, visibly. When `nextCursor` is `null` the last thing on
> the screen is «Это всё, что было», in `meta`, with no box and no button. There
> is no unread badge on the «Стена» tab and there never will be.

This is the largest departure from the apps whose shape was borrowed, and it is
the whole of the board's first refusal. An Instagram feed is engineered never to
bottom out, because bottoming out is when you leave. A family noticeboard wants
you to leave: you came to find out whether anything needs you, and «нет, это всё»
is a good answer that the app must be able to give.

**Density.** §C5's "answer the question inside 1.5 viewports" does not apply to a
stream, and is replaced by a narrower target: **the first viewport must contain
the compose row and whatever won band 2.** On a 390×844 phone that is the row
(56px) plus one attention card, leaving the top of the next card visible so the
surface reads as continuing rather than as ending.

#### D7.10 New items arriving while you read

D12 polls `/api/changes` and invalidates `['wall']` within ~20 s. A stream that
grows at the top while a thumb is halfway down it is the classic way to lose a
reader's place, so this is decided here rather than left to the refetch.

> **Rule.** New items are never inserted above the reader's viewport. If
> `scrollY > 0`, page one refetches into the cache and the feed does **not**
> re-render its head; a pill appears instead, and it carries no number.

```
        ┌─────────────────────┐
        │  ↑  Новое на стене  │   sticky under the app bar, 36px, --secondary
        └─────────────────────┘
```

- Tapping it scrolls to top (smooth; `prefers-reduced-motion` jumps) and commits
  the new head in the same action.
- `scrollY === 0` inserts directly and silently: the reader is at the top,
  content grows downward from the compose row, and nothing they are reading
  moves.
- Pull-to-refresh (§G6) commits pending items as part of the refresh and
  dismisses the pill.
- **No count on the pill.** «Новое на стене · 7» is an unread badge with extra
  steps, and it is the obligation meter D7.2 refuses. The pill says something is
  up there; the feed says what.
- The reader's own post never goes behind the pill. `useCreatePost` gains the
  optimistic insert-at-top that comments and reactions already have, with
  rollback on failure — you always see your own note appear.

**Consequence of getting it wrong:** silent insertion at the top is the bug where
a family member taps «Обсудить» and the card under their thumb turns out to be a
different one.

#### D7.11 «Очистить доску»

The owner asked for a way to clear it. A board could draw the line at its tail; a
feed has no tail, so the line has to become a real object.

> **Rule.** Clearing is a **horizon, not a delete.** `family_settings` gains
> `wall_cleared_at timestamptz null`; the feed returns only rows created after
> it. Nothing is deleted — no post, no comment, no reaction, no kudos, no poll,
> no activity row. The data stays in the database and the family sees a clean
> wall.

Why a horizon and not a delete: a bulk delete is the one irreversible operation
in this app that could remove several hundred rows on a single confirm, including
other people's words and other people's thank-yous. §G4 already refuses to put
delete behind a gesture for exactly this reason; putting a whole wall behind one
button is worse. A horizon is one column write, it is reversible for as long as
the row survives, and it never destroys somebody's «спасибо, что забрал Лизу».

**What clears and what stays.**

| Object                      | After a clear                                                                                                                                                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Announcements, system posts | Gone from the feed. Rows intact.                                                                                                                                                                                                                 |
| Activity lines              | Gone from the feed. Rows intact — `/activity` is still the family's own log and other modules read it.                                                                                                                                           |
| Comments, reactions         | Untouched, still attached to their post. They were never separately visible; they leave with the card that carried them.                                                                                                                         |
| Kudos                       | Gone from the feed. The «Спасибо» roster chip is a 30-day window and is **not** reset — a clear tidies the wall, it does not un-thank.                                                                                                           |
| Live pins                   | **Cleared.** Pinning means "keep this up"; clearing means "take everything down". A pin that survived would make the clear look broken.                                                                                                          |
| **Open polls**              | **Stay.** They are not "what happened", they are what is still being asked, and a clear must not silently cancel an unanswered question.                                                                                                         |
| **Attachments**             | **Every object stays in the bucket, untouched.** Not deleted, not marked, not swept later. The rows are intact, so the photographs are simply not fetched — and undo brings them all back because nothing ever went looking for them (§D7.14.9). |

The last two rows are the interesting ones, and it is the board's principle surviving
inside the feed: **a clear collapses the wall to exactly what still needs
answering, and it destroys nothing.** The attachments row is where that second
half stops being a slogan: a horizon that quietly deleted objects would be a
delete wearing a horizon's name, and the first person to discover it would
discover it by losing a photograph.

**Who may.** `settings:manage` — admin and owner. Not a new permission: the
horizon lives on the singleton `family_settings` row (D1), so the permission that
governs family settings governs it. `post:delete:any` is an adult's licence to
moderate one note somebody wrote, which is a different thing from resetting what
six people see. A reader without `settings:manage` sees no `⋯` item — not a
disabled one.

**The flow.**

1. App bar `⋯` → «Очистить доску» (`tone: 'destructive'`).
2. `ConfirmDialog` through `ResponsiveDialog`, so it is a sheet under a thumb. It
   names what happens, in words, and it names what stays:

   > **Очистить доску?**
   > Со стены исчезнет всё, что на ней сейчас, — у всех.
   > Открытые опросы останутся: на них ещё никто не ответил.
   > Ничего не удаляется навсегда.

   No row count in the dialog. «Уберём 247 записей» makes the action feel bigger
   or smaller than it is, and it is not a number the reader can act on.

3. A 6-second `sonner` toast — «Доска очищена · Вернуть» — matching every other
   reversible action in the app (§G4). Undo writes the previous `wall_cleared_at`
   back, `null` included.
4. The clear writes **one system post**, timestamped just after the horizon so it
   survives it: «Доску очистили 20 августа». That card is then the oldest thing in
   the feed, and it _is_ the line «Что было раньше» used to draw — which is why
   the feed can afford not to have a tail. A family member opening the app after a
   clear finds an explanation rather than an amnesia.

**Consequence of getting it wrong:** implement this as `DELETE FROM posts` and the
first time somebody clears a wall holding a thank-you their mother wrote, it is
gone, and the app has no answer.

#### D7.12 Gestures, states, permissions

**Gestures.**

- **No swipe on a card, anywhere on Стена.** §G4 puts a swipe on rows with one
  _reversible_ action. A card's row actions are pin and delete: one is not
  reversible, and the other is a toggle _with an expiry date_, which is not a
  thing a thumb should set by accident. Unchanged from the board, and still right.
- **Long-press** opens the same `ActionSheet` the visible `⋯` opens, built from
  one list so the two doors cannot drift (§G5). Coarse pointers only — swallowing
  right-click on a desktop is a gesture nobody asked for.
- **Pull-to-refresh** as §G6; on this screen it also commits and dismisses the
  «Новое на стене» pill.
- **Pinning always expires.** «Закреплено до 25 августа» self-clears; a boolean
  would stay pinned forever. Rendered day-and-month — the minute of a pin's expiry
  is a number nobody set and nobody can act on.

**Loading.** Three card skeletons of the same shape and count, minimum 250 ms so
they cannot flash. A refetch keeps the old cards on screen with the 2px
`--primary` bar under the app bar; the feed never blanks. A page-two fetch renders
one skeleton card at the foot, never a spinner in the middle of the stream.

**Error.** Page one failing is a full `ErrorState` with a retry, in place of the
feed. A **later** page failing is a quiet inline row at the foot with a retry, and
never `role="alert"` — fifteen cards that loaded perfectly well must not be
shouted over by page four.

**Offline.** Page one renders from cache (`gcTime` 30 min) and the compose row
still works: creating a post is optimistic, so the card appears immediately and
rolls back with a toast if the write never lands. `['changes']` is already the one
query that pauses while offline (D12), so the pill never appears against stale
data. **Media is the exception and says so**: the attach control is disabled with
«Фото можно добавить, когда появится интернет», because an attachment is bytes on
a server rather than an intent that can be replayed, and there is deliberately no
outbox for it (§D7.14.7). Posting without media still works. Already-loaded media
stays visible from the HTTP cache; media that was never fetched draws its
reserved box in the attachment's `dominantColor` and nothing else — never a
broken-image glyph, and never a retry button that cannot succeed.

**Media that fails to load while online** — a 404 from a reaped object, a 503
from unconfigured storage — collapses its box to nothing and leaves the card
otherwise intact. A note whose photo has gone is still a note; a card that
becomes an error report because one attachment is missing is worse than a card
with one less picture.

**Empty.**

- A reader who may write: the compose row **is** the invitation, so no
  `EmptyState` illustration is drawn above it — the same rule §D6 applies to the
  shopping composer. One quiet `body` line under the row: «Повесьте первую
  записку — её увидят все дома.»
- A reader who may not write (a `guest`): a two-line `<p>` on the feed surface —
  «Когда кто-нибудь что-то напишет, это появится здесь.» **Not `EmptyState`**: §E
  made `EmptyState.action` required, and there is no honest action to offer
  somebody whose every write would 403. This is the one place in the app where
  that requirement is met by not using the component.

**Permissions** go through `useCan()`, never a role comparison (D4). Verified
against `ROLE_PERMISSIONS` rather than assumed:

| Role          | The compose row offers | On a card                                                                                       | Media                                                            |
| ------------- | ---------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `guest`       | not rendered           | reads; the heart and the discs as **static text**; no thread composer; no `⋯`                   | **sees none.** «Фото — только для семьи» in place of the box     |
| `child`       | Объявление · Спасибо   | may like, react, comment and vote; `⋯` only on their own post, and only «Снять с доски»; no pin | may attach and may view, on posts and in threads                 |
| `teen`        | + Опрос                | + «Завершить» on their own poll                                                                 | same                                                             |
| `adult`       | all three              | + pin (день / 3 дня / неделю), + delete any post, + delete any comment                          | same, and deleting a note removes its media from every screen    |
| `admin/owner` | all three              | + the app bar's «Очистить доску»                                                                | same; a clear hides media and **destroys none of it** (§D7.14.9) |

A `child` holds `post:create`, `comment:create`, `kudos:give` and `poll:vote` but
**not** `poll:create`, `poll:close` or `post:pin` — so their door offers two kinds
of note and not three, their polls carry no «Завершить», and a pinned note
somebody else wrote carries no `⋯` at all. A child may attach photos, video and
voice exactly as an adult may: `post:create` is what carries the right to attach
(§D7.14.1), and a board where the ten-year-old can write but cannot show you
what they drew is a board that has quietly told them their notes count less.

**The `guest` row is a deliberate narrowing, and it is the one line in this
table that changes what an existing role means.** A guest reads the wall today,
and that was scoped when the wall was text. Photographs of children are the most
sensitive content this app will ever hold, so media gets its own permission,
`media:read`, granted to `child` and above and not to `guest` — reasoning and
consequences in §D7.14.10, and the owner's confirmation is asked for in
§D7.14.11 item 5.

#### D7.13 Contract gaps — what closed, and what this pass opens

The previous pass named four gaps. **All four have since closed** in
`packages/shared/src/contracts/wall.ts`, and this section is rewritten rather
than deleted so a reader arriving from D13 can see which interim behaviours are
now dead code rather than live spec:

| Gap named in the previous pass                 | Now                                                                                                          |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Polls are not feed items                       | **Closed.** `wallFeedItemSchema` is a four-way union: `post` · `activity` · `poll` · `kudos`.                |
| `pollResponseSchema` carries no `commentCount` | **Closed.** It does, and the poll card's foot line is the common one.                                        |
| Kudos are not feed items                       | **Closed.** `kudosFeedItemSchema` carries `toDisplayName`, so the «Спасибо» card can name the recipient.     |
| `reactionSummarySchema` has no `userIds`       | **Closed.** The chip draws the discs. **The interim that drew the emoji alone is gone — do not restore it.** |

**Desktop**: feed at 720; side column (≥ lg only) = «Что решили» · «Спасибо».
**Empty**: the compose row and one line — never a button that would 403.

This pass opens a new set, all in §D7.14.10, and they are of a different kind:
the four above were fields missing from schemas that already existed, and these
are a table, a permission and a route that do not exist yet. They are named
there rather than here because they belong with the design that needs them.

One is worth repeating in this list because it is the only change to an
**existing** contract that can break a caller:

> `createPostSchema.body` stops being `nonEmptyString(8000)` and becomes a
> trimmed, defaulted string constrained by a `superRefine` — **body or
> attachment, at least one**. A post with neither must still answer 400. Do not
> implement this as `body: optional()`: that quietly permits an empty note, and
> an empty note is a card with an author line, a foot line and nothing between
> them.

---

#### D7.14 Вложения — фото, видео, аудио

**What the user came for:** «должна быть возможность добавлять фото видео аудио
к посту, мы делаем чтото типо Instagram или даже более похожее Threads».

§D7.6 spec'd a media slot "with rules" and then deferred it, because no pipeline
existed. One exists now — the avatar path in `backend/src/modules/storage/**`
validates by magic bytes, serves through an authenticated route with ETag/304,
and is backed up nightly. **This section extends that pipeline. It does not
reinvent it**, and the two places where it cannot be extended (HTTP Range, and a
two-phase upload) are called out where they occur, with the reason.

Everything below is designed as a **family noticeboard would need it**, not as
Instagram would. The difference is concrete and it shows up in five places: the
attachment cap is set by what a grid holds rather than by what a server can
take; nothing autoplays; nothing is cropped to a square; a video is fetched only
when somebody asks for it; and the objects outlive every deletion the UI offers,
because §D7.11 made clearing a **horizon** and a horizon must never be able to
destroy a photograph.

---

##### D7.14.1 Media is not a fourth door

The compose menu offers three kinds of note: Объявление · Опрос · Спасибо. The
single most available mistake in this whole section is adding «Фото» as a fourth.

> **Rule.** Media is a **property of a note**, never a kind of note. There is no
> «Фото» in the compose menu, no camera glyph on the compose row, no camera in
> the app bar, and no attach control anywhere on Стена except **inside a composer
> the reader deliberately opened**. Attaching is reached from inside «Объявление»
> and from inside an open thread, and from nowhere else.

Why this is the line: a camera button on the feed surface is a one-tap path from
"reading the wall" to "posting a picture", with no note attached and nothing
said. That is a photo-sharing app, and D9 explicitly rejected «photo gallery» as
a feature. A photo _under_ «В субботу едем к бабушке» is a noticeboard. A photo
on its own, posted because a button was there, is the other product.

A post **may** end up with media and no text (§D7.14.4) — that is a legitimate
outcome of opening «Объявление» and deciding the picture says it. It is not a
door of its own.

**Кому что можно.** Attaching needs no new permission and deliberately gets
none: the right to attach travels with the right to write, so
`POST /api/media` is guarded `requireAny('post:create', 'comment:create')`.
A permission that must always be granted alongside another permission is a
permission somebody will forget to grant. **Reading** media is different, and it
is the one place a new permission is justified — see §D7.14.10.

---

##### D7.14.2 Layout — what a card with media looks like

Media sits **after** the body, never before it. Instagram puts the picture first
because the picture is the post; here the sentence is the news («В субботу едем
к бабушке») and the photo is the evidence for it. Threads makes the same choice
and it is the right one for a board. §D7.6 already drew it this way; this is the
reason.

**The box.**

- Full card width, **edge to edge below `sm`** (the feed surface is full-bleed
  there, §D7.3), radius 0 below `sm` and 8 at `sm` and above.
- **The box is reserved before the bytes arrive.** `aspect-ratio` is set from the
  server-supplied `width`/`height`, so nothing reflows on load and a thumb
  halfway down the feed does not get thrown by an image finishing. This is not
  optional — a feed that reflows while you read it is the single most annoying
  bug this screen can have.
- The reserved box is painted with the attachment's `dominantColor` when it has
  one, and `--muted` otherwise (§D7.14.8). A warm block that becomes a photo
  reads as loading; a grey block reads as broken.
- **`max-height: 60dvh`**, and the aspect ratio is **clamped at the tall end to
  4:5**. Anything taller (a full-height iPhone screenshot at 9:19.5) is drawn in
  a 4:5 box with `object-fit: cover` and the full frame is one tap away.

  Why clamp only the tall end, and why 4:5: a portrait phone photo is the common
  case, and forcing it to a square loses heads. 4:5 is the mildest clamp that
  bounds the height — at a 358px card it is **448px**, which leaves the top of
  the next card visible on a 390×844 phone. A panorama is short and harms
  nothing, so the wide end is unclamped.

**Several attachments — a two-column grid, and a hard cap of four.**

```
n=1    ┌──────────────────────┐      natural ratio, clamped at 4:5
       │                      │
       └──────────────────────┘

n=2    ┌──────────┬──────────┐       two squares, 2px gutter
       │          │          │
       └──────────┴──────────┘

n=3    ┌──────────┬──────────┐       two squares…
       │          │          │
       ├──────────┴──────────┤
       │                     │       …then one full-width cell at 2:1
       └─────────────────────┘

n=4    ┌──────────┬──────────┐       2 × 2 squares
       │          │          │
       ├──────────┼──────────┤
       │          │          │
       └──────────┴──────────┘
```

At a 358px card: `n=2` is 178px tall, `n=3` is 358px, `n=4` is 358px. Every
arrangement is under half a viewport, which is what keeps a photo post from
owning the screen the way a 2000-character body would (§D7.6 clamps that at four
lines for the same reason).

> **Rule.** **Four attachments per post, one per comment.** Not a resource
> limit — four is what the grid holds without a «+2» tile, and a «+2» tile is a
> digit on a card (§D7.7b). The same trick as `MemberDiscGroup` capped at the
> family size so «+N» never renders: **choose the bound that makes the counter
> unnecessary.**

The picker stops offering files at four and says so — «Больше четырёх не
поместится» — rather than accepting a fifth and dropping it silently.

**Mixed kinds are not allowed.**

> **Rule.** A post carries **up to four photos**, **or one video**, **or one
> audio**. Never a mixture.

A video in tile 3 of a 2×2 grid is 178px wide with a play button in it, which is
unplayable and unwatchable; an audio row inside a photo grid has no sensible
cell. And a note that is "three photos and a voice memo" is two notes. This
restriction removes an entire class of layout question and costs the family
nothing they will notice.

**On a tinted card the media insets.**

The head's attention card and the system post draw `--surface-attention` /
`--surface-calm` on the `<article>` itself (§D7.4, §D7.6). A full-bleed photo on
one of those runs to the screen edge and the wash stops reading as a card at all.

> **Rule.** On a card with a tinted ground, media insets by 16px on both sides
> and takes radius 8 at **every** width, including below `sm`. The wash must
> frame the picture.

---

##### D7.14.3 Съёмка и выбор — what attaching actually looks like on an installed iPhone

Everything asserted here was verified against WebKit source, WebKit Bugzilla and
MDN browser-compat-data on **20 August 2026**, by the same method
`docs/research/ios-pwa-push.md` uses and for the same reason: this project has
had three separate assumptions about iOS overturned by reading the source, and
the shape of this feature depends on facts that are widely repeated and wrong.
Sources are named inline. **Re-verify before trusting any of it in a year.**

##### One control, and no `capture` attribute on it

The attach control is a single `<input type="file">`. On iOS it raises WebKit's
own three-item menu, built in `WKFileUploadPanel.mm` — **«Фотогалерея» /
«Снять фото или видео» / «Выбрать файл»**, in that order, with the camera item
omitted entirely on a device without one.

> **Rule.** One control, `accept="image/*,video/*"`, `multiple`, **no `capture`
> attribute**. Camera and library are already both inside the menu the OS draws;
> a separate «Камера» button next to it would be a second door onto a room the
> first door already opens.

`capture` is genuinely supported on iOS — MDN BCD gives `safari_ios: 10`, and
`WKFileUploadPanel.mm` short-circuits straight to `UIImagePickerController` with
the front or rear device — which is exactly why it must **not** be set here:
setting it **removes** the library and the Files option. It is the right
attribute for a hypothetical "take a photo right now" flow and the wrong one for
"add a photo to this note".

(That verified support has one useful consequence worth writing down for a
future feature: `<input capture>` uses the **system** camera UI and needs no web
permission at all, which makes it strictly better than a `getUserMedia` camera —
see the audio problem below.)

##### Photos arrive as JPEG, and the one path where they do not

This determines whether the existing magic-byte gate — JPEG, PNG, WebP, and a
415 for everything else — survives contact with an iPhone set to «Высокая
эффективность» (HEIC). Three paths, three different answers:

| Path in the iOS menu | What your server receives                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Фотогалерея**      | **JPEG.** WebKit asks PHPicker for `AssetRepresentationMode.compatible`, which transcodes HEIC→JPEG and HEVC→H.264 before handing it over.        |
| **Снять фото**       | **JPEG, always** — a camera capture has no asset URL, so WebKit re-encodes with `UIImageJPEGRepresentation(image, 0.8)` and names it `image.jpg`. |
| **Выбрать файл**     | **The raw bytes.** No transcode step exists on this branch. Navigate to a `.heic` in Файлы and your server gets real HEIC magic bytes.            |

The first row is the one people get wrong, in both directions. WebKit landed
work in March 2024 (bug 267277) to stop transcoding when `accept` does not
require it — but it is gated behind the internal preference
`PhotoPickerPrefersOriginalImageFormat`, which defaults to **false** in shipping
WebKit, so `compatible` mode wins unconditionally. Bug **270470** (still open)
says so in as many words. **Do not design around "iOS might send HEIC from the
gallery" — today it does not — and do not rely on that forever either**, since
one preference flip reverses it.

Consequences, all cheap:

- **The server's photo whitelist does not change.** JPEG, PNG, WebP; magic
  bytes; 415 otherwise. The existing `image.ts` is correct as written.
- **Never put `image/heic` in `accept`.** There are consistent reports (Apple
  Developer Forums 743049; no WebKit bug, **secondary and unverified**) that
  listing it makes Safari hand back a _JPEG renamed `.heic`_. Listing it buys
  nothing and risks that.
- **A HEIC from «Выбрать файл» is handled on the client, not the server.** iOS
  Safari decodes HEIC natively (`MIMETypeRegistry.cpp`, `HAVE(HEIC)`), so the
  downscale-to-WebP step in `shared/media/encode.ts` simply works and the server
  never sees it. On Android or desktop Chrome the decode fails, and the honest
  answer there is the sentence «Не получилось открыть это фото. Попробуйте
  другое.» — because nobody outside Apple can display that file anyway.
- **The camera path loses EXIF** (`WKFileUploadPanel.mm` carries an open
  `// FIXME: Should EXIF data be maintained?`). Harmless here: the image comes
  out of the camera already upright. Keep decoding through an `<img>` rather
  than `createImageBitmap` regardless — `avatar-image.ts` already documents why,
  and the gallery path _does_ carry orientation.

##### Video: picking is safe, recording in place is not

Same menu, opposite outcome — and this is the finding that most changes what the
server has to do.

- **Фотогалерея → H.264**, because `compatible` mode transcodes on the way out.
- **Снять видео (single capture) → passed through untouched.**
  `_uploadItemFromMediaInfo` hands over `UIImagePickerControllerMediaURL` as-is,
  with no export session. On a phone set to «Высокая эффективность» that is
  **HEVC inside a QuickTime `.mov`**.
- Chrome on Android decodes HEVC; Chrome on Windows only where there is hardware
  support; Linux depends on VAAPI (caniuse `hevc`). So the family member who
  films the school concert on their iPhone can produce a file that half the
  household cannot watch, with no error message that explains why.

> **Rule.** **The container is `.mov`/QuickTime on every iOS path, never `.mp4`.**
> Sniff the `ftyp` brand; never trust the extension, and never trust
> `Content-Type`. And the server **whitelists the video codec, not just the
> container**: walk `moov → trak → mdia → minf → stbl → stsd` and accept only an
> `avc1`/`avc3` sample entry (H.264). `hvc1`/`hev1` is a **rejection with an
> instruction**, not a silent acceptance.

Walking to `stsd` is roughly sixty lines on top of the `mvhd` walk the duration
check already needs (§D7.14.6), with no dependency — the whole file is in a
buffer, so a `moov` at the end is not a problem. It is the same doctrine as the
magic-byte table one level deeper: **an unrecognised codec is a rejection, not a
guess.** What the member reads:

> «Это видео снято в формате, который откроется не у всех дома.
> Выберите его из галереи — так оно перекодируется само.»

That sentence is actionable precisely because picking the same clip from
Фотогалерея really does produce H.264. It is a two-tap fix, and it is the
difference between a rejection and a dead end.

##### Audio is the hard one, and it is hard for two independent reasons

**First: `accept="audio/*"` does not work on iOS.** MDN BCD's `safari_ios` note
on `accept` is explicit, and WebKit bug **242110** is open: since r250410,
`UTIsForMIMETypes` maps `audio/*` to `UTTypeMovie` rather than `UTTypeAudio`, so
the menu offers the **video** recorder and the Files browser is filtered to
movies — `.m4a` and `.mp3` are hidden. There is no file-picker path to an audio
file on an iPhone.

**Second: there is no camera/microphone permission that survives a launch.**
`getUserMedia` in a Home Screen web app has worked since iOS 13.4 (bug 185448,
RESOLVED FIXED), but bug **215884** — still collecting reports as recently as
February 2026 — records that the grant does not persist: closing and reopening
the installed app re-prompts, a grant given in Safari does not carry into the
installed app, and one reporter sees a re-prompt after ~90 seconds.

So:

> **Rule.** Audio is **recorded in the app**, never picked from a file. The
> control is a «Записать голосом» button inside the composer, which asks for the
> microphone, records with `MediaRecorder`, and produces one attachment.
> `accept="audio/*"` is never used anywhere.

- `MediaRecorder` has shipped on iOS since 14 (BCD `safari_ios: 14`), producing
  `audio/mp4` (AAC); Safari 18.4 added WebM/Opus, Ogg and fragmented MP4. Target
  is therefore: **feature-detect with `MediaRecorder.isTypeSupported()` and fall
  back to `audio/mp4`**, which is the one that works on every iPhone the family
  could be holding.
- **Design for the prompt, do not be surprised by it.** Tapping «Записать
  голосом» shows a one-line explanation first — «Нужен микрофон, чтобы записать
  голос» — and _then_ asks. A permission dialog that appears with no preceding
  sentence is the thing family members deny by reflex, and on iOS a denial is
  recovered only through Настройки, which nobody will find. Expect the prompt on
  **every launch** and never treat a previous grant as remembered.
- **This leg is the one to ship last.** See §D7.14.11 — whether `MediaRecorder`
  actually runs inside an installed Home Screen web app is the one claim in this
  subsection with **no primary source in either direction**, and it is a
  ten-minute device test.

##### What is impossible on iOS, so that nobody designs around it

- **No Background Fetch** (BCD `safari: false`; WebKit standards-position #149
  still "Needs position").
- **No Background Sync** (BCD `safari: false`) — already load-bearing for
  `features/shopping/outbox.ts`.
- **A service worker cannot keep an upload alive.** Bug 211018 documents the
  opposite: service-worker contexts freeze on backgrounding.

There is, however, one thing that **is** possible and that this project assumed
was not — see the correction in §D7.14.7.

---

##### D7.14.4 Card anatomy per kind

**Фото — announcement with text and media** (the common case):

```
(М) Мама · 35 минут назад                                            ⋯
В субботу едем к бабушке                        ← h2, display face, optional
Выезжаем в 10:00, не проспите.                  ← body 15/22, clamp 4 + «ещё»
┌───────────────────────────────────────────┐
│                                           │  ← full width, ratio from server
└───────────────────────────────────────────┘
❤️ (М)(Л)   👍 (П)   ☺+                   Обсуждение · 3
```

**Фото — media and no text.** This is what «типо Instagram» actually looks like
on this screen, and it is a legitimate card:

```
(М) Мама · 35 минут назад                                            ⋯
┌───────────────────────────────────────────┐
│                                           │
└───────────────────────────────────────────┘
❤️ (М)(Л)   ☺+                                       Обсудить
```

- 8px between the author line and the media, the same gap the body would have
  taken. Nothing is drawn in place of the missing text — **no «без описания»,
  no placeholder, no italic hint.** An absent caption is not an error state.
- `createPostSchema` therefore stops requiring a body. See §D7.14.10: the rule is
  **body or attachment, at least one**, expressed as a `superRefine`, never as
  `body: optional()` — a post with neither is still a bug and must still 400.

**Text and no media** is exactly today's card, unchanged.

**Видео:**

```
(П) Павел · час назад                                                ⋯
Лиза наконец поехала без страховки
┌───────────────────────────────────────────┐
│                    ▶                      │  ← poster frame, 56px filled play
│  0:42                                     │  ← duration pill, bottom-left
└───────────────────────────────────────────┘
❤️ (М)   ☺+                                          Обсудить
```

- The still is a **separate poster object**, not a frame decoded out of the
  video. It is ~30 KB; the video is up to 40 MB. This is what makes
  `preload="none"` possible and it is the single biggest data decision in this
  section — fifteen cards of `preload="metadata"` is fifteen range requests
  against the VDI before anybody has asked to watch anything.
- The **duration pill** («0:42», `meta` 13/500, `tabular-nums`, on a 60 % black
  scrim, bottom-left, 8px inset) is a number on a card, and it passes D7.2's
  rule cleanly: a clip's length is not sayable any other way, it is not attached
  to a person, nothing sorts by it, and it is precisely the fact that decides
  whether you tap now or later. State this in the review, because it will be
  challenged.
- **No progress bar, no view count, no «просмотров».** Views are the purest form
  of the thing D5 removed and there is no version of them that is safe here.

**Аудио — a row, not a box:**

```
(Б) Бабушка · вчера                                                  ⋯
┌───────────────────────────────────────────┐
│ ( ▶ )  ──────────────────────────  1:12   │  ← 56px row, --secondary ground
└───────────────────────────────────────────┘
❤️ (М)(Л)   ☺+                                       Обсудить
```

- Audio has no picture, so a 4:5 box of nothing would be absurd. It renders as a
  **56px row** with a 44px circular play/pause, a hairline progress line that
  fills as it plays, and the remaining time at the right in `tabular-nums`.
  Inset 16px at every width and radius 8 — a row is a row, not a bleed.
- Distinguishable at a glance from a video precisely **because it is a different
  shape**, not because of an icon. Colour is never the only signal (§B4), and
  neither is a glyph.
- **No waveform.** Drawing one needs either a server-side decoder (a dependency
  this backend deliberately does not have — see `avatar-image.ts`) or 40 numbers
  computed at record time and carried in a column. The second is cheap and would
  look good; it is **deferred**, named here so nobody reaches for a waveform
  library, and revisited only if the family actually uses voice notes.

---

##### D7.14.5 Playback

> **Rule. Nothing on Стена ever plays by itself.** No autoplay, not even muted,
> not on Wi-Fi, not when the card is centred in the viewport, not "just the
> first one".

A feed that starts moving while a grandmother scrolls it is the feature that
makes the app feel like something happening _to_ her. It also burns cellular
data, and it would be **inconsistent across the family's own phones** — which is
the argument that settles it rather than merely supporting it.

Muted autoplay _is_ permitted by WebKit (the 2016 video-policies post, still the
governing rule). But `HTMLMediaElement.cpp` adds
`RequireUserGestureForVideoDueToLowPowerMode` whenever the page reports Low
Power Mode, and the check is `element->isVideo()` with **no muted exemption** —
so a phone on 18 % battery shows a still while the identical card on a phone on
80 % plays, and there is no explanation the family could ever be given for that.
There is a matching restriction for thermal mitigation. One rule, everywhere, no
conditions, is the only version that is explicable.
(WebKit source, verified 2026‑08‑20.)

- **Photos: tap opens a full-screen viewer.** Pinch-zoom, swipe between the
  post's attachments, `Esc`/back/swipe-down to close, the description (§D7.14.8)
  as a caption at the foot, safe-area insets on all four sides, and the
  **uncropped** original — which is what makes the 4:5 clamp in the feed
  acceptable. The viewer is a route-less overlay: opening it must not push a
  history entry that the iOS back-swipe then eats (§G3).
- **Video: tap plays inline, in place.** **`playsinline` is not optional** —
  `MediaElementSession::requiresFullscreenForVideoPlayback()` still returns true
  without it on iPhone (iPad exempt), so the clip takes over the whole screen the
  moment it starts. Native controls from the first play, `preload="none"` until
  then. It does **not** open a lightbox — a video that jumps into a modal loses
  the reader's scroll position, and on iOS regaining it is not reliable.
- **`preload="none"` is belt and braces, not the mechanism.** iOS sets
  `MediaDataLoadsAutomatically` to false platform-wide, so it does not pre-buffer
  media without interaction anyway. The attribute is there for every other
  browser in the house, and the **poster object** is what actually keeps fifteen
  cards from costing fifteen range requests.
- **Audio: tap plays inline in its row.** iOS requires a user gesture for audio
  playback unconditionally (`RequiresUserGestureForAudioPlayback` defaults true
  on `IOS_FAMILY`), so there is no version of this that could have autoplayed
  even if we wanted it to.
- **Exactly one media element plays at a time, app-wide.** Starting a second
  pauses the first. Without this, scrolling past a playing clip leaves sound
  coming out of a card nobody can see, which on a phone is genuinely alarming.
- **A playing element pauses when it leaves the viewport** (`IntersectionObserver`,
  threshold 0). Same reason; this is the automatic half of the rule above.
- `prefers-reduced-motion` changes nothing here, because nothing moves until
  somebody asks it to. That is the point.

---

##### D7.14.6 Limits — the numbers

Two things set these, and neither is "what an upload endpoint can handle".

1. **The VDI has 14 GB free** (`docs/DEPLOYMENT.md` §6), of which ~1.5 GB is
   images plus the database plus fourteen retained dumps plus accumulating
   Docker layers.
2. **The nightly backup tars the whole object volume** into
   `latest-objects.tar.gz` and a container on the owner's PC **pulls it over a
   domestic connection every night** (§8). Today that tarball is six avatars.
   This section is about to make it the largest file in the system. See the
   flagged consequence at the end of this subsection — it is the most important
   operational finding in this document.

| Kind      | Accepted container → codec                                   | Max bytes, server-enforced | Max duration | What the client does first                                           |
| --------- | ------------------------------------------------------------ | -------------------------- | ------------ | -------------------------------------------------------------------- |
| **Фото**  | JPEG · PNG · WebP                                            | **8 MB**                   | —            | decode → downscale long edge to **2048** → WebP quality ladder       |
| **Видео** | QuickTime/MP4 (`ftyp`) **with an `avc1`/`avc3` video track** | **40 MB**                  | **60 s**     | read duration and size from a blob URL, refuse locally before upload |
| **Аудио** | MP4/M4A (`ftyp` + `mp4a`), WebM/Opus                         | **8 MB**                   | **180 s**    | recorded in-app (§D7.14.3); duration is known exactly                |
| Poster    | JPEG · WebP, generated by the client                         | **512 KB**                 | —            | one frame at t=0.1 s onto a canvas                                   |

Per post: **4 photos**, or **1 video**, or **1 audio**. Per comment: **1** of
anything.

**Where each limit is really enforced, stated honestly:**

- **Bytes are enforced by the server, always**, both by `@fastify/multipart`'s
  `fileSize` (so we never hold more than the limit in memory) and by a check on
  the assembled buffer (so a direct service call is still bounded). Exactly the
  belt-and-braces the avatar route already runs, for exactly the same reason.
- **The container is enforced by magic bytes**, never by `Content-Type` and
  never by the filename. This is the security boundary and it is the part of
  `image.ts` that generalises unchanged (§D7.14.10). **Note that every video
  from an iPhone is QuickTime, not MP4** (§D7.14.3): sniff the `ftyp` brand, and
  never branch on the extension.
- **The video codec is enforced too, and this is new.** Sniffing gives the
  container, not what is inside it — an `ftyp` box says nothing about H.264
  versus HEVC, and an iPhone recording in place produces HEVC that half the
  household cannot play (§D7.14.3). So the same box walk that reads duration
  continues to `moov → trak → mdia → minf → stbl → stsd` and reads the sample
  entry fourcc: **`avc1`/`avc3` accepted, everything else rejected with an
  instruction.** Roughly sixty lines beyond the duration walk, no dependency,
  and it converts an unwatchable card into a two-tap fix.
- **Duration is enforced where we can parse it, advisory where we cannot.** The
  `moov/mvhd` box carries `duration` and `timescale`; the file is already in a
  buffer, so a `moov` at the end is not a problem. For WebM and Ogg there is no
  comparably cheap read and the byte cap is the only enforcement. **Write this
  in the code comment**: a client that lies about `durationMs` gets a wrong
  duration pill, not a way past the byte cap.
- **The client checks everything first**, from a blob URL, before a single byte
  goes up: `File.size`, and `duration` after `loadedmetadata`. The difference
  between checking first and checking last is the difference between "we said no
  instantly" and "we spent three minutes of your tethered connection and then
  said no". The client cannot usefully check the **codec** — an iPhone decodes
  HEVC perfectly well, so a local probe would pass exactly where the family's
  other devices will fail. That check has to be the server's.

**Why 2048px and not the original.** The avatar path already establishes this
and the reasoning transfers verbatim: a phone photo is 4000×3000 and 6 MB; the
widest place it is ever drawn in this app is a 720px column at 2× (§C2), so
2048 is already generous. A 2048px WebP at the quality ladder lands around
250–500 KB. **The server therefore needs no image library at all** — no `sharp`,
no native build, no CVE surface from a C decoder parsing a stranger's file — and
the backend's entire image handling stays a magic-byte check and a byte count.
That property is worth protecting; it is why the photo cap is 8 MB rather than
25 MB even though the client normally sends 400 KB.

**Why video is not re-encoded client-side, and why the 40 MB cap is less cruel
than it looks.** Sixty seconds of iPhone 1080p is roughly 50 MB at «Высокая
эффективность» and roughly 100 MB at «Наиболее совместимые», so a naive reading
says the cap rejects clips the family considers short. It mostly does not,
because of the finding in §D7.14.3: picking a clip from **Фотогалерея** makes
PHPicker hand over the `compatible` representation, which is already transcoded.
The path that produces a 100 MB HEVC `.mov` is «Снять видео» — and that path is
the one the codec check rejects anyway, with a sentence telling the member to
pick it from the gallery instead. The two rules reinforce each other: the file
that is too big is usually the same file that is in the wrong codec, and the fix
for both is the same two taps.

Whether that holds for the clips this family actually shoots is an empirical
question, not a settled one, and §D7.14.11 names the half-day experiment.

**What the member sees when they exceed a limit.** Never a byte count they did
not choose, and never an English error. Every row except the codec one is
checked on the client before upload, so it arrives instantly:

| Situation                     | Where checked | Russian                                                                                                               |
| ----------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------- |
| Video longer than 60 s        | client        | «Видео длиннее минуты. Снимите покороче — так его посмотрят все, даже бабушка.»                                       |
| Video within 60 s but > 40 MB | client        | «Это видео слишком тяжёлое. Выберите его из галереи — так оно станет легче.»                                          |
| Video is not H.264            | **server**    | «Это видео снято в формате, который откроется не у всех дома. Выберите его из галереи — так оно перекодируется само.» |
| Audio longer than 180 s       | client        | «Запись длиннее трёх минут. Скажите главное — так её точно дослушают.»                                                |
| Microphone denied             | client        | «Без доступа к микрофону записать не получится. Разрешить можно в настройках телефона.»                               |
| Photo that will not decode    | client        | «Не получилось открыть это фото. Попробуйте другое.»                                                                  |
| Fifth attachment              | client        | «Больше четырёх не поместится.»                                                                                       |
| Mixed kinds                   | client        | «В одной записке — либо фото, либо видео, либо запись голоса.»                                                        |
| Storage unconfigured (503)    | server        | «Вложения сейчас недоступны. Записку можно повесить без них.»                                                         |

The numbers in those strings come from `GET /api/media/limits`, not from a
constant in the frontend. A client that hardcodes 8 MB while the server enforces
6 is the classic version of this bug, and it is free to avoid: the same config
value produces the guard and the sentence.

Two of these deserve their own note. The codec message is the only refusal that
arrives **after** the upload — it costs the member a wait, and it is worth it,
because the alternative is a card that nobody can tell them is broken. And every
one of these is a **refusal with an instruction**: «Снимите покороче»,
«Выберите из галереи», «Разрешить в настройках». A refusal without a next step
is where a family member stops using a feature.

> **Flag for the owner and for whoever owns `infra/`.** The nightly backup
> currently tars the entire object volume and pulls the whole tarball to a home
> PC every night. With media that becomes a multi-gigabyte nightly transfer of
> data that has not changed, and `docs/DEPLOYMENT.md` §6 already records that the
> object archives are **not** rotated by `BACKUP_KEEP`. **This must be fixed
> before media ships, not after**, and the fix is not this document's to write.
> The shape of it: pull objects incrementally (rsync or `--newer-than`) on a
> weekly cadence and keep the nightly for the SQL dump, which is a few MB
> gzipped. Media is also the one class of data in this app that is genuinely
> irreplaceable — a task can be retyped, a photograph of a child cannot — so the
> answer is a better backup, never a smaller one.

---

##### D7.14.7 Upload — a two-phase write, and why

The obvious design is to send the note and its files in one multipart request.
It is wrong here for three independent reasons, and the third is the one that
turns out to matter most.

1. A post with four photos is one 2 MB request that either wholly succeeds or
   wholly fails. One flaky photo loses the typed text.
2. Nothing can upload until the member has finished typing, so the whole wait
   lands after they tap «Повесить» — the moment they most expect the app to be
   finished.
3. **iOS destroys backgrounded PWAs.** `docs/research/ios-pwa-push.md` §12: a
   backgrounded web app comes back as a **cold start at `start_url`**, with React
   state, in-memory caches and unsaved input gone. §F9 already requires drafts to
   be persisted on `visibilitychange → hidden`, and a `File` handle cannot be
   persisted. So the request that was going to carry both the note and the
   photos is exactly the thing that does not survive being interrupted.

**A correction to what this project assumed, verified 20 August 2026.** The
natural assumption — and the one this section was first drafted on — is that
backgrounding kills an upload in flight. **It does not, and WebKit does this on
purpose.** `NetworkProcessProxy::setWebProcessHasUploads()` takes an
`UnboundedNetworking` RunningBoard assertion on the UI, Network and WebContent
processes for the duration, which is the same class of assertion that lets a
native app finish a transfer while backgrounded — and unlike the plain
`Background` assertion, it is not the one that times out after 30 seconds.

The trigger is narrow and it dictates how we write the request.
`ResourceRequestBase::hasUpload()` returns true only when the body contains an
`EncodedFileData` or `EncodedBlobData` element:

> **Rule.** Send the `File` or `Blob` **object itself**, inside a `FormData`.
> Never a base64 string, never an `ArrayBuffer`, never a JSON body with the
> bytes inlined. Those get **no** background assertion, and the difference is
> invisible in every desktop test you will run.

What is still true, and is why the two-phase design survives the correction
intact: **the bytes may well land, but the page waiting for the response may
not.** A cold start takes the React state that was going to receive the
attachment id. It is also unverified whether the assertion survives a screen
lock as well as an app switch, and whether the promise resolution is delivered
after a resume at all (§D7.14.11). Designing for "the upload dies" and designing
for "the upload lands but nothing is left to catch it" produce the **same**
answer here — which is a good sign, and it means this section did not need
rewriting when the assumption was overturned.

> **Rule.** Upload is **two phases**. `POST /api/media` takes one file, validates
> it, writes the object, and returns a **`mediaAttachment` with an id** — a row
> that is not yet attached to anything, owned by the uploader, with
> `expires_at = now() + 24 h`. `POST /api/wall/posts` (or a comment) then carries
> `attachmentIds`, and **claims** them inside the same transaction that writes
> the note: entity pointer set, `expires_at` cleared.

That shape pays for itself three times:

- **Upload starts the moment a file is picked**, while the sheet is still open
  and the member is still typing. By the time they have written a sentence the
  bytes are up.
- **A failure is per-file and retryable in place**, without touching the text.
- **The cold-start problem becomes small.** The draft that §F9 persists is
  `{ title, body, attachmentIds }` — three strings and a few uuids, which fit in
  `sessionStorage` trivially. A member who is interrupted by a phone call and
  comes back to a cold start finds their sheet with their **already-uploaded
  photos still on it**, and loses only whatever was still in flight. The 24-hour
  unclaimed window is exactly what makes that work, and it is why the window is
  a day rather than an hour.

**The outbox question, answered: no.** `features/shopping/outbox.ts` is a
durable IndexedDB queue and it exists for a specific reason — the shop basement
has no signal, and «отметить молоко купленным» is worthless twenty minutes
later. Media fails every part of that test:

- an outbox stores **intent**, and the intent here is several megabytes of
  bytes, which is a different kind of object;
- there is **no Background Sync and no Background Fetch in WebKit** — BCD gives
  `safari: false` for both, and WebKit's standards position on Background Fetch
  is still "Needs position" (verified 2026‑08‑20) — so the queue would flush only
  when the member reopens the app, at which point picking the photo again is two
  taps;
- **a service worker cannot help either**: bug 211018 documents service-worker
  contexts freezing on backgrounding, which is the opposite of what a durable
  queue would need;
- the queued bytes would sit under the 7-day script-writable-storage cap and
  whole-origin LRU eviction (research §10), so the "durable" queue would be the
  least durable thing in the feature;
- and the correction above removes the last reason to want one: WebKit already
  keeps a `File`-bodied upload alive across an app switch, which is most of what
  an outbox would have been for;
- a photo posted twenty minutes later is exactly as good as one posted now,
  which is the property the shopping tick does not have.

**What we build instead is the cheap half:** persist the draft _text_ and the
_completed_ attachment ids, and let the server's 24-hour unclaimed window be the
durability. That is the whole answer, it is a few lines, and it degrades to "pick
the photo again" rather than to a silent loss.

**Progress, and the trap in it.** `fetch()` reports **download** progress and not
upload progress, and streaming request bodies (`duplex: 'half'`) are not
available in Safari. So the upload call is an **`XMLHttpRequest`** with
`upload.onprogress`, deliberately, and that is the one place in the app that is
not `fetch`. It must carry the same `Authorization` header and go through the
same single-flight refresh as `shared/api/refresh.ts` — an XHR that quietly
invents its own auth path is how a token-rotation bug is born (D3). Write it as
a thin adapter over the existing client's token accessor, not as a second API
layer.

**Failure states, per tile.** Every attachment in the composer is a 72px tile:

| State        | Tile                                                                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------------------- |
| uploading    | thumbnail at 60 % opacity, determinate ring, ✕ cancels                                                              |
| done         | thumbnail, ✕ removes (and calls `DELETE /api/media/:id`, which only works while unclaimed)                          |
| failed       | thumbnail with a `--destructive` hairline, a **↻** and the Russian reason on one line; ↻ retries **this file only** |
| too big/long | never becomes a tile — refused at pick time with the sentence from §D7.14.6                                         |

- **«Повесить» is disabled while any tile is uploading**, and the sheet's footer
  says why in words — «Загружаем фото…» — rather than presenting a dead button
  with no explanation. It is **not** disabled by a failed tile: a member may post
  the note without the photo that would not go, and that is usually what they
  want at that point.
- **Offline**: the 📎 / «Добавить фото» control is disabled with «Фото можно
  добавить, когда появится интернет». Posting without media still works
  optimistically (§D7.12), because the note is the thing that matters.

---

##### D7.14.8 Description, and what a screen reader hears

Every attachment carries an optional **`alt`** — «описание», up to 200
characters — offered as one quiet row under each tile in the composer:
«Описание для тех, кто не видит».

- **Optional, deliberately.** A required description on a family board means
  nobody posts, or everybody types «фото». An optional one gets written when it
  matters, which is exactly when somebody is describing something for a specific
  person.
- When it is absent the accessible name is **built from what we know**, never
  left empty and never «изображение» (which is what a screen reader announces
  anyway): «Фото от Мамы», «Видео от Павла, 42 секунды», «Голосовая запись,
  1 минута 12 секунд». Empty `alt=""` means decorative, and a photo that is the
  content of a post is not decorative.
- The duration in that name is the same number the pill draws, for the same
  reason it passes D7.2 — and it is the **only** number allowed into an
  `aria-label` anywhere on this screen (§D7.7b).
- **`dominantColor`** — one `#rrggbb`, computed by the client from the canvas it
  is already using to downscale, sent as a form field, stored in one nullable
  column. It costs three lines and it is what makes the reserved box read as
  loading rather than as broken. Explicitly **not** BlurHash or ThumbHash: those
  are a dependency and a decode step for a difference nobody in this family will
  name.

---

##### D7.14.9 Lifecycle — nothing is orphaned, nothing is collected early

This is the subsection to get right, because both failure modes are silent. An
orphan is a bucket that grows forever on a 14 GB disk. A premature collection is
a photograph that is gone, and this app has no answer for that.

The governing fact is §D7.11: **clearing the board is a horizon, not a delete.**
`family_settings.wall_cleared_at` moves and the feed stops returning older rows.
Nothing is deleted — not a post, not a comment, not a reaction, not a kudos. It
follows immediately that:

> **Rule.** A clear touches **no object in the bucket**, ever. Not a delete, not
> a lifecycle rule, not a "tidy up objects older than the horizon" job. The rows
> are intact, so the attachments are simply not fetched. Undo puts the previous
> horizon back and the photographs are still there because nothing ever went
> looking for them.

The full lifecycle, with the only two places an object is ever removed:

| Stage                 | `entity_type` | `expires_at`  | Object                                                       |
| --------------------- | ------------- | ------------- | ------------------------------------------------------------ |
| **Uploaded**          | `null`        | `now() + 24h` | present                                                      |
| **Claimed**           | set           | `null`        | present, permanently                                         |
| **Board cleared**     | set           | `null`        | **present, untouched** — the row is hidden, not deleted      |
| **Note soft-deleted** | set           | `null`        | present; unreachable, because the route resolves via the row |
| **Reaped**            | —             | —             | removed                                                      |

**Reaper 1 — unclaimed uploads.** A member picks three photos, uploads them, then
closes the sheet without posting. Those three rows are never claimed. A job
(BullMQ, hourly) deletes rows where `expires_at < now()` and removes their
objects. This is the **only** collector that runs on a short clock, and it can
only ever touch a row that was never attached to anything.

**Reaper 2 — attachments of long-deleted notes.** A post is soft-deleted
(`deleted_at`), and §G4's 6-second undo may put it straight back. A job (daily)
removes objects whose owning post or comment has been soft-deleted for more than
**`MEDIA_ORPHAN_TTL_DAYS`, default 30**, then deletes the row.

> **Constraint, and it is not obvious: `MEDIA_ORPHAN_TTL_DAYS` must exceed
> `BACKUP_KEEP`.** The nightly dump retains 14 database snapshots. If an object
> is collected on day 7 while a dump from day 10 still references its row, then
> restoring that dump produces a post pointing at an object that no longer
> exists — a broken picture with no way to fix it, discovered during a restore,
> which is the worst possible moment. 30 > 14 with margin. If `BACKUP_KEEP` is
> ever raised, this must be raised with it, and the boot assertion that checks
> it belongs next to the config.

**Ordering of writes, copied from `storage.service.ts` and for the same reason.**
The avatar path establishes: validate, then write the object, then change the
database, then delete the old object after the commit. Every other ordering
loses data rather than leaking it. Media inherits it exactly:

1. validate bytes (magic bytes, size, duration) — the only security gate;
2. `put()` the object;
3. insert the `media_objects` row;
4. later, claim it inside the note's transaction.

A crash between 2 and 3 leaks one object with no row — which Reaper 1 cannot see
(there is no row) and which is therefore the one genuine leak in the design.
It costs a few hundred kilobytes and it is the right trade: the alternative,
writing the row first, produces a row pointing at nothing, which is a broken
image on somebody's card. A monthly `ListObjectsV2` reconciliation against the
table would close it and is **not** worth building at six users; note it here so
the next person does not rediscover the hole and assume it was missed.

**Removing an attachment from a note that already exists: you cannot.**

> **Rule.** Attachments are **immutable once claimed**. There is no "edit the
> photos on this note". To change them, delete the note (`post:delete:own` /
> `post:delete:any`, with its 6-second undo) and write it again.

This matches what the screen already does — there is no post-edit flow on Стена
today, and the body is equally immutable — and it removes a whole family of
questions about partial claims, re-claims and half-edited posts. It is worth
revisiting only if the family actually asks; flagged rather than defended.

**Moderation.** An adult with `post:delete:any` deleting a child's photo removes
the card immediately; the object survives for 30 days but is **unreachable**,
because the delivery route resolves the object through the row and the row is
soft-deleted. That is a real deletion from every user's point of view. A
hard-delete-now path is deliberately not offered: it would be the one
irreversible destructive operation on this screen, and §D7.11 already refused
that shape once for the same reason.

---

##### D7.14.10 Contract, schema and route changes

Precise enough to build from. Two agents will split this; the boundary is the
`media_objects` table, which **storage owns** — the wall service claims through
`storage.service.ts`, never through `storage.repository.ts` (D8: a module never
imports another module's repository).

**New table — `backend/src/modules/storage/media.schema.ts`**

```
media_kind  pgEnum ('image' | 'video' | 'audio')

media_objects
  id             uuid pk defaultRandom
  kind           media_kind      notNull
  contentType    text            notNull   -- from magic bytes, never the client
  objectKey      text            notNull   -- 'media/<yyyy>/<mm>/<id>/<random>.<ext>'
  posterKey      text                      -- video only; null otherwise
  byteSize       integer         notNull
  width          integer                   -- null for audio
  height         integer                   -- null for audio
  durationMs     integer                   -- null for image
  dominantColor  text                      -- '#rrggbb', client-computed, nullable
  alt            text                      -- <= 200 chars, nullable
  uploadedById   uuid            notNull -> users.id  onDelete: 'restrict'
  entityType     text                      -- null while unclaimed; 'post' | 'comment'
  entityId       uuid                      -- null while unclaimed
  sortOrder      integer         notNull default 0
  expiresAt      timestamptz               -- null once claimed
  createdAt      timestamptz     notNull defaultNow

  index media_entity_idx      on (entityType, entityId, sortOrder) where entityType is not null
  index media_unclaimed_idx   on (expiresAt)                        where expiresAt is not null
  index media_uploader_idx    on (uploadedById)
```

- **A new migration, never a regenerated baseline** (CONVENTIONS rule 8). This
  one has already cost a production deploy once.
- `entityType`/`entityId` is polymorphic, matching `comments` and `reactions` —
  same trade-off, same file-header warning, and the service layer owns the
  integrity. `entityType` is deliberately **not** the full
  `COMMENTABLE_ENTITY_TYPES` set: only `post` and `comment` may carry media.
  Kudos and polls may not (see below), and a task or an event carrying a photo is
  a different feature nobody has asked for.
- **`objectKey` is a real column here**, unlike the avatar path, which
  deliberately derives its key from the stored URL to avoid a second source of
  truth. The reason for the difference is worth writing in the file: an avatar
  has a URL to derive from, and media has an **id**; and the key carries a
  `yyyy/mm` prefix so the reapers and any future bucket audit can work by prefix
  rather than by scanning every object.

**Why kudos and polls take no attachments.** A «спасибо» is one sentence
addressed to one person — the warmest thing the app renders, and a photograph
attached to it turns it into an announcement with a recipient. A poll is a
question and a set of options. Both are shapes, not containers. If the owner
asks, the change is one entry in the entity-type whitelist plus a card layout —
but do not do it because it is easy.

**New contract file — `packages/shared/src/contracts/media.ts`**

```
MEDIA_KINDS = ['image', 'video', 'audio'] as const
mediaKindSchema = z.enum(MEDIA_KINDS)

mediaAttachmentSchema = z.object({
  id, kind, contentType, byteSize,
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  dominantColor: z.string().regex(/^#[0-9a-f]{6}$/).nullable(),
  alt: z.string().max(200).nullable(),
  url: z.string(),          // '/api/media/<id>'
  posterUrl: z.string().nullable(),
})

mediaLimitsSchema = z.object({
  maxPerPost, maxPerComment,
  image: { maxBytes, contentTypes: string[] },
  video: { maxBytes, maxDurationMs, contentTypes: string[] },
  audio: { maxBytes, maxDurationMs, contentTypes: string[] },
})
```

**Changes to `packages/shared/src/contracts/wall.ts`**

```
createPostSchema
  + attachmentIds: z.array(idSchema).max(4).default([])
  ~ body: z.string().trim().max(8000).default('')        // was nonEmptyString(8000)
  + .superRefine(...)  ->  body.length > 0 || attachmentIds.length > 0
                           else issue on `body`, code BAD_REQUEST

postResponseSchema
  + attachments: z.array(mediaAttachmentSchema).default([])

createCommentSchema
  + attachmentIds: z.array(idSchema).max(1).default([])
  ~ body: z.string().trim().max(4000).default('')
  + same superRefine

commentResponseSchema
  + attachments: z.array(mediaAttachmentSchema).default([])
```

`updatePostSchema` gains **nothing** — attachments are immutable (§D7.14.9).

Also export `LIKE_EMOJI = '❤️'` from the wall contract (§D7.7a), so client,
digest and any future notification rule agree on what a like is.

**Permission catalog — `packages/shared/src/domain/roles.ts`**

One new permission, and only one:

```
+ 'media:read'
```

granted to `child`, `teen`, `adult`, `admin`, `owner`. **Not to `guest`.**

The reasoning, because this is a real change to what a role means. `guest`
currently holds `member:read` and `event:read` and reads the wall, and that was
scoped when the wall was **text**. Photographs of children are the most
sensitive content this app will ever hold, and `guest` is by construction the
role handed to whoever is least inside the family — a babysitter, a relative
passing through, an account somebody made and forgot. Adding media without
touching the role would silently widen what "read the wall" means, and it is not
recoverable if it turns out to be wrong.

- A reader without `media:read` sees, in place of the media box, one quiet
  `body` line on `--muted` ground: «Фото — только для семьи». Not a lock icon,
  not a blur, and **not a blurred version of the actual image** — a blur is a
  client-side effect over bytes that were already sent.
- The delivery route enforces it server-side with `notFoundOnDeny`, so a guest
  requesting an object id gets a **404**, exactly as D4 requires: a 403 confirms
  the object exists.
- Attaching needs **no** new permission —
  `requireAny('post:create', 'comment:create')` (§D7.14.1).

**Config — `backend/src/core/config.ts`**

```
MEDIA_IMAGE_MAX_BYTES        default 8_388_608     (8 MB)
MEDIA_VIDEO_MAX_BYTES        default 41_943_040    (40 MB)
MEDIA_VIDEO_MAX_SECONDS      default 60
MEDIA_AUDIO_MAX_BYTES        default 8_388_608     (8 MB)
MEDIA_AUDIO_MAX_SECONDS      default 180
MEDIA_POSTER_MAX_BYTES       default 524_288       (512 KB)
MEDIA_MAX_PER_POST           default 4
MEDIA_MAX_PER_COMMENT        default 1
MEDIA_UNCLAIMED_TTL_HOURS    default 24
MEDIA_ORPHAN_TTL_DAYS        default 30            -- must exceed BACKUP_KEEP
```

They hang off the existing `config.storage` object, next to `avatarMaxBytes`,
under the same `storage.enabled` flag — an instance with no RustFS configured
answers **503** on upload and renders no attach control, and its calendar still
works. Same shape as `oauth` and `push`, for the same stated reason.

**Routes — `backend/src/modules/storage/media.routes.ts`**

| Method   | Path                    | Guard                                                     | Notes                                                                                                                                                    |
| -------- | ----------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST`   | `/api/media`            | `requireAny('post:create','comment:create')`              | multipart: `file` (required) + `poster` (optional image) + fields `alt`, `dominantColor`, `durationMs`, `width`, `height`. → `201 mediaAttachmentSchema` |
| `DELETE` | `/api/media/:id`        | same, **and** caller is `uploadedById`, **and** unclaimed | the ✕ on a composer tile. `409` on a claimed row — deleting a posted attachment is a post delete                                                         |
| `GET`    | `/api/media/:id`        | `member:read` + `media:read`, `notFoundOnDeny`            | streams; **Range-capable** (below)                                                                                                                       |
| `GET`    | `/api/media/:id/poster` | same                                                      | streams the poster                                                                                                                                       |
| `GET`    | `/api/media/limits`     | any authenticated                                         | the numbers the client's guards and sentences are built from                                                                                             |

**Five things about these routes that will otherwise be got wrong.**

1. **HTTP Range is mandatory, and the avatar precedent does not cover it.**
   `<video>` and `<audio>` in Safari open a resource with a `Range` request and
   will refuse to play something that answers `200` where a `206` was asked for.
   So `GET /api/media/:id` must read `Range`, pass it through to
   `GetObjectCommand({ Range })`, and answer `206` with `Content-Range` and
   `Accept-Ranges: bytes`. `s3.adapter.ts`'s `get()` grows an optional `range`
   and its result grows `contentRange`. **This is the single most likely cause of
   "the video plays in Chrome and not on the iPhone", and it produces no error
   message at all** — the element simply never starts.
2. **A second, separately-scoped `@fastify/multipart` registration.** The avatar
   route registers it inside its own plugin with `fileSize: avatarMaxBytes` and
   `files: 1`, precisely so no other endpoint accepts multipart. Media needs
   `files: 2` and a 40 MB `fileSize`. It must be its **own** encapsulated
   registration — raising the avatar route's limit to cover video would let
   somebody push 40 MB at a route that wants 2 MB.
3. **Memory.** `part.toBuffer()` on a 40 MB video means 40 MB resident per
   concurrent upload; six family members at once is ~240 MB on a 6.8 GB VDI.
   Acceptable, and it is the reason the cap is 40 and not 200. Streaming
   straight to S3 would need `@aws-sdk/lib-storage`, which is **not installed** —
   do not add it (CONVENTIONS rule 1); if concurrency ever becomes a real
   problem, that is the fix and the lead adds the dependency.
4. **The same response headers as the avatar route**, and for the same reasons:
   `Cache-Control: private, max-age=31536000, immutable` (safe because a media id
   is immutable and its object never changes), `X-Content-Type-Options: nosniff`,
   `Content-Security-Policy: default-src 'none'; sandbox`, `Vary: authorization`,
   ETag with `If-None-Match` → 304. The `nosniff` header is not decoration: it is
   what forbids a browser from second-guessing our sniffed `Content-Type`.
5. **`Content-Type` comes from the magic bytes, never from the request**, exactly
   as `image.ts` already documents. `image.ts` generalises into `media.ts` with
   the container table extended — `ftyp` at offset 4 with the brand at 8..12 for
   QuickTime/MP4/M4A, `1A 45 DF A3` for Matroska/WebM, `OggS` for Ogg — and **an
   unrecognised header stays a rejection, never a guess**. Two things to write
   into that file's header comment so the next reader does not have to
   rediscover them:

   - **Sniffing identifies the container, not the codec.** That closes the
     stored-XSS hole, which is what the check is for. It does not promise the
     clip will play anywhere, which is why `media.ts` also walks
     `moov → trak → mdia → minf → stbl → stsd` and whitelists `avc1`/`avc3`
     (§D7.14.6). The `mvhd` duration walk is on the way there, so it is one
     traversal, not two.
   - **Every video from an iPhone is QuickTime, never MP4** (§D7.14.3), so the
     brand table must contain `qt  ` and the extension must never be consulted.

**Live sync (D12) — `ROUTE_DOMAINS` gains one row, and it maps to nothing.**

```
| /api/media | (none) |
```

An upload changes nothing any screen draws — it stages an object that no card
references yet. Bumping `wall` for it would make every open phone in the house
refetch the feed each time somebody picks a photo, which is exactly the
"invalidate on a write nobody can see" waste D12 was written to avoid. The
**claim** happens inside `POST /api/wall/posts`, which already bumps `wall`, so
the card and its photo appear together in one invalidation.

This row is **explicit, not a fallthrough**: `sync.md` §8.1's coverage test fails
the build on a write route with no mapping, which is the correct behaviour and
the reason to write the row down rather than let it default.

**Frontend files**

| File                                                   | What                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shared/ui/media-grid.tsx` _(new)_                     | §D7.14.2 — the 1/2/3/4 layouts, ratio clamp, `dominantColor` ground, the tinted-card inset variant                                                                                                                                                                                 |
| `shared/ui/media-player.tsx` _(new)_                   | §D7.14.5 — the single-element-at-a-time registry, `playsinline`, `preload="none"`, pause-on-exit-viewport, the audio row                                                                                                                                                           |
| `shared/ui/media-viewer.tsx` _(new)_                   | the full-screen photo viewer: pinch-zoom, swipe between attachments, no history entry (§G3), `pt-safe`/`pb-safe`                                                                                                                                                                   |
| `shared/media/pick.ts` _(new)_                         | one file input, `accept="image/*,video/*"`, `multiple`, **no `capture`**, **never `audio/*`** (§D7.14.3); local size/duration guards; the Russian refusals                                                                                                                         |
| `shared/media/record.ts` _(new)_                       | `getUserMedia` + `MediaRecorder`, `isTypeSupported` with an `audio/mp4` fallback, the explain-then-prompt flow, and the assumption that the grant is **never** remembered across launches                                                                                          |
| `shared/media/encode.ts` _(new)_                       | the photo downscale + WebP quality ladder + `dominantColor` + poster extraction. **Generalise `features/settings/avatar-image.ts`** — do not write a second one                                                                                                                    |
| `shared/media/upload.ts` _(new)_                       | the XHR with `upload.onprogress`, over the existing token accessor                                                                                                                                                                                                                 |
| `features/wall/components/AttachmentField.tsx` _(new)_ | the tile strip in the composer: states, retry, ✕, the «описание» row                                                                                                                                                                                                               |
| `features/wall/components/ReactionBar.tsx`             | **The ❤️ chip is always drawn**, outline when nobody has used it — that chip **is** the like (§D7.7a). Other emoji appear only once used. Still no digit anywhere, `aria-label` included. `userIds` has landed, so `reactorLabel()` names people; the emoji-alone interim is gone. |
| `features/wall/components/CommentThread.tsx`           | per-comment foot row (❤️ + `⋯` sheet), 📎 on the composer, one attachment (§D7.8)                                                                                                                                                                                                  |
| `features/wall/components/AnnouncementComposer.tsx`    | `AttachmentField`; «Повесить» disabled while uploading; draft now `{title, body, attachmentIds}`                                                                                                                                                                                   |
| `features/wall/components/AnnouncementNote.tsx`        | the media slot, the no-text card, the `media:read` substitute line                                                                                                                                                                                                                 |
| `features/wall/locale.ts`                              | every string in §D7.14.6 and §D7.14.8                                                                                                                                                                                                                                              |

---

##### D7.14.11 What is not settled, and the experiment that settles it

Five, named rather than papered over, each with the experiment that closes it.
None blocks starting; the second one decides whether audio ships at all.

**1. Whether `MediaRecorder` actually runs inside an installed Home Screen web
app.** This is the load-bearing one, because §D7.14.3 established that
`accept="audio/*"` is broken on iOS (WebKit bug 242110, open), so an in-app
recorder is the **only** path to a voice note on an iPhone. `MediaRecorder` has
shipped on iOS since 14 and `getUserMedia` has worked in standalone since 13.4
(bug 185448, RESOLVED FIXED) — but I found **no primary source in either
direction** for the two of them together in a standalone Home Screen app, and
this project has been wrong about exactly that shape of claim three times.

> **Experiment.** On the real installed PWA: tap a record button, confirm the
> permission prompt appears, confirm a blob comes back, and read its `mimeType`.
> Ten minutes with Web Inspector over USB — the method that overturned three
> assumptions in the push research.
>
> **If it fails**, audio does not degrade to "pick a file", because there is no
> file picker for audio on iOS. It degrades to **not shipping audio**. In that
> case ship photo and video, say so plainly, and do not leave a record button
> that works on Android and not on the iPhones.

**2. Video sizes and codecs from the clips this family actually shoots.** The
mechanism is now settled (§D7.14.3): Фотогалерея transcodes to H.264, «Снять
видео» does not and yields HEVC in a `.mov` on a High-Efficiency phone. What is
**not** settled is whether the 40 MB cap and the 60-second cap are generous or
cruel for real clips, and whether Chrome demuxes HEVC inside a **QuickTime**
container specifically — caniuse tracks the codec, not the container, and no
primary source covers that pairing.

> **Experiment.** Record a 20-second clip on an iPhone at each of the two
> Камера → Форматы settings. Note both file sizes. Upload both through both
> menu paths (Фотогалерея and Снять видео) and open the card in (a) Safari on
> iOS, (b) Chrome on Android, (c) Chrome on Windows. Half a day, and it settles
> the caps, the codec whitelist, and whether the rejection sentence's advice
> ("pick it from the gallery") actually works.

**3. Whether the `UnboundedNetworking` assertion survives a screen lock**, how
long it lasts under memory pressure, and whether the JS promise resolves after a
resume or is simply dropped. The assertion itself is verified from WebKit source
(§D7.14.7); its lifetime under those three conditions is not, and no source
covers it.

> **Experiment.** Start a 30 MB upload on the installed PWA, then (a) switch
> apps, (b) lock the screen, (c) leave it locked five minutes. Watch the server
> log for the completed `POST /api/media`, and the client for whether it ever
> learns. **If the promise is dropped**, the fix is already half-built: the
> attachment exists server-side with a 24-hour claim window, so the composer can
> reconcile on resume by asking for the caller's unclaimed uploads. That would
> need one extra route (`GET /api/media/unclaimed`) and is not worth building
> before the experiment says so.

**4. The size of the object volume after a month of real use**, which decides
whether an explicit family-wide quota and a "what is taking up space" settings
screen need building. Building one now is speculative; discovering the disk is
full is not recoverable in a hurry.

> **Experiment.** None needed — instrument it. Report the bucket's total size
> through the existing health endpoint, look at it after four weeks, and build
> the quota UI only if the curve says so. **Trigger, written down now: at 50 %
> of the media budget, build it.**

**5. Whether `guest` should see media at all** is a decision, not an experiment,
and §D7.14.10 takes the cautious side by default (`media:read`, not granted to
`guest`). It is listed here because it is the one item on this list the owner
should actively confirm rather than discover: if the family's `guest` accounts
turn out to be grandparents rather than babysitters, the permission is one line
in `ROLE_PERMISSIONS` and the default was simply wrong in a recoverable
direction. The reverse — discovering after the fact that photographs of children
were readable by the loosest role in the system — is not recoverable at all.

---

### D8. Настройки and its sub-pages

The main page has already been rebuilt and is good. Two changes only.

1. **Desktop becomes two panes.** Below `lg`: as now. At `lg` and above: side
   column = the section list (Профиль · Уведомления · Способы входа ·
   Оформление · Календарь на телефоне), main = the selected section. Today the
   page is a 670px column floating in 1200px with 440px empty to its right — the
   content to fill it is the navigation that is currently _in_ the column.
2. **The `ValueRow` measure rule (§C2) applies here**, which is what
   permanently prevents the original «label at 378, chevron at 1326» defect from
   coming back on any future settings row.

#### D8a. Настройки → Уведомления

Measured **4820px on a phone, 3774px on desktop.** It is already grouped, which
helps, but the shape is wrong: each of 19 types is a card containing a master
switch, and _inside_ it a second row with three more switches (Push / Telegram /
В приложении). **76 switches**, and the same three words repeated 19 times.

Make it an actual matrix — which is what `PreferenceMatrix.tsx` is named for.

**Desktop / ≥ sm**

```
                                    Push   Telegram   В приложении
ЗАДАЧИ И ДЕЖУРСТВА
Назначена задача                     ●        ○            ●
  Вам поручили задачу или дежурство.
Скоро срок                           ●        ○            ●
Задача просрочена                    ○        ○            ●
…
```

- One sticky column header with the three channel names. 19 rows × 3 switches.
- A row is "off" when all three are off — kill the separate master switch, which
  is a fourth control expressing what the other three already say. A row with
  everything off renders its label at 60 % opacity.
- Each group gets a **group-level "all off" row**: «Задачи и дежурства ·
  выключить всё» as a quiet link, which is what the master switches were really
  for.
- Description text moves to a `ⓘ` tooltip / a second line only on `< sm`.
- Target height: **≤ 1400px on a phone**, ≤ 1100 on desktop.

**Phone (< sm)**, where three columns do not fit:

```
ЗАДАЧИ И ДЕЖУРСТВА                   выключить всё
┌──────────────────────────────────────────────┐
│ Назначена задача            📱 💬 🔔         │  channel icons, 44px each,
│ Вам поручили задачу.        ●  ○  ●          │  filled = on
└──────────────────────────────────────────────┘
```

One 64px row per type with three 44px icon toggles, `aria-label` carrying the
full channel name. Icons are legible because there are only three and they never
change: 📱 push, 💬 telegram, 🔔 в приложении — with the legend printed once
at the top of the section, not on every row.

- **Тихие часы** and **Устройства** stay as separate sections below.
- Устройства currently renders «Не отвечает — похоже, подписка умерла» in
  destructive red on _both_ rows plus a stray unlabelled checkbox. Dead
  subscriptions get a `--warning` chip «не отвечает» and one «Удалить»; the
  checkbox is a bug — remove it.
- The «Проверка / Отправить тестовое уведомление» block stays (research §15
  requires it) but moves to the **top**, because on iOS it is the only proof
  push works.

#### D8b. Настройки → Профиль

`ValueRow` list: Фото · Имя · День рождения · Цвет · Часовой пояс. Each row
opens a sheet with one field. No multi-field form: a profile is edited one thing
at a time, months apart. Цвет offers **the five ramp colours** (§B4) and nothing
else.

#### D8c. Настройки → Способы входа

One row per provider showing linked/not, the account it is linked to, and a
single trailing action («Отвязать» / «Привязать»). A warning row above if only
one method is linked: «Это единственный способ войти.» Keep the server-side
unlink guard as the authority.

---

### D9. Семья

**What the user came for:** "who is in the family and who is carrying what."

- Member rows, not cards: disc (ramp colour) · name `row` · role `meta` ·
  chevron. Owner/admin get a small `RoleBadge`.
- The load view is **neutral by construction** (D5): bars showing each member's
  share of the week, ordered by **name**, no numbers that can be ranked, one
  Russian sentence underneath («На этой неделе дела разошлись поровну»). The
  «Выручил других: 2» line stays — it is the one non-competitive metric and it
  rewards the right behaviour.
- `WeekLoadBar.tsx` currently calls `pointCount(load.earned)` unconditionally and
  crashes now that `PLURALS.point` is gone. It must render `choreCount` and
  nothing else.

**Desktop**: members in the main column, load in the side column.

---

### D10. Участники (admin)

- Pending requests are the attention block. Each: disc · name · email · «ждёт с
  17 августа» · «Одобрить» (primary) / «Отклонить» (ghost destructive).
- «Одобрить» opens the role sheet, because the role is chosen at approval time.
- Active members below as a plain list with role and last-seen.
- This screen may use the full column width — it is genuinely tabular.

---

### D11. Auth screens

`login-anon-phone` is the best-composed screen in the app. Leave the composition
alone. Four small changes:

1. The card is `--card` white on `--background` sand — at `oklch .99` vs `1.0`
   they are almost the same. Give the auth shell `--secondary` as its ground so
   the card reads as a card.
2. Nothing on the screen says what the app is. Put «Наша семья» under the house
   mark, in the display face.
3. On desktop the card is 384px centred in 1440 with nothing else. At `≥ lg`,
   split: left half = the mark, the name and one sentence of what this is; right
   half = the card. Same card, no new components.
4. `/auth/pending`, `/auth/rejected`, `/auth/suspended`: one mark, one heading,
   one sentence, one action («Обновить» / «Написать администратору»). They must
   never look like errors — a pending account is a normal state.

---

## D-forms. Create and edit — the centrepiece

This is where the app is judged. Every family member passes through these
screens roughly once a day.

### F1. What is wrong now, measured

|                 | Phone dialog           | Desktop dialog         | Viewport  |
| --------------- | ---------------------- | ---------------------- | --------- |
| «Новое дело»    | 358 × **1326**, top 63 | 512 × **1030**, top 68 | 844 / 900 |
| «Новое событие» | 358 × **1640**, top 34 | 672 × **1198**, top 36 | 844 / 900 |
| «Новая копилка» | 358 × **1034**, top 42 | —                      | 844       |

- **«Создать» is off-screen at every size, including 1440×900.** The user must
  scroll a dialog to find the button that does the thing they opened it for.
- **The event dialog starts 34px from the top of the screen.** Under an iPhone's
  status bar (47–59px in standalone) the title «Новое событие» is behind the
  clock. That is the clipped title the owner reported.
- **Five separate 2-column chip grids in one form.** In «Новое дело»:
  Исполнитель (5), Срок (4), Повторение (5). In «Новое событие»: Повторение (6),
  plus attendee chips. A 2-column grid of variable-length Russian labels produces
  ragged rows — «Никто — возьмёт любой» is two lines tall next to a one-line
  «Павел», and «Последний день месяца» wraps while «Ежедневно» does not. The
  whole form reads as an undifferentiated field of pills with no signal about
  what is required.
- **Everything is equally prominent**, so nothing tells you that a title and a
  time are all you need.
- **iOS kills backgrounded PWAs** (research §8). A 1640px half-filled modal is
  the most expensive thing in this app to lose, and it is the thing most likely
  to be lost.

### F2. The target

> **Create «ужин у бабушки, сегодня в 19:00»: 2 taps and one typed line.**
>
> tap ⊕ → type the title (keyboard is already up) → tap «Создать».
>
> Change it to tomorrow: +3 taps (tap the when-row, tap «Завтра», tap «Готово»).
> Make it weekly: +3 taps. Add a place: +1 tap and typing.

Every field that is not the title or the time must be **defaulted, correct, and
out of the way**.

**Defaults.**

| Field                 | Default                                                  | Why                                                          |
| --------------------- | -------------------------------------------------------- | ------------------------------------------------------------ |
| Событие: начало       | next :00 or :30 at least 30 min from now, family TZ      | the build currently defaults to «02:00», a timezone artefact |
| Событие: длительность | 1 час                                                    |                                                              |
| Событие: весь день    | off                                                      |                                                              |
| Дело: срок            | today 21:00 if created before 18:00, else tomorrow 21:00 | "by the end of the evening" is what a family means           |
| Дело: исполнитель     | «Любой»                                                  | assigning is a second decision                               |
| Повторение            | не повторяется                                           |                                                              |
| Видимость             | household                                                |                                                              |
| Напоминание           | за 1 час (events), в срок (tasks)                        |                                                              |

### F3. The container — a full-screen sheet on a phone

A 1900px scrolling dialog is the wrong container. Replace `Dialog` with a
**full-screen sheet** on `(pointer: coarse)` and keep `Dialog` on fine pointers.
New component: `shared/ui/form-sheet.tsx` (§E).

```
┌────────────────────────────────────────┐
│                ▁▁▁▁                    │  drag handle, 36×4, --hairline
│  Отмена     Новое событие     Создать  │  FIXED header, 56px, pt-safe
├────────────────────────────────────────┤  ← border only when scrolled
│                                        │
│  ┌──────────────────────────────────┐  │
│  │ Ужин у бабушки                   │  │  TITLE FIRST, autofocus,
│  └──────────────────────────────────┘  │  17px, borderless, 56px tall
│                                        │
│  🕘  Сегодня, 19:00 · 1 час        ›  │  THE WHEN-ROW — one row, one tap
│                                        │
│  ПОДРОБНЕЕ                             │  quiet label
│  📍 Место                    —      ›  │  56px ValueRows, hairline separated
│  🔁 Повторение     не повторяется   ›  │
│  👥 Кто                      —      ›  │
│  📝 Описание                 —      ›  │
│                                        │
└────────────────────────────────────────┘
     content scrolls; header never does
```

Rules:

- **Header is fixed and carries the primary action.** «Создать» is always
  reachable. It is disabled until the title is non-empty, and when disabled it
  keeps its position and label rather than vanishing.
- `pt-safe` on the header and `pb-safe` on the sheet. Sheet top inset is
  `max(env(safe-area-inset-top), 12px) + 12px` — never flush.
- The sheet is `h-[100dvh]`, never `100vh`.
- The **title field is autofocused** and the software keyboard is expected. The
  scroll container is `100dvh` so the keyboard shrinks it rather than covering
  the header.
- «Отмена» with unsaved input asks «Не сохранять?» once. Draft is persisted to
  `sessionStorage` on `visibilitychange → hidden` and restored on reopen
  (research §8: the PWA will be killed).
- Drag-to-dismiss via vaul's handle, with the same unsaved-input guard.

**Desktop**: the same content in a `Dialog`, `max-width: 520`,
`max-height: min(80dvh, 720px)`, header and footer fixed, body scrolls. The
footer holds «Отмена» / «Создать» because that is where a desktop user expects
them; the header does not duplicate them.

### F4. The when-row and the «когда» sheet

The single highest-value change. Instead of «Весь день» + «Дата» + «Начало» +
«Длительность» stacked in a nested bordered box — four labelled controls and a
box-in-a-box — one row that **states the plan in words**:

```
🕘  Сегодня, 19:00 · 1 час                                    ›
🕘  Завтра, весь день                                         ›
🕘  Каждый четверг с 20 августа, 19:00 · 2 часа               ›
```

Tapping it opens a small sheet (≈ 60 % height, not full screen):

```
┌────────────────────────────────────────┐
│              ▁▁▁▁                      │
│  Когда                        Готово   │
├────────────────────────────────────────┤
│ [ Сегодня ] [ Завтра ] [ Выбрать… ]    │  3 chips — ONE row, not a grid
│                                        │
│ ┌── DateField ──────────────────────┐  │  only when «Выбрать…»
│ │ 20 августа 2026                   │  │
│ └───────────────────────────────────┘  │
│                                        │
│ Весь день                        ○     │  Switch, 56px row
│                                        │
│ Начало   [ 18:00 ][ 19:00 ][ 20:00 ]   │  TimeField + 3 nearby suggestions
│ Сколько  [ 30 мин ][ 1 ч ][ 2 ч ][…]   │  4 chips + «другое»
└────────────────────────────────────────┘
```

- **Три chips maximum in a row, and the row never wraps.** If a set needs more
  than three options it is a list, not chips.
- «Весь день» on hides Начало and Сколько entirely instead of disabling them.
- The `DateField` / `TimeField` components already exist and already fix the
  native-control mismatch. One required change: `PickerSurface` in
  `shared/ui/field-shell.tsx` currently always uses a `Popover`. On
  `(pointer: coarse)` it must use a `Drawer` — a month grid inside a popover
  anchored to a 358px field is unusable with a thumb.

### F5. Chips become lists

Every remaining chip grid becomes either a single-row segmented control (≤ 3
short options, mutually exclusive, used daily) or a **list of radio rows in a
sheet**.

| Field                    | Now                     | Becomes                                                                                                                                                                                                                                                                                            |
| ------------------------ | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Повторение (5–6 options) | 2-col chip grid, ragged | `🔁 Повторение · не повторяется ›` → sheet with a **single-column list**: ○ Не повторяется / ○ Ежедневно / ○ По дням недели / ○ Раз в N недель / ○ N-е число месяца / ○ Последний день месяца. Selecting one that needs parameters reveals them **inline under that row**, not on a second screen. |
| Исполнитель (5 people)   | 3-col chip grid         | `👥 Кто · Любой ›` → sheet with a **horizontal row of member discs** (Любой + 5 people, 64px each, fits 390px) — a person is a face, not a pill                                                                                                                                                    |
| Срок (4 presets)         | 2-col chip grid         | The **one** case that stays inline: a single-row segmented control `[Сегодня][Завтра][На неделе][Дата…]`. It is the daily decision on a task.                                                                                                                                                      |
| Категория                | free text input         | `ValueRow` → sheet with the existing categories as rows + «Новая»                                                                                                                                                                                                                                  |
| Видимость                | Select                  | Moves behind «Подробнее», default household                                                                                                                                                                                                                                                        |
| Напоминания              | chips                   | `ValueRow` → sheet                                                                                                                                                                                                                                                                                 |

Net effect on «Новое событие», phone: **6 visible controls** (title, when-row,
and four `ValueRow`s under «ПОДРОБНЕЕ») instead of 12 fields and 2 chip grids.
Estimated height ≈ 520px inside an 844px sheet — no scrolling for the common
case.

### F6. Editing, and the recurrence scope

Editing uses the same sheet with the header reading «Изменить» and the primary
action «Сохранить». One structural change.

**Decide the scope before you edit, not after.**

Today the user fills a long form, presses Save, and is then asked «Только это /
Это и последующие / Все» — a decision they cannot evaluate, on top of a form
they just fought. Invert it. Tapping «Изменить» on an occurrence of a recurring
series opens a small sheet first:

```
┌────────────────────────────────────────┐
│  Что меняем?                           │
├────────────────────────────────────────┤
│ ○ Только это                           │
│   Изменится только 20 августа.         │  ← the consequence, in words
│ ○ Это и следующие                      │
│   Изменится 20 августа и все повторы   │
│   после него.                          │
│ ○ Все                                  │
│   Изменится каждый повтор, включая     │
│   прошедшие.                           │
└────────────────────────────────────────┘
```

Then the form opens with a persistent chip in its header:

```
│  Отмена      Изменить        Сохранить │
│  Меняем: только 20 августа   · сменить │  --secondary chip, 32px
```

One decision, taken when it is cheap, visible the whole time, changeable in one
tap. `shared/components/EditScopeDialog.tsx` stays but moves to the entry point
and gains the consequence lines. **Deleting** keeps the confirm-after pattern,
because deletion is not something you compose towards.

### F7. Copy in the forms

- Placeholders demonstrate, they do not instruct: «Например, ужин у бабушки».
- No field says «(необязательно)» — everything under «Подробнее» is optional by
  construction, and the word appears once as the section label.
- The button that creates says «Создать»; the toast that follows says
  «Событие создано». Same verb, same direction.
- Delete the помощь text under fields. «Начисляются тому, кто на самом деле
  сделал» is going away with points; the rest («По одному товару в строке») moves
  into the placeholder.

---

## C-gestures. The interaction model

The owner asked for swipes and "PWA features". The three questions worth
answering explicitly:

### G1. Every gesture has a visible twin — always

A swipe is an accelerator for someone who already knows it is there. If deleting
a shopping item is only a swipe, then for the grandmother in this family that
feature does not exist, and for the ten-year-old it is a thing that happens by
accident.

So: **no capability is reachable only by gesture.** Every swipe action also
exists as a visible control on the row (a tick, a 🗑) or in the row's action
sheet, which opens from a visible `⋯` _and_ from long-press. The gesture is a
second door onto the same room.

The corollary is that gestures are allowed to be silent. No coach marks, no
"swipe to delete" hints, no first-run tour. The visible control teaches the
action; the gesture is discovered or it is not, and nothing is lost either way.

### G2. Gate on touch, not on install — recommendation

**Gate on `(pointer: coarse)`, not `display-mode: standalone`.**

Reasoning:

- A gesture is an affordance of the input device, not a reward for installing.
  A phone in Safari has exactly the same thumb.
- Gating on standalone makes the gestures untestable in a browser, undebuggable
  in devtools and invisible to whichever family member has not installed yet —
  which, on the evidence of who installs PWAs, is likely the grandmother, the
  person who most needs the visible control _and_ would most benefit from a
  large forgiving swipe target.
- `display-mode: standalone` is genuinely required only for things that cannot
  work otherwise: push permission and subscription (research §1), the install
  prompt, and any home-indicator-specific chrome. Keep those gated.
- Practical form: a `useCoarsePointer()` hook over
  `matchMedia('(pointer: coarse)')`, live-updating, plus CSS
  `@media (pointer: coarse)` for the purely visual parts.

One exception: **pull-to-refresh is additionally suppressed in browser Safari
below iOS's own overscroll**, because Safari's own pull gesture exists there. In
practice `overscroll-behavior-y: none` is already set on `html`/`body`, so this
is a no-op — but implementers must verify on device rather than assume.

### G3. Not fighting the iOS back gesture

The system back gesture in a standalone web app starts within roughly 20–30px of
the **left** edge. Two measures, both applied:

1. **Direction.** Row swipes are **left-only** — the finger moves right→left and
   the action is revealed on the trailing edge. There is no right-swipe action
   anywhere in this app. A rightward drag on a row does nothing and lets the
   system have it.
2. **Dead zone.** A row's drag handler ignores any `touchstart` whose `clientX`
   is within **32px of the left edge of the viewport** (not of the row). Even a
   leftward drag that begins there is left alone, because that is where the user
   is most likely mid-back-gesture.

### G4. Swipe on a row — the spec

Applies to: shopping items, task rows, notification rows. Component:
`shared/ui/swipe-row.tsx` (§E).

- **Engage** when horizontal movement ≥ 12px _and_ |Δx| ≥ 2 × |Δy|. Otherwise it
  is a scroll and the row never moves. Once engaged, `touch-action: pan-y` is
  released to the row for the rest of the gesture.
- **Track 1:1** with the finger, with rubber-band resistance past 50 % of row
  width.
- **Rest stop** at 88px — one action button, 88 × row height, in the action's
  colour, with an icon and a word («Куплено», «Сделано», «Прочитано»). Releasing
  before 88px snaps back.
- **Commit** if released past **45 % of row width**, or by tapping the revealed
  button.
- **On commit**: the row animates its own state change in place (the tick fills,
  the title goes muted with a strike) and then, if the row leaves the section,
  collapses its height to 0 over 180ms. `prefers-reduced-motion` skips the
  collapse and swaps instantly.

**Which action goes on the swipe.** Exactly one per row, and **it is always the
reversible one**:

| Row           | Swipe left        | Never on a swipe    |
| ------------- | ----------------- | ------------------- |
| Shopping item | куплено / вернуть | **удалить**         |
| Task          | сделано / вернуть | удалить, пропустить |
| Notification  | прочитано         | удалить             |

Delete is destructive and irreversible from the user's point of view, so it is
not put behind a gesture at all. That removes the "lose your shopping list"
failure rather than papering over it. Delete lives on the visible 🗑 and in the
long-press sheet, and it always confirms when it removes more than one thing.

**Undo, regardless.** Every swipe commit raises a `sonner` toast for **6
seconds**: «Куплено · Отменить». The mutations are already optimistic, so undo
is a second optimistic write and feels instant. Toasts stack to a maximum of
one — a second swipe replaces the first toast and the first action stands.

**Haptics.** One 10ms `navigator.vibrate(10)` when the commit threshold is first
crossed, and nowhere else. iOS Safari does not implement `navigator.vibrate`, so
this is Android-only and must be a pure enhancement: the real feedback is the
visual snap. Never vibrate on tap, on open, on success or on error.

### G5. Long-press

- **450ms**, cancelled by >10px of movement or by any scroll.
- Opens the row's action sheet — the same sheet the visible `⋯` opens, and on a
  task the same actions the detail screen offers.
- The row gets `-webkit-touch-callout: none` and `user-select: none` (the
  `.no-callout` utility already exists) so iOS does not raise its own selection
  bubble.
- Long-press is for the _secondary menu_ only. Nothing is reachable solely by
  long-press.

### G6. Pull to refresh

- Host: `AppShell`, on the document scroller, only when `scrollY === 0`, only on
  `(pointer: coarse)`, and **never while a dialog, sheet or drawer is open**.
- Threshold 64px with resistance; the indicator is a 56px band that grows out
  from under the app bar with a rotating `--primary` arc.
- On release past threshold:
  `queryClient.refetchQueries({ type: 'active' })`.
  **Never `location.reload()`** — research §8: in an installed PWA a reload is a
  cold start that loses every bit of state, including a half-typed form.
- It is an accelerator only. Per research §8 the app must already refetch on
  `visibilitychange → visible`, so a family member who never discovers the
  gesture still gets fresh data.

### G7. Sheets over dialogs

On `(pointer: coarse)`, **every** modal is a vaul `Drawer` from the bottom with
a drag handle; on fine pointers it stays a `Dialog`. This is one new component,
`shared/ui/responsive-dialog.tsx`, and it changes: `EventFormDialog`,
`TaskEditor`/`TaskForm`, `GoalFormDialog`, `ContributeDialog`,
`MilestoneDialog`, `CreateListDialog`, `ApproveRoleSheet`, `RejectDialog`,
`EditScopeDialog`, `ConfirmDialog`, `MemberSheet`, `EventDetailSheet`,
`SwapPanel`, and `PickerSurface`.

Sizes: `full` (create/edit forms, §F3), `tall` (≈ 85dvh, detail sheets),
`auto` (content height, capped at 60dvh — pickers, confirms, action sheets).
All get `pb-safe` and a 36×4 handle.

### G8. Motion — where it helps and where it is noise

Helps:

- **Row state change**: 180ms ease-out on the tick fill and the strike-through.
  It is the receipt for the tap.
- **Sheet in/out**: vaul's spring, unmodified. It is the thing that makes a
  bottom sheet feel like a surface rather than a repaint.
- **Row collapse** when an item leaves a section: 180ms height + opacity, so the
  list does not teleport.
- **Number changes** (counts, saved amount): no animation, but reserve the width
  with `tabular-nums` so nothing reflows.

Noise — do not add:

- Page transitions between tabs. React Router + a fixed shell; a cross-fade on
  navigation just delays the content.
- Staggered card entrance animations. Six cards flying in is exactly the "AI
  demo" tell, and on a cold PWA start it delays the first useful pixel.
- Skeleton shimmer. A static `--muted` block is calmer and cheaper.
- Hover effects on touch. `@media (hover: hover)` guards all of them.

`prefers-reduced-motion` is already reset globally in `index.css` — keep it, and
make sure the swipe row's collapse and the sheet's spring both respect it.

---

## E. Components

Named against the real tree.

### New — `src/shared/ui/`

| File                    | What                                                                                                                                                                                                                                           |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `responsive-dialog.tsx` | `Dialog` on `(pointer: fine)`, vaul `Drawer` on coarse. Props: `size: 'full' \| 'tall' \| 'auto'`, `title`, `description`, `primaryAction`, `onOpenChange`. The single highest-leverage change in this document.                               |
| `form-sheet.tsx`        | The create/edit container (§F3). Fixed `pt-safe` header with Отмена / title / primary; scrolling body; `pb-safe`. Unsaved-input guard + `sessionStorage` draft on `visibilitychange`.                                                          |
| `value-row.tsx`         | The 56px row: optional leading icon, label, value (or «—»), trailing chevron/switch/action. **Caps its content at 720px** (§C2). Used by settings, forms, detail screens.                                                                      |
| `section.tsx`           | `label` (12/600 uppercase) + optional right-hand link + hairline-separated children on one L1 surface. Replaces per-widget `Card`.                                                                                                             |
| `swipe-row.tsx`         | §G4. Props: `action: { label, icon, tone, onCommit }`, `undoLabel`. Handles the 32px dead zone, the axis lock, the two stops, the toast.                                                                                                       |
| `segmented-control.tsx` | Promote `features/tasks/components/SegmentedControl.tsx` to shared. Max 3 options, single row, never wraps, 44px.                                                                                                                              |
| `day-rail.tsx`          | §C3. Renders the 56px rail cell (time / day marker / member tick).                                                                                                                                                                             |
| `member-disc.tsx`       | 24/32/64px, ramp colour by `sortOrder % 5`, initial. Wraps `UserAvatar`.                                                                                                                                                                       |
| `pull-to-refresh.tsx`   | §G6. Wraps `AppShell`'s main.                                                                                                                                                                                                                  |
| `use-coarse-pointer.ts` | `matchMedia('(pointer: coarse)')` hook, live.                                                                                                                                                                                                  |
| `media-grid.tsx`        | §D7.14.2. The 1/2/3/4 layouts, the 4:5 tall-end ratio clamp, `max-height: 60dvh`, the `dominantColor` reserved box, and an `inset` variant for tinted cards. Never renders a «+N» tile — the cap is four precisely so it does not have to.     |
| `media-player.tsx`      | §D7.14.5. `playsinline` (mandatory on iPhone), `preload="none"`, the poster/play/duration overlay for video, the 56px row for audio, and a module-level registry so **exactly one element plays app-wide**, pausing on exit from the viewport. |
| `media-viewer.tsx`      | The full-screen photo viewer: pinch-zoom, swipe between a post's attachments, the description as a caption, `pt-safe`/`pb-safe`, and **no history entry** so the iOS back-swipe is not eaten (§G3).                                            |

### Change — `src/shared/ui/`

| File                                                  | Change                                                                                                           |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `card.tsx`                                            | Remove `shadow-sm`. `gap-6 py-6` → `gap-4 py-4`; `px-6` → `px-4`.                                                |
| `field-shell.tsx`                                     | `PickerSurface` renders a `Drawer` on coarse pointers, `Popover` on fine (§F4).                                  |
| `sheet.tsx` / `drawer.tsx`                            | Add the 36×4 handle to every bottom drawer; verify `pb-safe` on all four sides.                                  |
| `button.tsx`                                          | Add `size="row"` (44px, full width, left-aligned) for the action sheets. Confirm every size is ≥ 44px on coarse. |
| `input.tsx`, `textarea.tsx`, `select.tsx`             | 17px on coarse, 15px on fine. Height 48 coarse / 40 fine.                                                        |
| `empty-state.tsx`, `shared/components/EmptyState.tsx` | `action` becomes **required**. Cap the description at two lines.                                                 |

### Change — `src/shared/components/`

| File                  | Change                                                                                                                                                                                                            |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PageHeader.tsx`      | Title uses `--font-display` at `h1`. On `≥ md` the title and the primary action move into `TopAppBar` and `PageHeader` renders only description + filters. `actions` collapse to a single icon button below `sm`. |
| `EditScopeDialog.tsx` | Becomes the **entry** prompt (§F6) and gains a one-line consequence under each option.                                                                                                                            |
| `ConfirmDialog.tsx`   | Via `ResponsiveDialog`. Destructive confirms name what is being removed and how many.                                                                                                                             |
| `UserAvatar.tsx`      | Colour comes from the chart ramp, not `users.color`. Export `AvatarGroup` capped at 4 + «+N».                                                                                                                     |

### Change — `src/app/layout/`

| File                 | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AppShell.tsx`       | The §C1 grid: `main` + optional `aside` slot, per-route. Hosts `PullToRefresh`. Container maxes per breakpoint, not one `max-w-3xl xl:max-w-5xl`.                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `BottomTabBar.tsx`   | **Opaque `--card` surface** — drop `bg-background/95` and `backdrop-blur-md`; they are literally the page colour and are why the bar does not read as a bar. Keep the 1px top border. Active tab gets a 48×32 `--secondary` pill behind the icon plus `--primary` icon and label. Surface extends into `env(safe-area-inset-bottom)`; the icon+label block stays centred in the top 56px. **Tapping the tab of the route you are already on scrolls the document to top** — the standard iOS behaviour, and what keeps Стена's compose row one tap from the bottom of a long feed (§D7.5). |
| `TopAppBar.tsx`      | On `≥ md`, carry the page title and the screen's one primary action. Today it is 1200×57 holding two controls.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `DesktopSidebar.tsx` | Fine as is. Add the pending-approval count badge on «Участники».                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

### Change — features

| File                                                   | Change                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `features/shopping/pages/ListPage.tsx`                 | The sticky offset fix (§D6). Composer top-of-list at `≥ md`.                                                                                                                                                                                                                                        |
| `features/shopping/components/QuickAddBar.tsx`         | Opaque; ≤ 3 rows; suggestions above the field; hint inline.                                                                                                                                                                                                                                         |
| `features/shopping/components/FrequentStrip.tsx`       | Edge fade + a `›` affordance; currently the last chip is clipped mid-word at 390px.                                                                                                                                                                                                                 |
| `features/shopping/components/ItemRow.tsx`             | Wrap in `SwipeRow` (куплено). 56/68px.                                                                                                                                                                                                                                                              |
| `features/today/components/WidgetCard.tsx`             | **Delete.** Replaced by `Section`.                                                                                                                                                                                                                                                                  |
| `features/today/pages/TodayPage.tsx`                   | The band model (§C2/D1). One attention block, one «все ›» per section.                                                                                                                                                                                                                              |
| `features/today/components/LoadWidget.tsx`             | Delete with points.                                                                                                                                                                                                                                                                                 |
| `features/tasks/components/TaskCard.tsx`               | 56px row, member disc, member tick. Remove the coloured footer band. Wrap in `SwipeRow`.                                                                                                                                                                                                            |
| `features/tasks/components/TaskFilters.tsx`            | Segmented `Мои/Все` + one «Фильтры · N» row → sheet on phone; side-column panel on desktop.                                                                                                                                                                                                         |
| `features/tasks/components/TaskForm.tsx`               | Rebuild per §F3–F5. Remove Баллы.                                                                                                                                                                                                                                                                   |
| `features/calendar/components/EventFormDialog.tsx`     | Rebuild per §F3–F5.                                                                                                                                                                                                                                                                                 |
| `features/calendar/pages/CalendarPage.tsx`             | Month into the app-bar title; remove `SubscribePanel` from the page.                                                                                                                                                                                                                                |
| `features/calendar/components/AgendaList.tsx`          | Adopt `DayRail`.                                                                                                                                                                                                                                                                                    |
| `features/goals/components/GoalCard.tsx`               | Row, one indicator, no floating «Пополнить».                                                                                                                                                                                                                                                        |
| `features/goals/components/ProgressRing.tsx`           | Detail screen only.                                                                                                                                                                                                                                                                                 |
| `features/settings/components/PreferenceMatrix.tsx`    | Become an actual matrix (§D8a).                                                                                                                                                                                                                                                                     |
| `features/family/components/WeekLoadBar.tsx`           | Remove points; `choreCount` only.                                                                                                                                                                                                                                                                   |
| `features/wall/components/AnnouncementComposer.tsx`    | Stays a `FormSheet` behind `BoardCompose`, the one door for all three kinds of note. Its trigger moves from the app-bar `⊕` to the feed's **compose row** below `md` (§D7.5). Стена's panels own no state and the screen mounts one tree at every width; `useTwoColumn` is not used there any more. |
| `features/wall/components/WallStream.tsx`              | Becomes the feed (§D7.4–D7.9): compose row, floating head with no section headers, bounded auto-load, a visible end, the «Новое на стене» pill. `Section` is used once, for the whole surface — never once per group.                                                                               |
| `features/wall/components/ActivityRow.tsx`             | Consecutive activity items coalesce into **one** digest card, 3 lines + «и ещё N» expanding in place (§D7.6).                                                                                                                                                                                       |
| `features/wall/components/ReactionBar.tsx`             | **Remove the digit.** Emoji chip + the reactors' discs; interim is the emoji alone until `reactionSummarySchema` carries `userIds` (§D7.7). `reactorLabel()` in `locale.ts` changes with it.                                                                                                        |
| `features/wall/pages/WallPage.tsx`                     | App-bar `⋯` → «Очистить доску» for `settings:manage` (§D7.11). `SideColumn` children wrapped `hidden lg:block`.                                                                                                                                                                                     |
| `features/wall/components/CommentThread.tsx`           | One 44px foot row per comment: ❤️ + `⋯` action sheet («Поставить реакцию», «Удалить»), long-press opening the same sheet. A 📎 on the existing composer, **one** attachment, 240px cap, inset not bled (§D7.8).                                                                                     |
| `features/wall/components/AttachmentField.tsx` _(new)_ | The composer's tile strip: pick → upload-on-pick → per-tile progress / retry / ✕, the «описание» row, and the local size, duration, count and mixed-kind refusals (§D7.14.6–7).                                                                                                                     |
| `features/wall/components/VoiceRecorder.tsx` _(new)_   | «Записать голосом» — explain-then-prompt, `MediaRecorder` with an `audio/mp4` fallback, and no assumption that a previous grant survived the launch (§D7.14.3). **Ship last**; §D7.14.11 item 1 decides whether it ships at all.                                                                    |
| `shared/media/{pick,encode,record,upload}.ts` _(new)_  | The four seams. `encode.ts` **generalises `features/settings/avatar-image.ts`** — do not write a second decode-and-downscale ladder.                                                                                                                                                                |

---

## F. Platform rules — do not break these

Non-negotiable. From D7 and `docs/research/ios-pwa-push.md` §9.

1. **Tap targets ≥ 44 × 44 px** on `(pointer: coarse)`, including icon-only
   buttons, switches, chips, list ticks and every tab-bar slot. The current build
   passes this; keep it.
2. **Every text control ≥ 16px on coarse pointers.** iOS zooms the viewport on
   focus below 16 and never zooms back, and `maximum-scale` is ignored. The
   global `@media (pointer: coarse) { input, select, textarea { font-size: 16px
!important } }` in `index.css` stays; this spec raises the intent to 17.
3. **No horizontal scroll at 320px.** Verified: `list-320` and `today-320` both
   report `scrollWidth === 320`. Any new fixed-width element must be checked at 320. Horizontal _scrollers_ (Часто покупаем, member discs) are allowed and
   must have an edge fade so the clipped item reads as scrollable, not broken.
4. **Safe-area insets everywhere an edge is touched.** `pt-safe` on the app bar
   and every full-screen sheet header; `pb-safe` on the tab bar, bottom drawers
   and any bottom-anchored composer. The tab bar's _surface_ extends into the
   inset; its content does not.
5. **`dvh`, never `vh`.** `100dvh` for the shell, sheets and any full-height
   pane. `vh` on iOS means the large viewport and produces a jump when the URL
   bar collapses.
6. **The tab bar is anchored.** `position: fixed; inset-inline: 0; bottom: 0`,
   **opaque** surface, 1px top border, and the page reserves
   `calc(var(--spacing-tabbar) + env(safe-area-inset-bottom, 0px) + 16px)` of
   bottom padding. Nothing else may be `sticky bottom-0` — anything that wants to
   sit above the bar offsets by
   `calc(var(--spacing-tabbar) + env(safe-area-inset-bottom, 0px))`.
7. **The document is the scroll container**, as `AppShell` already does, so iOS
   collapses the URL bar in browser and "tap the status bar to scroll to top"
   works. (`docs/research/ios-pwa-push.md` §9 proposes an inner pane; that trade
   is deliberately not taken. The "dead band under the tab bar" is a _surface_
   problem — the bar is the page colour at 95 % alpha — not a scroll problem, and
   §E fixes it there.)
8. **Never `location.reload()`** in pull-to-refresh, an update prompt or a retry.
   In an installed PWA a reload is a cold start (§8).
9. **Persist drafts on `visibilitychange → hidden` and `pagehide`.** iOS kills
   backgrounded PWAs; a half-filled create sheet must survive it.
10. **`-webkit-tap-highlight-color: transparent`, `touch-action: manipulation`**
    on every interactive element; `.no-callout` on anything long-pressable.
11. **`prefers-reduced-motion`** disables the swipe-row collapse, the sheet
    spring and every transition. Already reset globally — keep it.
12. **Contrast ≥ 4.5:1** for body text and ≥ 3:1 for UI boundaries in _both_
    themes. New tokens in §B1 must be re-measured before they ship; the existing
    `--primary` work at `oklch(.5535 …)` must not be undone.
13. **Colour is never the only signal** (§B4).
14. **All user-facing text is Russian, «вы», from `features/<domain>/locale.ts`.**
    Never a server `message` (D7).
15. **No media element ever plays without a tap**, and `playsinline` is on every
    `<video>`. Both verified from WebKit source on 2026‑08‑20 (§D7.14.5): without
    `playsinline` an iPhone takes the whole screen the moment playback starts,
    and Low Power Mode blocks video autoplay **including muted**, so an autoplay
    design behaves differently on two phones in the same room for a reason
    nobody can explain. **Exactly one media element plays app-wide**, and it
    pauses when it leaves the viewport.
16. **Send a `File` or `Blob` object on any upload — never base64, never an
    `ArrayBuffer`.** WebKit takes the `UnboundedNetworking` process assertion
    that lets an upload survive an app switch **only** when the request body
    contains file or blob data (§D7.14.7). The difference is invisible on a
    desktop and decides whether a photo survives a phone call.
17. **Never trust a media file's extension or its `Content-Type`.** Every video
    from an iPhone is QuickTime, not MP4, whatever it is called (§D7.14.3). The
    container comes from magic bytes and the codec from the `stsd` box; an
    unrecognised value is a rejection, never a guess.

---

## G. Sequencing

Not a schedule — a dependency order.

1. `responsive-dialog.tsx`, `form-sheet.tsx`, `value-row.tsx`, `section.tsx`,
   `use-coarse-pointer.ts`, the token additions in `index.css`. Nothing else can
   land first.
2. The two reported bugs: the shopping composer offset (§D6) and the tab-bar
   surface (§E/`BottomTabBar.tsx`). Both are small and both are visible on the
   owner's phone today.
3. The create/edit flows (§D-forms) — task, then event, then goal. This is the
   thing the owner is judging.
4. `AppShell` layout system (§C1/C4) and `TopAppBar` on desktop.
5. Screen-by-screen: Сегодня → Задачи → Покупки → Календарь → Копилки → Стена →
   Семья → Настройки/Уведомления.
6. Gestures (§C-gestures) — after the rows they attach to are final.
7. **Likes** (§D7.7). One always-drawn ❤️ chip on posts and comments, and the
   comment foot row. It depends on nothing above and it is the smallest thing
   the owner asked for, so it can land alongside Стена or before it.
8. **Media** (§D7.14), in this order and not another, because each step is
   useful on its own and each later step can be abandoned without stranding the
   earlier ones:

   a. the **backup fix** in `infra/` (§D7.14.6) — this is first, not last: it is
   the only step whose absence is unrecoverable;
   b. the storage backend — `media_objects`, `media.ts`, the upload and
   **Range-capable** delivery routes, `media:read`, the two reapers;
   c. **photos on posts** — the grid, the viewer, the composer tile strip;
   d. **photos in threads** (§D7.8b);
   e. **video**, once §D7.14.11 item 2 has been run on a real iPhone;
   f. **voice**, last, and only if §D7.14.11 item 1 says it works in an
   installed Home Screen app.

9. Typography: ship `Onest` last. Everything above works without it.
