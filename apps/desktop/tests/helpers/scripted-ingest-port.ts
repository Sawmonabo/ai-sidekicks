// The dependency every ingest case drives the client against, and the sources it is driven with.
//
// A shared module because more than one case file asks questions of one script (open path, chunk
// loop, retry, abandonment), and copies would drift when a request member moved. The port
// records rather than asserts, and can be held: only a dependency across the seam can see
// that a retry re-sent one sequence number with identical bytes, and only one that can be stopped
// mid-call can put an abandonment inside an await. The recorded shapes are derived from
// `AttachmentIngestPort`, so a request that drops or invents a member fails to compile here.

import type { ArtifactId } from "@ai-sidekicks/contracts/artifacts/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { manualGate } from "./held-calls.js";
import type { ChunkAcknowledgement } from "#renderer/features/composer/attachments/services/ingest-acknowledgement.js";
import type { AttachmentIngestPort } from "#renderer/features/composer/attachments/services/ingest-port.js";
import { AttachmentIngestClient } from "#renderer/features/composer/attachments/ingest-client.js";
import {
  attachmentSourceFrom,
  type AttachmentSource,
} from "#renderer/features/composer/attachments/shapes.js";

/** The session every case attaches into. */
export const INGEST_SESSION_ID = "11111111-1111-4111-8111-111111111111" as SessionId;

/** One recorded `AttachmentIngestInit`, exactly as the port declares it. */
export type RecordedInit = Parameters<AttachmentIngestPort["begin"]>[0];

/** One recorded `AttachmentIngestChunk`, exactly as the port declares it. */
export type RecordedChunk = Parameters<AttachmentIngestPort["writeChunk"]>[0];

/**
 * An ingest port that answers what the case tells it to, recording every request it is handed.
 */
export class ScriptedIngestPort {
  readonly initCalls: RecordedInit[] = [];
  readonly chunkCalls: RecordedChunk[] = [];
  readonly abortedIngestIds: string[] = [];
  /**
   * The next stream identity this port hands out: `ingest-1` first.
   *
   * One id per opened stream, since a port answering every `begin` with one id could not say which
   * spool an abort was for.
   */
  #nextIngestNumber = 1;
  #beginGate: Promise<void> | undefined;
  #chunkGate: Promise<void> | undefined;
  /**
   * The decoded bytes this port has appended, per stream and per sequence number.
   *
   * A real running total, because the registered `AttachmentIngestChunkResponse` carries it and the
   * client advances its own running total from it; a constant would let a client that ignored the
   * reply pass. The length comes from the platform's base64 decoder rather than arithmetic over the
   * encoded string. Keyed by sequence number so the total is idempotent under the resend the
   * contract makes safe: a chunk resent after a lost response is not appended twice.
   */
  readonly #spooledBytesByIngestId = new Map<string, Map<number, number>>();
  #chunkAcknowledgementOverride: ChunkAcknowledgement | undefined;

  /**
   * Answer every later chunk with this acknowledgement instead of the true one.
   *
   * A reply naming another stream, or a total that did not advance, is a shape a truthful port
   * never sends, so a case must script one to exercise the client's check. `undefined` restores
   * the truthful answer.
   */
  public acknowledgeChunksWith(acknowledgement: ChunkAcknowledgement | undefined): void {
    this.#chunkAcknowledgementOverride = acknowledgement;
  }

  /** Hold the next `begin` until the returned gate is opened; later calls run free. */
  public holdBegin(): { readonly open: () => void } {
    const gate = manualGate();
    this.#beginGate = gate.promise;
    return gate;
  }

  /** Hold the next chunk until the returned gate is opened; later calls run free. */
  public holdChunks(): { readonly open: () => void } {
    const gate = manualGate();
    this.#chunkGate = gate.promise;
    return gate;
  }

  /** The port a client is handed, answering what the case scripted. */
  public asPort(): AttachmentIngestPort {
    return {
      begin: async (request: RecordedInit) => {
        this.initCalls.push(request);
        const ingestId = `ingest-${String(this.#nextIngestNumber)}`;
        this.#nextIngestNumber += 1;
        await this.#beginGate;
        return { ingestId };
      },
      writeChunk: async (request: RecordedChunk) => {
        this.chunkCalls.push(request);
        await this.#chunkGate;
        return (
          this.#chunkAcknowledgementOverride ?? {
            ingestId: request.ingestId,
            receivedBytes: this.#append(request),
          }
        );
      },
      complete: async () => ({
        artifactId: "artifact-9" as ArtifactId,
        fileName: "notes-1.md",
        mimeType: "text/markdown",
        sizeBytes: 300,
      }),
      abort: async (request: { readonly ingestId: string }) => {
        this.abortedIngestIds.push(request.ingestId);
      },
    };
  }

  /** Append one chunk's decoded bytes and answer the stream's running total. */
  #append(request: RecordedChunk): number {
    const appendedBySequenceNumber =
      this.#spooledBytesByIngestId.get(request.ingestId) ?? new Map<number, number>();
    appendedBySequenceNumber.set(request.sequenceNumber, globalThis.atob(request.chunk).length);
    this.#spooledBytesByIngestId.set(request.ingestId, appendedBySequenceNumber);
    let spooledBytes = 0;
    for (const appended of appendedBySequenceNumber.values()) {
      spooledBytes += appended;
    }
    return spooledBytes;
  }
}

/** Bytes that differ at every position, so a concatenation check can actually fail. */
export function patternedBytes(byteLength: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(byteLength);
  for (let index = 0; index < byteLength; index += 1) {
    bytes[index] = (index * 7 + 13) % 251;
  }
  return bytes;
}

/** One client over one scripted port, on the session every case names. */
export function clientOver(port: ScriptedIngestPort): AttachmentIngestClient {
  return new AttachmentIngestClient({ port: port.asPort(), sessionId: INGEST_SESSION_ID });
}

/**
 * One source over bytes the case can recognize on the other side of the wire.
 *
 * The declared media type is optional because a user's file carries one or it does not.
 */
export function sourceOver(
  localId: string,
  declaredName: string,
  byteLength: number,
  declaredMediaType?: string,
): AttachmentSource {
  return attachmentSourceFrom({
    localId,
    declaredName,
    payload: new Blob([patternedBytes(byteLength)]),
    declaredMediaType,
  });
}

/** The attachment most cases attach: small enough to fit one chunk, declaring nothing. */
export const SMALL_SOURCE: AttachmentSource = sourceOver("attachment-1", "notes.md", 300);

/** A source over bytes a case can make unreadable and readable again, like a moved file. */
export interface MovableSource {
  readonly source: AttachmentSource;
  /** From now on every read of the payload rejects. */
  readonly moveFile: () => void;
  /** From now on reads answer the real bytes again. */
  readonly restoreFile: () => void;
}

/**
 * One source whose bytes the browser can stop handing over.
 *
 * A picker's `Blob` is a handle on a file the host still owns, so moving or deleting it between
 * two chunks makes `arrayBuffer()` reject after earlier reads succeeded. No real `Blob` can be put
 * in that state, so the payload is scripted. With `moveAfterReads`, the file moves once that many
 * reads have succeeded.
 */
export function movableSourceOver(
  localId: string,
  declaredName: string,
  byteLength: number,
  moveAfterReads?: number,
): MovableSource {
  const bytes = new Blob([patternedBytes(byteLength)]);
  let moved = false;
  let readsBeforeMove = moveAfterReads ?? Number.POSITIVE_INFINITY;
  const payload = {
    size: byteLength,
    slice: (start?: number, end?: number): unknown => {
      const real = bytes.slice(start, end);
      return {
        arrayBuffer: async (): Promise<ArrayBuffer> => {
          if (moved || readsBeforeMove <= 0) {
            await Promise.resolve();
            throw new Error("the file behind this blob is gone");
          }
          readsBeforeMove -= 1;
          return real.arrayBuffer();
        },
      };
    },
  } as unknown as Blob;
  return {
    source: attachmentSourceFrom({ localId, declaredName, payload }),
    moveFile: () => {
      moved = true;
    },
    restoreFile: () => {
      moved = false;
      readsBeforeMove = Number.POSITIVE_INFINITY;
    },
  };
}
