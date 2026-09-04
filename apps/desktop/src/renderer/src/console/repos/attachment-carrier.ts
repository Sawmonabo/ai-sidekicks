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
// THE INSTANT IS PUBLISHED WITH THE ENTRIES, AND THAT IS THE NO-TIMER RULE MADE
// STRUCTURAL. `AttachmentCard` reads a stall disclosure and a stream ceiling off an
// instant it is handed, so something has to supply one. A card that read the wall
// clock in its own render would move an age with nobody acting, and a surface that
// re-stamped on every render would do the same thing one level up. So the stamp is
// taken WHEN THE LEDGER PUBLISHES and carried in the same snapshot the entries are:
// an age moves when the upload moves, and at no other moment. There is no interval
// here and there can be none — this file mints no timer.
//
// THE LOCAL ID IS THE CARRIER'S, NOT THE FILE'S. Two files chosen in one picker can
// carry one name, and the ledger is keyed by local id — so a carrier that keyed on
// the declared name would silently drop the second of two `notes.md`. The counter
// rises and never repeats, which is the whole requirement.

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import type { ConsoleBridge } from "../bridge/index.js";
import { Emitter, RealClock, type ConsoleClock, type Unsubscribe } from "../core/index.js";
import { AttachmentIngestClient } from "./attachment-ingest-machine.js";
import { attachmentSourceFrom, type AttachmentIngestEntry } from "./attachment-model.js";

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

  /** Drop the subscription first, then give the daemon back every spool still open. */
  public dispose(): void {
    this.#clientSubscription?.();
    this.#clientSubscription = undefined;
    this.#client.dispose();
  }

  #publish(entries: readonly AttachmentIngestEntry[]): void {
    this.#snapshot = { entries, publishedAtMilliseconds: this.#clock.now() };
    this.#changes.emit(this.#snapshot);
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
