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
// THE RECORDED SHAPES ARE DERIVED FROM THE REGISTRY, never transcribed from what the
// client happens to send: `GrowthPort` is the mapped type over `growth-signatures.ts`, so
// a request that dropped a registered member or invented one fails to compile here rather
// than passing under a recorder that had been updated to match it.

import type { ConsoleBridge, GrowthPort } from "../../bridge/index.js";
import type { ConsoleClock } from "../../core/index.js";
import type { ChunkAcknowledgement } from "./attachment-ingest-acknowledgement.js";
import { AttachmentIngestClient } from "./attachment-ingest-machine.js";
import { attachmentSourceFrom, type AttachmentSource } from "./attachment-shapes.js";

/** One recorded `AttachmentIngestInit`, exactly as the registry declares it. */
export type RecordedInit = Parameters<GrowthPort["artifactIngestBegin"]>[0];

/** One recorded `AttachmentIngestChunk`, exactly as the registry declares it. */
export type RecordedChunk = Parameters<GrowthPort["artifactIngestWriteChunk"]>[0];

/** Bytes that differ at every position, so a concatenation check can actually fail. */
export function patternedBytes(byteLength: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(byteLength);
  for (let index = 0; index < byteLength; index += 1) {
    bytes[index] = (index * 7 + 13) % 251;
  }
  return bytes;
}

/** A promise the case opens by hand, so a call can be caught mid-flight. */
function manualGate(): { readonly promise: Promise<void>; readonly open: () => void } {
  let release = (): void => {};
  const promise = new Promise<void>((settle) => {
    release = (): void => {
      settle();
    };
  });
  return {
    promise,
    open: (): void => {
      release();
    },
  };
}

/**
 * A growth port that answers what the case tells it to.
 *
 * A class with private fields, matching the tree's rule, and it records rather than
 * asserts: a recorder lets each case ask its own question of the same script.
 */
export class ScriptedGrowthPort {
  readonly initCalls: RecordedInit[] = [];
  readonly chunkCalls: RecordedChunk[] = [];
  readonly abortedIngestIds: string[] = [];
  /**
   * The next stream identity this port hands out.
   *
   * ONE ID PER OPENED STREAM, because a port that answered every `begin` with one id
   * could not witness a per-stream act at all: two attachments open, one abort
   * recorded, and no case could say which spool it was for. The first id is still
   * `ingest-1`, so a case attaching one file reads the same recording it always did.
   */
  #nextIngestNumber = 1;
  #beginRefusalCode: string | undefined;
  #chunkRefusalCode: string | undefined;
  #completeRefusalCode: string | undefined;
  #abortRefusalCode: string | undefined;
  #beginRejection: unknown;
  #chunkRejection: unknown;
  #completeRejection: unknown;
  #abortRejection: unknown;
  #beginGate: Promise<void> | undefined;
  #chunkGate: Promise<void> | undefined;
  /**
   * The decoded bytes this port has appended, per stream and per sequence number.
   *
   * A REAL RUNNING TOTAL, because that is what the registered
   * `AttachmentIngestChunkResponse` carries and the client now advances its ledger from:
   * a port that answered a constant would let a client that ignored the reply pass every
   * case here. The decoded length comes from the platform's own base64 decoder rather
   * than from arithmetic over the encoded string, so nothing in this file is a second
   * implementation of the encoding the client uses.
   *
   * KEYED BY SEQUENCE NUMBER, so the total is idempotent under the replay the contract
   * makes safe: a chunk resent after a lost response is acknowledged without being
   * appended twice, which a running sum over calls would report as double the bytes. A
   * REFUSED chunk appends nothing at all, which is why the accounting happens after
   * both failure arms rather than on the way in.
   */
  readonly #spooledBytesByIngestId = new Map<string, Map<number, number>>();
  #chunkAcknowledgementOverride: ChunkAcknowledgement | undefined;

  /**
   * Answer the next `begin` — and every later one — with a refusal.
   *
   * The request is still RECORDED, on `refuseAbortsWith`'s reason: a refused open is
   * a request the daemon received, and a port that dropped it could not tell a stream
   * that was refused from one that was never opened.
   */
  public refuseBeginWith(code: string | undefined): void {
    this.#beginRefusalCode = code;
  }

  public refuseChunksWith(code: string | undefined): void {
    this.#chunkRefusalCode = code;
  }

  public refuseCompletionWith(code: string | undefined): void {
    this.#completeRefusalCode = code;
  }

  /**
   * Answer the next abort — and every later one — without releasing the spool.
   *
   * The id is still RECORDED, because a refused abort is a request the daemon
   * received: a port that dropped it would make "the client asked" and "the daemon
   * released" one fact, which is the conflation the client's own diagnostic exists to
   * separate.
   */
  public refuseAbortsWith(code: string | undefined): void {
    this.#abortRefusalCode = code;
  }

  /**
   * Reject the next `begin` — and every later one — rather than answering it.
   *
   * A REJECTION IS NOT A REFUSAL, and the four setters below exist because the two
   * arrive at the client through different doors. A refusal is an answer whose status
   * says the daemon declined; a rejection is a call that never produced one, which is
   * what an IPC disconnect and a vanished bridge namespace look like from here. A port
   * that could only refuse could not drive the arm where the promise itself fails, and
   * that arm is the one that used to escape as an unhandled rejection.
   *
   * The request is still RECORDED, on `refuseAbortsWith`'s reason: a rejected call was
   * still put, and a port that dropped it could not tell a leg that failed from one
   * that was never reached.
   */
  public rejectBeginWith(rejection: unknown): void {
    this.#beginRejection = rejection;
  }

  public rejectChunksWith(rejection: unknown): void {
    this.#chunkRejection = rejection;
  }

  public rejectCompletionWith(rejection: unknown): void {
    this.#completeRejection = rejection;
  }

  public rejectAbortsWith(rejection: unknown): void {
    this.#abortRejection = rejection;
  }

  /**
   * Answer every later chunk with this acknowledgement instead of the true one.
   *
   * The two answers a client must not accept are both shapes rather than statuses — a
   * reply naming another stream, and a total that did not advance — so neither is
   * reachable through the refusal setters above, and a case that could not script one
   * would be asserting the check by reading it.
   */
  public acknowledgeChunksWith(acknowledgement: ChunkAcknowledgement): void {
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

  /**
   * The port behind a bridge, with the window's clock where a case freezes one.
   *
   * `consoleClockFor` reads the running scenario engine's clock, so a case that hands
   * one over here is handing it to every subsystem the binding composes — which is the
   * only way to assert that a carrier stamps from the window's clock rather than from
   * a `RealClock` of its own.
   */
  public asBridge(clock?: ConsoleClock): ConsoleBridge {
    const port = {
      artifactIngestBegin: async (request: RecordedInit) => {
        this.initCalls.push(request);
        const ingestId = `ingest-${String(this.#nextIngestNumber)}`;
        this.#nextIngestNumber += 1;
        await this.#beginGate;
        if (this.#beginRejection !== undefined) {
          throw this.#beginRejection;
        }
        return this.#beginRefusalCode === undefined
          ? { status: "served", value: { ingestId } }
          : { status: "unavailable", code: this.#beginRefusalCode, detail: "scripted refusal" };
      },
      artifactIngestWriteChunk: async (request: RecordedChunk) => {
        this.chunkCalls.push(request);
        await this.#chunkGate;
        if (this.#chunkRejection !== undefined) {
          throw this.#chunkRejection;
        }
        if (this.#chunkRefusalCode !== undefined) {
          return {
            status: "unavailable",
            code: this.#chunkRefusalCode,
            detail: "scripted refusal",
          };
        }
        return {
          status: "served",
          value: this.#chunkAcknowledgementOverride ?? {
            ingestId: request.ingestId,
            receivedBytes: this.#append(request),
          },
        };
      },
      artifactIngestComplete: async () => {
        if (this.#completeRejection !== undefined) {
          throw this.#completeRejection;
        }
        return this.#completeRefusalCode === undefined
          ? {
              status: "served",
              value: {
                artifactId: "artifact-9",
                contentHash:
                  "sha256:9b1f1e9d0c3a4b5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6",
                normalizedName: "notes-1.md",
                derivedMediaType: "text/markdown",
                derivedSizeBytes: 300,
              },
            }
          : {
              status: "unavailable",
              code: this.#completeRefusalCode,
              detail: "scripted refusal",
            };
      },
      artifactIngestAbort: async (request: { readonly ingestId: string }) => {
        this.abortedIngestIds.push(request.ingestId);
        if (this.#abortRejection !== undefined) {
          throw this.#abortRejection;
        }
        return this.#abortRefusalCode === undefined
          ? { status: "served", value: undefined }
          : { status: "unavailable", code: this.#abortRefusalCode, detail: "scripted refusal" };
      },
    };
    return {
      growth: port,
      ...(clock === undefined ? {} : { scenarioEngine: { clock } }),
    } as unknown as ConsoleBridge;
  }
}

/** One client over one scripted port, on the session every case names. */
export function clientOver(port: ScriptedGrowthPort): AttachmentIngestClient {
  return new AttachmentIngestClient({ bridge: port.asBridge(), sessionId: "session-1" });
}

/**
 * One source over bytes the case can recognise on the other side of the wire.
 *
 * The declared media type is optional here for the same reason it is optional on the
 * request: a participant's file carries one or it does not, and the cases that turn on
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

/**
 * One source whose bytes the browser refuses to hand over.
 *
 * A `Blob` off a picker is a HANDLE on a file the host still owns, so a participant who
 * moves or deletes that file between two chunks gets a rejecting `arrayBuffer()` where
 * every earlier read succeeded. No real `Blob` can be put in that state from a test, so
 * the payload is scripted here — beside the sources every other case is driven with,
 * because it is a collaborator of the client and not a stand-in for it.
 */
export function unreadableSourceOver(
  localId: string,
  declaredName: string,
  byteLength: number,
  rejection: unknown,
): AttachmentSource {
  const unreadableSlice = {
    arrayBuffer: async (): Promise<ArrayBuffer> => {
      await Promise.resolve();
      throw rejection;
    },
  };
  const payload = {
    size: byteLength,
    slice: (): unknown => unreadableSlice,
  } as unknown as Blob;
  return attachmentSourceFrom({ localId, declaredName, payload });
}
