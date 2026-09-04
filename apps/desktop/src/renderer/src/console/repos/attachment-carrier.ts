// The carrier binding: where a file a participant chose becomes an ingest, and where
// the ingest client is constructed, subscribed, and disposed.
//
// WHY THIS MODULE EXISTS AT ALL. `attachment-ingest-machine.ts` is a class with a
// lifecycle and `AttachmentCarrierSection.tsx` is a render; between them there has to
// be exactly one place that owns construction, subscription, and teardown, or every
// surface that wanted an upload would own three of them. That is this file, on
// `repo-mounts-reader.ts`'s own shape one directory over: the class holds the state
// and the hook binds it to a component's lifetime.
//
// THE INSTANT IS PUBLISHED WITH THE ENTRIES. `AttachmentCard` reads a stall disclosure
// and a stream ceiling off an instant it is handed, so something has to supply one. A
// card that read the wall clock in its own render would move an age with nobody acting,
// and a surface that re-stamped on every render would do the same thing one level up.
// So the stamp is taken WHEN THE LEDGER PUBLISHES and carried in the same snapshot the
// entries are: an age moves when the upload moves, and at no other moment.
//
// WHICH IS EXACTLY WHY THE STALL NEEDS ONE WAKE-UP, AND ONLY ONE. The upload that
// stalls is the upload that stops publishing, so the card holding the last stamp is
// held at the instant of the last progress and its disclosure threshold can never be
// crossed — for precisely the stream that went quiet. A ONE-SHOT timeout at the
// earliest outstanding entry's own disclosure deadline closes that, and every word of
// that is load-bearing: it is armed once per deadline and not per card, it re-arms to
// the next outstanding deadline rather than repeating, it is cancelled by the next
// progress, settlement, abandonment, or disposal, and it READS NOTHING — it re-stamps
// the entries the ledger already published, so it is not a refresh and does not belong
// to `store/scheduling.ts`. There is still no interval here, and there can be none.
//
// THE LOCAL ID IS THE CARRIER'S, NOT THE FILE'S. Two files chosen in one picker can
// carry one name, and the ledger is keyed by local id — so a carrier that keyed on
// the declared name would silently drop the second of two `notes.md`. The counter
// rises and never repeats, which is the whole requirement.

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import type { ConsoleBridge } from "../bridge/index.js";
import {
  Emitter,
  RealClock,
  type ConsoleClock,
  type ScheduledHandle,
  type Unsubscribe,
} from "../core/index.js";
import { AttachmentIngestClient } from "./attachment-ingest-machine.js";
import {
  attachmentSourceFrom,
  ingestStallDisclosureAtMs,
  type AttachmentIngestEntry,
} from "./attachment-model.js";

/** What the carrier holds, and the instant it last said so. */
export interface AttachmentCarrierSnapshot {
  readonly entries: readonly AttachmentIngestEntry[];
  /** The instant of the publish that produced these entries. Never the wall clock at render. */
  readonly publishedAtMilliseconds: number;
}

export interface AttachmentCarrierOptions {
  readonly bridge: ConsoleBridge;
  readonly sessionId: string;
  /** Injected so a test drives a whole carrier on frozen time with no real clock. */
  readonly clock?: ConsoleClock;
}

/** One ingest client, its subscription, and the stamped snapshot a surface renders. */
export class AttachmentCarrier {
  readonly #client: AttachmentIngestClient;
  readonly #clock: ConsoleClock;
  readonly #changes = new Emitter<AttachmentCarrierSnapshot>("attachment carrier publish");

  #snapshot: AttachmentCarrierSnapshot;
  #clientSubscription: Unsubscribe | undefined;
  #nextLocalNumber = 1;
  #stallWakeUpHandle: ScheduledHandle | undefined;

  public constructor(options: AttachmentCarrierOptions) {
    this.#clock = options.clock ?? new RealClock();
    this.#client = new AttachmentIngestClient({
      bridge: options.bridge,
      sessionId: options.sessionId,
      clock: this.#clock,
    });
    this.#snapshot = { entries: this.#client.snapshot, publishedAtMilliseconds: this.#clock.now() };
  }

  /** Stable between publishes, which is what `useSyncExternalStore` requires of it. */
  public get snapshot(): AttachmentCarrierSnapshot {
    return this.#snapshot;
  }

  /**
   * Begin following the ledger.
   *
   * IDEMPOTENT, on `dispose`'s own reason next door: React runs an effect twice in
   * development strict mode, and a second subscription would restamp and re-emit for
   * every publish forever after.
   */
  public start(): void {
    this.#clientSubscription ??= this.#client.subscribe((entries) => {
      this.#publish(entries);
    });
  }

  public subscribe(sink: () => void): Unsubscribe {
    return this.#changes.subscribe(sink);
  }

  /**
   * Take every file the picker handed over, in the order it handed them.
   *
   * The declared media type goes over as the browser reported it — including the
   * empty string a browser sends when it could not place the file, which the stream
   * itself reads as an absent member rather than as a type this console invented.
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

  /** Stop sending. There is no cancel call, so this is abandonment and the copy says so. */
  public abandon(localId: string): void {
    this.#client.abandon(localId);
  }

  /**
   * Drop the subscription first, then give the daemon back every spool still open.
   *
   * The wake-up is cancelled here rather than left to fire against a disposed carrier:
   * a timeout that outlived its surface would publish into an emitter whose sinks are
   * gone, which is a stamp nobody reads and a handle nobody can cancel.
   */
  public dispose(): void {
    this.#cancelStallWakeUp();
    this.#clientSubscription?.();
    this.#clientSubscription = undefined;
    this.#client.dispose();
  }

  #publish(entries: readonly AttachmentIngestEntry[]): void {
    this.#snapshot = { entries, publishedAtMilliseconds: this.#clock.now() };
    // Armed BEFORE the emit, because `Emitter` re-raises a sink that threw: a wake-up
    // scheduled after a throwing subscriber would never be armed at all, and the
    // stalled upload it was for would go on charting the instant it stopped at.
    this.#armStallWakeUp();
    this.#changes.emit(this.#snapshot);
  }

  /**
   * Arrange the one wake-up the outstanding entries call for, and no other.
   *
   * ONE TIMER PER CARRIER, at the EARLIEST deadline still ahead of now. A timer per
   * entry would arm one per upload for a disclosure that is the same sentence on each,
   * and a deadline already behind now needs no wake-up at all — the snapshot being
   * published carries an instant past it, so the card is rendering the stalled arm as
   * this runs. When that wake-up fires it publishes and lands back here, which is what
   * re-arms it for the next entry's deadline: a chain of single shots rather than a
   * repeat, and one that stops on its own the moment nothing is outstanding.
   */
  #armStallWakeUp(): void {
    this.#cancelStallWakeUp();
    const deadlineMilliseconds = this.#earliestStallDeadlineMs();
    if (deadlineMilliseconds === undefined) {
      return;
    }
    this.#stallWakeUpHandle = this.#clock.scheduleTimeout(() => {
      this.#stallWakeUpHandle = undefined;
      // The same entries, a fresh instant. Nothing is read and nothing is asked: the
      // disclosure is a function of how long ago the last progress was, and this is
      // the moment that answer changes.
      this.#publish(this.#snapshot.entries);
    }, deadlineMilliseconds - this.#clock.now());
  }

  /** The soonest disclosure deadline still ahead of now, or `undefined` for none. */
  #earliestStallDeadlineMs(): number | undefined {
    const nowMilliseconds = this.#clock.now();
    let earliestMilliseconds: number | undefined;
    for (const entry of this.#snapshot.entries) {
      const deadlineMilliseconds = ingestStallDisclosureAtMs(entry);
      if (deadlineMilliseconds === undefined || deadlineMilliseconds <= nowMilliseconds) {
        continue;
      }
      if (earliestMilliseconds === undefined || deadlineMilliseconds < earliestMilliseconds) {
        earliestMilliseconds = deadlineMilliseconds;
      }
    }
    return earliestMilliseconds;
  }

  #cancelStallWakeUp(): void {
    if (this.#stallWakeUpHandle === undefined) {
      return;
    }
    this.#clock.cancel(this.#stallWakeUpHandle);
    this.#stallWakeUpHandle = undefined;
  }
}

/** What a surface holding a carrier renders and acts through. */
export interface AttachmentCarrierBinding {
  readonly snapshot: AttachmentCarrierSnapshot;
  readonly attachFiles: (files: readonly File[]) => void;
  readonly retry: (localId: string) => void;
  readonly abandon: (localId: string) => void;
}

/**
 * Bind one carrier to one component's lifetime.
 *
 * The carrier is memoised on its collaborators rather than built in the render body,
 * so a re-render does not mint a second client over the same session — which would
 * leave the first one's open streams unreachable and its spools to the daemon's
 * reaper.
 */
export function useAttachmentCarrier(
  bridge: ConsoleBridge,
  sessionId: string,
): AttachmentCarrierBinding {
  const carrier = useMemo(() => new AttachmentCarrier({ bridge, sessionId }), [bridge, sessionId]);
  useEffect(() => {
    carrier.start();
    return () => {
      carrier.dispose();
    };
  }, [carrier]);
  const subscribe = useCallback(
    (onCarrierChange: () => void) => carrier.subscribe(onCarrierChange),
    [carrier],
  );
  const read = useCallback(() => carrier.snapshot, [carrier]);
  const snapshot = useSyncExternalStore(subscribe, read, read);
  const attachFiles = useCallback(
    (files: readonly File[]) => {
      carrier.attachFiles(files);
    },
    [carrier],
  );
  const retry = useCallback(
    (localId: string) => {
      carrier.retry(localId);
    },
    [carrier],
  );
  const abandon = useCallback(
    (localId: string) => {
      carrier.abandon(localId);
    },
    [carrier],
  );
  return { snapshot, attachFiles, retry, abandon };
}
