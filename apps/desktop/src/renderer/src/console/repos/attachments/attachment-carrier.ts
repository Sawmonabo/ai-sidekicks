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

import { consoleClockFor, type ConsoleBridge } from "../../bridge/index.js";
import {
  Emitter,
  type ConsoleClock,
  type ScheduledHandle,
  type Unsubscribe,
} from "../../core/index.js";
import { earliestFutureDeadline, useSubjectScopedResource } from "../../store/index.js";
import { AttachmentIngestClient } from "./attachment-ingest-machine.js";
import { ingestStallDisclosureAtMs } from "./attachment-presentation.js";
import { attachmentSourceFrom, type AttachmentIngestEntry } from "./attachment-shapes.js";

/** What the carrier holds, and the instant it last said so. */
export interface AttachmentCarrierSnapshot {
  readonly entries: readonly AttachmentIngestEntry[];
  /** The instant of the publish that produced these entries. Never the wall clock at render. */
  readonly publishedAtMilliseconds: number;
}

export interface AttachmentCarrierOptions {
  readonly bridge: ConsoleBridge;
  readonly sessionId: string;
  /**
   * The clock every stamp this carrier publishes is taken from.
   *
   * REQUIRED, AND THE BINDING BELOW READS IT OFF THE BRIDGE. It used to default to a
   * fresh `RealClock`, which made the default the wall clock in exactly the place the
   * fixture is supposed to own time: `consoleClockFor` is the one answer to which
   * clock a window runs on, so a carrier under the fixture stamped its entries from
   * wall time while the scenario's beats advanced on frozen time, and a surface
   * showing an age disagreed with the ledger it was reading. A default is what let
   * that happen without a call site saying so, so there is none.
   */
  readonly clock: ConsoleClock;
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
  #disposed = false;

  public constructor(options: AttachmentCarrierOptions) {
    this.#clock = options.clock;
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
   * Whether this carrier has been torn down. Read by the hook that owns its lifetime.
   *
   * ASKED RATHER THAN REMEMBERED, on `UiStateStore.isClosed`'s reason: the owner
   * deciding whether to re-mint has one question, and a second flag beside it would be
   * a copy of this one to keep in step.
   */
  public get isDisposed(): boolean {
    return this.#disposed;
  }

  /**
   * Begin following the ledger.
   *
   * IDEMPOTENT, on `dispose`'s own reason next door: React runs an effect twice in
   * development strict mode, and a second subscription would restamp and re-emit for
   * every publish forever after.
   */
  public start(): void {
    if (this.#disposed) {
      // A disposed carrier's client refuses every attach, so subscribing to it would
      // follow a ledger nothing can add to. The owner re-mints instead — see the hook.
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
    this.#disposed = true;
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

  /**
   * The soonest disclosure deadline still ahead of now, or `undefined` for none.
   *
   * WHICH ENTRIES HAVE A DEADLINE IS THIS CLASS'S QUESTION; which of them is next is
   * the console's, and `earliestFutureDeadline` answers it for every surface that
   * renders against one. A carrier is not a render, so it arms its own single shot
   * rather than taking the hook beside that rule — but a second copy of the rule was
   * the part worth removing, and this is the whole of what is left.
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

/** What a surface holding a carrier renders and acts through. */
export interface AttachmentCarrierBinding {
  readonly snapshot: AttachmentCarrierSnapshot;
  readonly attachFiles: (files: readonly File[]) => void;
  readonly retry: (localId: string) => void;
  readonly abandon: (localId: string) => void;
}

/** Close one carrier. Declared once so the resource seam holds one identity for it. */
function closeAttachmentCarrier(carrier: AttachmentCarrier): void {
  carrier.dispose();
}

/**
 * Bind one carrier to one component's lifetime.
 *
 * THE SUBJECT IS THE BRIDGE AND THE KEY IS THE SESSION, which is what a carrier is
 * scoped to, so the console's own resource seam holds it: `useSubjectScopedResource`
 * opens the carrier on the render that first sees a `(bridge, session)` pair and
 * closes it however that render ended — including the pass React discards, which a
 * `useState` initializer with an effect-held cleanup never closed at all. It is also
 * what keeps this module off a second implementation of subject-scoped state; the
 * chokepoint gate beside the holder fails the build on one.
 *
 * A RE-MINT ARM STILL, and for the reason it always had. React's StrictMode
 * double-mount runs the seam's cleanup and then this effect's setup again on the SAME
 * committed carrier: the cleanup terminally disposed the ingest client, the replayed
 * setup called `start()` on the corpse, and every file the participant chose
 * afterwards reached a client whose `attach` returns at once — the attachment surface
 * inert, with nothing on screen to say so. Asking the carrier whether it is disposed
 * is what makes that arm correct without a second flag, and the replacement is
 * PUBLISHED through the seam, so it is closed on the seam's own terms rather than by
 * a cleanup of this effect's.
 */
export function useAttachmentCarrier(
  bridge: ConsoleBridge,
  sessionId: string,
): AttachmentCarrierBinding {
  // The window's own clock, resolved once per bridge — `clone-expiry-wake-up.ts`'s
  // shape, for its reason: `consoleClockFor` mints a fresh `RealClock` per call on a
  // live bridge, so reading it in a render body would hand the re-mint arm below a
  // different instance from the one the first carrier was opened on.
  const clock = useMemo(() => consoleClockFor(bridge), [bridge]);
  const { value: carrier, settle } = useSubjectScopedResource(
    bridge,
    sessionId,
    () => new AttachmentCarrier({ bridge, sessionId, clock }),
    closeAttachmentCarrier,
  );
  useEffect(() => {
    if (carrier.isDisposed) {
      settle()(new AttachmentCarrier({ bridge, sessionId, clock }));
      return;
    }
    carrier.start();
  }, [carrier, settle, bridge, sessionId, clock]);
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
