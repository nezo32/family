import { describe, expect, it } from 'vitest';

import { AppError } from '../../core/errors.js';
import { sniffImageType, validateImageUpload } from './image.js';

/**
 * The magic-byte gate.
 *
 * This is the file that has to keep passing. Everything else in the avatar
 * feature is plumbing; this is the part standing between a family member's
 * profile picture and a stored-XSS hole, because the only two things an
 * attacker controls on an upload are the bytes and the `Content-Type`, and one
 * of those we refuse to believe.
 */

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('IHDR-and-then-some-payload'),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 0x11)]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0x24, 0x00, 0x00, 0x00]),
  Buffer.from('WEBPVP8 '),
  Buffer.alloc(16, 0x22),
]);

const MAX = 2 * 1024 * 1024;

describe('sniffImageType', () => {
  it('recognises the three formats we accept', () => {
    expect(sniffImageType(PNG)).toBe('image/png');
    expect(sniffImageType(JPEG)).toBe('image/jpeg');
    expect(sniffImageType(WEBP)).toBe('image/webp');
  });

  it('rejects a RIFF container that is not WebP', () => {
    // WAV is RIFF too. Checking only the first four bytes would accept it, and
    // then we would be serving audio with `Content-Type: image/webp`.
    const wav = Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.from([0x24, 0x00, 0x00, 0x00]),
      Buffer.from('WAVEfmt '),
    ]);
    expect(sniffImageType(wav)).toBeNull();
  });

  it('rejects HTML, SVG and a bare text file', () => {
    expect(sniffImageType(Buffer.from('<html><script>alert(1)</script></html>'))).toBeNull();
    expect(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
    expect(sniffImageType(Buffer.from('just some text, honestly'))).toBeNull();
  });

  it('rejects a file too short to have a header', () => {
    expect(sniffImageType(Buffer.from([0x89, 0x50, 0x4e]))).toBeNull();
  });

  it('rejects a PNG signature that is one byte wrong', () => {
    const almost = Buffer.from(PNG);
    almost[7] = 0x09;
    expect(sniffImageType(almost)).toBeNull();
  });
});

describe('validateImageUpload', () => {
  it('returns the sniffed type and its extension', () => {
    expect(validateImageUpload(WEBP, { declaredType: 'image/webp', maxBytes: MAX })).toMatchObject({
      contentType: 'image/webp',
      extension: 'webp',
    });
  });

  it('trusts the bytes over a mismatched but allowed declared type', () => {
    // The client said PNG and sent a JPEG. Harmless, common (browsers do get
    // this wrong), and the stored type must still be the true one — otherwise
    // we serve a JPEG labelled `image/png`.
    const result = validateImageUpload(JPEG, { declaredType: 'image/png', maxBytes: MAX });
    expect(result.contentType).toBe('image/jpeg');
  });

  it('rejects an HTML file dressed as a PNG', () => {
    // The attack this whole module exists for: `Content-Type: image/png`, name
    // `photo.png`, contents a script. Serving it back from our own origin under
    // a sniffable type is stored XSS against every member who views the roster.
    const html = Buffer.from('<!doctype html><script>fetch("/api/me")</script>');
    expect(() =>
      validateImageUpload(html, { declaredType: 'image/png', maxBytes: MAX }),
    ).toThrowError(AppError);

    try {
      validateImageUpload(html, { declaredType: 'image/png', maxBytes: MAX });
      expect.unreachable('an HTML payload must not pass validation');
    } catch (error) {
      expect((error as AppError).code).toBe('UNSUPPORTED_MEDIA_TYPE');
    }
  });

  it('rejects a declared type outside the allow-list before looking at bytes', () => {
    // A HEIC straight off an iPhone. Real bytes, real image, unsupported.
    const heic = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypheic')]);
    try {
      validateImageUpload(heic, { declaredType: 'image/heic', maxBytes: MAX });
      expect.unreachable('HEIC must be rejected');
    } catch (error) {
      expect((error as AppError).code).toBe('UNSUPPORTED_MEDIA_TYPE');
    }
  });

  it('accepts a declared type carrying a charset parameter', () => {
    expect(
      validateImageUpload(PNG, { declaredType: 'image/png; charset=binary', maxBytes: MAX })
        .contentType,
    ).toBe('image/png');
  });

  it('sniffs when the client declared nothing at all', () => {
    expect(validateImageUpload(PNG, { declaredType: undefined, maxBytes: MAX }).contentType).toBe(
      'image/png',
    );
  });

  it('enforces the size cap', () => {
    const big = Buffer.concat([PNG, Buffer.alloc(64)]);
    try {
      validateImageUpload(big, { declaredType: 'image/png', maxBytes: 32 });
      expect.unreachable('an oversized image must be rejected');
    } catch (error) {
      expect((error as AppError).code).toBe('PAYLOAD_TOO_LARGE');
    }
  });

  it('rejects an empty part', () => {
    try {
      validateImageUpload(Buffer.alloc(0), { declaredType: 'image/png', maxBytes: MAX });
      expect.unreachable('an empty upload must be rejected');
    } catch (error) {
      expect((error as AppError).code).toBe('BAD_REQUEST');
    }
  });
});
