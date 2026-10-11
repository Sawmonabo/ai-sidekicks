// Takes a caller's file into a session's artifacts as a stream: an opening that reserves the
// declared size, numbered chunks spooled to a file outside the content store, and a completion that
// runs the validation pipeline over the spool and writes the file's manifest and payload reference
// in one transaction, the manifest first.
//
// - Openings pass the uploads' one admission, which client publishes share: the bound on open
//   uploads and the disk's free room, read at each opening, less what the open uploads have yet to
//   write. A stream gives its place back when it ends or its completion commits.
// - Every call on one stream runs alone, so an original and its resend never interleave. A resend
//   of the last chunk is answered without appending it again, any other break in the sequence ends
//   the stream, and a resent completion answers the first one's saved result while it is held.
// - A completion whose type check could not run to an answer leaves the stream open with its
//   spool, so the same completion is sent again; every other failure ends the stream.
// - Exclusions are taken in one order: the stream, then the admission ledger, then the content
//   store's key. The reaper snapshots under the ledger, lets it go, then takes each stream's own.
// - The registry is in memory and bounded: the open streams by the admission, the completed ones
//   by their lifetime and a count, past which the oldest is let go. A stream dies with the daemon,
//   and its spool is reaped once unwritten for long enough.

import { createHash, type Hash } from "node:crypto";
import { appendFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";

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
import { settleAll } from "../../settle-all.js";
import { mintUuidV7 } from "../../uuid-v7.js";
import type { AdmittedUpload, UploadAdmission } from "../admission.js";
import { mintArtifactId } from "../id.js";
import {
  prepareArtifactOwnerCheck,
  writePublishedManifest,
  type ArtifactOwnerCheck,
} from "../manifest-write.js";
import { formatContentHash } from "../payload-store.js";
import {
  ABANDONED_SPOOL_TTL_MS,
  MAX_HELD_COMPLETIONS,
  MAX_INGEST_STREAM_LIFETIME_MS,
} from "./limits.js";
import {
  ArtifactTooLargeError,
  ArtifactTypeCheckUnavailableError,
  IngestStreamInvalidError,
} from "../refusals.js";
import { normalizeFileName, type IngestValidation } from "../validation.js";

/** A stream taking chunks. */
interface OpenStream {
  readonly state: "open";
  readonly ingestId: string;
  readonly sessionId: SessionId;
  readonly runId: RunId | undefined;
  /** The caller's name, normalized: what the manifest keeps and a refusal names. */
  readonly fileName: string;
  /** The type the caller declared, kept only for UTF-8 text whose signature names no type. */
  readonly declaredMediaType: string | undefined;
  readonly declaredSizeBytes: number;
  /** The stream's place among the open uploads and the room it has yet to write. */
  readonly upload: AdmittedUpload;
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
  /** The digest the completion committed, which its saved result must still name. */
  readonly committedContentHash: string;
}

type IngestStream = OpenStream | CompletedStream;

/** What the ingest service is built from. */
export interface AttachmentIngestServiceDeps {
  readonly database: DatabaseConnections;
  /** The pipeline a completion runs over the spool before anything is kept. */
  readonly validation: Pick<IngestValidation, "run">;
  /** The admission an opening passes, shared with client publishes. */
  readonly admission: Pick<UploadAdmission, "admit" | "release" | "whileNoneAdmits">;
  /** Where the spools are written; on the content store's volume, outside the store. */
  readonly spoolDirectory: string;
  /** Wall clock in milliseconds since the epoch; defaults to `Date.now`. */
  readonly now?: () => number;
}

/** The ingest streams of every session, and the reaper pass that ends the abandoned ones. */
export class AttachmentIngestService {
  readonly #writer: Pick<DatabaseWriter, "write">;
  readonly #checkOwner: ArtifactOwnerCheck;
  readonly #validation: Pick<IngestValidation, "run">;
  readonly #admission: Pick<UploadAdmission, "admit" | "release" | "whileNoneAdmits">;
  readonly #spoolDirectory: string;
  readonly #now: () => number;
  readonly #streams = new Map<string, IngestStream>();
  readonly #streamLock = new KeyedLock<string>();
  /** The completed streams' ids, oldest first, so the oldest is let go past the count. */
  readonly #completedIds: string[] = [];

  constructor(deps: AttachmentIngestServiceDeps) {
    this.#writer = deps.database.writer;
    this.#checkOwner = prepareArtifactOwnerCheck(deps.database.reader);
    this.#validation = deps.validation;
    this.#admission = deps.admission;
    this.#spoolDirectory = deps.spoolDirectory;
    this.#now = deps.now ?? Date.now;
  }

  /**
   * Opens a stream for one file, reserving its declared size. Rejects with `session.not_found`,
   * with `run.not_found` for a run that is not the session's, and with the admission's refusals,
   * `artifact.too_large` and `artifact.ingest_capacity_exhausted`; a refusal opens nothing.
   */
  async init(request: AttachmentIngestInitRequest): Promise<AttachmentIngestInitResponse> {
    this.#checkOwner(request.sessionId, request.runId);
    const fileName = normalizeFileName(request.fileName);
    const upload = await this.#admission.admit(request.declaredSizeBytes, fileName);
    const ingestId = mintUuidV7();
    const spoolPath = path.join(this.#spoolDirectory, ingestId);
    try {
      await writeFile(spoolPath, new Uint8Array(), { flag: "wx", mode: 0o600 });
    } catch (error) {
      this.#admission.release(upload);
      throw error;
    }
    this.#streams.set(ingestId, {
      state: "open",
      ingestId,
      sessionId: request.sessionId,
      runId: request.runId,
      fileName,
      declaredMediaType: request.mediaType,
      declaredSizeBytes: request.declaredSizeBytes,
      upload,
      openedAt: this.#now(),
      spoolPath,
      contentHash: createHash("sha256"),
      nextSequenceNumber: 0,
      receivedBytes: 0,
      lastChunkDigest: undefined,
    });
    return { ingestId };
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
      stream.upload.remainingBytes = stream.declaredSizeBytes - stream.receivedBytes;
      stream.nextSequenceNumber += 1;
      stream.lastChunkDigest = chunkDigest;
      return { ingestId, receivedBytes: stream.receivedBytes };
    });
  }

  /**
   * Completes a stream: runs the pipeline over its spool, then writes the file's manifest,
   * attributed to `createdBy`, and its payload reference. A resent completion answers the first
   * one's saved result while it is held. Rejects with `artifact.ingest_stream_invalid` for a
   * stream that is unknown, ended or past its lifetime, with `artifact.type_unreadable` for bytes
   * the detector refused, with `session.not_found` once its session is gone and `run.not_found`
   * for a run that is not the session's; each of these ends the stream. Rejects with
   * `artifact.type_check_unavailable` when the type check could not run to an answer, leaving the
   * stream open for the same completion again.
   */
  async complete(ingestId: string, createdBy: DeviceId): Promise<AttachmentIngestCompleteResponse> {
    return this.#streamLock.run(ingestId, async () => {
      const stream = await this.#heldStreamOf(ingestId);
      if (stream.state === "completed") {
        if (stream.response.contentHash !== stream.committedContentHash) {
          return this.#endWith(
            stream,
            new IngestStreamInvalidError(ingestId, "completion_record_mismatch"),
          );
        }
        return stream.response;
      }
      // A copy, so a completion sent again after a type check that could not run digests anew.
      const contentHash = formatContentHash(stream.contentHash.copy().digest("hex"));
      const artifactId = mintArtifactId();
      let derivedMediaType: string;
      try {
        ({ derivedMediaType } = await this.#validation.run(
          {
            spoolPath: stream.spoolPath,
            contentHash,
            fileName: stream.fileName,
            declaredMediaType: stream.declaredMediaType,
          },
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
        if (error instanceof ArtifactTypeCheckUnavailableError) {
          throw error;
        }
        return this.#endWith(stream, error);
      }
      const response: AttachmentIngestCompleteResponse = {
        artifactId,
        contentHash,
        normalizedName: stream.fileName,
        derivedMediaType,
        derivedSizeBytes: stream.receivedBytes,
      };
      this.#admission.release(stream.upload);
      this.#streams.set(ingestId, {
        state: "completed",
        ingestId,
        openedAt: stream.openedAt,
        response,
        committedContentHash: contentHash,
      });
      this.#holdCompleted(ingestId);
      return response;
    });
  }

  /**
   * One pass of the reaper: ends every stream past its lifetime, open or completed, releasing what
   * it held, and deletes every spool no stream holds that has gone unwritten past its time to live.
   * Throws the one failure, or every failure together, once the rest are done.
   */
  async reap(): Promise<void> {
    const expiredIds = await this.#admission.whileNoneAdmits(() =>
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

  // Forgets the stream, which releases its place and reservation, and deletes its spool.
  async #end(stream: IngestStream): Promise<void> {
    this.#streams.delete(stream.ingestId);
    if (stream.state === "open") {
      this.#admission.release(stream.upload);
      await rm(stream.spoolPath, { force: true });
    }
  }

  // Notes a completed stream, letting the oldest completed one go past the count held.
  #holdCompleted(ingestId: string): void {
    this.#completedIds.push(ingestId);
    if (this.#completedIds.length <= MAX_HELD_COMPLETIONS) {
      return;
    }
    const oldestId = this.#completedIds.shift();
    // Gone already when the reaper or a call ended it; never an open stream, whose id is fresh.
    if (oldestId !== undefined && this.#streams.get(oldestId)?.state === "completed") {
      this.#streams.delete(oldestId);
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
