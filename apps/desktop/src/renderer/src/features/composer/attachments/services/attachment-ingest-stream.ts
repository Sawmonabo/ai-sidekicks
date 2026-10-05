// The three-call ingest protocol (open, chunk, complete) and what each answer does to the
// staged entry. Own-built because chunking, decoded-byte accounting and safe retry are contract
// behavior. A retry is safe: open is skipped when the stream is already open, and a repeated
// completion returns the saved result. A user can act mid-call, so every
// continuation re-reads the record after its await and a stale one writes nothing. No timer.

import type { SessionId } from "@ai-sidekicks/contracts/session/session";
import { lossyStringify } from "@renderer/lib/wire/errors.js";
import { normalizeWireRejection } from "@renderer/lib/wire/rejection.js";
import { reportTripwire } from "@renderer/lib/tripwires/tripwires.js";
import { type Clock } from "@renderer/lib/clock.js";
import type { AttachmentSpoolReclaimer } from "./attachment-ingest-abort.js";
import type { AttachmentIngestPort } from "./attachment-ingest-answer.js";
import { AttachmentChunkStream } from "./attachment-ingest-chunks.js";
import { writeIngestRefusal, type AttachmentIngestEntries } from "../attachment-ingest-entries.js";
import { isSendingAttachmentIngestEntry } from "../attachment-shapes.js";

/** Where the protocol's own diagnostic reports from, so a firing names a module. */
export const INGEST_STREAM_SITE =
  "features/composer/attachments/services/attachment-ingest-stream.ts";

/** The subsystem a refusal names when the daemon's rejection carries no code of its own. */
const INGEST_REFUSAL_ORIGIN = "composer-attachments";

/** What one ingest stream driver is given to run an upload. */
export interface AttachmentIngestStreamDriverOptions {
  readonly port: IngestLegs;
  readonly sessionId: SessionId;
  readonly clock: Clock;
  /** The staged list's own record. Written here, owned by the staged list. */
  readonly entries: AttachmentIngestEntries;
  /** Where a spool this driver opened and could not reach the record with is given back. */
  readonly reclaimer: AttachmentSpoolReclaimer;
}

/**
 * One attachment's stream, from open to complete, driven on demand. The running set is a set
 * rather than a latch key because a caller must be able to ask whether a stream is running
 * without taking the key: a retry offered mid-stream would be a duplicate upload.
 */
export class AttachmentIngestStreamDriver {
  readonly #port: Pick<AttachmentIngestPort, "begin" | "complete">;
  readonly #sessionId: SessionId;
  readonly #clock: Clock;
  readonly #entries: AttachmentIngestEntries;
  readonly #reclaimer: AttachmentSpoolReclaimer;
  readonly #chunks: AttachmentChunkStream;
  readonly #runningLocalIds = new Set<string>();

  public constructor(options: AttachmentIngestStreamDriverOptions) {
    const port = marked(options.port);
    this.#port = port;
    this.#sessionId = options.sessionId;
    this.#clock = options.clock;
    this.#entries = options.entries;
    this.#reclaimer = options.reclaimer;
    this.#chunks = new AttachmentChunkStream({
      port,
      clock: options.clock,
      entries: options.entries,
    });
  }

  /** Whether this attachment already has a stream running, so a control may not offer one. */
  public isRunning(localId: string): boolean {
    return this.#runningLocalIds.has(localId);
  }

  /** Terminal. Nothing new is driven; the continuations still awaiting find a disposed record. */
  public forget(): void {
    this.#runningLocalIds.clear();
  }

  /**
   * Begin or resume one stream: open it if it is not open, chunk it, then complete it. Never
   * rejects. A rejected port call becomes the entry's refusal, carrying the daemon's own code and
   * message, so the chip offers its retry. A subscriber that throws while the record publishes is
   * reported as a tripwire and not written again: the write already landed.
   */
  public async drive(localId: string): Promise<void> {
    if (this.#runningLocalIds.has(localId)) {
      return;
    }
    this.#runningLocalIds.add(localId);
    try {
      const opened = await this.#openStream(localId);
      if (!opened) {
        return;
      }
      const streamed = await this.#chunks.send(localId);
      if (!streamed) {
        return;
      }
      await this.#completeStream(localId);
    } catch (escape) {
      if (escape instanceof PortRejection) {
        this.#refuse(localId, escape.reason);
        return;
      }
      reportTripwire(
        "publish-failure",
        INGEST_STREAM_SITE,
        `the ingest of ${localId} recorded its step and could not ` +
          `publish it (${lossyStringify(escape)}); the record holds the ` +
          "entry and every view subscribed to it is now a step behind",
      );
    } finally {
      this.#runningLocalIds.delete(localId);
    }
  }

  /**
   * Records a rejected call on the entry. An upload the person abandoned or removed while the
   * call was in flight keeps the state they gave it.
   */
  #refuse(localId: string, rejection: unknown): void {
    const entry = this.#entries.current(localId);
    if (entry === undefined || !isSendingAttachmentIngestEntry(entry)) {
      return;
    }
    const refusal = normalizeWireRejection(INGEST_REFUSAL_ORIGIN, rejection);
    writeIngestRefusal(this.#entries, localId, entry, {
      code: refusal.code,
      detail: refusal.detail,
    });
  }

  /** Init leg; skipped when the stream is already open, so a retry is safe. */
  async #openStream(localId: string): Promise<boolean> {
    const entry = this.#entries.current(localId);
    const stamp = this.#entries.stamp(localId);
    if (entry === undefined || stamp === undefined) {
      return false;
    }
    if (entry.ingestId !== undefined) {
      return true;
    }
    // A `File` off a picker or drop carries an empty `type` when the browser could not place
    // it; that is reported the same way as a source that declared nothing, as an absent member.
    const declared = entry.declared.declaredMediaType;
    const declaredMediaType = declared === undefined || declared === "" ? undefined : declared;
    const opened = await this.#port.begin({
      sessionId: this.#sessionId,
      fileName: entry.declared.declaredName,
      // Spread so a source that declared nothing sends no `mediaType` key at all: the daemon
      // reads presence, and `undefined` or an empty string would declare a type nobody gave.
      ...(declaredMediaType === undefined ? {} : { mediaType: declaredMediaType }),
      declaredSizeBytes: entry.declared.byteLength,
    });
    const settled = this.#entries.currentIfUnchanged(localId, stamp);
    if (settled === undefined) {
      // Abandoned, removed, or disposed while Init was in flight. The daemon opened a stream
      // whose id never reached the record, so only this path can give its spool back.
      this.#reclaimer.request(opened.ingestId);
      return false;
    }
    this.#entries.write(localId, {
      ...settled,
      state: "ingesting",
      ingestId: opened.ingestId,
      lastProgressAtMilliseconds: this.#clock.now(),
    });
    return true;
  }

  /** Complete leg; the derived values replace the declaration here and nowhere else. */
  async #completeStream(localId: string): Promise<void> {
    const entry = this.#entries.current(localId);
    const stamp = this.#entries.stamp(localId);
    if (entry === undefined || stamp === undefined || entry.ingestId === undefined) {
      return;
    }
    const ingestId = entry.ingestId;
    const completion = await this.#port.complete({ ingestId });
    const settled = this.#entries.currentIfUnchanged(localId, stamp);
    if (settled === undefined) {
      return;
    }
    this.#entries.write(localId, {
      ...settled,
      state: "complete",
      derived: completion,
      lastProgressAtMilliseconds: this.#clock.now(),
    });
  }
}

type IngestLegs = Pick<AttachmentIngestPort, "begin" | "writeChunk" | "complete">;

/** A port call's rejection in transit, so `drive`'s catch can tell it from a local fault. */
class PortRejection {
  public constructor(public readonly reason: unknown) {}
}

/** The port's three legs, each rejecting as a `PortRejection` that `drive` unwraps. */
function marked(port: IngestLegs): IngestLegs {
  const mark = async <Answer>(call: () => Promise<Answer>): Promise<Answer> => {
    try {
      return await call();
    } catch (reason) {
      throw new PortRejection(reason);
    }
  };
  return {
    begin: (request) => mark(() => port.begin(request)),
    writeChunk: (request) => mark(() => port.writeChunk(request)),
    complete: (request) => mark(() => port.complete(request)),
  };
}
