import type { AllowedMediaType, MediaKind } from '@family/shared';

import { unsupportedMedia, type ProbedMedia, type SniffedContainer } from './media.js';

/**
 * Dimensions and duration, read out of the file itself.
 *
 * ## Why this exists at all
 *
 * Two hard requirements, neither optional:
 *
 * - **The card must box its media before the bytes arrive.** §D7.6 asks for an
 *   `aspect-ratio` set from server-supplied dimensions, because a feed that
 *   reflows as each photo loads is the single most visible jank on a phone. So
 *   the server has to know the pixel size, and it has to know it without
 *   decoding the image.
 * - **A duration limit has to be measurable.** «до 3 минут» that nobody
 *   enforces is a sentence in a document, not a limit; and duration is what
 *   actually bounds what the nightly volume tar has to carry.
 *
 * ## Why it is written by hand
 *
 * There is no `sharp`, no `ffprobe` and no metadata library in this tree, and
 * adding one is not this task's call — but none of that is needed. Every number
 * below sits in a container header: PNG's `IHDR`, JPEG's `SOFn`, WebP's
 * `VP8*` chunk, an MP4 `moov/mvhd` and `trak/tkhd`, an MP3 frame header. Parsing
 * a header is not decoding a file: nothing here allocates a frame buffer, so a
 * decompression bomb is a number we reject rather than memory we consume.
 *
 * ## Why it reads from a seekable source rather than a Buffer
 *
 * `moov` is at the **end** of a video the phone recorded (nothing rewrites a
 * 90 MB file to move it to the front), and a JPEG's `SOFn` can sit past a
 * megabyte of EXIF and ICC. Both need arbitrary seeks, and holding a 100 MB
 * video in memory to do them is exactly what the upload path spools to a temp
 * file to avoid. `ByteSource` is that seam: a file handle in production, a
 * Buffer in the unit tests.
 */

export interface ByteSource {
  readonly size: number;
  /** Up to `length` bytes at `offset`. Short reads at EOF are normal, not an error. */
  read(offset: number, length: number): Promise<Buffer>;
}

export function bufferSource(buffer: Buffer): ByteSource {
  return {
    size: buffer.length,
    read: (offset, length) =>
      Promise.resolve(buffer.subarray(offset, Math.min(buffer.length, offset + length))),
  };
}

/* -------------------------------------------------------------------------- */
/* Still images                                                                */
/* -------------------------------------------------------------------------- */

export interface Dimensions {
  readonly width: number;
  readonly height: number;
}

function pngDimensions(head: Buffer): Dimensions | null {
  // 8-byte signature, then the IHDR chunk: length(4) type(4) width(4) height(4).
  if (head.length < 24 || head.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
}

function gifDimensions(head: Buffer): Dimensions | null {
  // Logical screen descriptor, little-endian, straight after `GIF89a`.
  if (head.length < 10) return null;
  return { width: head.readUInt16LE(6), height: head.readUInt16LE(8) };
}

function webpDimensions(head: Buffer): Dimensions | null {
  if (head.length < 30) return null;
  const chunk = head.toString('latin1', 12, 16);

  if (chunk === 'VP8 ') {
    // Lossy: a 3-byte frame tag, the 3-byte start code 9d 01 2a, then 14-bit
    // width and height (the top two bits are the scaling factor).
    if (head.length < 30) return null;
    if (head[23] !== 0x9d || head[24] !== 0x01 || head[25] !== 0x2a) return null;
    return {
      width: head.readUInt16LE(26) & 0x3fff,
      height: head.readUInt16LE(28) & 0x3fff,
    };
  }

  if (chunk === 'VP8L') {
    // Lossless: signature byte, then 14 bits of (width-1) and 14 of (height-1).
    if (head[20] !== 0x2f) return null;
    const bits = head.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }

  if (chunk === 'VP8X') {
    // Extended (animation, alpha, EXIF): 24-bit little-endian canvas size − 1.
    const width = head.readUIntLE(24, 3) + 1;
    const height = head.readUIntLE(27, 3) + 1;
    return { width, height };
  }

  return null;
}

/** Markers that carry no payload length, so the walk must not try to skip one. */
const STANDALONE_MARKERS = new Set([0xd8, 0xd9, 0x01]);

/**
 * JPEG dimensions, by walking the segment chain to the first `SOFn`.
 *
 * The chain is followed rather than the bytes scanned for a signature: a
 * signature scan finds `SOF0` inside an embedded EXIF thumbnail and returns the
 * thumbnail's size, which is both wrong and plausible-looking.
 */
async function jpegDimensions(source: ByteSource): Promise<Dimensions | null> {
  let offset = 2;
  // A malformed file must not be able to spin here; no real JPEG has thousands
  // of segments before its first SOF.
  for (let guard = 0; guard < 4096; guard += 1) {
    const header = await source.read(offset, 4);
    if (header.length < 4) return null;
    if (header[0] !== 0xff) return null;

    const marker = header[1];
    if (marker === undefined) return null;
    // Fill bytes: any number of 0xff may precede a marker.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (STANDALONE_MARKERS.has(marker) || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }

    const length = header.readUInt16BE(2);
    if (length < 2) return null;

    // SOF0..SOF15, minus the three that are not frame headers (DHT, JPGA, DAC).
    const isStartOfFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isStartOfFrame) {
      const frame = await source.read(offset + 4, 5);
      if (frame.length < 5) return null;
      // precision(1) height(2) width(2)
      return { height: frame.readUInt16BE(1), width: frame.readUInt16BE(3) };
    }

    // `SOS` starts entropy-coded data — there is no frame header after it.
    if (marker === 0xda) return null;
    offset += 2 + length;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* ISO base media files: MP4, QuickTime, M4A                                   */
/* -------------------------------------------------------------------------- */

interface Box {
  readonly type: string;
  readonly payloadStart: number;
  readonly end: number;
}

/**
 * The boxes directly inside `[start, end)`.
 *
 * Every size is validated against the enclosing range before it is used: a box
 * claiming to be 4 GB inside a 200-byte parent is the shape of a parser
 * exploit, and here it simply ends the walk.
 */
async function readBoxes(source: ByteSource, start: number, end: number): Promise<Box[]> {
  const boxes: Box[] = [];
  let offset = start;

  for (let guard = 0; guard < 1024 && offset + 8 <= end; guard += 1) {
    const header = await source.read(offset, 16);
    if (header.length < 8) break;

    let size = header.readUInt32BE(0);
    const type = header.toString('latin1', 4, 8);
    let payloadStart = offset + 8;

    if (size === 1) {
      if (header.length < 16) break;
      // 64-bit size. `readBigUInt64BE` -> Number is safe: anything past 2^53
      // fails the range check below long before precision matters.
      size = Number(header.readBigUInt64BE(8));
      payloadStart = offset + 16;
    } else if (size === 0) {
      size = end - offset;
    }

    if (size < payloadStart - offset || offset + size > end) break;

    boxes.push({ type, payloadStart, end: offset + size });
    offset += size;
  }

  return boxes;
}

async function findBox(
  source: ByteSource,
  start: number,
  end: number,
  type: string,
): Promise<Box | null> {
  const boxes = await readBoxes(source, start, end);
  return boxes.find((box) => box.type === type) ?? null;
}

interface MovieHeader {
  readonly timescale: number;
  readonly duration: number;
}

async function readMvhd(source: ByteSource, box: Box): Promise<MovieHeader | null> {
  const buf = await source.read(box.payloadStart, 32);
  if (buf.length < 20) return null;
  const version = buf.readUInt8(0);
  if (version === 1) {
    if (buf.length < 32) return null;
    return { timescale: buf.readUInt32BE(20), duration: Number(buf.readBigUInt64BE(24)) };
  }
  return { timescale: buf.readUInt32BE(12), duration: buf.readUInt32BE(16) };
}

interface TrackHeader {
  readonly durationUnits: number;
  readonly width: number;
  readonly height: number;
}

/**
 * `tkhd`, with the display matrix applied.
 *
 * The rotation matters and it is the one thing a naive parser gets wrong: an
 * iPhone records **landscape pixels plus a 90° matrix**, so a portrait video
 * whose `tkhd` says 1920×1080 draws as 1080×1920. Reading the width and height
 * without the matrix produces a feed card boxed on its side.
 */
async function readTkhd(source: ByteSource, box: Box): Promise<TrackHeader | null> {
  const buf = await source.read(box.payloadStart, 96);
  if (buf.length < 24) return null;
  const version = buf.readUInt8(0);
  const base = version === 1 ? 36 : 24;
  const durationOffset = version === 1 ? 28 : 20;
  if (buf.length < base + 64) return null;

  const durationUnits =
    version === 1 ? Number(buf.readBigUInt64BE(durationOffset)) : buf.readUInt32BE(durationOffset);

  // reserved(8) + layer/alternate_group/volume/reserved(8) then the 3x3 matrix.
  const matrixStart = base + 16;
  const a = buf.readInt32BE(matrixStart);
  const b = buf.readInt32BE(matrixStart + 4);
  const c = buf.readInt32BE(matrixStart + 12);
  const d = buf.readInt32BE(matrixStart + 16);

  const widthOffset = matrixStart + 36;
  // 16.16 fixed point.
  const width = Math.round(buf.readUInt32BE(widthOffset) / 65536);
  const height = Math.round(buf.readUInt32BE(widthOffset + 4) / 65536);

  const rotatedQuarterTurn = a === 0 && d === 0 && b !== 0 && c !== 0;
  return rotatedQuarterTurn
    ? { durationUnits, width: height, height: width }
    : { durationUnits, width, height };
}

interface IsoBmffInfo {
  readonly hasVideo: boolean;
  readonly hasAudio: boolean;
  readonly durationMs: number | null;
  readonly width: number | null;
  readonly height: number | null;
}

export async function probeIsoBmff(source: ByteSource): Promise<IsoBmffInfo | null> {
  const top = await readBoxes(source, 0, source.size);
  const moov = top.find((box) => box.type === 'moov');
  if (!moov) return null;

  const children = await readBoxes(source, moov.payloadStart, moov.end);
  const mvhdBox = children.find((box) => box.type === 'mvhd');
  const movie = mvhdBox ? await readMvhd(source, mvhdBox) : null;

  let hasVideo = false;
  let hasAudio = false;
  let width: number | null = null;
  let height: number | null = null;
  let longestTrackUnits = 0;

  for (const trak of children.filter((box) => box.type === 'trak')) {
    const trakChildren = await readBoxes(source, trak.payloadStart, trak.end);
    const tkhdBox = trakChildren.find((box) => box.type === 'tkhd');
    const track = tkhdBox ? await readTkhd(source, tkhdBox) : null;

    const mdia = trakChildren.find((box) => box.type === 'mdia');
    let handler = '';
    if (mdia) {
      const hdlr = await findBox(source, mdia.payloadStart, mdia.end, 'hdlr');
      if (hdlr) {
        const buf = await source.read(hdlr.payloadStart, 12);
        if (buf.length >= 12) handler = buf.toString('latin1', 8, 12);
      }
    }

    if (handler === 'vide') {
      hasVideo = true;
      // The largest video track wins: some cameras write a tiny preview track
      // alongside the real one.
      if (track && (width === null || track.width * track.height > width * (height ?? 0))) {
        width = track.width;
        height = track.height;
      }
    } else if (handler === 'soun') {
      hasAudio = true;
    }

    if (track) longestTrackUnits = Math.max(longestTrackUnits, track.durationUnits);
  }

  let durationMs: number | null = null;
  if (movie && movie.timescale > 0) {
    // 0xFFFFFFFF is the "unknown duration" sentinel a still-recording file
    // carries; fall back to the longest track, which is in the same timescale.
    const units =
      movie.duration > 0 && movie.duration !== 0xffffffff ? movie.duration : longestTrackUnits;
    if (units > 0) durationMs = Math.round((units / movie.timescale) * 1000);
  }

  return { hasVideo, hasAudio, durationMs, width, height };
}

/* -------------------------------------------------------------------------- */
/* MP3                                                                         */
/* -------------------------------------------------------------------------- */

const BITRATES_V1_L1 = [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448];
const BITRATES_V1_L2 = [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384];
const BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATES_V2_L1 = [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256];
const BITRATES_V2_L23 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];

const SAMPLE_RATES: Record<number, readonly number[]> = {
  0b11: [44100, 48000, 32000], // MPEG 1
  0b10: [22050, 24000, 16000], // MPEG 2
  0b00: [11025, 12000, 8000], // MPEG 2.5
};

interface Mp3Frame {
  readonly bitrateKbps: number;
  readonly sampleRate: number;
  readonly samplesPerFrame: number;
  readonly isMpeg1: boolean;
  readonly isMono: boolean;
}

function parseMp3Frame(header: Buffer, offset: number): Mp3Frame | null {
  if (offset + 4 > header.length) return null;
  const b1 = header.readUInt8(offset + 1);
  const b2 = header.readUInt8(offset + 2);
  const b3 = header.readUInt8(offset + 3);
  if (header.readUInt8(offset) !== 0xff || (b1 & 0xe0) !== 0xe0) return null;

  const versionBits = (b1 >> 3) & 0b11;
  const layerBits = (b1 >> 1) & 0b11;
  if (versionBits === 0b01 || layerBits === 0b00) return null;

  const bitrateIndex = (b2 >> 4) & 0b1111;
  const sampleRateIndex = (b2 >> 2) & 0b11;
  if (bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 0b11) return null;

  const isMpeg1 = versionBits === 0b11;
  const table = isMpeg1
    ? layerBits === 0b11
      ? BITRATES_V1_L1
      : layerBits === 0b10
        ? BITRATES_V1_L2
        : BITRATES_V1_L3
    : layerBits === 0b11
      ? BITRATES_V2_L1
      : BITRATES_V2_L23;

  const bitrateKbps = table[bitrateIndex];
  const sampleRate = SAMPLE_RATES[versionBits]?.[sampleRateIndex];
  if (bitrateKbps === undefined || sampleRate === undefined) return null;

  const samplesPerFrame =
    layerBits === 0b11 ? 384 : layerBits === 0b10 ? 1152 : isMpeg1 ? 1152 : 576;

  return {
    bitrateKbps,
    sampleRate,
    samplesPerFrame,
    isMpeg1,
    isMono: ((b3 >> 6) & 0b11) === 0b11,
  };
}

/** ID3v2 sizes are "syncsafe": seven bits per byte, so no byte can look like a frame sync. */
function id3Length(head: Buffer): number {
  if (head.length < 10 || head.toString('latin1', 0, 3) !== 'ID3') return 0;
  const flags = head.readUInt8(5);
  const size =
    ((head.readUInt8(6) & 0x7f) << 21) |
    ((head.readUInt8(7) & 0x7f) << 14) |
    ((head.readUInt8(8) & 0x7f) << 7) |
    (head.readUInt8(9) & 0x7f);
  // Bit 4 is "a footer is present", which is another ten bytes.
  return 10 + size + ((flags & 0x10) !== 0 ? 10 : 0);
}

/**
 * MP3 duration.
 *
 * Three strategies in order of trustworthiness: the `Xing`/`Info` frame count a
 * VBR encoder writes, the `VBRI` count Fraunhofer's writes, and — for constant
 * bitrate, which is most of what a family shares — the arithmetic
 * `bytes / (bitrate / 8)`. Returns `null` when none of them applies, and `null`
 * is a rejection one layer up rather than a shrug: an unmeasurable duration is
 * an unenforceable limit.
 */
export async function probeMp3(source: ByteSource): Promise<number | null> {
  const head = await source.read(0, 10);
  const audioStart = id3Length(head);

  // Find the first frame sync. A tag we mis-sized, or junk before the audio, is
  // normal in the wild — scanning a window is what every decoder does too.
  const window = await source.read(audioStart, 8192);
  let frameOffset = -1;
  let frame: Mp3Frame | null = null;
  for (let i = 0; i + 4 <= window.length; i += 1) {
    const candidate = parseMp3Frame(window, i);
    if (candidate) {
      frameOffset = audioStart + i;
      frame = candidate;
      break;
    }
  }
  if (!frame || frameOffset < 0) return null;

  const frameBuf = await source.read(frameOffset, 200);

  // The VBR header lives after the side information, whose size depends on the
  // version and the channel mode.
  const sideInfo = frame.isMpeg1 ? (frame.isMono ? 17 : 32) : frame.isMono ? 9 : 17;
  const xingOffset = 4 + sideInfo;
  if (frameBuf.length >= xingOffset + 12) {
    const tag = frameBuf.toString('latin1', xingOffset, xingOffset + 4);
    if (tag === 'Xing' || tag === 'Info') {
      const flags = frameBuf.readUInt32BE(xingOffset + 4);
      if ((flags & 0x0001) !== 0) {
        const frames = frameBuf.readUInt32BE(xingOffset + 8);
        if (frames > 0) {
          return Math.round((frames * frame.samplesPerFrame * 1000) / frame.sampleRate);
        }
      }
    }
  }
  if (frameBuf.length >= 36 + 18 && frameBuf.toString('latin1', 36, 40) === 'VBRI') {
    const frames = frameBuf.readUInt32BE(36 + 14);
    if (frames > 0) {
      return Math.round((frames * frame.samplesPerFrame * 1000) / frame.sampleRate);
    }
  }

  const audioBytes = source.size - frameOffset;
  if (audioBytes <= 0) return null;
  return Math.round((audioBytes * 8) / frame.bitrateKbps);
}

/* -------------------------------------------------------------------------- */
/* The one entry point                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Turn a sniffed container plus the file itself into the row we are about to
 * store. Throws `UNSUPPORTED_MEDIA_TYPE` (with a Russian sentence) rather than
 * returning a half-known result — a stored row with no dimensions is a card
 * that reflows forever.
 */
export async function probeMedia(
  source: ByteSource,
  sniffed: SniffedContainer,
  head: Buffer,
): Promise<ProbedMedia> {
  const still = (contentType: AllowedMediaType, dimensions: Dimensions | null): ProbedMedia => {
    if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) unsupportedMedia('unknown');
    return {
      contentType,
      kind: 'image' satisfies MediaKind,
      width: dimensions.width,
      height: dimensions.height,
      durationMs: null,
    };
  };

  switch (sniffed.container) {
    case 'png':
      return still('image/png', pngDimensions(head));
    case 'gif':
      return still('image/gif', gifDimensions(head));
    case 'webp':
      return still('image/webp', webpDimensions(head));
    case 'jpeg':
      return still('image/jpeg', await jpegDimensions(source));
    case 'mp3': {
      return {
        contentType: 'audio/mpeg',
        kind: 'audio',
        width: null,
        height: null,
        durationMs: await probeMp3(source),
      };
    }
    case 'isobmff': {
      const info = await probeIsoBmff(source);
      // No `moov` at all means the file is truncated or is not really an
      // ISO-BMFF; either way there is nothing to enforce a limit against.
      if (!info) unsupportedMedia('unknown');

      const isQuickTime = sniffed.brands[0] === 'qt  ';
      if (info.hasVideo) {
        return {
          contentType: isQuickTime ? 'video/quicktime' : 'video/mp4',
          kind: 'video',
          width: info.width,
          height: info.height,
          durationMs: info.durationMs,
        };
      }
      if (info.hasAudio) {
        // An audio-only MP4 is an M4A whatever its brand says. Deciding this
        // from the tracks rather than the brand is what keeps a `.m4a` written
        // with brand `isom` from being served as a video that never draws.
        return {
          contentType: 'audio/mp4',
          kind: 'audio',
          width: null,
          height: null,
          durationMs: info.durationMs,
        };
      }
      // An ISO-BMFF file with neither a video nor an audio track is a HEIC
      // still, a subtitle container or something we have no business storing.
      return unsupportedMedia('unknown');
    }
  }
}
