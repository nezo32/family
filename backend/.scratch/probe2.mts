import { installTemporal } from '../src/core/temporal.js';
await installTemporal();
const { recurrenceEngine } = await import('../src/core/recurrence/engine.js');
// Berlin spring-forward: 2026-03-29, 02:00 -> 03:00
for (const [d, m] of [['2026-03-29T00:00:00', 1440], ['2026-10-25T00:00:00', 1440], ['2026-03-28T23:30:00', 60], ['2026-03-29T01:30:00', 60]] as const) {
  const start = recurrenceEngine.toInstant(d, 'Europe/Berlin');
  const end = recurrenceEngine.addWallClock(d, m, 'Europe/Berlin');
  console.log(d, m, '=>', end.local, 'real min:', (end.instant.getTime()-start.getTime())/60000);
}
