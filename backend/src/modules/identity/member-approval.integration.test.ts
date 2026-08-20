import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { APP_ROUTES, type InAppNotification } from '@family/shared';

import { hasTestDb } from '../../test/db.js';
import {
  closeHarness,
  createOwner,
  expectStatus,
  pendingIdOf,
  registerUser,
  request,
  resetDatabase,
  startHarness,
  type Harness,
  type TestUser,
} from '../../test/harness.js';
import { notificationIntents } from '../notifications/notifications.schema.js';
import { dispatchIntent } from '../notifications/notifications.service.js';
import { users } from './users.schema.js';

/**
 * The join-request journey, from the owner's notification to the applicant's
 * waiting screen — against a real database.
 *
 * ## The incident this file is the answer to
 *
 * An owner opened «Заявка в семью — дарья кислякова ждёт подтверждения · google»
 * and pressed the one button on the card. The card then said «Подтверждено
 * 20 августа в 08:09», so she told the applicant she was in. She was not: that
 * button was the D11 delivery receipt, `POST /notifications/deliveries/:id/
 * acknowledge`. That day's production log contains two of those calls and **not
 * one** `POST /members/:id/approve`; the applicant's row was still
 * `pending_approval` when we looked.
 *
 * Two rules follow, and neither is expressible without a database:
 *
 *  1. Acknowledging a notification changes **nothing** about the thing it is
 *     about. A test that stubs the repository cannot tell the difference
 *     between "did not approve" and "approved, and the stub forgot".
 *  2. Approving changes the **row**, not just the response body. `approveMember`
 *     is a conditional `UPDATE ... WHERE status = 'pending_approval'`: a
 *     predicate matching zero rows would still hand back a 200-shaped object if
 *     anyone ever loosened `requireTransitioned`, and the applicant would sit on
 *     «ожидание решения» exactly as she did.
 *
 * The applicant's own view is asserted from her side of the wall — through the
 * anonymous status ticket, the only endpoint a `pending_approval` user can call
 * — because "the owner's screen updated" is a different claim.
 */
describe.skipIf(!hasTestDb)('join request: approval vs. acknowledgement (integration)', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness();
  });

  afterAll(async () => {
    await closeHarness();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  /**
   * Fan every `member_pending_approval` intent out into delivery rows and
   * return the owner's inbox row for it.
   *
   * Called directly rather than through BullMQ: `emitIntent` enqueues
   * `notification.dispatch` after the producer's commit and the suite runs with
   * workers off, so waiting for a worker would mean waiting forever.
   * `dispatchIntent` is the exact function that worker invokes.
   */
  async function joinRequestRow(owner: TestUser): Promise<InAppNotification> {
    const intents = await h.db
      .select({ id: notificationIntents.id })
      .from(notificationIntents)
      .where(eq(notificationIntents.type, 'member_pending_approval'));

    for (const intent of intents) await dispatchIntent(h.db, intent.id);

    const inbox = await request(h.app, {
      method: 'GET',
      url: '/api/notifications',
      token: owner.accessToken,
    });
    expectStatus(inbox, 200);

    const row = inbox
      .json<{ items: InAppNotification[] }>()
      .items.find((item) => item.type === 'member_pending_approval');

    if (!row) throw new Error('the owner never received a join-request notification');
    return row;
  }

  it('acknowledging the notification does not approve the applicant; approving moves the row', async () => {
    const owner = await createOwner(h.app);

    const { response, displayName } = await registerUser(h.app, {
      displayName: 'дарья кислякова',
    });
    expectStatus(response, 200);
    const ticket = response.json<{ pending: { ticket: string } | null }>().pending?.ticket ?? '';
    const applicantId = await pendingIdOf(h.app, owner, displayName);

    const row = await joinRequestRow(owner);
    // `high` priority, so the card really does offer the D11 button. If this
    // ever flips to `false` the trap is gone by accident rather than by design,
    // and the rest of this test would be asserting nothing.
    expect(row.needsAcknowledgement).toBe(true);

    /* ---- what the owner actually did ------------------------------------ */

    const ack = await request(h.app, {
      method: 'POST',
      url: `/api/notifications/deliveries/${row.id}/acknowledge`,
      token: owner.accessToken,
      payload: { occurredAt: new Date().toISOString() },
    });
    expectStatus(ack, 200);
    expect(ack.json<{ acknowledgedAt: string | null }>().acknowledgedAt).not.toBeNull();

    // The receipt was recorded and the applicant is untouched. That is the
    // whole incident, in three assertions.
    const [afterAck] = await h.db.select().from(users).where(eq(users.id, applicantId));
    expect(afterAck?.status).toBe('pending_approval');
    expect(afterAck?.approvedAt).toBeNull();
    expect(afterAck?.approvedById).toBeNull();

    // Still waiting, read from her own side of the wall.
    const waiting = await request(h.app, {
      method: 'GET',
      url: `/api/auth/status?ticket=${encodeURIComponent(ticket)}`,
    });
    expectStatus(waiting, 200);
    expect(waiting.json<{ status: string }>().status).toBe('pending_approval');

    // Still in the queue, too — an acknowledged notification must not quietly
    // drain it.
    const queue = await request(h.app, {
      method: 'GET',
      url: '/api/members/pending',
      token: owner.accessToken,
    });
    expectStatus(queue, 200);
    expect(queue.json<{ pendingCount: number }>().pendingCount).toBe(1);

    /* ---- what she meant to do ------------------------------------------- */

    const approve = await request(h.app, {
      method: 'POST',
      url: `/api/members/${applicantId}/approve`,
      token: owner.accessToken,
      payload: { role: 'adult' },
    });
    expectStatus(approve, 200);

    // The row, not the response body: `transitionUserStatus` is conditional,
    // and a predicate that matches zero rows is the silent failure mode this
    // file exists to rule out.
    const [approved] = await h.db.select().from(users).where(eq(users.id, applicantId));
    expect(approved?.status).toBe('active');
    expect(approved?.role).toBe('adult');
    expect(approved?.approvedAt).toBeInstanceOf(Date);
    expect(approved?.approvedById).toBe(owner.id);

    // The applicant's waiting screen polls exactly this endpoint. If it does
    // not flip, nothing she can see ever changes.
    const decided = await request(h.app, {
      method: 'GET',
      url: `/api/auth/status?ticket=${encodeURIComponent(ticket)}`,
    });
    expectStatus(decided, 200);
    expect(decided.json<{ status: string }>().status).toBe('active');
  });

  it('links the join request to the approval queue the router actually has', async () => {
    const owner = await createOwner(h.app);
    const { response } = await registerUser(h.app, { displayName: 'дарья кислякова' });
    expectStatus(response, 200);

    const row = await joinRequestRow(owner);

    /*
     * `/admin/members`, with no applicant id appended.
     *
     * The renderer used to build `/admin/members/<uuid>`, and the SPA has no
     * `:id` child under the queue — so the card's one navigable affordance
     * landed on the 404 screen, leaving the D11 receipt as the only button that
     * appeared to do anything. Asserted end to end rather than only over
     * `renderNotification`, because the string has to survive the intent
     * payload, the fan-out and the inbox serializer to reach a thumb.
     */
    expect(row.link).toBe(APP_ROUTES.adminMembers);
  });
});
