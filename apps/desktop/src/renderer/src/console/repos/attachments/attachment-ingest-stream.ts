// The three-call ingest protocol: open, chunk, complete — and what each answer does to
// the ledger entry the stream is about.
//
// SPLIT FROM `attachment-ingest-machine.ts` ON THE SEAM BETWEEN AN ACT AND A WIRE. That
// module owns what a participant's act does to the carrier's record — attach, retry,
// abandon, remove, reorder — a set of synchronous decisions over the ledger. This one
// owns what happens on the wire afterwards, and hands the middle leg to
// `attachment-ingest-chunks.ts`, which is a loop rather than a call. Three subjects,
// three modules; the file that held all three was doing three jobs at once, which
// `apps/desktop/AGENTS.md` rejects.
//
// THE PROTOCOL IS OWN-BUILT, and this module is where that is decided and why: the
// chunking, the decoded-byte accounting, and the replay-safe retry are all `Spec-014`
// CONTRACT behaviour, and a generic upload library would obscure every one of them. So
// this is a class with private fields rather than a hook holding four `useState`s.
//
// WHAT IT CALLS, AND WHAT ANSWERS TODAY. The trio `AttachmentIngestInit`,
// `AttachmentIngestChunk`, `AttachmentIngestComplete` is typed in the corpus and
// registers NO method string anywhere, so every leg goes through
// `bridge/growth-port.ts` and comes back `wire-unregistered` against the
// `artifact-ingest-and-crud` slate row. That is not a stub: the chunk loop runs, every
// request carries exactly the members the registered shape names, the ledger advances
// on whatever is acknowledged, and the refusal renders where the progress would have.
// When the wire lands, the port's methods stop refusing and this file does not change.
//
// RETRY REPLAYS, IT DOES NOT RESTART. Every call of the trio is retry-safe: Init is
// skipped where the stream is already open, and a replayed completion replays its
// original response verbatim. So a lost response resumes at the current offset.
//
// A REJECTION IS A REFUSAL, AT EVERY LEG. A growth call can REJECT rather than answer —
// the bridge's namespace is gone on an IPC disconnect — and a rejection that escaped a
// leg reached nobody: the caller discards this driver's promise, so the browser reported
// an unhandled rejection and the ledger sat at `declared` or `ingesting` forever, with
// no refusal to read and no retry to press. So every leg goes through
// `answerOrRefusal`, and `drive` carries a last catch of its own, because a rejection
// past those is a defect in this console rather than an answer from anywhere.
//
// A PARTICIPANT CAN ACT WHILE A CALL IS IN FLIGHT, so every continuation re-reads the
// ledger after its await and proceeds only if the entry still stands where it stood.
// Abandonment makes this load-bearing: an upload stopped while Init was in flight would
// otherwise be resumed by the continuation writing its captured entry back. A stale
// continuation writes nothing. The one thing it does do is give back the spool the
// daemon opened underneath it, which nobody else can: that ingest id reached no ledger
// entry, so `abandon` never saw it.
//
// NO TIMER, ANYWHERE. Work happens when a participant asks for it and at no other
// moment. There is no interval, no backoff timer, and no automatic re-drive:
// `wait-and-retry` is a sentence a person reads and a control they press, because a
// console that retried a 429 on its own would hide the capacity problem it exists to
// report.

import { lossyStringify } from "../../../../../shared/wire-errors.js";
import type { ConsoleBridge } from "../../bridge/index.js";
import { reportTripwire, type ConsoleClock } from "../../core/index.js";
import type { AttachmentSpoolReclaimer } from "./attachment-ingest-abort.js";
import { answerOrRefusal, type PortAnswer } from "./attachment-ingest-answer.js";
import { AttachmentChunkStream } from "./attachment-ingest-chunks.js";
import { writeIngestRefusal, type AttachmentIngestLedger } from "./attachment-ingest-ledger.js";

/** Where the protocol's own diagnostic reports from, so a firing names a module. */
export const INGEST_STREAM_SITE = "console/repos/attachments/attachment-ingest-stream.ts";

/** What each leg is called in the one sentence that says which call failed. */
const INGEST_OPEN_LEG = "The ingest open";
const INGEST_COMPLETION_LEG = "The ingest completion";

export interface AttachmentIngestStreamDriverOptions {
  readonly bridge: ConsoleBridge;
  readonly sessionId: string;
  readonly clock: ConsoleClock;
  /** The carrier's own record. Written here, owned next door. */
  readonly ledger: AttachmentIngestLedger;
  /** Where a spool this driver opened and could not reach the ledger with is given back. */
  readonly reclaimer: AttachmentSpoolReclaimer;
}

/**
 * One attachment's stream, from Init to Complete, driven on demand.
 *
 * THE RUNNING SET IS RE-ENTRANCY AND NOT SUPERSESSION, which is why it is a set here
 * rather than a key taken from `store/generation-latch.ts`. Supersession in this family
 * is the ledger's stamp, which that register already supplies; what this one answers is
 * whether a second `drive` for the same attachment would put a second Init on the wire —
 * and the caller has to be able to ASK, because a retry offered while a stream is
 * running is a duplicate upload. The register answers that question only by TAKING the
 * key, which is the act the asking exists to avoid.
 */
export class AttachmentIngestStreamDriver {
  readonly #bridge: ConsoleBridge;
  readonly #sessionId: string;
  readonly #clock: ConsoleClock;
  readonly #ledger: AttachmentIngestLedger;
  readonly #reclaimer: AttachmentSpoolReclaimer;
  readonly #chunks: AttachmentChunkStream;
  readonly #runningLocalIds = new Set<string>();

  public constructor(options: AttachmentIngestStreamDriverOptions) {
    this.#bridge = options.bridge;
    this.#sessionId = options.sessionId;
    this.#clock = options.clock;
    this.#ledger = options.ledger;
    this.#reclaimer = options.reclaimer;
    this.#chunks = new AttachmentChunkStream({
      bridge: options.bridge,
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
   * THIS PROMISE IS DISCARDED BY EVERY CALLER — `attach`, `retry`, and nothing else —
   * so it may not reject: a rejection nobody awaits is an unhandled rejection in the
   * page and a ledger entry frozen where it stood. Every call the three legs make is
   * already normalized into an answer by `#answer`, so what remains here is the
   * publication itself: `Emitter` re-raises a sink that threw, and the ledger's write
   * has already landed by then, which is precisely why this catch REPORTS rather than
   * writing again. The record advanced and the fan-out did not, so a second write
   * would re-publish into the same throwing sink and lose the diagnostic too.
   *
   * `apply-chokepoint-bypass` is the kind for it, on the two sites that already report
   * under it (`frame/session-event-binder.ts`, `bridge/scenario-engine.ts`): a store
   * and the surfaces reading it are out of step because a delivery did not arrive. In
   * a development build the registry throws after recording, which is the console's
   * standing policy and the one arm where this promise does reject — loudly, at the
   * defect, with the record already made.
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
    const answer: PortAnswer<{ readonly ingestId: string }> = await answerOrRefusal(
      INGEST_OPEN_LEG,
      async () =>
        this.#bridge.growth.artifactIngestBegin({
          sessionId: this.#sessionId,
          fileName: entry.declared.declaredName,
          // Spread rather than assigned, so a source that declared nothing sends a
          // request with no `mediaType` key at all. The contract makes absence a
          // first-class state and the daemon reads presence, so a key carrying
          // `undefined` — or an empty string — would be this console declaring a type
          // it was never told.
          ...(declaredMediaType === undefined ? {} : { mediaType: declaredMediaType }),
          declaredSizeBytes: entry.declared.byteLength,
        }),
    );
    const settled = this.#ledger.currentIfUnchanged(localId, stamp);
    if (settled === undefined) {
      // Abandoned, removed, or disposed while Init was in flight. The daemon opened a
      // stream whose id never reached the ledger, so this is the only place that can
      // ask for its spool back.
      this.#reclaimer.request(answer.value?.ingestId);
      return false;
    }
    if (answer.status !== "served" || answer.value === undefined) {
      writeIngestRefusal(this.#ledger, localId, settled, answer);
      return false;
    }
    this.#ledger.write(localId, {
      ...settled,
      state: "ingesting",
      ingestId: answer.value.ingestId,
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
    const answer: PortAnswer<{
      readonly artifactId: string;
      readonly normalizedName: string;
      readonly derivedMediaType: string;
      readonly derivedSizeBytes: number;
    }> = await answerOrRefusal(INGEST_COMPLETION_LEG, async () =>
      this.#bridge.growth.artifactIngestComplete({ ingestId }),
    );
    const settled = this.#ledger.currentIfUnchanged(localId, stamp);
    if (settled === undefined) {
      return;
    }
    if (answer.status !== "served" || answer.value === undefined) {
      writeIngestRefusal(this.#ledger, localId, settled, answer);
      return;
    }
    this.#ledger.write(localId, {
      ...settled,
      state: "complete",
      derived: {
        artifactId: answer.value.artifactId,
        normalizedName: answer.value.normalizedName,
        derivedMediaType: answer.value.derivedMediaType,
        derivedSizeBytes: answer.value.derivedSizeBytes,
      },
      lastProgressAtMilliseconds: this.#clock.now(),
    });
  }
}
