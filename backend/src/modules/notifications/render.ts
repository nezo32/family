import { NOTIFICATION_TYPES, type NotificationType } from '@family/shared';

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

/**
 * Russian plural agreement comes from `@family/shared`.
 *
 * This file used to carry its own `plural(n, one, few, many)` — the fourth of
 * six copies of the same rule, and one of two using the positional arity that
 * shadowed the tuple form everything else uses. Re-exported under the local
 * name so the call sites below read the same as before.
 */
export { pluralRu as plural } from '@family/shared';

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
        navigate: route('/tasks', taskId),
      };
    }

    case 'task_due_soon': {
      const taskId = id(p, 'occurrenceId', 'taskId', 'entityId');
      const due = text(p, 'dueLabel');
      return {
        title: 'Скоро срок задачи',
        body: joinBody(text(p, 'title', 'Задача'), due ? `срок ${due}` : 'срок совсем близко'),
        navigate: route('/tasks', taskId),
      };
    }

    case 'task_overdue': {
      const taskId = id(p, 'occurrenceId', 'taskId', 'entityId');
      const overdueBy = text(p, 'overdueLabel');
      return {
        title: 'Задача просрочена',
        body: joinBody(text(p, 'title', 'Задача'), overdueBy ? `просрочена ${overdueBy}` : null),
        navigate: route('/tasks', taskId),
      };
    }

    case 'task_completed': {
      const taskId = id(p, 'occurrenceId', 'taskId', 'entityId');
      const points = count(p, 'points');
      return {
        title: 'Задача выполнена',
        body: joinBody(
          `${actor(p)}: ${text(p, 'title', 'задача закрыта')}`,
          points !== null && points > 0
            ? `+${points} ${pluralRu(points, RU_PLURALS.point)}`
            : null,
        ),
        navigate: route('/tasks', taskId),
      };
    }

    case 'chore_swap_requested': {
      const swapId = id(p, 'swapId', 'entityId');
      return {
        title: 'Просьба подменить',
        body: joinBody(
          `${actor(p)} просит подменить на дежурстве`,
          text(p, 'title'),
          text(p, 'dueLabel'),
        ),
        navigate: route('/chores/swaps', swapId),
      };
    }

    case 'chore_swap_answered': {
      const swapId = id(p, 'swapId', 'entityId');
      const accepted = p.accepted === true;
      return {
        title: accepted ? 'Обмен принят' : 'Обмен отклонён',
        body: joinBody(
          `${actor(p)} ${accepted ? 'согласился подменить' : 'не может подменить'}`,
          text(p, 'title'),
        ),
        navigate: route('/chores/swaps', swapId),
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
        navigate: route('/calendar', eventId),
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
        navigate: route('/calendar', eventId),
      };
    }

    case 'birthday_today': {
      const age = count(p, 'age');
      const name = text(p, 'personName', text(p, 'title', 'Кто-то из семьи'));
      return {
        title: 'День рождения',
        body: joinBody(
          `Сегодня празднует ${name}`,
          age !== null && age > 0 ? `${age} ${pluralRu(age, RU_PLURALS.year)}` : null,
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
        navigate: route('/goals', goalId),
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
        navigate: route('/goals', goalId),
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
        navigate: route('/goals', goalId),
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
        navigate: route('/shopping', listId),
      };
    }

    /* ------------------------- membership & admin -------------------------- */

    case 'member_pending_approval': {
      const userId = id(p, 'userId', 'entityId');
      return {
        title: 'Заявка в семью',
        body: joinBody(
          text(p, 'displayName', 'Новый участник'),
          'ждёт подтверждения',
          text(p, 'provider'),
        ),
        navigate: route('/settings/members', userId),
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
      const postId = id(p, 'postId', 'entityId');
      return {
        title: 'Объявление',
        body: joinBody(text(p, 'title', text(p, 'excerpt', 'Новое объявление')), `— ${actor(p)}`),
        navigate: route('/wall', postId),
      };
    }

    case 'kudos_received': {
      const postId = id(p, 'postId', 'kudosId', 'entityId');
      return {
        title: 'Спасибо от семьи',
        body: joinBody(
          `${actor(p)} сказал${p.actorIsFemale === true ? 'а' : ''} спасибо`,
          text(p, 'reason', text(p, 'message')),
        ),
        navigate: route('/wall', postId),
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
            tasks !== null ? `${tasks} ${plural(tasks, 'задача', 'задачи', 'задач')}` : null,
            events !== null ? `${events} ${plural(events, 'событие', 'события', 'событий')}` : null,
            text(p, 'summary'),
          ) || 'Сводка за неделю готова',
        navigate: '/digest',
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
