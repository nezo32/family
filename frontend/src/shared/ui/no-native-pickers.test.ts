import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Guards the picker decision.
 *
 * `<input type="date">`, `type="time"` and `type="datetime-local"` were removed
 * from this app for a measured reason: their value box cannot shrink, so at
 * 390px the browser was given 148px for a control that needs 215px and the
 * field rendered clipped. They also render in whatever locale iOS feels like
 * («20 авг. 2026 г.») instead of the format the rest of the app writes.
 *
 * `DateField` / `TimeField` / `DateTimeField` / `ColorField` replaced them.
 * This test exists because that is easy to undo by accident — a native input is
 * the obvious thing to reach for, it looks fine on a desktop, and the damage
 * only shows on a phone.
 */

const SRC = join(import.meta.dirname, '..', '..');

/**
 * Built fresh per call rather than shared at module scope: a stateful regex
 * silently returns false on later files, which is a guard that passes while the
 * codebase rots. An earlier revision of this file did exactly that.
 */
function bannedInput(): RegExp {
  return /<input[^>]*type\s*=\s*[{"'\s]*(date|time|datetime-local|color)\b/;
}

/**
 * The replacement fields document themselves by quoting the very inputs they
 * replaced, so the scan must read code only. Stripping comments rather than
 * allow-listing those files keeps the guard live inside `shared/ui` itself —
 * exactly where a native input is most likely to creep back in.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      sourceFiles(path, found);
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      found.push(path);
    }
  }
  return found;
}

describe('native date, time and colour inputs stay removed', () => {
  it('no source file declares one', () => {
    const offenders = sourceFiles(SRC)
      .filter((path) => bannedInput().test(stripComments(readFileSync(path, 'utf8'))))
      .map((path) => path.slice(SRC.length + 1));

    expect(
      offenders,
      'use DateField / TimeField / DateTimeField / ColorField instead — ' +
        'see shared/ui/date-field.tsx for why',
    ).toEqual([]);
  });

  it('detects a real declaration and ignores a documented one', () => {
    // A guard that cannot fail is worth nothing, and this one already silently
    // could not: an earlier revision carried a stray control character in the
    // pattern, so it passed against a file that did declare a native input.
    const scan = (src: string) => bannedInput().test(stripComments(src));

    expect(scan('return <input type="date" />;')).toBe(true);
    expect(scan('<input type="time" className="x" />')).toBe(true);
    expect(scan('<input type={"color"} />')).toBe(true);
    expect(scan('/** replaces `<input type="date">` */')).toBe(false);
    expect(scan('// <input type="time"> used to live here')).toBe(false);
    expect(scan('<input type="text" />')).toBe(false);
  });
});
