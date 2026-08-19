import { installTemporal } from '../src/core/temporal.js';
await installTemporal();
const { recurrenceEngine } = await import('../src/core/recurrence/engine.js');

const rule = {
  rrule: 'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=-1',
  dtstartLocal: '2000-02-29T00:00:00',
  timezone: 'Europe/Moscow',
  rdatesLocal: [] as string[],
  exdatesLocal: [] as string[],
};
console.log('leap:', recurrenceEngine.expand(rule, { from: new Date('2024-01-01T00:00:00Z'), to: new Date('2029-12-31T00:00:00Z') }));

const plain = { ...rule, rrule: 'FREQ=YEARLY;BYMONTH=5;BYMONTHDAY=17', dtstartLocal: '1990-05-17T00:00:00' };
console.log('plain:', recurrenceEngine.expand(plain, { from: new Date('2026-01-01T00:00:00Z'), to: new Date('2028-12-31T00:00:00Z') }));

console.log('berlin 23:30 +60', recurrenceEngine.addWallClock('2026-10-24T23:30:00', 60, 'Europe/Berlin'));
const a = recurrenceEngine.toInstant('2026-10-25T02:30:00', 'Europe/Berlin');
const b = recurrenceEngine.addWallClock('2026-10-25T02:30:00', 60, 'Europe/Berlin');
console.log('berlin 02:30 +60', b.local, (b.instant.getTime() - a.getTime())/60000, 'real minutes');

for (const tz of ['Pacific/Kiritimati', 'Pacific/Niue', 'Europe/Moscow']) {
  const s = recurrenceEngine.toInstant('2026-09-07T00:00:00', tz);
  const e = recurrenceEngine.addWallClock('2026-09-07T00:00:00', 1440, tz);
  console.log(tz, s.toISOString(), e.local, e.instant.toISOString());
}
console.log('describe leap:', recurrenceEngine.describe(rule));
console.log('decompile leap:', recurrenceEngine.decompile(rule.rrule, 'Europe/Moscow'));
