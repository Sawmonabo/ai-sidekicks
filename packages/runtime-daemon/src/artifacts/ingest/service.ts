// Takes a caller's file into a session's artifacts as a stream: an opening that reserves the
// declared size, numbered chunks spooled to a file outside the content store, and a completion that
// runs the validation pipeline over the spool and writes the file's manifest and payload reference
// in one transaction, the manifest first.
//
// - Openings are admitted one at a time against the open-stream bound and the disk's free room,
//   read at each opening, less what the open streams have yet to send. Only an opening raises those
//   totals, so a release landing during one only makes it more careful.
// - Every call on one stream runs alone, so an original and its resend never interleave. A resend
//   of the last chunk is answered without appending it again, any other break in the sequence ends
//   the stream, and a resent completion answers the first one's result while the stream is held.
// - Exclusions are taken in one order: the stream, then the admission ledger, then the content
//   store's key. The reaper snapshots under the ledger, lets it go, then takes each stream's own.
// - The registry is in memory: a stream dies with the daemon, and its spool is reaped once
//   unwritten for long enough.

import { createHash, type Hash } from "node:crypto";
import { appendFile, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";

import type { Statement } from "better-sqlite3";

import type {
  AttachmentIngestChunkRequest,
  AttachmentIngestChunkResponse,
  AttachmentIngestCompleteResponse,
  AttachmentIngestInitRequest,
  AttachmentIngestInitResponse,
} from "@ai-sidekicks/contracts/artifacts/ingest";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { DeviceId } from "@ai-sidekicks/contracts/trust-statement";

import { withCleanupFailures } from "../../cleanup-failures.js";
import type { DatabaseConnections } from "../../database/connection/lifecycle.js";
import type { DatabaseWriter } from "../../database/writer.js";
import { isMissingFileError } from "../../file/missing-error.js";
import { KeyedLock } from "../../keyed-lock.js";
import { SESSION_EXISTS_SQL } from "../../session/directory/lookups.js";
import { sessionNotFound } from "../../session/not-found.js";
import { settleAll } from "../../settle-all.js";
import { mintUuidV7 } from "../../uuid-v7.js";
import { mintArtifactId } from "../id.js";
import { writePublishedManifest } from "../manifest-write.js";
import { formatContentHash } from "../payload-store.js";
import {
  ABANDONED_SPOOL_TTL_MS,
  MAX_ACTIVE_INGEST_STREAMS,
  MAX_INGEST_STREAM_LIFETIME_MS,
} from "./limits.js";
import {
  ArtifactTooLargeError,
  IngestCapacityExhaustedError,
  IngestStreamInvalidError,
} from "../refusals.js";
import { normalizeFileName, type IngestValidation } from "./validation.js";

// The one key of the admission ledger's exclusion.
const ADMISSION_LEDGER_KEY = "admission";

/** A stream taking chunks. */
interface OpenStream {
  readonly state: "open";
  readonly ingestId: string;
  readonly sessionId: SessionId;
  readonly runId: RunId | undefined;
  /** The caller's name, normalized: what the manifest keeps and a refusal names. */
  readonly fileName: string;
  readonly declaredSizeBytes: number;
  /** Wall-clock milliseconds at the opening. */
  readonly openedAt: number;
  readonly spoolPath: string;
  /** The SHA-256 of every byte appended so far. */
  readonly contentHash: Hash;
  nextSequenceNumber: number;
  receivedBytes: number;
  /** The SHA-256 of the last chunk appended, which a resend is compared against. */
  lastChunkDigest: string | undefined;
}

/** A stream whose completion committed, held only to answer a resent completion. */
interface CompletedStream {
  readonly state: "completed";
  readonly ingestId: string;
  readonly openedAt: number;
  readonly response: AttachmentIngestCompleteResponse;
}

type IngestStream = OpenStream | CompletedStream;

/** What the ingest service is built from. */
export interface AttachmentIngestServiceDeps {
  readonly database: DatabaseConnections;
  /** The pipeline a completion runs over the spool before anything is kept. */
  readonly validation: Pick<IngestValidation, "run">;
  /** Where the spools are written; on the content store's volume, outside the store. */
  readonly spoolDirectory: string;
  /** The free bytes on the volume holding a folder. */
  readonly readVolumeFreeBytes: (folderPath: string) => Promise<number>;
  /** Wall clock in milliseconds since the epoch; defaults to `Date.now`. */
  readonly now?: () => number;
}

/** The ingest streams of every session, and the reaper pass that ends the abandoned ones. */
export class AttachmentIngestService {
  readonly #writer: Pick<DatabaseWriter, "write">;
  readonly #selectSessionExists: Statement<{ sessionId: string }, unknown>;
  readonly #validation: Pick<IngestValidation, "run">;
  readonly #spoolDirectory: string;
  readonly #readVolumeFreeBytes: (folderPath: string) => Promise<number>;
  readonly #now: () => number;
  readonly #streams = new Map<string, IngestStream>();
  readonly #streamLock = new KeyedLock<string>();
  readonly #admissionLedger = new KeyedLock<string>();

  constructor(deps: AttachmentIngestServiceDeps) {
    this.#writer = deps.database.writer;
    this.#selectSessionExists = deps.database.reader.prepare(SESSION_EXISTS_SQL);
    this.#validation = deps.validation;
    this.#spoolDirectory = deps.spoolDirectory;
    this.#readVolumeFreeBytes = deps.readVolumeFreeBytes;
    this.#now = deps.now ?? Date.now;
  }

  /**
   * Opens a stream for one file, reserving its declared size. Rejects with `session.not_found`,
   * with `artifact.too_large` when the disk could not hold the declaration with no other stream
   * open, and with `artifact.ingest_capacity_exhausted` at the open-stream bound or when the disk
   * has no room for it beside the open streams; a refusal opens nothing.
   */
  async init(request: AttachmentIngestInitRequest): Promise<AttachmentIngestInitResponse> {
    if (this.#selectSessionExists.get({ sessionId: request.sessionId }) === undefined) {
      throw sessionNotFound(request.sessionId);
    }
    const fileName = normalizeFileName(request.fileName);
    return this.#admissionLedger.run(ADMISSION_LEDGER_KEY, async () => {
      await mkdir(this.#spoolDirectory, { recursive: true, mode: 0o700 });
      const availableBytes = await this.#readVolumeFreeBytes(this.#spoolDirectory);
      if (request.declaredSizeBytes > availableBytes) {
        throw new ArtifactTooLargeError(fileName, { availableBytes });
      }
      let openCount = 0;
      let reservedBytes = 0;
      for (const stream of this.#streams.values()) {
        if (stream.state === "open") {
          openCount += 1;
          reservedBytes += stream.declaredSizeBytes - stream.receivedBytes;
        }
      }
      if (
        openCount >= MAX_ACTIVE_INGEST_STREAMS ||
        request.declaredSizeBytes > availableBytes - reservedBytes
      ) {
        throw new IngestCapacityExhaustedError();
      }
      const ingestId = mintUuidV7();
      const spoolPath = path.join(this.#spoolDirectory, ingestId);
      await writeFile(spoolPath, new Uint8Array(), { flag: "wx", mode: 0o600 });
      this.#streams.set(ingestId, {
        state: "open",
        ingestId,
        sessionId: request.sessionId,
        runId: request.runId,
        fileName,
        declaredSizeBytes: request.declaredSizeBytes,
        openedAt: this.#now(),
        spoolPath,
        contentHash: createHash("sha256"),
        nextSequenceNumber: 0,
        receivedBytes: 0,
        lastChunkDigest: undefined,
      });
      return { ingestId };
    });
  }

  /**
   * Appends one chunk to its stream's spool and answers the stream's running total of bytes. A
   * resend of the last chunk is answered without appending it again. Rejects with
   * `artifact.ingest_stream_invalid` for a stream that is unknown, ended, completed or past its
   * lifetime, or for a chunk out of sequence, which ends the stream; and with `artifact.too_large`
   * for a chunk past the declared size, which ends it too.
   */
  async chunk(request: AttachmentIngestChunkRequest): Promise<AttachmentIngestChunkResponse> {
    const { ingestId } = request;
    return this.#streamLock.run(ingestId, async () => {
      const stream = await this.#heldStreamOf(ingestId);
      if (stream.state === "completed") {
        throw new IngestStreamInvalidError(ingestId, "already_completed");
      }
      const bytes = Buffer.from(request.chunk, "base64");
      const chunkDigest = createHash("sha256").update(bytes).digest("hex");
      const isResendOfLast =
        request.sequenceNumber === stream.nextSequenceNumber - 1 &&
        chunkDigest === stream.lastChunkDigest;
      if (isResendOfLast) {
        return { ingestId, receivedBytes: stream.receivedBytes };
      }
      if (request.sequenceNumber !== stream.nextSequenceNumber) {
        return this.#endWith(stream, new IngestStreamInvalidError(ingestId, "sequence_broken"));
      }
      if (stream.receivedBytes + bytes.length > stream.declaredSizeBytes) {
        return this.#endWith(
          stream,
          new ArtifactTooLargeError(stream.fileName, {
            declaredSizeBytes: stream.declaredSizeBytes,
          }),
        );
      }
      try {
        await appendFile(stream.spoolPath, bytes);
      } catch (error) {
        return this.#endWith(stream, error);
      }
      stream.contentHash.update(bytes);
      stream.receivedBytes += bytes.length;
      stream.nextSequenceNumber += 1;
      stream.lastChunkDigest = chunkDigest;
      return { ingestId, receivedBytes: stream.receivedBytes };
    });
  }

  /**
   * Completes a stream: runs the pipeline over its spool, then writes the file's manifest,
   * attributed to `createdBy`, and its payload reference. A resent completion answers the first
   * one's result while the stream is held. Rejects with `artifact.ingest_stream_invalid` for a
   * stream that is unknown, ended or past its lifetime, with `artifact.type_unreadable` for bytes
   * whose type could not be read, and with `session.not_found` once its session is gone; any
   * failure ends the stream.
   */
  async complete(ingestId: string, createdBy: DeviceId): Promise<AttachmentIngestCompleteResponse> {
    return this.#streamLock.run(ingestId, async () => {
      const stream = await this.#heldStreamOf(ingestId);
      if (stream.state === "completed") {
        return stream.response;
      }
      const contentHash = formatContentHash(stream.contentHash.digest("hex"));
      const artifactId = mintArtifactId();
      let derivedMediaType: string;
      try {
        ({ derivedMediaType } = await this.#validation.run(
          { spoolPath: stream.spoolPath, contentHash, fileName: stream.fileName },
          (mediaType) =>
            writePublishedManifest(this.#writer, {
              artifactId,
              sessionId: stream.sessionId,
              runId: stream.runId,
              createdBy,
              artifactType: "file",
              contentHash,
              sizeBytes: stream.receivedBytes,
              mediaType,
              metadata: { fileName: stream.fileName },
              createdAt: new Date(this.#now()).toISOString(),
            }),
        ));
      } catch (error) {
        return this.#endWith(stream, error);
      }
      const response: AttachmentIngestCompleteResponse = {
        artifactId,
        contentHash,
        normalizedName: stream.fileName,
        derivedMediaType,
        derivedSizeBytes: stream.receivedBytes,
      };
      this.#streams.set(ingestId, {
        state: "completed",
        ingestId,
        openedAt: stream.openedAt,
        response,
      });
      return response;
    });
  }

  /**
   * One pass of the reaper: ends every stream past its lifetime, open or completed, releasing what
   * it held, and deletes every spool no stream holds that has gone unwritten past its time to live.
   * Throws the one failure, or every failure together, once the rest are done.
   */
  async reap(): Promise<void> {
    const expiredIds = await this.#admissionLedger.run(ADMISSION_LEDGER_KEY, () =>
      Promise.resolve(
        [...this.#streams.values()]
          .filter((stream) => this.#isPastLifetime(stream))
          .map((stream) => stream.ingestId),
      ),
    );
    await settleAll(
      [
        ...expiredIds.map((ingestId) =>
          this.#streamLock.run(ingestId, async () => {
            // A call holding the stream may have ended it while this pass waited.
            const stream = this.#streams.get(ingestId);
            if (stream !== undefined && this.#isPastLifetime(stream)) {
              await this.#end(stream);
            }
          }),
        ),
        this.#reapAbandonedSpools(),
      ],
      "reaping the ingest streams",
    );
  }

  // The stream `ingestId` names, ending it first when it is past its lifetime.
  async #heldStreamOf(ingestId: string): Promise<IngestStream> {
    const stream = this.#streams.get(ingestId);
    if (stream === undefined) {
      throw new IngestStreamInvalidError(ingestId, "unknown_stream");
    }
    if (this.#isPastLifetime(stream)) {
      return this.#endWith(stream, new IngestStreamInvalidError(ingestId, "lifetime_expired"));
    }
    return stream;
  }

  #isPastLifetime(stream: IngestStream): boolean {
    return this.#now() - stream.openedAt > MAX_INGEST_STREAM_LIFETIME_MS;
  }

  // Ends `stream`, then throws `refusal`, any failure deleting its spool attached to its cause.
  async #endWith(stream: IngestStream, refusal: unknown): Promise<never> {
    const cleanupFailures: unknown[] = [];
    await this.#end(stream).catch((failure: unknown) => cleanupFailures.push(failure));
    throw withCleanupFailures(refusal, cleanupFailures, "ending the ingest stream");
  }

  // Forgets the stream, which releases its slot and reservation, and deletes its spool.
  async #end(stream: IngestStream): Promise<void> {
    this.#streams.delete(stream.ingestId);
    if (stream.state === "open") {
      await rm(stream.spoolPath, { force: true });
    }
  }

  async #reapAbandonedSpools(): Promise<void> {
    let spoolNames: string[];
    try {
      spoolNames = await readdir(this.#spoolDirectory);
    } catch (error) {
      if (isMissingFileError(error)) {
        return;
      }
      throw error;
    }
    const reapBefore = this.#now() - ABANDONED_SPOOL_TTL_MS;
    await settleAll(
      spoolNames
        .filter((spoolName) => !this.#streams.has(spoolName))
        .map(async (spoolName) => {
          const spoolPath = path.join(this.#spoolDirectory, spoolName);
          try {
            if ((await stat(spoolPath)).mtimeMs < reapBefore) {
              await rm(spoolPath, { force: true });
            }
          } catch (error) {
            // Ended by its stream while this pass looked.
            if (!isMissingFileError(error)) {
              throw error;
            }
          }
        }),
      "reaping the abandoned spools",
    );
  }
}
