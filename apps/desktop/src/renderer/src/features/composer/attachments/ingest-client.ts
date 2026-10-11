// The staged list's user-facing acts: attach, retry, abandon, remove and dispose. The record
// itself is `ingest-entries.ts`; the wire legs are in `services/`. Every act is
// synchronous: a press moves the record and returns, and the stream driver's promise, which
// never rejects, is not awaited. There is no timer, backoff or automatic re-drive.

import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import { RealClock, type Clock } from "#renderer/lib/clock.js";
import type { Unsubscribe } from "#shared/preload-api.js";
import type { AttachmentIngestPort } from "./services/ingest-port.js";
import { AttachmentIngestEntries } from "./ingest-entries.js";
import { canRetryIngest } from "./policy.js";
import { AttachmentIngestStreamDriver } from "./services/ingest-stream.js";
import type { AttachmentIngestEntry, AttachmentSource } from "./shapes.js";

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
  readonly #streams: AttachmentIngestStreamDriver;

  #disposed = false;

  public constructor(options: AttachmentIngestClientOptions) {
    const clock = options.clock ?? new RealClock();
    this.#streams = new AttachmentIngestStreamDriver({
      port: options.port,
      sessionId: options.sessionId,
      clock,
      entries: this.#entries,
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
   * byte; `attach-another` sends nothing, since the same bytes get the same answer; every other
   * disposition resumes at the current offset, so a lost response costs one chunk. Only from a
   * refusal that still holds the payload, which every refusal but one of the file itself does.
   */
  public retry(localId: string): void {
    const entry = this.#entries.current(localId);
    if (entry === undefined || !canRetryIngest(entry) || this.#streams.isRunning(localId)) {
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
   * Stops sending. The state moves at once because sending stops at once; the ingest calls have
   * no abort, so the daemon's reaper claims the spool, and the copy names it.
   */
  public abandon(localId: string): void {
    const entry = this.#entries.current(localId);
    if (entry === undefined || entry.state === "complete") {
      return;
    }
    this.#entries.write(localId, { ...entry, state: "abandoned", disposition: undefined });
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
   * Stops the staged list; the daemon's reaper claims every spool still open. Idempotent: the
   * record's snapshot outlives its disposal, and strict-mode React disposes twice.
   */
  public dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#streams.forget();
    this.#entries.dispose();
  }
}
