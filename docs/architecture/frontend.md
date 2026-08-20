# Frontend architecture

The application shell and design system for `@family/frontend`. Read together
with `docs/DECISIONS.md` (binding — especially **D3** sessions, **D4** RBAC,
**D6** money, **D7** frontend) and `docs/CONVENTIONS.md`.

Everything described here already exists in the repo. Feature agents build **on
top** of it and should not need to change any of it.

---

## 1. Stack

| Concern      | Choice                                                                             | Notes                                                                                           |
| ------------ | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Build        | Vite 6                                                                             | `vite.config.ts`, `@` → `src`, `/api` proxied to `localhost:3000` in dev                        |
| UI           | React 19 + TypeScript (strict, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`) |                                                                                                 |
| Styling      | Tailwind v4, **CSS-first**                                                         | all theming in `src/index.css` — there is **no `tailwind.config.js`** and there must not be one |
| Components   | shadcn/ui "new-york"                                                               | vendored into `src/shared/ui/`                                                                  |
| Server state | TanStack Query v5                                                                  | the only place server data lives                                                                |
| Client state | Zustand                                                                            | thin, for genuinely local UI state                                                              |
| Routing      | React Router v7 (**data router**)                                                  | `createBrowserRouter`                                                                           |
| Forms        | react-hook-form + `zodResolver`                                                    | schemas come from `@family/shared`                                                              |
| PWA          | `vite-plugin-pwa`, `strategies: 'injectManifest'`                                  | custom SW at `src/sw.ts`                                                                        |
| Tests        | Vitest + Testing Library                                                           | `src/test/setup.ts`                                                                             |

**Primary target is an installed iOS Home-Screen PWA.** Desktop is first-class,
but when the two conflict, the phone wins.

---

## 2. Folder layout

```
frontend/
  index.html                 lang="ru", viewport-fit=cover, PWA meta, FOUC guard
  vite.config.ts             plugins, proxy, PWA manifest
  public/
    favicon.ico, favicon.svg
    icons/                   manifest + apple-touch icons (see icons/README.md)
    screenshots/             manifest screenshots (placeholders — replace)
  src/
    main.tsx                 createRoot + SW registration
    App.tsx                  <Providers />
    index.css                the entire design system
    sw.ts                    service worker (precache + nav fallback; push TODO)
    vite-env.d.ts            typed import.meta.env

    app/                     ← the shell. Owned by the frontend architect.
      providers.tsx          QueryClient + Theme + Router + Toaster + ErrorBoundary
      router.tsx             THE ROUTE CONTRACT (§3)
      RootLayout.tsx         installs the navigate bridge for the API layer
      theme-provider.tsx     light / dark / system, no flash
      ErrorBoundary.tsx      AppErrorBoundary, RouteErrorBoundary, NotFound
      layout/
        AppShell.tsx         authenticated chrome + AuthShell for /login, /auth/*
        TopAppBar.tsx        title, notification bell, avatar menu
        BottomTabBar.tsx     phone navigation (safe-area aware)
        DesktopSidebar.tsx   ≥ md navigation
        nav-items.ts         the navigation model, permission-gated
      pages/Placeholder.tsx  scaffolding for un-built routes
      pwa/register-sw.ts     Russian update prompt

    shared/                  ← cross-cutting. Owned by the frontend architect.
      api/                   client, token store, refresh, query client, errors
      auth/                  useMe, useCan, <Can>, route guards
      components/            PageHeader, EmptyState, ErrorState, LoadingScreen,
                             ConfirmDialog, UserAvatar
      lib/                   utils(cn), i18n, format, routes, toast
      ui/                    shadcn components — vendored, do not lint-fix

    features/<domain>/       ← YOURS.
      api.ts                 typed fetchers + a `keys` object
      hooks.ts               useQuery / useMutation wrappers
      components/
      pages/                 PascalCase.tsx, default export
      locale.ts              this feature's Russian strings
```

Naming: files `kebab-case.ts`, React components `PascalCase.tsx`.
The `shared/ui/` directory keeps shadcn's kebab-case because it is vendored.

---

## 3. The route contract

This table is the agreement between the shell and every feature module. It is
mirrored in the header comment of `src/app/router.tsx` and in the `ROUTES`
constant in `src/shared/lib/routes.ts`. **Never hardcode a path string** — import
`ROUTES`.

| Path                      | Nav label (RU) | Page module                                                          | Guard                            |
| ------------------------- | -------------- | -------------------------------------------------------------------- | -------------------------------- |
| `/`                       | Сегодня        | `features/today/pages/TodayPage.tsx`                                 | auth                             |
| `/tasks`                  | Задачи         | `features/tasks/pages/TasksPage.tsx`                                 | auth + `task:read`               |
| `/calendar`               | Календарь      | `features/calendar/pages/CalendarPage.tsx`                           | auth + `event:read`              |
| `/goals`                  | Копилки        | `features/goals/pages/GoalsPage.tsx`                                 | auth + `goal:read`               |
| `/shopping`               | Покупки        | `features/shopping/pages/ShoppingPage.tsx`                           | auth + `shopping:read`           |
| `/wall`                   | Стена          | `features/wall/pages/WallPage.tsx`                                   | auth                             |
| `/family`                 | Семья          | `features/family/pages/FamilyPage.tsx`                               | auth + `member:read`             |
| `/settings`               | Настройки      | `features/settings/pages/SettingsPage.tsx`                           | auth                             |
| `/settings/profile`       | Профиль        | `features/settings/pages/ProfilePage.tsx`                            | auth                             |
| `/settings/notifications` | Уведомления    | `features/settings/pages/NotificationsPage.tsx`                      | auth + `notification:manage:own` |
| `/settings/accounts`      | Способы входа  | `features/settings/pages/AccountsPage.tsx`                           | auth + `identity:manage:own`     |
| `/admin/members`          | Участники      | `features/admin/pages/MembersPage.tsx`                               | auth + `member:approve`          |
| `/login`                  | —              | `features/auth/pages/LoginPage.tsx`                                  | public, redirects if signed in   |
| `/auth/pending`           | —              | `features/auth/pages/AccountStatusPages.tsx` → `PendingApprovalPage` | **public**                       |
| `/auth/rejected`          | —              | `features/auth/pages/AccountStatusPages.tsx` → `RejectedPage`        | **public**                       |
| `/auth/suspended`         | —              | `features/auth/pages/AccountStatusPages.tsx` → `SuspendedPage`       | **public**                       |
| anything else             | —              | `app/ErrorBoundary.tsx` → `NotFound`                                 | —                                |

`/auth/*` **must** render with no session at all: a `pending_approval` user is
never issued one (D3).

### Rules

1. **Detail views are paths under your section**, never new top-level segments:
   `/tasks/:taskId`, `/goals/:goalId`. Add them as `children` of your route (ask
   the shell owner) or handle them with a nested `<Routes>` inside your page.
2. Every page module **default-exports** a component taking no props. The
   account-status screens are the one exception (three named exports from one
   module, wired with the `namedPage` helper).
3. Pages are lazy — the `import()` lives in `router.tsx`, so nothing in your
   feature reaches the initial bundle.
4. Your page renders **inside `AppShell`**: no app bar, no navigation, no outer
   page padding of your own. Start with `<PageHeader>`.
5. Adding a navigation entry means editing `app/layout/nav-items.ts`, which
   feeds both the tab bar and the sidebar.

---

## 4. Adding a feature — step by step

Say you own **shopping**.

**1. Contracts.** Import request/response schemas from `@family/shared`
(`import type { ... } from '@family/shared'`). Do not redeclare them.

**2. `features/shopping/locale.ts`** — every user-facing string, typed:

```ts
export const SHOPPING_RU = {
  title: 'Покупки',
  addItem: 'Добавить товар',
  emptyTitle: 'Список пуст',
  emptyDescription: 'Добавьте первый товар — его увидят все.',
} as const;
```

Cross-cutting words (`Сохранить`, `Отмена`, weekday names) come from
`@/shared/lib/i18n`, not from here.

**3. `features/shopping/api.ts`** — typed fetchers + query keys:

```ts
import { api } from '@/shared/api/client';
import type { ShoppingItem } from '@family/shared';

export const shoppingKeys = {
  all: ['shopping'] as const,
  lists: () => [...shoppingKeys.all, 'list'] as const,
  list: (filters: ListFilters) => [...shoppingKeys.lists(), filters] as const,
  detail: (id: string) => [...shoppingKeys.all, 'detail', id] as const,
};

export const fetchItems = (listId: string) =>
  api.get<ShoppingItem[]>(`/shopping/lists/${listId}/items`);

export const createItem = (listId: string, body: CreateItemInput) =>
  api.post<ShoppingItem>(`/shopping/lists/${listId}/items`, body);
```

`api` handles the base URL, JSON, the bearer token, the 401 refresh + retry and
error typing. **Never call `fetch` directly.**

**4. `features/shopping/hooks.ts`** — thin Query wrappers:

```ts
export function useItems(listId: string) {
  return useQuery({
    queryKey: shoppingKeys.list({ listId }),
    queryFn: () => fetchItems(listId),
  });
}

export function useCreateItem(listId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateItemInput) => createItem(listId, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: shoppingKeys.lists() }),
    onError: (error) => notify.error(error), // Russian, from the ErrorCode
  });
}
```

**5. `features/shopping/pages/ShoppingPage.tsx`** — replace the placeholder body,
keep the path and the default export:

```tsx
export default function ShoppingPage() {
  const { data, isPending, isError, error, refetch } = useItems(listId);
  const { can } = useCan();

  if (isPending) return <ListSkeleton />;
  if (isError) return <ErrorState error={error} onRetry={() => void refetch()} />;

  return (
    <>
      <PageHeader
        title={SHOPPING_RU.title}
        actions={
          <Can perm="shopping:write">
            <Button onClick={openCreate}>{SHOPPING_RU.addItem}</Button>
          </Can>
        }
      />
      {data.length === 0 ? (
        <EmptyState title={SHOPPING_RU.emptyTitle} description={SHOPPING_RU.emptyDescription} />
      ) : (
        <ItemList items={data} />
      )}
    </>
  );
}
```

**6. Navigation** (only if you own a new section) — add an entry to
`app/layout/nav-items.ts` with its `perm` and, if it belongs on a phone,
`primary: true` (max five primary slots).

**7. Tests** — `*.test.ts(x)` next to the code. Test business rules and edge
cases, not framework behaviour.

**8. Verify** — `npx tsc -b --noEmit`, `npx vite build`, `npx vitest run`,
`npx eslint .`, `npx prettier --check "src/**/*"`.

### Hard rules for feature work

- **All user-facing text is Russian**, from your `locale.ts`.
- **Never render a server `message`.** Map the `ErrorCode` — `errorMessageRu(error)`
  or `notify.error(error)`.
- **Never branch on `role ===`.** Use `useCan()` / `<Can>`.
- **Money is integer minor units.** Render with `formatMoney()`; parse with
  `parseMoney()`. Never a float, never `value * 100`.
- **Dates render in the family timezone** — `formatTime`, `formatDateTime`,
  `toLocalDateKey` from `@/shared/lib/format`. Floating wall-clock strings
  (`2026-09-07T09:00:00`) go through `formatFloatingLocal`.
- Do not add a `tailwind.config.js`, do not edit `package.json`, do not run
  `pnpm install`.

---

## 5. Auth, sessions and the refresh flow

### Where the tokens live

| Token                  | Lifetime | Storage                                                  | Read by JS? |
| ---------------------- | -------- | -------------------------------------------------------- | ----------- |
| Access (HS256 JWT)     | 10 min   | **module-scope variable** in `shared/api/token-store.ts` | yes         |
| Refresh (opaque, 32 B) | 30 d     | `__Host-rt; HttpOnly; Secure; SameSite=Lax; Path=/`      | **no**      |

D3, and the reason is worth repeating: `localStorage` is readable by any XSS
payload _and_ is subject to iOS's 7-day script-writable storage cap, which would
log an installed PWA out after a week away. A server-set `HttpOnly` cookie is
exempt from that cap. Consequence: **a page reload starts with no access token**,
the first request 401s, and the refresh below fixes it transparently.

### Flow

```
  component
      │  useQuery / useMutation
      ▼
  shared/api/client.ts ──► fetch(url, { Authorization: Bearer <memory>,
      │                                 credentials: 'same-origin' })
      │
      ├─ 2xx ─────────────────────────────────────────────► parsed JSON
      │
      ├─ 401 ──► refresh.ts :: refreshAccessToken()
      │              │
      │              ├─ a refresh is already in flight? await THAT promise
      │              │  (single-flight — React 19 StrictMode, several PWA tabs
      │              │   and iOS resume all fire at once; N refreshes means N
      │              │   rotations and N chances to trip the backend's
      │              │   token-family reuse detector)
      │              │
      │              ├─ POST /api/auth/refresh   (cookie rides along)
      │              │      ├─ 200 ──► setAccessToken(new)  ──► RETRY once ──► 2xx
      │              │      ├─ 403 ACCOUNT_* ──► endSession → /auth/{pending|rejected|suspended}
      │              │      ├─ 4xx other ─────► endSession → /login?next=<path>
      │              │      └─ network error ─► return null, session NOT ended
      │              │                          (offline; cookie is probably fine)
      │
      ├─ 403 ACCOUNT_PENDING_APPROVAL ─► /auth/pending
      ├─ 403 ACCOUNT_REJECTED ────────► /auth/rejected
      ├─ 403 ACCOUNT_SUSPENDED ───────► /auth/suspended
      ├─ 403 FORBIDDEN ───────────────► throw ApiError
      │                                 …and the QueryCache onError in
      │                                 providers.tsx invalidates ['me'], so a
      │                                 stale permission set self-heals (D7)
      │
      └─ any other ──► throw ApiError { code: ErrorCode, status, details, requestId }
                       └─► rendered as Russian by errorMessageRu(code)
```

Retries are capped: `_retried` on the request options means a 401 can trigger at
most one refresh + one retry per request. `endSession()` is idempotent, so a
burst of failing requests produces exactly one redirect.

Redirects go through `shared/api/navigation.ts`, whose `navigate` is installed by
`app/RootLayout.tsx`; before the router mounts it falls back to
`window.location.replace`, which is always correct, just slower.

### Permissions

`GET /api/me` returns the **effective** permission list — the role matrix with
per-user `permission_grants` / `permission_denies` already folded in (D4). The
client never re-derives it.

```tsx
const { can, scopeFor, canAny, isReady } = useCan();

can('task:create'); // unscoped permission, exact match
can('task:update', task); // `task:update:any` → true
// `task:update:own` → true iff task is yours
can('task:update'); // `…:own` with no row → true (affordance)
scopeFor('task:read'); // 'any' | 'own' | null → narrow your query
```

Ownership is tested against `ownerId | createdById | authorId | userId | assigneeId`
on the resource. Declarative form:

```tsx
<Can perm="post:delete" resource={post}><DeleteButton /></Can>
<CanAny perms={['goal:create', 'goal:update']}>…</CanAny>
```

Route guards: `<RequireAuth>` (session + non-`active` status redirect) and
`<RequirePermission perm=… | anyOf=… | allOf=…>` (renders "Нет доступа" rather
than bouncing, so a shared link does not look broken).

This is an **affordance layer only**. The backend enforces the same rules, and
returns 404 rather than 403 for rows outside your read scope (D4).

---

## 6. Design tokens

All of it lives in `src/index.css`. Tailwind v4 CSS-first: `@theme inline` maps
the shadcn token names onto CSS custom properties defined on `:root` and `.dark`.
There is **no `tailwind.config.js`**.

### Palette — "Тёплый дом"

Not stock shadcn slate, deliberately. Slate is a cool, corporate dashboard grey;
this app is a shared living space opened dozens of times a day from a phone home
screen, often late in the evening. So:

- a **warm neutral axis** (hue ≈ 70–85 — paper/sand, not blue),
- a **terracotta / baked-clay primary** (hue ≈ 42) that reads friendly and
  handmade rather than "SaaS blue",
- a **muted sage accent** (hue ≈ 150) for positive affordances,
- a **warm brick destructive** so warnings sit in the same family,
- dark mode on a **warm charcoal** (hue ≈ 55), not blue-black: on an OLED phone
  in a dim room, blue-black is the thing that keeps you awake.

Colours are OKLCH so the lightness steps are perceptually even.

| Token                            | Light                                           | Dark                                              | Use                     |
| -------------------------------- | ----------------------------------------------- | ------------------------------------------------- | ----------------------- |
| `--background` / `--foreground`  | `oklch(.99 .0065 84)` / `oklch(.2585 .0195 55)` | `oklch(.1985 .0115 56)` / `oklch(.9485 .0105 84)` | page                    |
| `--card`, `--popover`            | white                                           | `oklch(.2415 .0135 56)`                           | raised surfaces         |
| `--primary`                      | `oklch(.6135 .1495 42)`                         | `oklch(.7085 .1385 46)`                           | clay — CTAs, active nav |
| `--secondary`                    | `oklch(.945 .0185 82)`                          | `oklch(.2885 .0165 60)`                           | warm sand               |
| `--muted` / `--muted-foreground` |                                                 |                                                   | secondary text, chips   |
| `--accent`                       | `oklch(.9265 .0405 150)`                        | `oklch(.3285 .0385 155)`                          | sage — hover, "done"    |
| `--destructive`                  | `oklch(.5785 .1985 27.5)`                       | `oklch(.6485 .1885 26)`                           | delete                  |
| `--success` / `--warning`        |                                                 |                                                   | status badges           |
| `--border`, `--input`, `--ring`  |                                                 |                                                   |                         |
| `--chart-1…5`                    | clay, sage, honey, plum, sky                    |                                                   | recharts                |
| `--sidebar*`                     |                                                 |                                                   | desktop rail            |

`--radius: 0.75rem` (friendly, not sharp) with `--radius-sm/md/lg/xl/2xl` derived.

Also exported as Tailwind spacing tokens: `--spacing-safe-t/r/b/l`
(`env(safe-area-inset-*)`), `--spacing-tabbar` (3.5rem), `--spacing-appbar`
(3.5rem) — so `h-tabbar`, `h-appbar` work as utilities.

### PWA hardening in `@layer base`

| Rule                                                                                  | Why                                                                 |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `-webkit-text-size-adjust: 100%`                                                      | iOS inflates text in landscape otherwise                            |
| `-webkit-tap-highlight-color: transparent`                                            | kills the grey flash on every tap                                   |
| `overscroll-behavior-y: none` on `html`/`body`                                        | no rubber-band revealing browser chrome                             |
| `min-height: 100dvh` (never `100vh`)                                                  | `vh` includes the collapsed iOS URL bar → layout jump               |
| `@media (pointer: coarse) { input, select, textarea { font-size: 16px !important } }` | **iOS zooms the viewport on focus below 16px and never zooms back** |
| `prefers-reduced-motion` reset                                                        | accessibility                                                       |

Utilities: `.pt-safe .pb-safe .pl-safe .pr-safe .px-safe .mb-safe`,
`.h-dvh .min-h-dvh`, `.h-app-content`, `.no-callout`, plus `[data-scroll-pane]`
for momentum scrolling inside a pane.

---

## 7. The shell

```
≥ md                              < md
┌────────┬──────────────────┐     ┌──────────────────┐
│sidebar │ TopAppBar        │     │ TopAppBar (pt-safe)
│(rail)  ├──────────────────┤     ├──────────────────┤
│        │ <Outlet/>        │     │ <Outlet/>        │
│        │                  │     │                  │
└────────┴──────────────────┘     ├──────────────────┤
                                  │ BottomTabBar     │
                                  │ (pb-safe)        │
                                  └──────────────────┘
```

- **The page is the scroll container**, not an inner div: iOS only collapses the
  URL bar and only honours "tap the status bar to scroll to top" for the document
  scroller. The shell reserves room for the fixed tab bar with padding.
- **Scroll restoration** is done in `AppShell` by keying saved offsets on
  `location.key`: a new navigation lands at the top, back/forward restores.
- **Tab bar**: at most five slots, ≥ 44 px targets, overflow in a bottom drawer
  ("Ещё"). Filtered by `useCan()`.
- **Top bar**: current section title, notification bell (`unreadCount` prop —
  wire it up from the notifications feature), avatar menu with profile, settings,
  theme switch and sign-out.
- `AuthShell` is the chrome-less variant for `/login` and `/auth/*`.

Theme: `app/theme-provider.tsx` (light / dark / system, live `matchMedia`,
cross-tab sync). The flash-of-wrong-theme guard is the inline script in
`index.html` — it reads the same `family.theme` localStorage key and sets the
same `.dark` class before first paint. **If you change one, change the other.**
(The theme preference is a device display setting, not a credential; D3's
localStorage ban is about tokens.)

---

## 8. Service worker & PWA

`vite.config.ts` uses `strategies: 'injectManifest'` with `srcDir: 'src'`,
`filename: 'sw.ts'`, `registerType: 'prompt'`, `injectRegister: null`.

`src/sw.ts` is deliberately dependency-free (only `workbox-window` is a declared
dependency of this package) and implements:

- precache from `self.__WB_MANIFEST`, cache name derived from the build,
- old-cache cleanup on `activate` + navigation preload,
- navigations: network-first with the precached `index.html` as the offline
  fallback (React Router owns routing from there),
- hashed assets: cache-first,
- `/api/*` and `/auth/*`: **never cached**,
- `SKIP_WAITING` message handling for the update prompt.

**Push is not implemented** — there is a clearly marked `// TODO(push)` block at
the bottom listing the four handlers a later agent must add (`push`,
`notificationclick`, `notificationclose`, `pushsubscriptionchange`). That agent
owns it; do not write push logic elsewhere.

Registration is `src/app/pwa/register-sw.ts`: a Russian "Доступна новая версия /
Обновить" toast (never a silent swap — an installed PWA that reloads under a
half-filled form loses the user's work) plus an hourly update check, because iOS
keeps a PWA alive for days.

Manifest: Russian `name`/`short_name`/`description`, `id: '/'`, `scope: '/'`,
`display: standalone` + `display_override`, `orientation: portrait`, `lang: ru`,
any + maskable icons at 192/512, three shortcuts (Сегодня / Задачи / Покупки)
and three screenshots. Assets are in `public/icons` and `public/screenshots` —
see `public/icons/README.md` for what still needs a designer.

---

## 9. Environment variables

Typed in `src/vite-env.d.ts`:

| Variable                     | Meaning                                                                                                                                                                      |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VITE_API_URL`               | API origin. **Empty in dev and prod** (same origin, which is what makes the `__Host-rt` cookie work). Set only for a split-origin deployment, which also needs backend CORS. |
| `VITE_VAPID_PUBLIC_KEY`      | VAPID application server key for Web Push subscribe.                                                                                                                         |
| `VITE_TELEGRAM_BOT_USERNAME` | Bot username without `@`, for the Telegram login widget.                                                                                                                     |

---

## 10. Verification

```bash
cd frontend
npx tsc -b --noEmit          # types
npx vite build               # bundle + service worker + manifest
npx vitest run               # unit tests
npx eslint .                 # lint
npx prettier --check "src/**/*.{ts,tsx,css,json,md}"
```

All five pass on the current tree.
