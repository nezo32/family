import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { hasTestDb } from './db.js';
import { closeHarness, createOwner, request, resetDatabase, startHarness } from './harness.js';
import { goalTransactions } from '../modules/goals/goals.schema.js';

describe.skipIf(!hasTestDb)('probe3', () => {
  let h: Awaited<ReturnType<typeof startHarness>>;
  beforeAll(async () => { h = await startHarness(); });
  afterAll(async () => { await closeHarness(); });

  it('does a 500 contribution still commit?', async () => {
    await resetDatabase();
    const owner = await createOwner(h.app);
    const g = await request(h.app, { method: 'POST', url: '/api/goals', token: owner.accessToken,
      payload: { title: 'X', targetAmount: 100000, currency: 'RUB', visibility: 'household' } });
    const gid = (g.json() as any).id;
    const c = await request(h.app, { method: 'POST', url: `/api/goals/${gid}/contributions`, token: owner.accessToken, payload: { amount: 5000, kind: 'contribution' } });
    console.log('[contribute]', c.statusCode, c.body.slice(0, 200));
    const rows = await h.db.select().from(goalTransactions).where(eq(goalTransactions.goalId, gid));
    console.log('[rows after 500]', rows.length, JSON.stringify(rows.map(r => ({ delta: r.delta, occurredAt: r.occurredAt }))));
    const get = await request(h.app, { method: 'GET', url: `/api/goals/${gid}`, token: owner.accessToken });
    console.log('[GET /goals/:id]', get.statusCode, get.body.slice(0, 200));
    const list = await request(h.app, { method: 'GET', url: '/api/goals', token: owner.accessToken });
    console.log('[GET /goals]', list.statusCode, list.body.slice(0, 300));
    const summary = await request(h.app, { method: 'GET', url: '/api/goals/summary', token: owner.accessToken });
    console.log('[GET /goals/summary]', summary.statusCode, summary.body.slice(0, 200));
    const tx = await request(h.app, { method: 'GET', url: `/api/goals/${gid}/transactions`, token: owner.accessToken });
    console.log('[GET transactions]', tx.statusCode, tx.body.slice(0, 200));
  }, 120000);
});
