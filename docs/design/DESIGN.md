# Design specification — «Наша семья»

Status: **binding for frontend work.** Read with `docs/DECISIONS.md` (D5, D7),
`docs/architecture/frontend.md` and `docs/research/ios-pwa-push.md` §8–§9.

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
  *arrangement* of those fields, not their appearance — with one change:
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

| File | Screen | Viewport / theme |
|---|---|---|
| `today-phone-light/dark` | Сегодня | 390 both themes |
| `today-desktop-light/dark` | Сегодня | 1440 both themes |
| `today-320` | Сегодня | 320 light |
| `today-empty-phone` | Сегодня, no data | 390 light |
| `today-loading-phone` | Сегодня, pending | 390 light |
| `tasks-phone-dark` | Задачи | 390 dark |
| `tasks-desktop-light`, `tasks-desktop1024` | Задачи | 1440 / 1024 light |
| `tasks-empty-phone`, `tasks-loading-phone` | Задачи | 390 light |
| `calendar-phone-dark`, `calendar-phone-light` | Календарь | 390 |
| `calendar-desktop-light` | Календарь | 1440 |
| `goals-phone-light`, `goals-desktop-light` | Копилки | 390 / 1440 |
| `shopping-phone-light`, `shopping-desktop-light` | Покупки (списки) | 390 / 1440 |
| `shopping-empty-phone` | Покупки, no lists | 390 |
| `list-phone-light`, `list-phone-dark` | Покупки → список | 390 |
| `list-phone-typed` | список, «хлеб» typed | 390 dark |
| `list-desktop-light` | список | 1440 |
| `list-320` | список | 320 |
| `wall-phone-dark`, `wall-desktop-light` | Стена | 390 / 1440 |
| `family-phone-light`, `family-desktop-light` | Семья (crashes: points) | 390 / 1440 |
| `settings-phone-light`, `settings-desktop-light/dark` | Настройки | 390 / 1440 |
| `settings-notifications-phone/-desktop` | Уведомления | 390 / 1440 |
| `settings-profile-phone`, `settings-accounts-phone` | Профиль / Способы входа | 390 |
| `admin-members-desktop` | Участники | 1440 |
| `task-create-phone-dark`, `task-create-desktop` | «Новое дело» modal | 390 / 1440 |
| `event-create-phone-dark`, `event-create-desktop` | «Новое событие» modal | 390 / 1440 |
| `goal-create-phone-dark` | «Новая копилка» modal | 390 |
| `notif-panel-phone` | Notifications panel | 390 |
| `login-anon-phone/-desktop`, `register-anon-phone` | Вход / Регистрация | 390 / 1440 |

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

A dashboard's job is to display state. A board's job is to hold *the next thing
someone has to do*, at a size you can read while putting your shoes on. Five
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
  bans the *shape* of it — leaderboards, medals, "лучший", ordering people by
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
  --surface-attention:      oklch(0.9705 0.0225 42);   /* clay wash        */
  --surface-attention-fg:   oklch(0.3585 0.0985 34);
  --surface-calm:           oklch(0.9645 0.0265 150);  /* sage wash, "done"*/
  --surface-calm-fg:        oklch(0.3285 0.0525 150);
  /* The rail / hairline that separates rows inside one surface.
     Lighter than --border, which is for the outline of a surface. */
  --hairline:               oklch(0.9285 0.0125 80);
}
.dark {
  --surface-attention:      oklch(0.2685 0.0345 38);
  --surface-attention-fg:   oklch(0.8585 0.0705 40);
  --surface-calm:           oklch(0.2585 0.0285 152);
  --surface-calm-fg:        oklch(0.8785 0.0505 150);
  --hairline:               oklch(1 0 0 / 8%);
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

| Token | Size / LH | Weight | Face | Used for |
|---|---|---|---|---|
| `display` | 28 / 34 | 700 | Onest | The greeting on Сегодня; a goal's saved amount. **Max one per screen.** |
| `h1` | 22 / 28 | 700 | Onest | Page title (`PageHeader`), sheet title |
| `h2` | 17 / 24 | 600 | Onest | Section heading inside a screen; the title of a detail sheet's group |
| `row` | 17 / 24 | 500 | Inter | **The tappable line of a row** — task title, item name, event title, settings label |
| `body` | 15 / 22 | 400 | Inter | Descriptions, notes, empty-state copy |
| `meta` | 13 / 18 | 500 | Inter | Time, quantity, category, counts, "3 задачи" |
| `label` | 12 / 16 | 600, +0.06em, uppercase | Inter | Section labels only (ОВОЩИ, СЕГОДНЯ, УВЕДОМЛЕНИЯ). **Never for content.** |
| `input` | 17 / 24 touch, 15 / 22 pointer:fine | 400 | Inter | Every text control. Never below 16 on coarse. |

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

| Level | Surface | Border | Shadow | What |
|---|---|---|---|---|
| L0 ground | `--background` | — | none | The page |
| L1 surface | `--card` | 1px `--border`, radius 12 | **none** | Every in-page card, list panel, row group |
| L2 floating | `--popover` | 1px `--border`, radius 16 | `0 12px 32px -12px rgb(0 0 0 / .28)` | Dialogs, sheets, popovers, toasts, the notifications panel |

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
came to this screen to perform. On Покупки that is *not* «Новый список» (a
full-width clay button is currently the loudest thing on a screen whose job is
to show you three lists) — it is opening a list. Everything else is
`variant="ghost"` or `variant="secondary"`.

**Status colours, and what they are allowed to tint.**

| Meaning | Token | Applied to |
|---|---|---|
| Просрочено | `--destructive` | The row's 3px left rail + the word «Просрочено». **Not the row background.** Four overdue tasks must not be four pink boxes. |
| Скоро (< 2 ч), не отправлено | `--warning` | The meta line only |
| Сделано / куплено / собрано | `--success` on `--surface-calm` | The tick fill; a done group's ground |
| Требует решения | `--surface-attention` | The one attention block per screen (§C2) |
| Удалить | `--destructive` | Text + icon of the destructive action, never a filled button except inside a confirm dialog |

**Member identity — this is what `--chart-1..5` is for.**

The family has five people and the theme has five chart colours: clay, sage,
honey, plum, sky, both light and dark ramps, already perceptually spaced. Assign
`chart-{(sortOrder % 5) + 1}` to each member and use it *everywhere a person
appears*:

- the **member disc** — 24px circle, member colour at 18 % as ground, member
  colour at full as the initial, used for assignee, attendee, contributor,
  requester, wall author;
- the **day-rail tick** on a task row assigned to someone;
- the event bar in the calendar agenda;
- the fairness bars on Семья.

Stop rendering `users.color` for these. The seeded values (`#2563eb`,
`#db2777`, `#16a34a`, `#f59e0b`, `#7c3aed`) are stock cold Tailwind hues that
fight the warm palette on every screen they appear on — visible in
`today-desktop-light`, where a pink «БН» disc sits on a sand card. Keep the
column (a member may still pick one, and it is used for the ICS feed), but the
UI renders from the ramp. If the family wants to choose, let them choose *one of
the five*.

**Never colour alone.** Overdue also says «Просрочено». Done also has a tick.
A member disc also has an initial. Assume one of the five is colour-blind.

---

## C. Layout system

This is the part to get right.

### C1. Breakpoints and the container

Tailwind defaults, used properly.

| Range | Shell | Content |
|---|---|---|
| **< 768** (`base`) | Top bar + bottom tab bar | One column. Gutter 16. Full width. |
| **768–1023** (`md`) | Sidebar rail 240 + top bar | One column, **max 640, left-aligned**, gutter 32. Not centred in a void. |
| **1024–1279** (`lg`) | Sidebar 240 + top bar | **Two columns**: main `minmax(420px, 720px)` + side `320px`, gap 24, gutter 32 |
| **≥ 1280** (`xl`) | Sidebar 240 + top bar | Two columns: main `minmax(480px, 760px)` + side `360px`, gap 32, gutter 40, container max **1360** |
| **≥ 1536** | as `xl` | Do **not** grow the columns. Grow the gutters. |

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
  *surface* may be full-bleed but its content is capped at 720 and left-aligned,
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

The side column is not filler. Each screen already *has* the content — it is
currently stacked below the fold or crammed above the list on a phone.

| Screen | Main column | Side column (≥ lg) |
|---|---|---|
| Сегодня | Attention block + Мои дела + Сегодня в календаре | Неделя (7 compact day rows) · Копилка · Заявки |
| Задачи | The task list | **Фильтры** (moved out of the phone chip wall) · Нагрузка за неделю |
| Календарь | Agenda or month grid | Mini month grid · «Подписаться на календарь» |
| Копилки | Goal rows | Сводка (накоплено / в работе / достигнуто) |
| Покупки → список | Items | «Часто покупаем» · «Уже куплено» (collapsed) |
| Стена | Feed | «Спасибо» · Опросы |
| Семья | Members | Нагрузка / справедливость |
| Настройки | The selected section | The section nav — Профиль / Уведомления / Способы входа / Оформление |
| Участники | The queue | Roles legend + counts |

Two consequences worth stating:

1. **On desktop the top bar earns its keep.** Today `TopAppBar` is 1200px wide
   and holds a section title on the left and a bell + avatar on the right, with
   ~1000px of nothing between. On ≥ md it should carry the **page title and the
   screen's one primary action**, and `PageHeader` then renders only its
   description and filters. Measured: `topbar` is 1200×57 at x=240 with two
   controls in it.
2. **The side column collapses, it does not disappear.** Below `lg` its contents
   move to the bottom of the main column in the same order, except Фильтры,
   which becomes a single «Фильтры ·  3» row that opens a sheet.

### C5. Density targets

A phone screen should answer its question inside **1.5 viewports** (≈ 1260px).
Measured today:

| Screen | Now | Target |
|---|---|---|
| Сегодня | 1661 | ≤ 1100 |
| Задачи | 2232 | ≤ 1300 (filters into a sheet, rows 56 not 96) |
| Уведомления | 4820 | ≤ 1400 (matrix, §D9) |
| Покупки → список | 1280 | ≤ 1280 (fine; fix the overlap instead) |

---

## D. Screens

Common conventions for every spec below: **loading** = a skeleton with the same
shape and count as the real content, minimum 250 ms on screen so it cannot
flash, and on a *refetch* the old data stays visible with a 2px `--primary`
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
Фильтры expanded as a real panel (this is where 12 chips are fine) + «Нагрузка
за неделю» as neutral bars with no numbers a person could rank by. **Do not**
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

### D7. Стена

**What the user came for:** "what did the family say."

- Pinned post first, on `--surface-attention` with a small 📌 and «закреплено до
  25 августа» in `meta`. Everything else in one feed.
- Post row: author disc + name + relative time · title (`h2`) · body (`body`,
  clamped to 4 lines with «ещё») · reaction bar · «N комментариев».
- The composer is **not** always on screen. It is the app-bar `⊕`, opening the
  same full-screen sheet pattern as every other create flow (§D-forms).
- Reactions: a single row of at most five emoji + a `+`. Tap toggles; the count
  animates by 1 with no layout shift (reserve the digit width with
  `tabular-nums`).
- System posts (goal reached, birthday) get no author disc and a `--surface-calm`
  ground so they are visibly not a person talking.

**Desktop**: feed at 720; side = «Спасибо» totals and open polls.
**Empty**: «На стене пусто» + «Написать».

---

### D8. Настройки and its sub-pages

The main page has already been rebuilt and is good. Two changes only.

1. **Desktop becomes two panes.** Below `lg`: as now. At `lg` and above: side
   column = the section list (Профиль · Уведомления · Способы входа ·
   Оформление · Календарь на телефоне), main = the selected section. Today the
   page is a 670px column floating in 1200px with 440px empty to its right — the
   content to fill it is the navigation that is currently *in* the column.
2. **The `ValueRow` measure rule (§C2) applies here**, which is what
   permanently prevents the original «label at 378, chevron at 1326» defect from
   coming back on any future settings row.

#### D8a. Настройки → Уведомления

Measured **4820px on a phone, 3774px on desktop.** It is already grouped, which
helps, but the shape is wrong: each of 19 types is a card containing a master
switch, and *inside* it a second row with three more switches (Push / Telegram /
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
  destructive red on *both* rows plus a stray unlabelled checkbox. Dead
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

| | Phone dialog | Desktop dialog | Viewport |
|---|---|---|---|
| «Новое дело» | 358 × **1326**, top 63 | 512 × **1030**, top 68 | 844 / 900 |
| «Новое событие» | 358 × **1640**, top 34 | 672 × **1198**, top 36 | 844 / 900 |
| «Новая копилка» | 358 × **1034**, top 42 | — | 844 |

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

| Field | Default | Why |
|---|---|---|
| Событие: начало | next :00 or :30 at least 30 min from now, family TZ | the build currently defaults to «02:00», a timezone artefact |
| Событие: длительность | 1 час | |
| Событие: весь день | off | |
| Дело: срок | today 21:00 if created before 18:00, else tomorrow 21:00 | "by the end of the evening" is what a family means |
| Дело: исполнитель | «Любой» | assigning is a second decision |
| Повторение | не повторяется | |
| Видимость | household | |
| Напоминание | за 1 час (events), в срок (tasks) | |

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

| Field | Now | Becomes |
|---|---|---|
| Повторение (5–6 options) | 2-col chip grid, ragged | `🔁 Повторение · не повторяется ›` → sheet with a **single-column list**: ○ Не повторяется / ○ Ежедневно / ○ По дням недели / ○ Раз в N недель / ○ N-е число месяца / ○ Последний день месяца. Selecting one that needs parameters reveals them **inline under that row**, not on a second screen. |
| Исполнитель (5 people) | 3-col chip grid | `👥 Кто · Любой ›` → sheet with a **horizontal row of member discs** (Любой + 5 people, 64px each, fits 390px) — a person is a face, not a pill |
| Срок (4 presets) | 2-col chip grid | The **one** case that stays inline: a single-row segmented control `[Сегодня][Завтра][На неделе][Дата…]`. It is the daily decision on a task. |
| Категория | free text input | `ValueRow` → sheet with the existing categories as rows + «Новая» |
| Видимость | Select | Moves behind «Подробнее», default household |
| Напоминания | chips | `ValueRow` → sheet |

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
sheet, which opens from a visible `⋯` *and* from long-press. The gesture is a
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
  person who most needs the visible control *and* would most benefit from a
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

- **Engage** when horizontal movement ≥ 12px *and* |Δx| ≥ 2 × |Δy|. Otherwise it
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

| Row | Swipe left | Never on a swipe |
|---|---|---|
| Shopping item | куплено / вернуть | **удалить** |
| Task | сделано / вернуть | удалить, пропустить |
| Notification | прочитано | удалить |

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
- Long-press is for the *secondary menu* only. Nothing is reachable solely by
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

| File | What |
|---|---|
| `responsive-dialog.tsx` | `Dialog` on `(pointer: fine)`, vaul `Drawer` on coarse. Props: `size: 'full' \| 'tall' \| 'auto'`, `title`, `description`, `primaryAction`, `onOpenChange`. The single highest-leverage change in this document. |
| `form-sheet.tsx` | The create/edit container (§F3). Fixed `pt-safe` header with Отмена / title / primary; scrolling body; `pb-safe`. Unsaved-input guard + `sessionStorage` draft on `visibilitychange`. |
| `value-row.tsx` | The 56px row: optional leading icon, label, value (or «—»), trailing chevron/switch/action. **Caps its content at 720px** (§C2). Used by settings, forms, detail screens. |
| `section.tsx` | `label` (12/600 uppercase) + optional right-hand link + hairline-separated children on one L1 surface. Replaces per-widget `Card`. |
| `swipe-row.tsx` | §G4. Props: `action: { label, icon, tone, onCommit }`, `undoLabel`. Handles the 32px dead zone, the axis lock, the two stops, the toast. |
| `segmented-control.tsx` | Promote `features/tasks/components/SegmentedControl.tsx` to shared. Max 3 options, single row, never wraps, 44px. |
| `day-rail.tsx` | §C3. Renders the 56px rail cell (time / day marker / member tick). |
| `member-disc.tsx` | 24/32/64px, ramp colour by `sortOrder % 5`, initial. Wraps `UserAvatar`. |
| `pull-to-refresh.tsx` | §G6. Wraps `AppShell`'s main. |
| `use-coarse-pointer.ts` | `matchMedia('(pointer: coarse)')` hook, live. |

### Change — `src/shared/ui/`

| File | Change |
|---|---|
| `card.tsx` | Remove `shadow-sm`. `gap-6 py-6` → `gap-4 py-4`; `px-6` → `px-4`. |
| `field-shell.tsx` | `PickerSurface` renders a `Drawer` on coarse pointers, `Popover` on fine (§F4). |
| `sheet.tsx` / `drawer.tsx` | Add the 36×4 handle to every bottom drawer; verify `pb-safe` on all four sides. |
| `button.tsx` | Add `size="row"` (44px, full width, left-aligned) for the action sheets. Confirm every size is ≥ 44px on coarse. |
| `input.tsx`, `textarea.tsx`, `select.tsx` | 17px on coarse, 15px on fine. Height 48 coarse / 40 fine. |
| `empty-state.tsx`, `shared/components/EmptyState.tsx` | `action` becomes **required**. Cap the description at two lines. |

### Change — `src/shared/components/`

| File | Change |
|---|---|
| `PageHeader.tsx` | Title uses `--font-display` at `h1`. On `≥ md` the title and the primary action move into `TopAppBar` and `PageHeader` renders only description + filters. `actions` collapse to a single icon button below `sm`. |
| `EditScopeDialog.tsx` | Becomes the **entry** prompt (§F6) and gains a one-line consequence under each option. |
| `ConfirmDialog.tsx` | Via `ResponsiveDialog`. Destructive confirms name what is being removed and how many. |
| `UserAvatar.tsx` | Colour comes from the chart ramp, not `users.color`. Export `AvatarGroup` capped at 4 + «+N». |

### Change — `src/app/layout/`

| File | Change |
|---|---|
| `AppShell.tsx` | The §C1 grid: `main` + optional `aside` slot, per-route. Hosts `PullToRefresh`. Container maxes per breakpoint, not one `max-w-3xl xl:max-w-5xl`. |
| `BottomTabBar.tsx` | **Opaque `--card` surface** — drop `bg-background/95` and `backdrop-blur-md`; they are literally the page colour and are why the bar does not read as a bar. Keep the 1px top border. Active tab gets a 48×32 `--secondary` pill behind the icon plus `--primary` icon and label. Surface extends into `env(safe-area-inset-bottom)`; the icon+label block stays centred in the top 56px. |
| `TopAppBar.tsx` | On `≥ md`, carry the page title and the screen's one primary action. Today it is 1200×57 holding two controls. |
| `DesktopSidebar.tsx` | Fine as is. Add the pending-approval count badge on «Участники». |

### Change — features

| File | Change |
|---|---|
| `features/shopping/pages/ListPage.tsx` | The sticky offset fix (§D6). Composer top-of-list at `≥ md`. |
| `features/shopping/components/QuickAddBar.tsx` | Opaque; ≤ 3 rows; suggestions above the field; hint inline. |
| `features/shopping/components/FrequentStrip.tsx` | Edge fade + a `›` affordance; currently the last chip is clipped mid-word at 390px. |
| `features/shopping/components/ItemRow.tsx` | Wrap in `SwipeRow` (куплено). 56/68px. |
| `features/today/components/WidgetCard.tsx` | **Delete.** Replaced by `Section`. |
| `features/today/pages/TodayPage.tsx` | The band model (§C2/D1). One attention block, one «все ›» per section. |
| `features/today/components/LoadWidget.tsx` | Delete with points. |
| `features/tasks/components/TaskCard.tsx` | 56px row, member disc, member tick. Remove the coloured footer band. Wrap in `SwipeRow`. |
| `features/tasks/components/TaskFilters.tsx` | Segmented `Мои/Все` + one «Фильтры · N» row → sheet on phone; side-column panel on desktop. |
| `features/tasks/components/TaskForm.tsx` | Rebuild per §F3–F5. Remove Баллы. |
| `features/calendar/components/EventFormDialog.tsx` | Rebuild per §F3–F5. |
| `features/calendar/pages/CalendarPage.tsx` | Month into the app-bar title; remove `SubscribePanel` from the page. |
| `features/calendar/components/AgendaList.tsx` | Adopt `DayRail`. |
| `features/goals/components/GoalCard.tsx` | Row, one indicator, no floating «Пополнить». |
| `features/goals/components/ProgressRing.tsx` | Detail screen only. |
| `features/settings/components/PreferenceMatrix.tsx` | Become an actual matrix (§D8a). |
| `features/family/components/WeekLoadBar.tsx` | Remove points; `choreCount` only. |
| `features/wall/components/AnnouncementComposer.tsx` | Into a `FormSheet` behind the app-bar `⊕`. |

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
   report `scrollWidth === 320`. Any new fixed-width element must be checked at
   320. Horizontal *scrollers* (Часто покупаем, member discs) are allowed and
   must have an edge fade so the clipped item reads as scrollable, not broken.
4. **Safe-area insets everywhere an edge is touched.** `pt-safe` on the app bar
   and every full-screen sheet header; `pb-safe` on the tab bar, bottom drawers
   and any bottom-anchored composer. The tab bar's *surface* extends into the
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
   is deliberately not taken. The "dead band under the tab bar" is a *surface*
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
12. **Contrast ≥ 4.5:1** for body text and ≥ 3:1 for UI boundaries in *both*
    themes. New tokens in §B1 must be re-measured before they ship; the existing
    `--primary` work at `oklch(.5535 …)` must not be undone.
13. **Colour is never the only signal** (§B4).
14. **All user-facing text is Russian, «вы», from `features/<domain>/locale.ts`.**
    Never a server `message` (D7).

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
7. Typography: ship `Onest` last. Everything above works without it.
