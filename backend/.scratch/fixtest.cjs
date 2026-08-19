const fs = require('fs');
const p = 'src/modules/events/events.test.ts';
const buf = fs.readFileSync(p);

// Strip any real control bytes that leaked into the source, then rewrite the
// control-character assertions using explicit \uXXXX escapes.
const cleaned = [];
for (const byte of buf) {
  if (byte < 9 || (byte > 13 && byte < 32) || byte === 127) continue;
  cleaned.push(byte);
}
let s = Buffer.from(cleaned).toString('utf8');

const BS = String.fromCharCode(92); // a literal backslash in the emitted source
const NL = String.fromCharCode(10);

const marker = "  it('drops control characters that would inject a content line', () => {";
const start = s.indexOf(marker);
if (start < 0) throw new Error('marker not found');
const end = s.indexOf('  });', start);
if (end < 0) throw new Error('block end not found');

const block = [
  marker,
  '    // BEL, NUL and DEL would otherwise let a title terminate the content line.',
  "    expect(escapeText('Тест" + BS + "u0007X')).toBe('ТестX');",
  "    expect(escapeText('A" + BS + "u0000B')).toBe('AB');",
  "    expect(escapeText('A" + BS + "u007FB')).toBe('AB');",
  '    // TAB is a legal TEXT character and survives untouched.',
  "    expect(escapeText('A" + BS + "tB')).toBe('A" + BS + "tB');",
  '',
].join(NL);

s = s.slice(0, start) + block + s.slice(end);
fs.writeFileSync(p, s, 'utf8');
console.log('patched');
