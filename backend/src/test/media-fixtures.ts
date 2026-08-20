/**
 * Byte-level fixtures for the media pipeline.
 *
 * ## Why these are built rather than checked in
 *
 * The pipeline's whole job is to read a container header, so a fixture that
 * *is* a container header — one whose dimensions, duration and rotation the
 * test chose — is worth more than a binary blob nobody can read. Every number
 * asserted in `media.test.ts` is a number a builder below put there.
 *
 * ## What they are not
 *
 * {@link buildMp4} produces a structurally valid ISO base media file with an
 * empty `mdat`: real boxes, real `mvhd`/`tkhd`/`hdlr`, no encoded frames. It is
 * enough for everything this codebase does — sniff the brand, read the tracks,
 * measure the duration, store it, stream it back, range-read it — and it is not
 * a file any player would render. Generating a genuinely playable clip needs an
 * encoder, and there is no ffmpeg in this tree (nor should there be, on this
 * VDI). Where that distinction matters the test says so.
 */

/** `<size><type><payload>` — the ISO-BMFF box. */
function box(type: string, ...payload: Buffer[]): Buffer {
  const body = Buffer.concat(payload);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(body.length + 8, 0);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, body]);
}

function u32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value, 0);
  return buffer;
}

/** The 3×3 display matrix, as nine 16.16 fixed-point values. */
function matrix(values: readonly number[]): Buffer {
  const buffer = Buffer.alloc(36);
  values.forEach((value, index) => {
    buffer.writeInt32BE(value, index * 4);
  });
  return buffer;
}

const UNITY_MATRIX = matrix([0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000]);
/** 90° clockwise — what an iPhone writes for a portrait clip. */
const ROTATE_90_MATRIX = matrix([0, 0x10000, 0, -0x10000, 0, 0, 0, 0, 0x40000000]);

export interface Mp4Options {
  readonly width?: number;
  readonly height?: number;
  readonly durationMs?: number;
  /** `qt  ` for a QuickTime `.mov`, anything else for MP4. */
  readonly brand?: string;
  /** `vide` for video, `soun` for an audio-only M4A. */
  readonly handler?: 'vide' | 'soun';
  /** A quarter-turn display matrix, so width and height come back swapped. */
  readonly rotated?: boolean;
  /** Padding bytes in `mdat`, to make the object big enough to range-read. */
  readonly padding?: number;
  /** Put `moov` **after** `mdat`, which is what a phone recording actually does. */
  readonly moovLast?: boolean;
}

export function buildMp4(options: Mp4Options = {}): Buffer {
  const {
    width = 640,
    height = 360,
    durationMs = 2000,
    brand = 'isom',
    handler = 'vide',
    rotated = false,
    padding = 0,
    moovLast = false,
  } = options;

  const timescale = 1000;
  const durationUnits = Math.round((durationMs * timescale) / 1000);

  const ftyp = box(
    'ftyp',
    Buffer.from(brand, 'latin1'),
    u32(512),
    Buffer.from('isomiso2', 'latin1'),
  );

  // version+flags, creation, modification, timescale, duration, then the tail
  // this parser never reads (rate, volume, matrix, next track id).
  const mvhd = box(
    'mvhd',
    Buffer.alloc(4),
    Buffer.alloc(8),
    u32(timescale),
    u32(durationUnits),
    Buffer.alloc(80),
  );

  const tkhd = box(
    'tkhd',
    Buffer.alloc(4), // version 0 + flags
    Buffer.alloc(8), // creation, modification
    u32(1), // track id
    Buffer.alloc(4), // reserved
    u32(durationUnits),
    Buffer.alloc(8), // reserved[2]
    Buffer.alloc(8), // layer, alternate group, volume, reserved
    rotated ? ROTATE_90_MATRIX : UNITY_MATRIX,
    u32(width * 65536),
    u32(height * 65536),
  );

  const hdlr = box(
    'hdlr',
    Buffer.alloc(4), // version + flags
    Buffer.alloc(4), // pre_defined
    Buffer.from(handler, 'latin1'),
    Buffer.alloc(12), // reserved
    Buffer.from([0]), // empty name
  );

  const moov = box('moov', mvhd, box('trak', tkhd, box('mdia', hdlr)));
  const mdat = box('mdat', Buffer.alloc(padding, 0x21));

  return moovLast ? Buffer.concat([ftyp, mdat, moov]) : Buffer.concat([ftyp, moov, mdat]);
}

/**
 * A HEIC still, as an iPhone writes it when «Высокоэффективный» is on: the same
 * `ftyp` an MP4 has, with a brand that must be recognised in order to be
 * refused with advice instead of stored as a video that never plays.
 */
export function buildHeic(): Buffer {
  return Buffer.concat([
    box('ftyp', Buffer.from('heic', 'latin1'), Buffer.alloc(4), Buffer.from('mif1heic', 'latin1')),
    box('meta', Buffer.alloc(16)),
  ]);
}

/* -------------------------------------------------------------------------- */
/* Still images                                                                */
/* -------------------------------------------------------------------------- */

/** A real 1×1 PNG — the same one the avatar suite uses. */
export const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** A PNG whose `IHDR` claims whatever the test wants, for the dimension checks. */
export function buildPng(width: number, height: number): Buffer {
  const ihdr = Buffer.concat([
    u32(13),
    Buffer.from('IHDR', 'latin1'),
    u32(width),
    u32(height),
    Buffer.from([8, 6, 0, 0, 0]),
    u32(0), // CRC, unchecked here
  ]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ihdr,
    Buffer.from('IEND', 'latin1'),
  ]);
}

/**
 * A JPEG with a fat `APP1` between `SOI` and `SOF0`.
 *
 * The padding is the point: it is where a real EXIF block (and its thumbnail)
 * sits, and it is why the parser walks the segment chain instead of scanning
 * for a signature.
 */
export function buildJpeg(width: number, height: number, exifBytes = 4096): Buffer {
  const app1 = Buffer.concat([
    Buffer.from([0xff, 0xe1]),
    (() => {
      const length = Buffer.alloc(2);
      length.writeUInt16BE(exifBytes + 2, 0);
      return length;
    })(),
    Buffer.alloc(exifBytes, 0x20),
  ]);

  const sof = Buffer.alloc(11);
  sof.writeUInt8(0xff, 0);
  sof.writeUInt8(0xc0, 1);
  sof.writeUInt16BE(9, 2); // segment length
  sof.writeUInt8(8, 4); // precision
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof.writeUInt8(1, 9); // one component
  sof.writeUInt8(0, 10);

  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    app1,
    sof,
    Buffer.from([0xff, 0xda, 0x00, 0x02]),
    Buffer.alloc(16, 0x55),
    Buffer.from([0xff, 0xd9]),
  ]);
}

export function buildGif(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.write('GIF89a', 0, 'latin1');
  header.writeUInt16LE(width, 6);
  header.writeUInt16LE(height, 8);
  return Buffer.concat([header, Buffer.from(';', 'latin1')]);
}

/** Lossy WebP: `RIFF`…`WEBP`, a `VP8 ` chunk, the `9d 01 2a` start code. */
export function buildWebp(width: number, height: number): Buffer {
  const payload = Buffer.alloc(14);
  payload.writeUInt8(0x9d, 3);
  payload.writeUInt8(0x01, 4);
  payload.writeUInt8(0x2a, 5);
  payload.writeUInt16LE(width, 6);
  payload.writeUInt16LE(height, 8);

  const chunk = Buffer.concat([
    Buffer.from('VP8 ', 'latin1'),
    (() => {
      const size = Buffer.alloc(4);
      size.writeUInt32LE(payload.length, 0);
      return size;
    })(),
    payload,
  ]);

  const riffSize = Buffer.alloc(4);
  riffSize.writeUInt32LE(4 + chunk.length, 0);
  return Buffer.concat([
    Buffer.from('RIFF', 'latin1'),
    riffSize,
    Buffer.from('WEBP', 'latin1'),
    chunk,
  ]);
}

/* -------------------------------------------------------------------------- */
/* Audio                                                                       */
/* -------------------------------------------------------------------------- */

/** 128 kbps, 44.1 kHz, MPEG-1 Layer III — one frame is 417 bytes and 26.12 ms. */
export const MP3_FRAME_BYTES = 417;

/**
 * A constant-bitrate MP3 of `frames` frames, optionally behind an ID3v2 tag.
 *
 * CBR rather than Xing on purpose: it exercises the arithmetic fallback, which
 * is the branch most family files actually take.
 */
export function buildMp3(frames: number, options: { id3?: boolean } = {}): Buffer {
  const frame = Buffer.alloc(MP3_FRAME_BYTES);
  // ff fb: MPEG-1 Layer III, no CRC. 90: bitrate index 9 (128 kbps), sample
  // rate index 0 (44100), no padding. 00: stereo.
  frame.writeUInt8(0xff, 0);
  frame.writeUInt8(0xfb, 1);
  frame.writeUInt8(0x90, 2);
  frame.writeUInt8(0x00, 3);

  const audio = Buffer.concat(Array.from({ length: frames }, () => frame));
  if (!options.id3) return audio;

  // ID3v2.3, 64 bytes of payload, size written syncsafe.
  const tag = Buffer.alloc(10 + 64);
  tag.write('ID3', 0, 'latin1');
  tag.writeUInt8(3, 3);
  tag.writeUInt8(0, 5); // flags: no footer
  tag.writeUInt8(0, 6);
  tag.writeUInt8(0, 7);
  tag.writeUInt8(0, 8);
  tag.writeUInt8(64, 9);
  return Buffer.concat([tag, audio]);
}

/** Duration of {@link buildMp3}, by the same arithmetic the parser uses. */
export function mp3DurationMs(frames: number): number {
  return Math.round((frames * MP3_FRAME_BYTES * 8) / 128);
}

/* -------------------------------------------------------------------------- */
/* Things we refuse                                                            */
/* -------------------------------------------------------------------------- */

export const SVG_WITH_SCRIPT = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
);

export const HTML_DOCUMENT = Buffer.from(
  '<!doctype html><html><body><script>fetch("/api/me")</script></body></html>',
);

/** Matroska/WebM: the EBML magic. */
export const WEBM_HEADER = Buffer.concat([
  Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
  Buffer.alloc(32, 0x42),
]);

/** RIFF, but `WAVE` rather than `WEBP` — the reason `RIFF` alone is not enough. */
export const WAV_HEADER = Buffer.concat([
  Buffer.from('RIFF', 'latin1'),
  Buffer.alloc(4),
  Buffer.from('WAVEfmt ', 'latin1'),
  Buffer.alloc(20),
]);
