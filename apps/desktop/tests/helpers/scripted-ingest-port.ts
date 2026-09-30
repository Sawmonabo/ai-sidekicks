// The collaborator every ingest case drives the client against, and the sources it is
// driven with.
//
// A module rather than a copy inside each sibling case file, because four files ask four
// different questions of ONE script — the open path, the chunk loop, retry, and
// abandonment — and a port written out four times would drift the first time a registered
// request member moved, leaving three files asserting a shape the client no longer sends.
//
// IT RECORDS RATHER THAN ASSERTS, and it can be HELD. Only a collaborator on the other
// side of the seam can witness that a retry re-sent one sequence number carrying identical
// bytes, and only one that can be stopped mid-call can put an abandonment inside an await.
// So the port keeps every request it was handed and each case asks its own question of the
// recording.
//
// THE RECORDED SHAPES ARE DERIVED FROM THE PORT, never transcribed from what the client
// happens to send: `AttachmentIngestPort` declares each request, so a request that dropped
// a member or invented one fails to compile here rather than passing under a recorder that
// had been updated to match it.
//
// AND IT IS TEST SUPPORT BY NAME. A recorder that answers every ingest call with a
// scripted reply is reachable from a rendering path only as a port that lies, so the
// `.test-support.ts` suffix is what keeps that unreachable rather than a header asking
// a reader not to.

import type { ArtifactId, SessionId } from "@ai-sidekicks/contracts";

import { manualGate } from "./held-calls.js";
import type { ChunkAcknowledgement } from "@renderer/features/composer/attachments/services/attachment-ingest-acknowledgement.js";
import type { AttachmentIngestPort } from "@renderer/features/composer/attachments/services/attachment-ingest-answer.js";
import { AttachmentIngestClient } from "@renderer/features/composer/attachments/attachment-ingest-client.js";
import {
  attachmentSourceFrom,
  type AttachmentSource,
} from "@renderer/features/composer/attachments/attachment-shapes.js";

/** The session every case attaches into. */
export const INGEST_SESSION_ID = "11111111-1111-4111-8111-111111111111" as SessionId;

/** One recorded `AttachmentIngestInit`, exactly as the port declares it. */
export type RecordedInit = Parameters<AttachmentIngestPort["begin"]>[0];

/** One recorded `AttachmentIngestChunk`, exactly as the port declares it. */
export type RecordedChunk = Parameters<AttachmentIngestPort["writeChunk"]>[0];

/**
 * An ingest port that answers what the case tells it to.
 *
 * A class with private fields, matching the tree's rule, and it records rather than
 * asserts: a recorder lets each case ask its own question of the same script.
 */
export class ScriptedIngestPort {
  readonly initCalls: RecordedInit[] = [];
  readonly chunkCalls: RecordedChunk[] = [];
  readonly abortedIngestIds: string[] = [];
  /**
   * The next stream identity this port hands out.
   *
   * ONE ID PER OPENED STREAM, because a port that answered every `begin` with one id
   * could not witness a per-stream act at all: two attachments open, one abort
   * recorded, and no case could say which spool it was for. The first id is
   * `ingest-1`, so a case attaching one file reads that id.
   */
  #nextIngestNumber = 1;
  #beginGate: Promise<void> | undefined;
  #chunkGate: Promise<void> | undefined;
  /**
   * The decoded bytes this port has appended, per stream and per sequence number.
   *
   * A REAL RUNNING TOTAL, because that is what the registered
   * `AttachmentIngestChunkResponse` carries and the client advances its ledger from:
   * a port that answered a constant would let a client that ignored the reply pass every
   * case here. The decoded length comes from the platform's own base64 decoder rather
   * than from arithmetic over the encoded string, so nothing in this file is a second
   * implementation of the encoding the client uses.
   *
   * KEYED BY SEQUENCE NUMBER, so the total is idempotent under the replay the contract
   * makes safe: a chunk resent after a lost response is acknowledged without being
   * appended twice, which a running sum over calls would report as double the bytes.
   */
  readonly #spooledBytesByIngestId = new Map<string, Map<number, number>>();
  #chunkAcknowledgementOverride: ChunkAcknowledgement | undefined;

  /**
   * Answer every later chunk with this acknowledgement instead of the true one.
   *
   * The two answers a client must not accept — a reply naming another stream, and a total
   * that did not advance — are shapes a truthful port never sends, so a case that could
   * not script one would be asserting the check by reading it. Passing `undefined` goes
   * back to the truthful answer.
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
 * The declared media type is optional here for the same reason it is optional on the
 * request: a user's file carries one or it does not, and the cases that turn on
 * the difference need both arms buildable.
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
 * A `Blob` off a picker is a HANDLE on a file the host still owns, so a user who moves or
 * deletes that file between two chunks gets a rejecting `arrayBuffer()` where every
 * earlier read succeeded. No real `Blob` can be put in that state from a test, so the
 * payload is scripted here, beside the sources every other case is driven with.
 *
 * With `moveAfterReads`, the file moves once that many reads have succeeded, which is how
 * a case loses the file between two chunks of one upload.
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
