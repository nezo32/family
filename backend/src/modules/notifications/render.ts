import {
  APP_ROUTES,
  countRu,
  NOTIFICATION_TYPES,
  RU_PLURALS,
  type NotificationType,
} from '@family/shared';

/**
 * Notification copy — `(type, payload) → { title, body, navigate }`, in Russian.
 *
 * ## Why the titles look the way they do
 *
 * On iOS every notification wears the **app icon** — `icon`, `badge` and `image`
 * are all ignored, and `tag`/`renotify` do nothing, so ten task updates are ten
 * identical-looking rows on the lock screen (see `docs/research/ios-pwa-push.md`
 * §3). The **type must therefore be legible from the title text alone**, and the
 * title must survive truncation at roughly 40 characters on a narrow phone.
 *
 * So: the title names the *kind of event* («Задача просрочена»), never the
 * entity, and the body carries the specifics. Nobody has to open the app to
 * learn what class of thing happened.
 *
 * ## Why it renders from the payload, not the database
 *
 * A deferred delivery may fire eight hours after the event. By then the task can
 * be renamed, reassigned or deleted. `notification_intents.payload` is
 * denormalized on purpose and this module reads *only* from it — a renderer that
 * re-queried the source row would produce «Задача выполнена: (удалено)».
 *
 * ## Adding a notification type
 *
 * The switch below is exhaustive over `NotificationType`. Adding a value to the
 * enum without adding a case here is a **compile error** (`assertNever`), which
 * is exactly the review we want.
 */

/** What every channel adapter and the in-app inbox consume. */
export interface RenderedNotification {
  /** Short, type-legible. Keep under ~40 characters. */
  title: string;
  /** One or two lines of specifics. Truncated by the push budget if needed. */
  body: string;
  /**
   * Client route to open on tap, e.g. `/tasks/<id>`. Always app-relative — the
   * push adapter turns it into the absolute URL the Declarative Web Push
   * `navigate` field requires. `null` means "not navigable"; the client falls
   * back to the inbox.
   */
  navigate: string | null;
}

export type NotificationPayload = Record<string, unknown>;

/* -------------------------------------------------------------------------- */
/* Payload readers — a payload is untrusted JSON from an arbitrary producer    */
/* -------------------------------------------------------------------------- */

function text(payload: NotificationPayload, key: string, fallback = ''): string {
  const value = payload[key];
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return fallback;
}

function count(payload: NotificationPayload, key: string): number | null {
  const value = payload[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) {
    return Number(value);
  }
  return null;
}

function id(payload: NotificationPayload, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

/** `/tasks/<id>` when the id is present, otherwise the list route. */
function route(base: string, entityId: string | null): string {
  return entityId ? `${base}/${entityId}` : base;
}

/** Trims to `max` characters on a word boundary and appends an ellipsis. */
export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  const hard = value.slice(0, Math.max(0, max - 1));
  const lastSpace = hard.lastIndexOf(' ');
  const cut = lastSpace > max * 0.6 ? hard.slice(0, lastSpace) : hard;
  return `${cut.trimEnd()}…`;
}

/*
 * Russian plural agreement comes from `@family/shared` — `countRu(n, forms)`.
 *
 * This file used to carry its own `plural(n, one, few, many)`: the fourth of
 * six copies of the same rule, and one of the two using the positional arity
 * that shadowed the tuple form everything else uses. It was exported and had no
 * consumers outside this file, so it is simply gone rather than re-exported —
 * a second name for the shared function is how the drift started.
 */

/** Money arrives as integer minor units (D6) — never a float. */
function money(payload: NotificationPayload, key: string): string | null {
  const minor = count(payload, key);
  if (minor === null) return null;
  const major = Math.round(minor) / 100;
  const formatted = Number.isInteger(major)
    ? major.toLocaleString('ru-RU')
    : major.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${formatted} ₽`;
}

/** `who did it` — producers denormalize the actor's display name into the payload. */
function actor(payload: NotificationPayload, fallback = 'Кто-то из семьи'): string {
  return text(payload, 'actorName', text(payload, 'actorDisplayName', fallback));
}

/**
 * «за час», «за 2 часа», «за день», «за 30 минут» — the lead time of a task
 * reminder, in words.
 *
 * Russian needs three plural forms and picks between them by the *last two*
 * digits, which is why this is a function and not a template literal. Whole
 * days and whole hours get their own wording because «за 1440 минут» is not
 * something a person says.
 */
function ruPlural(n: number, one: string, few: string, many: string): string {
  const mod100 = Math.abs(n) % 100;
  const mod10 = mod100 % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

export function leadPhrase(minutes: number | null): string | null {
  if (minutes === null || !Number.isFinite(minutes) || minutes <= 0) return null;
  if (minutes === 10_080) return 'за неделю';
  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    return days === 1 ? 'за день' : `за ${String(days)} ${ruPlural(days, 'день', 'дня', 'дней')}`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1
      ? 'за час'
      : `за ${String(hours)} ${ruPlural(hours, 'час', 'часа', 'часов')}`;
  }
  return `за ${String(minutes)} ${ruPlural(minutes, 'минуту', 'минуты', 'минут')}`;
}

function joinBody(...parts: Array<string | null | undefined>): string {
  return parts.filter((p): p is string => Boolean(p && p.length > 0)).join(' · ');
}

function assertNever(value: never): never {
  throw new Error(`Unhandled notification type: ${String(value)}`);
}

/* -------------------------------------------------------------------------- */
/* The renderer                                                                */
/* -------------------------------------------------------------------------- */

/** Hard ceiling so a malicious or buggy payload cannot blow the push budget. */
const MAX_TITLE = 60;
const MAX_BODY = 300;

export function renderNotification(
  type: NotificationType,
  payload: NotificationPayload = {},
): RenderedNotification {
  const rendered = renderRaw(type, payload);
  return {
    title: truncate(rendered.title, MAX_TITLE),
    body: truncate(rendered.body, MAX_BODY),
    navigate: rendered.navigate,
  };
}

function renderRaw(type: NotificationType, p: NotificationPayload): RenderedNotification {
  switch (type) {
    /* ------------------------------ tasks & chores ------------------------- */

    case 'task_assigned': {
      const taskId = id(p, 'occurrenceId', 'taskId', 'entityId');
      return {
        title: 'Новая задача',
        body: joinBody(text(p, 'title', 'Вам поручили задачу'), text(p, 'dueLabel')),
        navigate: route(APP_ROUTES.tasks, taskId),
      };
    }

    case 'task_due_soon': {
      const taskId = id(p, 'occurrenceId', 'taskId', 'entityId');
      // The lead time the family chose, said back to them in words: a reminder
      // that does not say how far ahead it is makes the reader open the app to
      // find out, which is the one thing a reminder is supposed to save.
      const lead = leadPhrase(count(p, 'offsetMinutes'));
      const due = text(p, 'dueLabel');
      return {
        title: 'Скоро дело',
        body: joinBody(
          text(p, 'title', 'Дело'),
          lead ?? (due ? `срок ${due}` : 'срок совсем близко'),
        ),
        navigate: route(APP_ROUTES.tasks, taskId),
      };
    }

    /**
     * «Пора» — the occurrence has started. The one task notification nobody
     * chose and nobody can drop from a series (see `task_started` in the shared
     * contract); it says the name of the chore and nothing else, because at the
     * moment a thing is supposed to start there is nothing else to say.
     */
    case 'task_started': {
      const taskId = id(p, 'occurrenceId', 'taskId', 'entityId');
      return {
        title: 'Пора',
        body: joinBody(text(p, 'title', 'Дело'), text(p, 'atLabel')),
        navigate: route(APP_ROUTES.tasks, taskId),
      };
    }

    case 'task_overdue': {
      const taskId = id(p, 'occurrenceId', 'taskId', 'entityId');
      const overdueBy = text(p, 'overdueLabel');
      return {
        title: 'Задача просрочена',
        body: joinBody(text(p, 'title', 'Задача'), overdueBy ? `просрочена ${overdueBy}` : null),
        navigate: route(APP_ROUTES.tasks, taskId),
      };
    }

    case 'task_completed': {
      const taskId = id(p, 'occurrenceId', 'taskId', 'entityId');
      // No «+13 очков» here any more, and nothing takes its place: a push that
      // tells one child what another child scored is the sibling scoreboard in
      // its purest form (D5). «Миша: посуда» is the whole message.
      return {
        title: 'Задача выполнена',
        body: `${actor(p)}: ${text(p, 'title', 'задача закрыта')}`,
        navigate: route(APP_ROUTES.tasks, taskId),
      };
    }

    case 'chore_swap_requested': {
      return {
        title: 'Просьба подменить',
        body: joinBody(
          `${actor(p)} просит подменить на дежурстве`,
          text(p, 'title'),
          text(p, 'dueLabel'),
        ),
        /*
         * The task list, with **no id appended** — because this notification
         * asks for a decision, and «Помогу»/«Не смогу» only exist there.
         *
         * The link used to be `route(APP_ROUTES.tasks, swapId)`. `/tasks/:taskId`
         * is a real route, so it resolved and `isKnownAppPath` waved it through;
         * but `:taskId` is an *occurrence* id and a swap id is not one, so
         * `TaskDetailPage` looked up a row that does not exist and rendered its
         * error state. The path was right and the id was the wrong kind — which
         * is why structural validation could not see it, and why the sweep test
         * now checks the id's provenance as well as the path's shape.
         *
         * `/tasks/<occurrenceId>` would at least load: it is the chore the swap
         * is about. It is still the wrong destination for *this* type. The
         * detail page carries the outgoing side of a swap (`SwapRequestButton`)
         * and nothing else; the incoming queue with the accept/decline buttons
         * is `SwapInbox`, which `TasksPage` renders in the side column — a
         * column that collapses under the list on a phone rather than
         * disappearing. So the list is where the asked-for action actually is.
         */
        navigate: APP_ROUTES.tasks,
      };
    }

    case 'chore_swap_answered': {
      // The occurrence, not the swap: this one reports an outcome rather than
      // asking for a decision, and the thing the reader wants to see is the
      // chore itself — who is carrying it now that the answer landed. The swap
      // row is finished business by the time this is read (and once
      // `respondedAt` is set it drops out of every pending list anyway).
      const occurrenceId = id(p, 'occurrenceId', 'taskId', 'entityId');
      const accepted = p.accepted === true;
      return {
        title: accepted ? 'Обмен принят' : 'Обмен отклонён',
        body: joinBody(
          `${actor(p)} ${accepted ? 'согласился подменить' : 'не может подменить'}`,
          text(p, 'title'),
        ),
        navigate: route(APP_ROUTES.tasks, occurrenceId),
      };
    }

    /* -------------------------------- calendar ----------------------------- */

    case 'event_reminder': {
      const eventId = id(p, 'occurrenceId', 'eventId', 'entityId');
      return {
        title: 'Скоро событие',
        body: joinBody(
          text(p, 'title', 'Событие в календаре'),
          text(p, 'startsLabel'),
          text(p, 'location'),
        ),
        navigate: route(APP_ROUTES.calendar, eventId),
      };
    }

    case 'event_created': {
      const eventId = id(p, 'eventId', 'occurrenceId', 'entityId');
      return {
        title: 'Новое событие',
        body: joinBody(
          `${actor(p)} добавил${p.actorIsFemale === true ? 'а' : ''} событие`,
          text(p, 'title'),
          text(p, 'startsLabel'),
        ),
        navigate: route(APP_ROUTES.calendar, eventId),
      };
    }

    case 'birthday_today': {
      const age = count(p, 'age');
      const name = text(p, 'personName', text(p, 'title', 'Кто-то из семьи'));
      return {
        title: 'День рождения',
        body: joinBody(
          `Сегодня празднует ${name}`,
          age !== null && age > 0 ? countRu(age, RU_PLURALS.year) : null,
        ),
        navigate: '/calendar',
      };
    }

    /* --------------------------------- goals ------------------------------- */

    case 'goal_contribution': {
      const goalId = id(p, 'goalId', 'entityId');
      const amount = money(p, 'amountMinor');
      return {
        title: 'Взнос в копилку',
        body: joinBody(
          `${actor(p)} пополнил${p.actorIsFemale === true ? 'а' : ''} копилку`,
          text(p, 'goalTitle', text(p, 'title')),
          amount,
        ),
        navigate: route(APP_ROUTES.goals, goalId),
      };
    }

    case 'goal_milestone_reached': {
      const goalId = id(p, 'goalId', 'entityId');
      const percent = count(p, 'percent');
      return {
        title: 'Копилка растёт',
        body: joinBody(
          text(p, 'goalTitle', text(p, 'title', 'Общая цель')),
          percent !== null ? `собрано ${Math.round(percent)}%` : null,
          money(p, 'balanceMinor'),
        ),
        navigate: route(APP_ROUTES.goals, goalId),
      };
    }

    case 'goal_reached': {
      const goalId = id(p, 'goalId', 'entityId');
      return {
        title: 'Цель достигнута',
        body: joinBody(
          text(p, 'goalTitle', text(p, 'title', 'Общая цель')),
          'нужная сумма собрана',
          money(p, 'targetMinor'),
        ),
        navigate: route(APP_ROUTES.goals, goalId),
      };
    }

    /* ------------------------------- shopping ------------------------------ */

    case 'shopping_urgent_item': {
      const listId = id(p, 'listId', 'entityId');
      return {
        title: 'Срочная покупка',
        body: joinBody(
          text(p, 'itemName', text(p, 'title', 'Срочный товар')),
          text(p, 'listName'),
          `добавил${p.actorIsFemale === true ? 'а' : ''} ${actor(p)}`,
        ),
        navigate: route(APP_ROUTES.shopping, listId),
      };
    }

    /* ------------------------- membership & admin -------------------------- */

    case 'member_pending_approval': {
      return {
        title: 'Заявка в семью',
        body: joinBody(
          text(p, 'displayName', 'Новый участник'),
          'ждёт подтверждения',
          text(p, 'provider'),
        ),
        /*
         * The queue page, with **no applicant id appended**.
         *
         * `/admin/members` has no `:id` child route — the approval queue is one
         * list, and a member is approved from a card in it, not from a detail
         * page. `route(APP_ROUTES.adminMembers, userId)` produced
         * `/admin/members/<uuid>`, which the router does not match, so the tap
         * that was supposed to open the queue landed on the 404 screen instead.
         *
         * `isKnownAppPath` did not catch it: it accepts any child of a known
         * route because that is exactly how `/tasks/<id>` and `/goals/<id>` are
         * built. The rule only holds for routes that *have* a detail page, and
         * this one does not — so the link is pinned here rather than derived.
         */
        navigate: APP_ROUTES.adminMembers,
      };
    }

    case 'member_approved': {
      return {
        title: 'Доступ открыт',
        body: joinBody(
          'Заявку одобрили — добро пожаловать в семью',
          text(p, 'approvedByName') ? `подтвердил ${text(p, 'approvedByName')}` : null,
        ),
        navigate: '/',
      };
    }

    /* ------------------------------ family wall ---------------------------- */

    case 'announcement_posted': {
      return {
        title: 'Объявление',
        body: joinBody(text(p, 'title', text(p, 'excerpt', 'Новое объявление')), `— ${actor(p)}`),
        /*
         * The wall itself. `/wall/<postId>` was the same 404 as the join
         * request: `WallPage` is a single feed with no `:postId` child route,
         * so the deep link fell through to the catch-all. The newest post is at
         * the top of the feed, which is where this notification is about to
         * send somebody anyway.
         */
        navigate: APP_ROUTES.wall,
      };
    }

    case 'kudos_received': {
      return {
        title: 'Спасибо от семьи',
        body: joinBody(
          `${actor(p)} сказал${p.actorIsFemale === true ? 'а' : ''} спасибо`,
          text(p, 'reason', text(p, 'message')),
        ),
        // Same as `announcement_posted`: the wall has no per-post route.
        navigate: APP_ROUTES.wall,
      };
    }

    /* --------------------------- periodic & system ------------------------- */

    case 'weekly_digest': {
      const tasks = count(p, 'taskCount');
      const events = count(p, 'eventCount');
      return {
        title: 'Итоги недели',
        body:
          joinBody(
            tasks !== null ? countRu(tasks, RU_PLURALS.task) : null,
            events !== null ? countRu(events, RU_PLURALS.event) : null,
            text(p, 'summary'),
          ) || 'Сводка за неделю готова',
        // There is no /digest screen. The weekly summary is a view of the week
        // ahead, which is what Сегодня already shows.
        navigate: APP_ROUTES.today,
      };
    }

    case 'system_alert': {
      return {
        title: text(p, 'title', 'Внимание'),
        body: text(p, 'message', text(p, 'body', 'Важное сообщение о работе приложения')),
        navigate: text(p, 'link') || '/settings',
      };
    }

    default:
      return assertNever(type);
  }
}

/**
 * Belt-and-braces coverage check used by the test suite: every enum member must
 * render a non-empty title and body from an empty payload, because a producer
 * that forgets a field must still produce something a human can read.
 */
export function renderAllTypesForTest(): Record<NotificationType, RenderedNotification> {
  const out = {} as Record<NotificationType, RenderedNotification>;
  for (const type of NOTIFICATION_TYPES) out[type] = renderNotification(type, {});
  return out;
}
