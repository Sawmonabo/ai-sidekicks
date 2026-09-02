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

import type { ConsoleBridge, GrowthPort } from "../bridge/index.js";
import { AttachmentIngestClient } from "./attachment-ingest.js";
import { attachmentSourceFrom, type AttachmentSource } from "./attachment-model.js";

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
  readonly chunkCalls: RecordedChunk[] = [];
  readonly abortedIngestIds: string[] = [];
  #chunkRefusalCode: string | undefined;
  #completeRefusalCode: string | undefined;
  #beginGate: Promise<void> | undefined;
  #chunkGate: Promise<void> | undefined;

  public refuseChunksWith(code: string | undefined): void {
    this.#chunkRefusalCode = code;
  }

  public refuseCompletionWith(code: string | undefined): void {
    this.#completeRefusalCode = code;
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

  public asBridge(): ConsoleBridge {
    const port = {
      artifactIngestBegin: async () => {
        await this.#beginGate;
        return { status: "served", value: { ingestId: "ingest-1" } };
      },
      artifactIngestWriteChunk: async (request: RecordedChunk) => {
        this.chunkCalls.push(request);
        await this.#chunkGate;
        return this.#chunkRefusalCode === undefined
          ? { status: "served", value: undefined }
          : { status: "unavailable", code: this.#chunkRefusalCode, detail: "scripted refusal" };
      },
      artifactIngestComplete: async () =>
        this.#completeRefusalCode === undefined
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
            },
      artifactIngestAbort: async (request: { readonly ingestId: string }) => {
        this.abortedIngestIds.push(request.ingestId);
        return { status: "served", value: undefined };
      },
    };
    return { growth: port } as unknown as ConsoleBridge;
  }
}

/** One client over one scripted port, on the session every case names. */
export function clientOver(port: ScriptedGrowthPort): AttachmentIngestClient {
  return new AttachmentIngestClient({ bridge: port.asBridge(), sessionId: "session-1" });
}

/** One source over bytes the case can recognise on the other side of the wire. */
export function sourceOver(
  localId: string,
  declaredName: string,
  byteLength: number,
): AttachmentSource {
  return attachmentSourceFrom({
    localId,
    declaredName,
    payload: new Blob([patternedBytes(byteLength)]),
  });
}

/** The attachment most cases attach: small enough to fit inside one chunk. */
export const SMALL_SOURCE: AttachmentSource = sourceOver("attachment-1", "notes.md", 300);
