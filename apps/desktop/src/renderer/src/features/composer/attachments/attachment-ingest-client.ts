// The staged list's user-facing acts: attach, retry, abandon, remove and dispose. The record
// itself is `attachment-ingest-entries.ts`; the wire legs are in `services/`. Every act is
// synchronous: a press moves the record and returns, and the stream driver's promise, which
// never rejects, is not awaited. There is no timer, backoff or automatic re-drive.

import type { SessionId } from "@ai-sidekicks/contracts/session";
import { RealClock, type Clock } from "@renderer/lib/clock.js";
import type { Unsubscribe } from "@shared/preload-api.js";
import { AttachmentSpoolReclaimer } from "./services/attachment-ingest-abort.js";
import type { AttachmentIngestPort } from "./services/attachment-ingest-answer.js";
import { AttachmentIngestEntries } from "./attachment-ingest-entries.js";
import { AttachmentIngestStreamDriver } from "./services/attachment-ingest-stream.js";
import type { AttachmentIngestEntry, AttachmentSource } from "./attachment-shapes.js";

/** The port to call through, the session, and an optional clock. */
export interface AttachmentIngestClientOptions {
  readonly port: AttachmentIngestPort;
  readonly sessionId: SessionId;
  /** Injected so a test drives every stream on frozen time with no real clock. */
  readonly clock?: Clock;
}

/** Every attachment a user has handed this staged list, in the order they chose. */
export class AttachmentIngestClient {
  readonly #entries = new AttachmentIngestEntries();
  readonly #reclaimer: AttachmentSpoolReclaimer;
  readonly #streams: AttachmentIngestStreamDriver;

  #disposed = false;

  public constructor(options: AttachmentIngestClientOptions) {
    const clock = options.clock ?? new RealClock();
    this.#reclaimer = new AttachmentSpoolReclaimer(options.port, clock);
    this.#streams = new AttachmentIngestStreamDriver({
      port: options.port,
      sessionId: options.sessionId,
      clock,
      entries: this.#entries,
      reclaimer: this.#reclaimer,
    });
  }

  /** The staged list, in declared order. Stable identity between publishes. */
  public get snapshot(): readonly AttachmentIngestEntry[] {
    return this.#entries.snapshot;
  }

  /** Subscribes to each publish of the staged list; returns the unsubscribe. */
  public subscribe(sink: (entries: readonly AttachmentIngestEntry[]) => void): Unsubscribe {
    return this.#entries.subscribe(sink);
  }

  /**
   * Takes one attachment and begins its stream. No count of the app's own is enforced: how many
   * files a message carries is what the daemon and the provider accept.
   */
  public attach(source: AttachmentSource): void {
    const localId = source.declared.localId;
    if (this.#disposed || this.#entries.holds(localId)) {
      return;
    }
    this.#entries.declare(source);
    void this.#streams.drive(localId);
  }

  /**
   * Sends again after a refusal. `restart` drops the stream identity and begins from the first
   * byte; every other disposition resumes at the current offset, so a lost response costs one
   * chunk. Only from `refused`, the last state that still holds the payload.
   */
  public retry(localId: string): void {
    const entry = this.#entries.current(localId);
    if (entry === undefined || entry.state !== "refused" || this.#streams.isRunning(localId)) {
      return;
    }
    const restarting = entry.disposition === "restart";
    this.#entries.write(localId, {
      ...entry,
      state: "declared",
      refusal: undefined,
      disposition: undefined,
      ...(restarting ? { ingestId: undefined, receivedBytes: 0 } : {}),
    });
    void this.#streams.drive(localId);
  }

  /**
   * Stops sending and asks for the spool back. The state moves at once because sending stops at
   * once; the abort call is best-effort, so the copy names the reaper.
   */
  public abandon(localId: string): void {
    const entry = this.#entries.current(localId);
    if (entry === undefined || entry.state === "complete") {
      return;
    }
    this.#entries.write(localId, { ...entry, state: "abandoned", disposition: undefined });
    this.#reclaimer.request(entry.ingestId);
  }

  /** Take one attachment out of the staged list entirely, position included. */
  public remove(localId: string): void {
    if (!this.#entries.holds(localId)) {
      return;
    }
    this.abandon(localId);
    this.#entries.remove(localId);
  }

  /**
   * Stops the staged list and gives back every spool still held. The aborts go first: an ingest
   * id lives only in the record, so once it is disposed nothing can name an open stream, and its
   * spool and capacity reservation would stand until the reaper claimed them. `abandoned` entries
   * were already asked for and `complete` ones hold nothing. Fired, not awaited. Idempotent: the
   * record's snapshot outlives its disposal, and strict-mode React disposes twice.
   */
  public dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#streams.forget();
    for (const entry of this.#entries.snapshot) {
      if (entry.state !== "complete" && entry.state !== "abandoned") {
        this.#reclaimer.request(entry.ingestId);
      }
    }
    this.#entries.dispose();
  }
}
