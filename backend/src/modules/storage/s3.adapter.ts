import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ServiceException,
} from '@aws-sdk/client-s3';
import type { Readable } from 'node:stream';

import { getConfig } from '../../core/config.js';
import { AppError } from '../../core/errors.js';

/**
 * The S3 seam. Everything that knows the word "bucket" lives here.
 *
 * The target is RustFS (Apache-2.0, S3-compatible) on the internal network, but
 * nothing below is RustFS-specific — the same code talks to MinIO, Garage or
 * real S3. Two settings make that true:
 *
 * - **`forcePathStyle: true`.** Virtual-hosted style puts the bucket in the
 *   hostname (`family-media.rustfs:9000`), which resolves in exactly one
 *   deployment on earth: AWS. Every self-hosted implementation needs path
 *   style, and the failure without it is a DNS error rather than an S3 error,
 *   which sends you looking in the wrong place for an hour.
 * - **Explicit static credentials.** Without them the SDK's default provider
 *   chain runs, which on a container with no credentials means a 1-second
 *   stall on the EC2 instance-metadata endpoint before every single request.
 *
 * Storage is optional. `getStorage()` returns `null` when it is unconfigured so
 * callers can answer 503 instead of the process refusing to boot — a family
 * that has not set up avatars should still get their calendar.
 */

/** What a conditional request needs, without transferring the bytes. */
export interface ObjectMetadata {
  readonly contentType: string;
  readonly contentLength: number | undefined;
  /** The S3 ETag, quotes included, ready to put straight on the response. */
  readonly etag: string | undefined;
}

export interface StoredObject extends ObjectMetadata {
  readonly body: Readable;
  /**
   * `bytes <start>-<end>/<total>` when this was a ranged read, `undefined`
   * otherwise. The serving route copies it straight onto a `206`.
   */
  readonly contentRange: string | undefined;
}

/** Raised when a `Range` header names bytes the object does not have. */
export class RangeNotSatisfiableError extends Error {
  constructor() {
    super('Requested range is not satisfiable');
    this.name = 'RangeNotSatisfiableError';
  }
}

export interface Storage {
  readonly bucket: string;
  ensureBucket(): Promise<void>;
  put(input: {
    key: string;
    body: Uint8Array;
    contentType: string;
    cacheControl?: string;
  }): Promise<{ etag: string | undefined }>;
  /**
   * Same as `put`, but from a stream whose length is already known.
   *
   * This is the video path, and it exists because `put` takes a `Uint8Array`:
   * buffering a 100 MB upload to hand it over would put 100 MB per concurrent
   * upload on a VDI that also runs Postgres, Redis and the object store. The
   * upload spools to a temp file instead and this streams it out of there.
   *
   * `contentLength` is **required** rather than optional on purpose: without it
   * the SDK falls back to `aws-chunked` streaming, which several S3 clones
   * handle badly — the same reason `put` sends the length explicitly.
   */
  putStream(input: {
    key: string;
    body: Readable;
    contentLength: number;
    contentType: string;
    cacheControl?: string;
  }): Promise<{ etag: string | undefined }>;
  /** Metadata only, for `If-None-Match` — a 304 must not pull the body. */
  head(key: string): Promise<ObjectMetadata | null>;
  /**
   * `null` when the key does not exist — a missing object is not an error here.
   *
   * `range` is passed through verbatim (`bytes=0-1`, `bytes=1000-`), because
   * the store already implements RFC 9110 ranges correctly and re-deriving the
   * arithmetic here would be a second implementation to keep right. An
   * unsatisfiable range raises {@link RangeNotSatisfiableError}.
   */
  get(key: string, options?: { range?: string | undefined }): Promise<StoredObject | null>;
  /** Idempotent: deleting a key that is already gone succeeds. */
  remove(key: string): Promise<void>;
  /** Test seam — drops the memoized `ensureBucket` result. */
  reset(): void;
}

function statusOf(error: unknown): number | undefined {
  return (error as S3ServiceException | undefined)?.$metadata?.httpStatusCode;
}

function nameOf(error: unknown): string | undefined {
  return (error as { name?: string } | undefined)?.name;
}

/** A 404 from S3 for a `Head*`/`Get*` — the object or bucket simply is not there. */
function isNotFound(error: unknown): boolean {
  const name = nameOf(error);
  return (
    statusOf(error) === 404 ||
    name === 'NotFound' ||
    name === 'NoSuchKey' ||
    name === 'NoSuchBucket'
  );
}

/** A 416 from the store: the `Range` header named bytes the object does not have. */
function isRangeNotSatisfiable(error: unknown): boolean {
  return statusOf(error) === 416 || nameOf(error) === 'InvalidRange';
}

/**
 * The two errors AWS raises when the bucket already exists.
 *
 * RustFS 1.0.0-rc.2 raises neither — a repeated `CreateBucket` simply succeeds —
 * but the check stays, because this adapter is not allowed to be RustFS-only
 * and a 409 here would otherwise take the whole boot down.
 */
function isBucketAlreadyMine(error: unknown): boolean {
  const name = nameOf(error);
  return name === 'BucketAlreadyOwnedByYou' || name === 'BucketAlreadyExists';
}

class S3Storage implements Storage {
  readonly bucket: string;
  private readonly client: S3Client;
  /** Memoized so N concurrent uploads produce one `CreateBucket`, not N. */
  private bucketReady: Promise<void> | undefined;

  constructor(config: {
    endpoint: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucket: string;
    forcePathStyle: boolean;
  }) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      maxAttempts: 3,
    });
  }

  ensureBucket(): Promise<void> {
    this.bucketReady ??= this.createBucketIfAbsent().catch((error: unknown) => {
      // Do not cache the failure: a bucket that could not be created because
      // RustFS was still starting must be retried on the next upload, not
      // remembered as permanently broken until the next deploy.
      this.bucketReady = undefined;
      throw error;
    });
    return this.bucketReady;
  }

  private async createBucketIfAbsent(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return;
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }

    try {
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    } catch (error) {
      // Two backends racing to create the same bucket is the normal case on a
      // rolling restart, not a failure.
      if (!isBucketAlreadyMine(error)) throw error;
    }
  }

  async put(input: {
    key: string;
    body: Uint8Array;
    contentType: string;
    cacheControl?: string;
  }): Promise<{ etag: string | undefined }> {
    await this.ensureBucket();
    const result = await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        Body: input.body,
        // Sending the length explicitly keeps the SDK from switching to
        // `aws-chunked` streaming, which several S3 clones handle badly.
        ContentLength: input.body.byteLength,
        ContentType: input.contentType,
        ...(input.cacheControl ? { CacheControl: input.cacheControl } : {}),
      }),
    );
    return { etag: result.ETag };
  }

  async putStream(input: {
    key: string;
    body: Readable;
    contentLength: number;
    contentType: string;
    cacheControl?: string;
  }): Promise<{ etag: string | undefined }> {
    await this.ensureBucket();
    const result = await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        Body: input.body,
        ContentLength: input.contentLength,
        ContentType: input.contentType,
        ...(input.cacheControl ? { CacheControl: input.cacheControl } : {}),
      }),
    );
    return { etag: result.ETag };
  }

  async head(key: string): Promise<ObjectMetadata | null> {
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        contentType: result.ContentType ?? 'application/octet-stream',
        contentLength: result.ContentLength,
        etag: result.ETag,
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async get(
    key: string,
    options: { range?: string | undefined } = {},
  ): Promise<StoredObject | null> {
    let result;
    try {
      result = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
          ...(options.range ? { Range: options.range } : {}),
        }),
      );
    } catch (error) {
      if (isRangeNotSatisfiable(error)) throw new RangeNotSatisfiableError();
      if (isNotFound(error)) return null;
      throw error;
    }

    if (!result.Body) return null;
    return {
      // In Node the SDK's `Body` is always a `Readable`; the union in the type
      // covers the browser build, which this process is not.
      body: result.Body as Readable,
      /**
       * Falls back to `application/octet-stream`, never to the caller's guess.
       * An object whose stored type went missing must not become whatever the
       * request would like it to be.
       */
      contentType: result.ContentType ?? 'application/octet-stream',
      contentLength: result.ContentLength,
      etag: result.ETag,
      contentRange: result.ContentRange,
    };
  }

  async remove(key: string): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (error) {
      // S3 `DeleteObject` is already idempotent; this only covers a backend
      // that decides to 404 a missing key.
      if (!isNotFound(error)) throw error;
    }
  }

  reset(): void {
    this.bucketReady = undefined;
  }
}

let cached: Storage | null | undefined;

/**
 * The process-wide storage handle, or `null` when `config.storage.enabled` is
 * false. Lazily built so `loadConfig()` is not forced at import time.
 */
export function getStorage(): Storage | null {
  if (cached === undefined) {
    const { storage } = getConfig();
    cached = storage.enabled ? new S3Storage(storage) : null;
  }
  return cached;
}

/** Same, but throws the 503 every write path wants. */
export function requireStorage(): Storage {
  const storage = getStorage();
  if (!storage) {
    throw new AppError(
      'SERVICE_UNAVAILABLE',
      'Object storage is not configured (set S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_BUCKET)',
    );
  }
  return storage;
}

/** Test helper — drops the memoized client so a new config takes effect. */
export function resetStorageForTests(): void {
  cached = undefined;
}
