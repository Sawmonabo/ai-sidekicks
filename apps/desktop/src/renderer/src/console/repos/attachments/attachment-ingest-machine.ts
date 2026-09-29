// The carrier's user-facing acts: what attach, retry, abandon, remove,
// and disposal do to the record of every attachment a person has handed this session.
//
// THREE MODULES, THREE SUBJECTS, AND THIS ONE IS THE ACTS. The carrier's own record —
// which attachments there are, in which order, and where each one stands — is
// `attachment-ingest-ledger.ts`. The wire is `attachment-ingest-stream.ts`, whose
// middle leg is `attachment-ingest-chunks.ts`. Giving a stopped stream's spool back is
// `attachment-ingest-abort.ts`, whose rules are the opposite of the stream's in every
// respect that matters; the port every leg calls through is declared in
// `attachment-ingest-answer.ts`; and what one chunk acknowledgement establishes is
// `attachment-ingest-acknowledgement.ts`.
//
// EVERY ACT HERE IS SYNCHRONOUS, and that is the seam. A press moves the ledger and
// returns; whether anything then goes on a wire is the driver's question, and the
// promise it answers with is deliberately discarded — a stream is not a render and a
// press is not a round trip. The one thing this module awaits is nothing at all.
//
// NO TIMER, ANYWHERE. The carrier performs work when a user asks it to — attach,
// retry, abandon — and at no other moment. There is no interval, no backoff timer, and
// no automatic re-drive.

import type { SessionId } from "@ai-sidekicks/contracts";
import { RealClock, type ConsoleClock, type Unsubscribe } from "../../core/index.js";
import { AttachmentSpoolReclaimer } from "./attachment-ingest-abort.js";
import type { AttachmentIngestPort } from "./attachment-ingest-answer.js";
import { AttachmentIngestLedger } from "./attachment-ingest-ledger.js";
import { AttachmentIngestStreamDriver } from "./attachment-ingest-stream.js";
import type { AttachmentIngestEntry, AttachmentSource } from "./attachment-shapes.js";

export interface AttachmentIngestClientOptions {
  readonly port: AttachmentIngestPort;
  readonly sessionId: SessionId;
  /** Injected so a test drives every stream on frozen time with no real clock. */
  readonly clock?: ConsoleClock;
}

/** Every attachment a user has handed this carrier, in the order they chose. */
export class AttachmentIngestClient {
  readonly #ledger = new AttachmentIngestLedger();
  readonly #reclaimer: AttachmentSpoolReclaimer;
  readonly #streams: AttachmentIngestStreamDriver;

  #disposed = false;

  public constructor(options: AttachmentIngestClientOptions) {
    this.#reclaimer = new AttachmentSpoolReclaimer(options.port);
    this.#streams = new AttachmentIngestStreamDriver({
      port: options.port,
      sessionId: options.sessionId,
      clock: options.clock ?? new RealClock(),
      ledger: this.#ledger,
      reclaimer: this.#reclaimer,
    });
  }

  /** The carrier, in declared order. Stable identity between publishes. */
  public get snapshot(): readonly AttachmentIngestEntry[] {
    return this.#ledger.snapshot;
  }

  public subscribe(sink: (entries: readonly AttachmentIngestEntry[]) => void): Unsubscribe {
    return this.#ledger.subscribe(sink);
  }

  /**
   * Take one attachment and begin its stream.
   *
   * The count cap is NOT enforced here. The daemon refuses the whole carrier at
   * acceptance with `artifact.too_many_attachments` and leaves every artifact minted by
   * an earlier ingest untouched, so a client that blocked the eleventh attach would be
   * deriving eligibility the daemon owns — and would be wrong the moment an operator
   * raises the bound. The count is rendered against its cap and the daemon decides.
   */
  public attach(source: AttachmentSource): void {
    const localId = source.declared.localId;
    if (this.#disposed || this.#ledger.holds(localId)) {
      return;
    }
    this.#ledger.declare(source);
    void this.#streams.drive(localId);
  }

  /**
   * Send again after a refusal.
   *
   * The disposition decides the shape: `restart` drops the stream identity and the
   * ledger and begins from the first byte, and every other disposition resumes at the
   * current offset — which is what makes a lost response cost one chunk rather than the
   * whole upload.
   *
   * ONLY FROM `refused`, which is exactly where the card offers the control. It is also
   * the last state that still holds the payload: a completed or abandoned entry has
   * released its bytes, so a retry from one would have nothing to send and the ledger
   * would refuse the write anyway. Stated here so the refusal is the guard rather than
   * the backstop.
   */
  public retry(localId: string): void {
    const entry = this.#ledger.current(localId);
    if (entry === undefined || entry.state !== "refused" || this.#streams.isRunning(localId)) {
      return;
    }
    const restarting = entry.disposition === "restart";
    this.#ledger.write(localId, {
      ...entry,
      state: "declared",
      refusal: undefined,
      disposition: undefined,
      ...(restarting
        ? { ingestId: undefined, receivedBytes: 0, openedAtMilliseconds: undefined }
        : {}),
    });
    void this.#streams.drive(localId);
  }

  /**
   * Stop sending, and ask for the spool back.
   *
   * The state moves immediately because sending stops immediately; the abort call is
   * best-effort, which is why the copy states the reaper rather than promising an
   * instant reclaim.
   */
  public abandon(localId: string): void {
    const entry = this.#ledger.current(localId);
    if (entry === undefined || entry.state === "complete") {
      return;
    }
    this.#ledger.write(localId, { ...entry, state: "abandoned", disposition: undefined });
    this.#reclaimer.request(entry.ingestId);
  }

  /** Take one attachment out of the carrier entirely, position included. */
  public remove(localId: string): void {
    if (!this.#ledger.holds(localId)) {
      return;
    }
    this.abandon(localId);
    this.#ledger.remove(localId);
  }

  /** The reference a carrier would carry: artifact ids, ordered, and nothing else. */
  public attachmentArtifactIds(): readonly string[] {
    return this.#ledger.artifactIds();
  }

  /**
   * Stop the carrier, and give the daemon back every spool it is still holding.
   *
   * THE ABORTS GO FIRST, AND THE ORDER IS THE WHOLE POINT. Disposing the ledger is
   * what stops the continuations, and it is also what makes the open streams
   * unreachable: an ingest id lives in the ledger and nowhere else, so after the
   * ledger goes nothing in this console can name one. A carrier closed with several
   * uploads open would leave those spools and their aggregate reservations standing until
   * the daemon's abandoned-spool reaper claimed them, and a later upload in the same
   * session could fail capacity admission long after the surface was gone.
   *
   * `abandoned` entries are skipped rather than reclaimed twice: `abandon` already asked
   * for that spool back at the moment sending stopped, and a second request for one
   * spool is a duplicate rather than a safeguard. `complete` entries hold a finished
   * stream, which there is nothing to reclaim from.
   *
   * FIRED AND NOT AWAITED. Disposal is synchronous — a carrier that waited on a
   * best-effort abort would hold a closed surface open for an answer no surface is
   * left to render.
   *
   * IDEMPOTENT, on `repo-mounts-reader.ts`'s reason for its own guard: the ledger's
   * published snapshot outlives its disposal, so a second call would walk the same
   * entries and send the daemon a second reclaim request for every spool the first
   * one already asked back. React unmounts an effect twice in development strict
   * mode, which is exactly where a carrier is disposed twice.
   */
  public dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#streams.forget();
    for (const entry of this.#ledger.snapshot) {
      if (entry.state !== "complete" && entry.state !== "abandoned") {
        this.#reclaimer.request(entry.ingestId);
      }
    }
    this.#ledger.dispose();
  }
}
