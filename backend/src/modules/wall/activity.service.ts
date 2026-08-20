import { and, eq } from 'drizzle-orm';

import type { Executor } from '../../core/db.js';
import { badRequest } from '../../core/errors.js';
import { activityLog, type ActivityLogRow } from './wall.schema.js';

/**
 * The family activity feed — append-only, like the ledgers (D5/D6).
 *
 * `summary` is a **pre-rendered Russian sentence** frozen at write time
 * ("Паша выполнил задачу „Вынести мусор“"). Two reasons (household.md §6):
 * the feed must stay readable after the referenced task is renamed or deleted,
 * and re-deriving copy on read would couple the feed to every other module's
 * wording.
 *
 * Other modules must **not** hand-write those strings. They pass structured
 * data to `recordActivityEvent`, which renders it through the catalogue below,
 * so the feed never ends up with three spellings of the same event.
 */

/* -------------------------------------------------------------------------- */
/* Verb catalogue                                                              */
/* -------------------------------------------------------------------------- */

/** The commentable kinds, spelled as the comment renderer needs them. */
export type CommentTargetKind = 'post' | 'task' | 'event' | 'goal' | 'poll';

/**
 * Every verb the feed knows, with the payload its renderer needs.
 *
 * Verbs are dotted domain events. Adding one is a two-line change here plus a
 * renderer below — and the compiler then forces every call site to supply the
 * right payload.
 */
export interface ActivityVerbPayloads {
  'task.completed': { title: string };
  'task.created': { title: string };
  'task.assigned': { title: string; assigneeName: string };
  'task.swapped': { title: string; toName: string };

  'event.created': { title: string };
  'event.cancelled': { title: string };

  'goal.created': { title: string };
  'goal.contributed': { title: string; amountMinor: number; currency?: string };
  'goal.milestone.reached': { title: string; milestone: string };
  'goal.reached': { title: string };

  'shopping.bought': { item: string; listTitle: string };
  'shopping.list.created': { title: string };

  'post.created': { title: string };
  'post.pinned': { title: string };
  'comment.added': { entityType: CommentTargetKind; entityTitle: string };

  'poll.created': { question: string };
  'poll.closed': { question: string };

  'kudos.given': { toName: string; emoji: string };

  'member.approved': { memberName: string };
  'member.joined': Record<string, never>;
}

export type ActivityVerb = keyof ActivityVerbPayloads;

/* -------------------------------------------------------------------------- */
/* Russian rendering                                                           */
/* -------------------------------------------------------------------------- */

export type ActivityGender = 'm' | 'f' | 'unknown';

/** Who did it, as far as the renderer is concerned. `name: null` => the system. */
export interface ActivityActor {
  name: string | null;
  /** Omit to let `inferGender` guess from the name. */
  gender?: ActivityGender;
}

const QUOTE_OPEN = '„';
const QUOTE_CLOSE = '“';

/** Russian inner quotes: „Вынести мусор“. */
const q = (value: string): string => `${QUOTE_OPEN}${value.trim()}${QUOTE_CLOSE}`;

/**
 * Masculine diminutives that end in -а/-я and would otherwise be read as
 * feminine, plus the family-role words the app is likely to see as a display
 * name. Паша, Миша and Никита are exactly why a bare suffix rule is not enough.
 */
const MASCULINE_NAMES = new Set([
  'паша',
  'миша',
  'гоша',
  'лёша',
  'леша',
  'гриша',
  'ваня',
  'коля',
  'петя',
  'вася',
  'витя',
  'толя',
  'костя',
  'боря',
  'сеня',
  'стёпа',
  'степа',
  'юра',
  'вова',
  'дима',
  'тёма',
  'тема',
  'сева',
  'серёжа',
  'сережа',
  'антоша',
  'никита',
  'илья',
  'кузьма',
  'фома',
  'данила',
  'папа',
  'дед',
  'дедушка',
  'батя',
  'отец',
  'сын',
  'брат',
  'дядя',
]);

const FEMININE_NAMES = new Set([
  'мама',
  'баба',
  'бабушка',
  'мать',
  'дочь',
  'дочка',
  'сестра',
  'тётя',
  'тетя',
]);

/**
 * Names that are genuinely both. Guessing here is worse than not guessing: the
 * renderer falls back to a phrasing that needs no gender at all.
 */
const AMBIGUOUS_NAMES = new Set(['саша', 'женя', 'валя', 'слава', 'шура']);

const CONSONANTS = 'бвгдджзклмнпрстфхцчшщ';

/**
 * Best-effort grammatical gender of a display name.
 *
 * There is no gender column on `users` (D1 keeps that table minimal), so this
 * is a heuristic — and it is deliberately conservative: anything it is not sure
 * about comes back `unknown`, and the renderer then produces a sentence that is
 * correct for everyone.
 */
export function inferGender(displayName: string | null | undefined): ActivityGender {
  if (!displayName) return 'unknown';
  const first = displayName.trim().split(/[\s-]+/)[0];
  if (!first) return 'unknown';
  const name = first.toLocaleLowerCase('ru-RU').replace(/[^\p{L}]/gu, '');
  if (name.length === 0) return 'unknown';

  if (AMBIGUOUS_NAMES.has(name)) return 'unknown';
  if (MASCULINE_NAMES.has(name)) return 'm';
  if (FEMININE_NAMES.has(name)) return 'f';

  const last = name.at(-1);
  if (last === undefined) return 'unknown';
  if (last === 'а' || last === 'я') return 'f';
  if (last === 'й' || CONSONANTS.includes(last)) return 'm';
  return 'unknown';
}

interface GenderedForms {
  /** Predicate for a masculine actor: "выполнил задачу „X“". */
  m: string;
  /** Predicate for a feminine actor: "выполнила задачу „X“". */
  f: string;
  /** A complete sentence with no gendered verb: "Задача „X“ выполнена". */
  neutral: string;
}

/**
 * Assembles the sentence.
 *
 * - known gender  => «Паша выполнил задачу „Вынести мусор“»
 * - unknown       => «Задача „Вынести мусор“ выполнена — Саша»
 * - system actor  => «Задача „Вынести мусор“ выполнена»
 *
 * The unknown-gender form never inflects the name: a Russian name forced into
 * an oblique case is a much worse bug than a slightly formal sentence.
 */
function gendered(actor: ActivityActor, forms: GenderedForms): string {
  const name = actor.name?.trim();
  if (!name) return forms.neutral;
  const gender = actor.gender ?? inferGender(name);
  if (gender === 'm') return `${name} ${forms.m}`;
  if (gender === 'f') return `${name} ${forms.f}`;
  return `${forms.neutral} — ${name}`;
}

/**
 * Integer minor units => «1 000,00 ₽» (D6). Hand-rolled rather than `Intl` so
 * the feed reads identically on every machine and in the tests.
 */
export function formatAmountRu(minorUnits: number, currency = 'RUB'): string {
  const sign = minorUnits < 0 ? '−' : '';
  const abs = Math.abs(Math.trunc(minorUnits));
  const major = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '\u00A0');
  const minor = String(abs % 100).padStart(2, '0');
  const unit = currency === 'RUB' ? '₽' : currency;
  return `${sign}${major},${minor}\u00A0${unit}`;
}

/** Dative noun phrase for "комментарий к …". */
const COMMENT_TARGET_RU: Record<CommentTargetKind, string> = {
  post: 'к объявлению',
  task: 'к задаче',
  event: 'к событию',
  goal: 'к цели',
  poll: 'к опросу',
};

type VerbRenderer<V extends ActivityVerb> = (
  actor: ActivityActor,
  payload: ActivityVerbPayloads[V],
) => string;

/**
 * The renderer for every verb. This object is the reason other modules pass
 * structured data instead of strings.
 */
export const ACTIVITY_VERB_RENDERERS: { [V in ActivityVerb]: VerbRenderer<V> } = {
  'task.completed': (actor, p) =>
    gendered(actor, {
      m: `выполнил задачу ${q(p.title)}`,
      f: `выполнила задачу ${q(p.title)}`,
      neutral: `Задача ${q(p.title)} выполнена`,
    }),

  'task.created': (actor, p) =>
    gendered(actor, {
      m: `создал задачу ${q(p.title)}`,
      f: `создала задачу ${q(p.title)}`,
      neutral: `Создана задача ${q(p.title)}`,
    }),

  'task.assigned': (actor, p) =>
    gendered(actor, {
      m: `назначил задачу ${q(p.title)}, исполнитель: ${p.assigneeName}`,
      f: `назначила задачу ${q(p.title)}, исполнитель: ${p.assigneeName}`,
      neutral: `Задача ${q(p.title)} назначена, исполнитель: ${p.assigneeName}`,
    }),

  'task.swapped': (actor, p) =>
    gendered(actor, {
      m: `передал задачу ${q(p.title)}, новый исполнитель: ${p.toName}`,
      f: `передала задачу ${q(p.title)}, новый исполнитель: ${p.toName}`,
      neutral: `Задача ${q(p.title)} передана, новый исполнитель: ${p.toName}`,
    }),

  'event.created': (actor, p) =>
    gendered(actor, {
      m: `добавил событие ${q(p.title)}`,
      f: `добавила событие ${q(p.title)}`,
      neutral: `Добавлено событие ${q(p.title)}`,
    }),

  'event.cancelled': (actor, p) =>
    gendered(actor, {
      m: `отменил событие ${q(p.title)}`,
      f: `отменила событие ${q(p.title)}`,
      neutral: `Событие ${q(p.title)} отменено`,
    }),

  'goal.created': (actor, p) =>
    gendered(actor, {
      m: `создал цель ${q(p.title)}`,
      f: `создала цель ${q(p.title)}`,
      neutral: `Создана цель ${q(p.title)}`,
    }),

  'goal.contributed': (actor, p) => {
    const amount = formatAmountRu(p.amountMinor, p.currency ?? 'RUB');
    return gendered(actor, {
      m: `пополнил цель ${q(p.title)} на ${amount}`,
      f: `пополнила цель ${q(p.title)} на ${amount}`,
      neutral: `Цель ${q(p.title)} пополнена на ${amount}`,
    });
  },

  /** Always impersonal: a milestone is crossed by the balance, not by a person. */
  'goal.milestone.reached': (_actor, p) => `Цель ${q(p.title)}: пройден этап ${q(p.milestone)}`,

  'goal.reached': (_actor, p) => `Цель ${q(p.title)} достигнута`,

  'shopping.bought': (actor, p) =>
    gendered(actor, {
      m: `купил ${q(p.item)} из списка ${q(p.listTitle)}`,
      f: `купила ${q(p.item)} из списка ${q(p.listTitle)}`,
      neutral: `Куплено: ${q(p.item)} из списка ${q(p.listTitle)}`,
    }),

  'shopping.list.created': (actor, p) =>
    gendered(actor, {
      m: `создал список покупок ${q(p.title)}`,
      f: `создала список покупок ${q(p.title)}`,
      neutral: `Создан список покупок ${q(p.title)}`,
    }),

  'post.created': (actor, p) =>
    gendered(actor, {
      m: `опубликовал объявление ${q(p.title)}`,
      f: `опубликовала объявление ${q(p.title)}`,
      neutral: `Опубликовано объявление ${q(p.title)}`,
    }),

  'post.pinned': (actor, p) =>
    gendered(actor, {
      m: `закрепил объявление ${q(p.title)}`,
      f: `закрепила объявление ${q(p.title)}`,
      neutral: `Объявление ${q(p.title)} закреплено`,
    }),

  'comment.added': (actor, p) => {
    const target = `${COMMENT_TARGET_RU[p.entityType]} ${q(p.entityTitle)}`;
    return gendered(actor, {
      m: `оставил комментарий ${target}`,
      f: `оставила комментарий ${target}`,
      neutral: `Новый комментарий ${target}`,
    });
  },

  'poll.created': (actor, p) =>
    gendered(actor, {
      m: `создал опрос ${q(p.question)}`,
      f: `создала опрос ${q(p.question)}`,
      neutral: `Создан опрос ${q(p.question)}`,
    }),

  'poll.closed': (actor, p) =>
    gendered(actor, {
      m: `завершил опрос ${q(p.question)}`,
      f: `завершила опрос ${q(p.question)}`,
      neutral: `Опрос ${q(p.question)} завершён`,
    }),

  /**
   * Nominal on purpose: two names in one sentence would need a dative, and
   * inflecting a name we did not author is how feeds produce nonsense.
   */
  'kudos.given': (actor, p) =>
    `Благодарность ${p.emoji}: ${actor.name?.trim() ?? 'семья'} → ${p.toName}`,

  'member.approved': (actor, p) =>
    gendered(actor, {
      m: `одобрил заявку, новый участник: ${p.memberName}`,
      f: `одобрила заявку, новый участник: ${p.memberName}`,
      neutral: `Заявка одобрена, новый участник: ${p.memberName}`,
    }),

  'member.joined': (actor) =>
    gendered(actor, {
      m: 'присоединился к семье',
      f: 'присоединилась к семье',
      neutral: 'Новый участник семьи',
    }),
};

export const ACTIVITY_VERBS = Object.keys(ACTIVITY_VERB_RENDERERS) as ActivityVerb[];

const ACTIVITY_VERB_SET: ReadonlySet<string> = new Set<string>(ACTIVITY_VERBS);

export function isActivityVerb(value: string): value is ActivityVerb {
  return ACTIVITY_VERB_SET.has(value);
}

/** Renders the frozen Russian sentence for one event. Pure — no database. */
export function renderActivitySummary<V extends ActivityVerb>(
  verb: V,
  actor: ActivityActor,
  payload: ActivityVerbPayloads[V],
): string {
  const render = ACTIVITY_VERB_RENDERERS[verb] as VerbRenderer<V>;
  return render(actor, payload)
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/* -------------------------------------------------------------------------- */
/* Writing                                                                     */
/* -------------------------------------------------------------------------- */

export interface RecordActivityInput {
  /** `null` => the system acted (scheduler, digest, materializer). */
  actorId: string | null;
  verb: ActivityVerb;
  entityType?: string | null;
  entityId?: string | null;
  /** Pre-rendered Russian sentence. Build it with `renderActivitySummary`. */
  summary: string;
  metadata?: Record<string, unknown>;
}

/**
 * Append one row to the feed.
 *
 * Takes the executor first (D8) so callers can write it inside the same
 * transaction as the thing that happened — an activity row that survives a
 * rolled-back task completion is a lie.
 */
export async function recordActivity(
  tx: Executor,
  input: RecordActivityInput,
): Promise<ActivityLogRow> {
  if (!isActivityVerb(input.verb)) {
    throw badRequest(`Unknown activity verb: ${String(input.verb)}`);
  }
  const summary = input.summary.trim();
  if (summary.length === 0) throw badRequest('Activity summary must not be empty');

  const [row] = await tx
    .insert(activityLog)
    .values({
      actorId: input.actorId,
      verb: input.verb,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      summary,
      metadata: input.metadata ?? {},
    })
    .returning();

  if (!row) throw badRequest('activity_log insert returned no row');
  return row;
}

export interface RecordActivityEventInput<V extends ActivityVerb> {
  actorId: string | null;
  /** Display name (and optional explicit gender) of the actor. */
  actor: ActivityActor;
  verb: V;
  payload: ActivityVerbPayloads[V];
  entityType?: string | null;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * The call other modules should use: hand over structured data, get a correctly
 * rendered Russian sentence written to the feed.
 */
export async function recordActivityEvent<V extends ActivityVerb>(
  tx: Executor,
  input: RecordActivityEventInput<V>,
): Promise<ActivityLogRow> {
  return recordActivity(tx, {
    actorId: input.actorId,
    verb: input.verb,
    entityType: input.entityType ?? null,
    entityId: input.entityId ?? null,
    summary: renderActivitySummary(input.verb, input.actor, input.payload),
    metadata: input.metadata ?? { ...input.payload },
  });
}

/**
 * Removes feed rows pointing at one entity.
 *
 * The feed is append-only for the application; this exists solely for the
 * nightly orphan sweep and for GDPR-style member erasure, and nothing in a
 * request path may call it.
 */
export async function purgeActivityFor(
  tx: Executor,
  entityType: string,
  entityId: string,
): Promise<void> {
  await tx
    .delete(activityLog)
    .where(and(eq(activityLog.entityType, entityType), eq(activityLog.entityId, entityId)));
}
