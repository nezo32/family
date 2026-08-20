import { sql } from 'drizzle-orm';

import { closeDb, createDbClient, type Db } from '../core/db.js';
import { getConfig } from '../core/config.js';
import { logger } from '../core/logger.js';
import { familySettings } from '../modules/identity/identity.schema.js';
import { users } from '../modules/identity/users.schema.js';
import { rotationMembers, rotations } from '../modules/chores/chores.schema.js';
import { eventSeries } from '../modules/events/events.schema.js';
import { goalMilestones, goalTransactions, savingsGoals } from '../modules/goals/goals.schema.js';
import { shoppingItems, shoppingLists } from '../modules/shopping/shopping.schema.js';
import { taskSeries } from '../modules/tasks/tasks.schema.js';
import { runMaterializeAll } from '../modules/tasks/tasks.jobs.js';
import { materializeEventSeries } from '../modules/events/events.repository.js';
import { posts } from '../modules/wall/wall.schema.js';
import { pathToFileURL } from 'node:url';

/**
 * Development seed.
 *
 * Creates a plausible family so the UI has something real to render. Safe to
 * re-run: every insert is guarded, and it refuses to run against a database
 * that already has users unless `SEED_FORCE=true`.
 *
 * This inserts **series** only — task and event *occurrences* are produced by
 * the materializer (`scheduler.materialize-all`), which is the same path
 * production uses. Seeding occurrences directly would hide materializer bugs.
 */

/**
 * Turn the seeded rules into actual occurrences.
 *
 * The seed writes **series** only and then runs the real materializer — the
 * same path production uses — rather than inserting occurrence rows by hand,
 * so a materializer bug surfaces here instead of hiding behind hand-written
 * data. Without this pass the seed leaves five chores and three events that
 * render as an empty Задачи and an empty Календарь, which looks like a broken
 * app to anyone opening it for the first time.
 */
async function materializeSeedWindow(db: Db): Promise<void> {
  const tasks = await runMaterializeAll(db);

  // Events have no "materialize everything" job — their service does it inside
  // the create transaction — so the seed walks the series it just wrote.
  const series = await db.select({ id: eventSeries.id }).from(eventSeries);
  let events = 0;
  for (const row of series) {
    const result = await materializeEventSeries(db, row.id);
    events += result.inserted;
  }

  logger.info({ tasks: tasks.inserted, events }, 'seed materialization complete');
}
const RUB = (roubles: number): number => Math.round(roubles * 100);

async function seed(db: Db): Promise<void> {
  const config = getConfig();

  const [existing] = await db.select({ count: sql<number>`count(*)::int` }).from(users);
  if ((existing?.count ?? 0) > 0 && process.env.SEED_FORCE !== 'true') {
    logger.warn('database already has users — skipping seed (set SEED_FORCE=true to override)');
    return;
  }

  await db.transaction(async (tx) => {
    /* ----------------------------- family settings ---------------------------- */
    await tx
      .insert(familySettings)
      .values({ familyName: 'Наша семья', timezone: 'Europe/Moscow' })
      .onConflictDoNothing();

    /* --------------------------------- people --------------------------------- */
    const ownerEmail = config.BOOTSTRAP_OWNER_EMAIL || 'papa@example.com';

    const people = await tx
      .insert(users)
      .values([
        {
          email: ownerEmail,
          emailVerified: true,
          displayName: 'Павел',
          role: 'owner' as const,
          status: 'active' as const,
          birthDate: '1988-04-12',
          color: '#2563eb',
          choreWeight: '1.00',
          sortOrder: 0,
          approvedAt: new Date(),
        },
        {
          email: 'mama@example.com',
          emailVerified: true,
          displayName: 'Мария',
          role: 'admin' as const,
          status: 'active' as const,
          birthDate: '1990-09-03',
          color: '#db2777',
          choreWeight: '1.00',
          sortOrder: 1,
          approvedAt: new Date(),
        },
        {
          email: 'sasha@example.com',
          displayName: 'Саша',
          role: 'teen' as const,
          status: 'active' as const,
          birthDate: '2010-01-22',
          color: '#16a34a',
          choreWeight: '0.70',
          sortOrder: 2,
          approvedAt: new Date(),
        },
        {
          displayName: 'Лиза',
          role: 'child' as const,
          status: 'active' as const,
          birthDate: '2016-06-30',
          color: '#f59e0b',
          choreWeight: '0.40',
          sortOrder: 3,
          approvedAt: new Date(),
        },
        {
          email: 'babushka@example.com',
          displayName: 'Бабушка Нина',
          role: 'adult' as const,
          // Deliberately left pending so the approval queue has something in it.
          status: 'pending_approval' as const,
          birthDate: '1962-11-08',
          color: '#7c3aed',
          choreWeight: '0.00',
          sortOrder: 4,
        },
      ])
      .returning({ id: users.id, displayName: users.displayName });

    const byName = new Map(people.map((p) => [p.displayName, p.id]));
    const papa = byName.get('Павел');
    const mama = byName.get('Мария');
    const sasha = byName.get('Саша');
    const liza = byName.get('Лиза');
    if (!papa || !mama || !sasha || !liza) throw new Error('seed: user insert did not return ids');

    /* -------------------------------- rotation -------------------------------- */
    const [rotation] = await tx
      .insert(rotations)
      .values({ name: 'Дежурство по дому', strategy: 'weighted_balance', balanceWindowDays: 28 })
      .returning({ id: rotations.id });
    if (!rotation) throw new Error('seed: rotation insert failed');

    await tx.insert(rotationMembers).values([
      { rotationId: rotation.id, userId: papa, weight: '1.00', position: 0 },
      { rotationId: rotation.id, userId: mama, weight: '1.00', position: 1 },
      { rotationId: rotation.id, userId: sasha, weight: '0.70', position: 2 },
      { rotationId: rotation.id, userId: liza, weight: '0.40', position: 3 },
    ]);

    /* ------------------------------- task series ------------------------------ */
    await tx.insert(taskSeries).values([
      {
        title: 'Помыть посуду',
        notes: 'После ужина, до 21:00',
        createdById: papa,
        rrule: 'FREQ=DAILY;INTERVAL=1',
        dtstartLocal: '2026-08-19T19:30:00',
        timezone: 'Europe/Moscow',
        dueOffsetMinutes: 90,
        graceMinutes: 30,
        rotationId: rotation.id,
        category: 'кухня',
      },
      {
        title: 'Постирать бельё',
        createdById: mama,
        rrule: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=SA',
        dtstartLocal: '2026-08-22T10:00:00',
        timezone: 'Europe/Moscow',
        dueOffsetMinutes: 480,
        rotationId: rotation.id,
        category: 'дом',
      },
      {
        title: 'Вынести мусор',
        createdById: papa,
        rrule: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,TH',
        dtstartLocal: '2026-08-20T08:00:00',
        timezone: 'Europe/Moscow',
        dueOffsetMinutes: 120,
        rotationId: rotation.id,
        category: 'дом',
      },
      {
        title: 'Полить цветы',
        createdById: mama,
        rrule: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=WE,SU',
        dtstartLocal: '2026-08-19T18:00:00',
        timezone: 'Europe/Moscow',
        defaultAssigneeId: liza,
        category: 'дом',
      },
      {
        title: 'Приготовить ужин',
        createdById: mama,
        rrule: 'FREQ=DAILY;INTERVAL=1',
        dtstartLocal: '2026-08-19T18:00:00',
        timezone: 'Europe/Moscow',
        dueOffsetMinutes: 60,
        rotationId: rotation.id,
        category: 'кухня',
      },
    ]);

    /* ------------------------------ event series ------------------------------ */
    await tx.insert(eventSeries).values([
      {
        title: 'Стоматолог — Саша',
        location: 'Стоматология «Улыбка», ул. Ленина 14',
        createdById: mama,
        rrule: null,
        dtstartLocal: '2026-09-02T15:30:00',
        timezone: 'Europe/Moscow',
        durationMinutes: 60,
        reminderOffsets: [1440, 60],
        color: '#dc2626',
        category: 'здоровье',
      },
      {
        title: 'Родительское собрание',
        location: 'Школа №7, кабинет 204',
        createdById: papa,
        rrule: null,
        dtstartLocal: '2026-09-10T18:30:00',
        timezone: 'Europe/Moscow',
        durationMinutes: 90,
        reminderOffsets: [1440],
        color: '#0891b2',
        category: 'школа',
      },
      {
        title: 'Семейный ужин у бабушки',
        createdById: mama,
        rrule: 'FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=1',
        dtstartLocal: '2026-09-01T17:00:00',
        timezone: 'Europe/Moscow',
        durationMinutes: 180,
        reminderOffsets: [2880],
        color: '#7c3aed',
        category: 'семья',
      },
    ]);

    /* ---------------------------- moneybox / goals ---------------------------- */
    const [seaGoal] = await tx
      .insert(savingsGoals)
      .values({
        title: 'Отпуск на море',
        description: 'Неделя в июле, четверо взрослых и двое детей',
        targetAmount: RUB(200_000),
        deadline: '2027-06-01',
        color: '#0ea5e9',
        icon: 'palmtree',
        createdById: papa,
        sortOrder: 0,
      })
      .returning({ id: savingsGoals.id });
    if (!seaGoal) throw new Error('seed: goal insert failed');

    await tx.insert(goalMilestones).values([
      { goalId: seaGoal.id, title: 'Забронировать жильё', targetAmount: RUB(60_000), sortOrder: 0 },
      { goalId: seaGoal.id, title: 'Купить билеты', targetAmount: RUB(120_000), sortOrder: 1 },
      { goalId: seaGoal.id, title: 'Цель достигнута', targetAmount: RUB(200_000), sortOrder: 2 },
    ]);

    await tx.insert(goalTransactions).values([
      {
        goalId: seaGoal.id,
        userId: papa,
        delta: RUB(30_000),
        kind: 'contribution' as const,
        note: 'Премия',
        createdById: papa,
      },
      {
        goalId: seaGoal.id,
        userId: mama,
        delta: RUB(25_000),
        kind: 'contribution' as const,
        createdById: mama,
      },
      {
        goalId: seaGoal.id,
        userId: papa,
        delta: RUB(15_000),
        kind: 'contribution' as const,
        createdById: papa,
      },
    ]);

    await tx.insert(savingsGoals).values({
      title: 'Велосипед',
      description: 'Копит сам',
      targetAmount: RUB(35_000),
      color: '#16a34a',
      icon: 'bike',
      ownerId: sasha,
      visibility: 'private' as const,
      createdById: sasha,
      sortOrder: 1,
    });

    /* -------------------------------- shopping -------------------------------- */
    const lists = await tx
      .insert(shoppingLists)
      .values([
        {
          name: 'Продукты',
          icon: 'shopping-cart',
          color: '#16a34a',
          createdById: mama,
          sortOrder: 0,
        },
        { name: 'Хозтовары', icon: 'spray-can', color: '#0891b2', createdById: papa, sortOrder: 1 },
        { name: 'Аптека', icon: 'pill', color: '#dc2626', createdById: mama, sortOrder: 2 },
      ])
      .returning({ id: shoppingLists.id, name: shoppingLists.name });

    const groceries = lists.find((l) => l.name === 'Продукты');
    if (!groceries) throw new Error('seed: shopping list insert failed');

    await tx.insert(shoppingItems).values([
      {
        listId: groceries.id,
        name: 'Молоко',
        quantity: '2',
        unit: 'шт',
        category: 'молочное',
        requestedById: mama,
        sortOrder: 0,
      },
      {
        listId: groceries.id,
        name: 'Хлеб',
        quantity: '1',
        unit: 'шт',
        category: 'выпечка',
        requestedById: papa,
        sortOrder: 1,
      },
      {
        listId: groceries.id,
        name: 'Картошка',
        quantity: '3',
        unit: 'кг',
        category: 'овощи',
        requestedById: mama,
        sortOrder: 2,
      },
      {
        listId: groceries.id,
        name: 'Яблоки',
        quantity: '1.5',
        unit: 'кг',
        category: 'фрукты',
        requestedById: sasha,
        sortOrder: 3,
      },
      {
        listId: groceries.id,
        name: 'Сыр',
        category: 'молочное',
        requestedById: papa,
        isUrgent: true,
        sortOrder: 4,
      },
    ]);

    /* ---------------------------------- wall ---------------------------------- */
    await tx.insert(posts).values({
      authorId: mama,
      type: 'announcement' as const,
      title: 'В субботу приезжает бабушка',
      body: 'Убираем дом в пятницу вечером. Саша — свою комнату, Лиза — игрушки в гостиной.',
      pinnedUntil: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });
  });

  await materializeSeedWindow(db);

  logger.info('seed complete');
}

// Hand-building a `file://` string gets the slash count wrong on Windows
// (`file://E:/...` vs the real `file:///E:/...`), so this guard silently never
// fired and the script exited having done nothing. Let Node do the conversion.
const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === entrypoint) {
  const { sql: client, db } = createDbClient();
  try {
    await seed(db);
    await client.end({ timeout: 5 });
    await closeDb();
    process.exit(0);
  } catch (err) {
    logger.fatal({ err }, 'seed failed');
    process.exit(1);
  }
}

export { seed };
