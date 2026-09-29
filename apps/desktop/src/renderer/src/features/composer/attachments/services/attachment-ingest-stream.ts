// The three-call ingest protocol: open, chunk, complete — and what each answer does to
// the ledger entry the stream is about.
//
// SPLIT FROM `attachment-ingest-machine.ts` ON THE SEAM BETWEEN AN ACT AND A WIRE. That
// module owns what a user's act does to the carrier's record — attach, retry,
// abandon, remove — a set of synchronous decisions over the ledger. This one
// owns what happens on the wire afterwards, and hands the middle leg to
// `attachment-ingest-chunks.ts`, which is a loop rather than a call. Three subjects,
// three modules.
//
// THE PROTOCOL IS OWN-BUILT, and this module is where that is decided and why: the
// chunking, the decoded-byte accounting, and the replay-safe retry are all CONTRACT
// behaviour, and a generic upload library would obscure every one of them. So
// this is a class with private fields rather than a hook holding four `useState`s.
//
// WHAT IT CALLS. Every leg goes through the `AttachmentIngestPort` the client was handed,
// and the ledger advances on whatever that port acknowledges: the chunk loop runs and
// every request carries exactly the members the port names. A rejected port call is not
// turned into state; it propagates out of `drive`. The one fault `drive` catches is local:
// a subscriber that threw while the ledger published a write that had already landed.
//
// RETRY REPLAYS, IT DOES NOT RESTART. Every call of the trio is retry-safe: Init is
// skipped where the stream is already open, and a replayed completion replays its
// original response verbatim. So a lost response resumes at the current offset.
//
// A USER CAN ACT WHILE A CALL IS IN FLIGHT, so every continuation re-reads the
// ledger after its await and proceeds only if the entry still stands where it stood.
// Abandonment makes this load-bearing: an upload stopped while Init was in flight would
// otherwise be resumed by the continuation writing its captured entry back. A stale
// continuation writes nothing. The one thing it does do is give back the spool the
// daemon opened underneath it, which nobody else can: that ingest id reached no ledger
// entry, so `abandon` never saw it.
//
// NO TIMER, ANYWHERE. Work happens when a user asks for it and at no other
// moment. There is no interval, no backoff timer, and no automatic re-drive.

import type { SessionId } from "@ai-sidekicks/contracts";
import { lossyStringify } from "@renderer/lib/wire-errors.js";
import { reportTripwire } from "@renderer/lib/tripwires.js";
import { type Clock } from "@renderer/lib/clock.js";
import type { AttachmentSpoolReclaimer } from "./attachment-ingest-abort.js";
import type { AttachmentIngestPort } from "./attachment-ingest-answer.js";
import { AttachmentChunkStream } from "./attachment-ingest-chunks.js";
import type { AttachmentIngestEntries } from "../attachment-ingest-entries.js";

/** Where the protocol's own diagnostic reports from, so a firing names a module. */
export const INGEST_STREAM_SITE = "console/repos/attachments/attachment-ingest-stream.ts";

/** What one ingest stream driver is given to run an upload. */
export interface AttachmentIngestStreamDriverOptions {
  readonly port: IngestLegs;
  readonly sessionId: SessionId;
  readonly clock: Clock;
  /** The carrier's own record. Written here, owned next door. */
  readonly ledger: AttachmentIngestEntries;
  /** Where a spool this driver opened and could not reach the ledger with is given back. */
  readonly reclaimer: AttachmentSpoolReclaimer;
}

/**
 * One attachment's stream, from Init to Complete, driven on demand.
 *
 * THE RUNNING SET IS RE-ENTRANCY AND NOT SUPERSESSION, which is why it is a set here
 * rather than a key taken from `store/read/generation-latch.ts`. Supersession in this family
 * is the ledger's stamp, which that register already supplies; what this one answers is
 * whether a second `drive` for the same attachment would put a second Init on the wire —
 * and the caller has to be able to ASK, because a retry offered while a stream is
 * running is a duplicate upload. The register answers that question only by TAKING the
 * key, which is the act the asking exists to avoid.
 */
export class AttachmentIngestStreamDriver {
  readonly #port: Pick<AttachmentIngestPort, "begin" | "complete">;
  readonly #sessionId: SessionId;
  readonly #clock: Clock;
  readonly #ledger: AttachmentIngestEntries;
  readonly #reclaimer: AttachmentSpoolReclaimer;
  readonly #chunks: AttachmentChunkStream;
  readonly #runningLocalIds = new Set<string>();

  public constructor(options: AttachmentIngestStreamDriverOptions) {
    const port = marked(options.port);
    this.#port = port;
    this.#sessionId = options.sessionId;
    this.#clock = options.clock;
    this.#ledger = options.ledger;
    this.#reclaimer = options.reclaimer;
    this.#chunks = new AttachmentChunkStream({
      port,
      clock: options.clock,
      ledger: options.ledger,
    });
  }

  /** Whether this attachment already has a stream running, so a control may not offer one. */
  public isRunning(localId: string): boolean {
    return this.#runningLocalIds.has(localId);
  }

  /** Terminal. Nothing new is driven; the continuations still awaiting find a disposed ledger. */
  public forget(): void {
    this.#runningLocalIds.clear();
  }

  /**
   * Begin or resume one stream: open it if it is not open, chunk it, then complete it.
   *
   * Every caller discards this promise (`attach` and `retry`), so a rejected port call
   * surfaces as the page's unhandled rejection rather than as ledger state.
   *
   * A subscriber that throws while the ledger publishes is different: the write has
   * already landed, so the record is ahead of the surfaces reading it. That is reported
   * as an `apply-chokepoint-bypass` tripwire and not written again, since a second write
   * would publish into the same throwing subscriber.
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
        throw escape.reason;
      }
      reportTripwire(
        "apply-chokepoint-bypass",
        INGEST_STREAM_SITE,
        `the ingest of ${localId} recorded its step and could not publish it (${lossyStringify(escape)}); the ledger holds the entry and every surface subscribed to it is now a step behind`,
      );
    } finally {
      this.#runningLocalIds.delete(localId);
    }
  }

  /** `AttachmentIngestInit`. Skipped when the stream is already open, which is what makes retry a replay. */
  async #openStream(localId: string): Promise<boolean> {
    const entry = this.#ledger.current(localId);
    const stamp = this.#ledger.stamp(localId);
    if (entry === undefined || stamp === undefined) {
      return false;
    }
    if (entry.ingestId !== undefined) {
      return true;
    }
    // A `File` off a picker or a drop carries an EMPTY `type` when the browser could not
    // place it, which is the same situation as a source that declared nothing and is
    // reported the same way: as an absent member.
    const declared = entry.declared.declaredMediaType;
    const declaredMediaType = declared === undefined || declared === "" ? undefined : declared;
    const opened = await this.#port.begin({
      sessionId: this.#sessionId,
      fileName: entry.declared.declaredName,
      // Spread rather than assigned, so a source that declared nothing sends a request
      // with no `mediaType` key at all. The contract makes absence a first-class state
      // and the daemon reads presence, so a key carrying `undefined` — or an empty
      // string — would be this console declaring a type it was never told.
      ...(declaredMediaType === undefined ? {} : { mediaType: declaredMediaType }),
      declaredSizeBytes: entry.declared.byteLength,
    });
    const settled = this.#ledger.currentIfUnchanged(localId, stamp);
    if (settled === undefined) {
      // Abandoned, removed, or disposed while Init was in flight. The daemon opened a
      // stream whose id never reached the ledger, so this is the only place that can
      // ask for its spool back.
      this.#reclaimer.request(opened.ingestId);
      return false;
    }
    this.#ledger.write(localId, {
      ...settled,
      state: "ingesting",
      ingestId: opened.ingestId,
      openedAtMilliseconds: this.#clock.now(),
      lastProgressAtMilliseconds: this.#clock.now(),
    });
    return true;
  }

  /** `AttachmentIngestComplete`. The derived truth replaces the declaration here and nowhere else. */
  async #completeStream(localId: string): Promise<void> {
    const entry = this.#ledger.current(localId);
    const stamp = this.#ledger.stamp(localId);
    if (entry === undefined || stamp === undefined || entry.ingestId === undefined) {
      return;
    }
    const ingestId = entry.ingestId;
    const completion = await this.#port.complete({ ingestId });
    const settled = this.#ledger.currentIfUnchanged(localId, stamp);
    if (settled === undefined) {
      return;
    }
    this.#ledger.write(localId, {
      ...settled,
      state: "complete",
      derived: {
        artifactId: completion.artifactId,
        normalizedName: completion.normalizedName,
        derivedMediaType: completion.derivedMediaType,
        derivedSizeBytes: completion.derivedSizeBytes,
      },
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
