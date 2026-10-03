// The staged attachments: where a chosen file becomes an ingest, and the one owner of the
// ingest client's construction, subscription and disposal. The publish instant is stamped when
// the record publishes and travels in the same snapshot, so an age moves only when an upload
// does. A stalled upload stops publishing, so one one-shot timeout at the earliest outstanding
// disclosure deadline re-stamps the same entries; it reads nothing and there is no interval.
// The local id is this list's counter, not the file name, since two files can share a name.

import type { SessionId } from "@ai-sidekicks/contracts";
import { earliestFutureDeadline } from "@renderer/lib/deadlines.js";
import type { Unsubscribe } from "@shared/preload-api.js";
import { Emitter } from "@renderer/lib/emitter.js";
import { type Clock, type ScheduledHandle } from "@renderer/lib/clock.js";
import type { AttachmentIngestPort } from "./services/attachment-ingest-answer.js";
import { AttachmentIngestClient } from "./attachment-ingest-client.js";
import { ingestStallDisclosureAtMs } from "./attachment-presentation.js";
import { attachmentSourceFrom, type AttachmentIngestEntry } from "./attachment-shapes.js";

/** What the staged list holds, and the instant it last said so. */
export interface StagedAttachmentsSnapshot {
  readonly entries: readonly AttachmentIngestEntry[];
  /** The instant of the publish that produced these entries. Never the wall clock at render. */
  readonly publishedAtMilliseconds: number;
}

/** What a staged list is given to run uploads for one session. */
export interface StagedAttachmentsOptions {
  /** The four calls of an upload; nothing here reaches for a bridge to make them. */
  readonly port: AttachmentIngestPort;
  readonly sessionId: SessionId;
  /**
   * The clock every stamp this staged list publishes is taken from. Required with no default,
   * so the list runs on the window's clock (`useBridgeClock`) rather than wall time beside a
   * frozen fixture clock.
   */
  readonly clock: Clock;
}

/** One ingest client, its subscription, and the stamped snapshot a view renders. */
export class StagedAttachments {
  readonly #client: AttachmentIngestClient;
  readonly #clock: Clock;
  readonly #changes = new Emitter<StagedAttachmentsSnapshot>("staged attachments publish");

  #snapshot: StagedAttachmentsSnapshot;
  #clientSubscription: Unsubscribe | undefined;
  #nextLocalNumber = 1;
  #stallWakeUpHandle: ScheduledHandle | undefined;
  #disposed = false;

  public constructor(options: StagedAttachmentsOptions) {
    this.#clock = options.clock;
    this.#client = new AttachmentIngestClient({
      port: options.port,
      sessionId: options.sessionId,
      clock: this.#clock,
    });
    this.#snapshot = { entries: this.#client.snapshot, publishedAtMilliseconds: this.#clock.now() };
  }

  /** Stable between publishes, which is what `useSyncExternalStore` requires of it. */
  public get snapshot(): StagedAttachmentsSnapshot {
    return this.#snapshot;
  }

  /** Whether this staged list has been torn down; the hook that owns its lifetime asks it. */
  public get isDisposed(): boolean {
    return this.#disposed;
  }

  /**
   * Begin following the record. Idempotent: strict mode runs an effect twice, and a second
   * subscription would re-emit every publish.
   */
  public start(): void {
    if (this.#disposed) {
      // A disposed list's client refuses every attach, so the owner re-mints instead.
      return;
    }
    this.#clientSubscription ??= this.#client.subscribe((entries) => {
      this.#publish(entries);
    });
  }

  public subscribe(sink: () => void): Unsubscribe {
    return this.#changes.subscribe(sink);
  }

  /**
   * Take every file the picker handed over, in order. The declared media type is passed as the
   * browser reported it, including the empty string, which the stream reads as absent.
   */
  public attachFiles(files: readonly File[]): void {
    for (const file of files) {
      this.#client.attach(
        attachmentSourceFrom({
          localId: `attachment-${String(this.#nextLocalNumber)}`,
          declaredName: file.name,
          payload: file,
          declaredMediaType: file.type,
        }),
      );
      this.#nextLocalNumber += 1;
    }
  }

  /** Send a refused stream again, per the disposition its refusal carried. */
  public retry(localId: string): void {
    this.#client.retry(localId);
  }

  /** Stop sending. There is no cancel call, so this is abandonment. */
  public abandon(localId: string): void {
    this.#client.abandon(localId);
  }

  /**
   * Drop the subscription, then give the daemon back every spool still open. The wake-up is
   * canceled here so a timeout cannot outlive the list.
   */
  public dispose(): void {
    this.#disposed = true;
    this.#cancelStallWakeUp();
    this.#clientSubscription?.();
    this.#clientSubscription = undefined;
    this.#client.dispose();
  }

  #publish(entries: readonly AttachmentIngestEntry[]): void {
    this.#snapshot = { entries, publishedAtMilliseconds: this.#clock.now() };
    // Armed before the emit because `Emitter` re-raises a throwing sink; armed after, the
    // wake-up would never be set.
    this.#armStallWakeUp();
    this.#changes.emit(this.#snapshot);
  }

  /**
   * Arrange the one wake-up the outstanding entries call for: one timer per list, at the
   * earliest deadline still ahead. A deadline already behind needs none, since the snapshot's
   * instant is past it. The wake-up re-arms through `#publish`, a chain of single shots.
   */
  #armStallWakeUp(): void {
    this.#cancelStallWakeUp();
    const deadlineMilliseconds = this.#earliestStallDeadlineMs();
    if (deadlineMilliseconds === undefined) {
      return;
    }
    this.#stallWakeUpHandle = this.#clock.scheduleTimeout(() => {
      this.#stallWakeUpHandle = undefined;
      // The same entries with a fresh instant; nothing is read.
      this.#publish(this.#snapshot.entries);
    }, deadlineMilliseconds - this.#clock.now());
  }

  /**
   * The soonest disclosure deadline still ahead of now, or `undefined` for none. This class
   * decides which entries have a deadline; `earliestFutureDeadline` picks the next one.
   */
  #earliestStallDeadlineMs(): number | undefined {
    const deadlines: number[] = [];
    for (const entry of this.#snapshot.entries) {
      const deadlineMilliseconds = ingestStallDisclosureAtMs(entry);
      if (deadlineMilliseconds !== undefined) {
        deadlines.push(deadlineMilliseconds);
      }
    }
    return earliestFutureDeadline(deadlines, this.#clock.now());
  }

  #cancelStallWakeUp(): void {
    if (this.#stallWakeUpHandle === undefined) {
      return;
    }
    this.#clock.cancel(this.#stallWakeUpHandle);
    this.#stallWakeUpHandle = undefined;
  }
}
