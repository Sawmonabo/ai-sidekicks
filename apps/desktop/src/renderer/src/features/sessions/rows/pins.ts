// Which sessions are pinned, and where that fact lives. Pins are per-install view state,
// never auth material and never sent anywhere, so the map is a durable UI-state record in the
// persistence layer's global partition under the `pin` value class, written through
// `UiStateStore`.
//
// Only pinned sessions are written: unpinning deletes the entry, so the record grows with the
// person's decisions, not with the sessions they have opened.

import type { Refusal } from "#renderer/lib/refusal/contract.js";
import { isWireRecord } from "#renderer/lib/wire/record.js";
import type { UiStateStore } from "#renderer/store/persistence/ui-state-store.js";
import { DurableViewState } from "#renderer/store/persistence/durable-view-state.js";

/** The record key inside the global partition. Identifier-shaped, as the store requires. */
export const PINNED_SESSIONS_KEY = "session-pins";

/** The literal the `pin` value class stores for a pinned session. */
const PINNED = "pinned";

/** The persisted map: session identifier to the pinned literal, pinned sessions only. */
export type SessionPins = Readonly<Record<string, typeof PINNED>>;

/** The empty pin map: what a list shows before a record is read. */
export const NO_PINS: SessionPins = {};

/** What a view holds: the map, the last refusal, and the one act that changes it. */
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

  /** The current pin map. */
  public get pinned(): SessionPins {
    return this.#state.value;
  }

  /** The last refused write, so the list renders it instead of hiding it. */
  public get lastRefusal(): Refusal | undefined {
    return this.#state.lastRefusal;
  }

  /** Listens for changes; returns the unsubscribe. */
  public subscribe(sink: () => void): () => void {
    return this.#state.subscribe(sink);
  }

  /** Reads the saved pin map once. */
  public async hydrate(): Promise<void> {
    await this.#state.hydrate();
  }

  /** Released when the window's durable store is replaced. Terminal. */
  public dispose(): void {
    this.#state.dispose();
  }

  /** Pins or unpins one session. Unpinning removes the entry rather than storing a default. */
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
 * Narrows a stored record back into a pin map, dropping entries that do not survive. Per entry,
 * so one bad value loses one pin instead of un-pinning the whole list.
 */
export function narrowSessionPins(raw: unknown): SessionPins | undefined {
  if (!isWireRecord(raw)) {
    return undefined;
  }
  const narrowed: Record<string, typeof PINNED> = {};
  for (const [sessionId, marker] of Object.entries(raw)) {
    if (marker === PINNED) {
      narrowed[sessionId] = PINNED;
    }
  }
  return narrowed;
}
