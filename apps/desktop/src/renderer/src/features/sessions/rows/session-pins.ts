// Which sessions are pinned, and where that fact lives.
//
// Pin and unpin are renderer-local, persisted to machine-local config: pins are
// per-install view state, they are never auth material, and they never travel.
//
// So the pin map is a durable UI-state record in the persistence layer's GLOBAL
// partition, the window-wide one, not a session's, under the `pin` value class. It
// travels through `UiStateStore` like every other durable byte in this console;
// nothing here opens an adapter or measures a quota.
//
// ONLY PINNED SESSIONS ARE WRITTEN DOWN. An unpinned row has no record at all and
// unpinning DELETES its entry, so the record is proportional to the decisions a person
// made and not to the number of sessions they have ever opened.

import type { Refusal } from "@renderer/lib/refusal.js";
import type { UiStateStore } from "@renderer/store/persistence/ui-state-store.js";
import { DurableViewState } from "../durable-view/durable-view-state.js";

/** The record key inside the global partition. Identifier-shaped, as the store requires. */
export const PINNED_SESSIONS_KEY = "session-pin-tiers";

/** The literal the `pin` value class stores for a pinned session. */
const PINNED = "front";

/** The persisted map: session identifier to the pinned literal, pinned sessions only. */
export type SessionPins = Readonly<Record<string, typeof PINNED>>;

/** The empty pin map: what a list shows before a record is read. */
export const NO_PINS: SessionPins = {};

/** What a view holds: the map, the refusal, and the one act that changes it. */
export interface SessionPinBinding {
  readonly pinned: SessionPins;
  readonly lastRefusal: Refusal | undefined;
  readonly setPinned: (sessionId: string, isPinned: boolean) => void;
}

/** The pin map, durable. One per window; the screen builds it once and holds it. */
export class SessionPinStore {
  readonly #state: DurableViewState<SessionPins>;

  public constructor(store: UiStateStore) {
    this.#state = new DurableViewState<SessionPins>({
      store,
      key: PINNED_SESSIONS_KEY,
      valueClass: "pin",
      initial: NO_PINS,
      narrow: narrowSessionPins,
    });
  }

  public get pinned(): SessionPins {
    return this.#state.value;
  }

  /** The last refused write, so the list renders it instead of hiding it. */
  public get lastRefusal(): Refusal | undefined {
    return this.#state.lastRefusal;
  }

  public subscribe(sink: () => void): () => void {
    return this.#state.subscribe(sink);
  }

  public async hydrate(): Promise<void> {
    await this.#state.hydrate();
  }

  /** Released when the window's durable store is replaced. Terminal. */
  public dispose(): void {
    this.#state.dispose();
  }

  /** Whether this store has been superseded. Read by the binding's own test. */
  public get isDisposed(): boolean {
    return this.#state.isDisposed;
  }

  /** Pin or unpin one session. Unpinning removes the entry rather than storing a default. */
  public async setPinned(sessionId: string, isPinned: boolean): Promise<void> {
    const next: Record<string, typeof PINNED> = { ...this.#state.value };
    if (isPinned) {
      next[sessionId] = PINNED;
    } else {
      delete next[sessionId];
    }
    await this.#state.commit(next);
  }
}

/**
 * Narrow a stored record back into a pin map, dropping entries that do not survive.
 *
 * Per ENTRY rather than per record: a single unrecognized value discards that session's
 * pin and keeps everyone else's, where refusing the whole record would silently un-pin
 * a list a person had arranged.
 */
export function narrowSessionPins(raw: unknown): SessionPins | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const narrowed: Record<string, typeof PINNED> = {};
  for (const [sessionId, marker] of Object.entries(raw as Readonly<Record<string, unknown>>)) {
    if (marker === PINNED) {
      narrowed[sessionId] = PINNED;
    }
  }
  return narrowed;
}
