// Which sessions are pinned, and where that fact lives.
//
// Pin and unpin are renderer-local, persisted to shell-local config: pins are
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

import { useCallback, useSyncExternalStore } from "react";

import type { ConsoleRefusal } from "@renderer/lib/refusal.js";
import type { UiStateStore } from "@renderer/store/persistence/ui-state-store.js";
import {
  DurableViewBindingHolder,
  noDurableViewSubscription,
  useDurableViewBinding,
} from "../durable-view/durable-view-binding.js";
import { DurableViewState } from "@renderer/features/sessions/durable-view/durable-view-state.js";

/** The record key inside the global partition. Identifier-shaped, as the store requires. */
export const SESSION_PIN_TIERS_KEY = "session-pin-tiers";

/** The literal the `pin` value class stores for a pinned session. */
const PINNED = "front";

/** The persisted map: session identifier to the pinned literal, pinned sessions only. */
export type SessionPinMap = Readonly<Record<string, typeof PINNED>>;

const NO_PINS: SessionPinMap = {};

/** What a surface holds: the map, the refusal, and the one act that changes it. */
export interface SessionPinBinding {
  readonly pinned: SessionPinMap;
  readonly lastRefusal: ConsoleRefusal | undefined;
  readonly setPinned: (sessionId: string, isPinned: boolean) => void;
}

/** The pin map, durable. One per window; the surface builds it once and holds it. */
export class SessionPinStore {
  readonly #state: DurableViewState<SessionPinMap>;

  public constructor(store: UiStateStore) {
    this.#state = new DurableViewState<SessionPinMap>({
      store,
      key: SESSION_PIN_TIERS_KEY,
      valueClass: "pin",
      initial: NO_PINS,
      narrow: narrowSessionPinMap,
    });
  }

  public get pinned(): SessionPinMap {
    return this.#state.value;
  }

  /** The last refused write, so the list renders it instead of hiding it. */
  public get lastRefusal(): ConsoleRefusal | undefined {
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
export function narrowSessionPinMap(raw: unknown): SessionPinMap | undefined {
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

/** How a pin store is minted. Module-level, because the holder reads it once. */
function mintSessionPinStore(store: UiStateStore): SessionPinStore {
  return new SessionPinStore(store);
}

/**
 * This window's pin map, held for as long as the window is open.
 *
 * ONE HOLDER PER WINDOW AND NOT ONE PER MOUNT, on the precedent
 * `settings/shared/shell-preferences/shell-preferences-holder.ts` states in its own
 * words: module scope IS window scope here, since an auxiliary window is its own
 * renderer process and no channel joins two windows' module graphs. Minted inside the
 * hook instead, a second visit to the sessions destination built a second store over
 * the one database — two writers of one record, each spreading its own in-memory copy
 * of it over the other's writes.
 *
 * A `const` holding an encapsulated object rather than a module-level `let` or `Map`,
 * which the state-and-views rule in `apps/desktop/AGENTS.md` rejects: the supersession
 * rule is an invariant over two fields moving together and is only checkable with one
 * owner.
 */
const consoleSessionPins = new DurableViewBindingHolder(mintSessionPinStore);

/**
 * Bind the pin map into a component.
 *
 * KEYED ON THE STORE'S IDENTITY, through this window's one pin holder. It was built
 * by a `useState` initializer instead — which runs once per mounted component and is
 * never recomputed — so when `frame/bindings/ui-state-lifecycle.ts` replaced this window's
 * store after a bridge or scenario change, the pins stayed attached to the closed
 * one: the previous scenario's map stayed on screen, every later write went to a
 * database nothing reads, and the replacement was never hydrated. The HOLDER's own
 * lifetime was the mount's for the same reason and cost the mirror image of it — a
 * second visit to this destination minted a rival store over the live database.
 *
 * The hydrate rides the holder's own effect, so a render pass React discards still
 * performs no durable read.
 */
export function useSessionPins(store: UiStateStore): SessionPinBinding {
  const { binding, acquire } = useDurableViewBinding(consoleSessionPins, store);
  const subscribe = useCallback(
    (onStoreChange: () => void) => binding?.subscribe(onStoreChange) ?? noDurableViewSubscription,
    [binding],
  );
  const readPinned = useCallback(() => binding?.pinned ?? NO_PINS, [binding]);
  const pinned = useSyncExternalStore(subscribe, readPinned, readPinned);
  // Read AFTER the subscription, deliberately. A write whose refusal CHANGED —
  // raised or cleared — emits on its own, so the component re-renders and this
  // getter is re-read; folding the refusal into the subscribed value instead would
  // change the map's identity on a write that did not change the map, and every
  // memoised row would re-render.
  const setPinned = useCallback(setPinnedThrough(acquire), [acquire]);
  return { pinned, lastRefusal: binding?.lastRefusal, setPinned };
}

/**
 * The pin act, bound to whatever store the acquirer is holding when it is pressed.
 *
 * Module-level and taking the acquirer, so the act's own two arguments are its
 * parameters and nothing else.
 */
function setPinnedThrough(
  acquire: () => SessionPinStore,
): (sessionId: string, isPinned: boolean) => void {
  return (sessionId, isPinned) => {
    // Not awaited, and the rejection cannot escape: `setPinned` declares its failure
    // as a recorded refusal rather than as a rejection.
    void acquire().setPinned(sessionId, isPinned);
  };
}
