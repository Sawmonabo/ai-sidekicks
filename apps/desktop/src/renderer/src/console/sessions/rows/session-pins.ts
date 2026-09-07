// Which sessions are pinned to the front tier, and where that fact lives.
//
// `Spec-023 §Console Design (Meridian)` §All-sessions list: "Pin, unpin, move
// tier: renderer-local, persisted to shell-local config … pins are per-install
// view state, they are never auth material, and they never travel."
//
// So the pin map is a durable UI-state record in the persistence layer's GLOBAL
// partition — the window-wide one, not a session's — under the `pin` value class,
// whose closed shape (`front` or `back` per session) is exactly what a pin is. It
// travels through `UiStateStore` like every other durable byte in this console;
// nothing here opens an adapter or measures a quota.
//
// ONLY THE EXCEPTIONS ARE WRITTEN DOWN. The back tier is the default, so a row
// nobody has pinned has no record at all and moving a row back DELETES its entry
// rather than storing the default. That keeps the record proportional to the
// decisions a person actually made instead of to the number of sessions they have
// ever opened — and it is why the list offers "move to the back tier" and no
// separate "unpin": with two tiers and a default, those are one act.

import { useCallback, useSyncExternalStore } from "react";

import type { ConsoleRefusal } from "../../core/index.js";
import type { UiStateStore } from "../../persistence/index.js";
import {
  DurableViewBindingHolder,
  noDurableViewSubscription,
  useDurableViewBinding,
} from "../durable-view/durable-view-binding.js";
import { DurableViewState } from "../durable-view/durable-view-state.js";
import {
  DEFAULT_SESSION_PIN_TIER,
  SESSION_PIN_TIERS,
  type SessionPinTier,
} from "./session-rows.js";

/** The record key inside the global partition. Identifier-shaped, as the store requires. */
export const SESSION_PIN_TIERS_KEY = "session-pin-tiers";

/** The persisted map: session identifier to tier, exceptions only. */
export type SessionPinMap = Readonly<Record<string, SessionPinTier>>;

const NO_PINS: SessionPinMap = {};

function isSessionPinTier(candidate: unknown): candidate is SessionPinTier {
  return (
    typeof candidate === "string" && (SESSION_PIN_TIERS as readonly string[]).includes(candidate)
  );
}

/**
 * Narrow a stored record back into a pin map, dropping entries that do not survive.
 *
 * Per ENTRY rather than per record: a single unrecognised tier — an older build's
 * vocabulary, or a hand-edited store — discards that session's pin and keeps
 * everyone else's, where refusing the whole record would silently un-pin a list a
 * person had arranged.
 */
export function narrowSessionPinMap(raw: unknown): SessionPinMap | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const narrowed: Record<string, SessionPinTier> = {};
  for (const [sessionId, tier] of Object.entries(raw as Readonly<Record<string, unknown>>)) {
    if (isSessionPinTier(tier)) {
      narrowed[sessionId] = tier;
    }
  }
  return narrowed;
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

  public get tiers(): SessionPinMap {
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

  /**
   * Put one session in a tier.
   *
   * Moving to the default tier removes the entry rather than storing the default,
   * which is what makes "move to the back tier" and "unpin" the same act and keeps
   * the durable record to the decisions a person actually made.
   */
  public async setTier(sessionId: string, tier: SessionPinTier): Promise<void> {
    const next: Record<string, SessionPinTier> = { ...this.#state.value };
    if (tier === DEFAULT_SESSION_PIN_TIER) {
      delete next[sessionId];
    } else {
      next[sessionId] = tier;
    }
    await this.#state.commit(next);
  }
}

/** What a surface holds: the map, the refusal, and the one act that changes it. */
export interface SessionPinBinding {
  readonly tiers: SessionPinMap;
  readonly lastRefusal: ConsoleRefusal | undefined;
  readonly setTier: (sessionId: string, tier: SessionPinTier) => void;
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
 * which `apps/desktop/AGENTS.md` §State and views rejects: the supersession rule is an
 * invariant over two fields moving together and is only checkable with one owner.
 */
const consoleSessionPins = new DurableViewBindingHolder(mintSessionPinStore);

/** The tier a pinned session sits on, named where the durable write is composed. */
const PINNED_SESSION_TIER: SessionPinTier = "front";

/**
 * Put one session on the front tier through the binding this window is holding NOW.
 *
 * FOR A CALLER THAT IS NOT RENDERING — the auto-pin authority a settled start stamps,
 * which is consulted on a first send that usually happens after this destination has
 * unmounted and after a person may have rearranged the list by hand. It resolves the
 * held binding rather than acquiring against a store it captured, because the store a
 * caller saw when it was composed may be one this window has since closed, and
 * acquiring against that identity would supersede the live binding with a successor
 * over a dead database.
 *
 * A window holding no pin binding writes nothing, which is the honest answer rather
 * than a swallow: no binding means this window has no durable store to put a pin in.
 * It is unreachable from the one caller there is — a session can only have been
 * started from the destination that acquires this binding on mount.
 */
export function pinSessionToFrontTier(sessionId: string): void {
  // Not awaited, and the rejection cannot escape, for `setTierThrough`'s reason: the
  // store declares its failure as a recorded refusal rather than as a rejection.
  void consoleSessionPins.heldBinding?.setTier(sessionId, PINNED_SESSION_TIER);
}

/**
 * The pin act, bound to whatever store the acquirer is holding when it is pressed.
 *
 * Module-level and taking the acquirer rather than written inline in the hook, so the
 * act's own two arguments — the row it is about and the tier it moves to — are its
 * parameters and nothing else. Written inside the hook it read as a value keyed on a
 * session, which is the one shape a surface must not hold by hand.
 */
function setTierThrough(
  acquire: () => SessionPinStore,
): (sessionId: string, tier: SessionPinTier) => void {
  return (sessionId, tier) => {
    // Not awaited, and the rejection cannot escape: `setTier` declares its failure
    // as a recorded refusal rather than as a rejection, so there is nothing here for
    // a caller to catch.
    void acquire().setTier(sessionId, tier);
  };
}

/**
 * Bind the pin map into a component.
 *
 * KEYED ON THE STORE'S IDENTITY, through this window's one pin holder. It was built
 * by a `useState` initializer instead — which runs once per mounted component and is
 * never recomputed — so when `frame/ui-state-lifecycle.ts` replaced this window's
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
  const readTiers = useCallback(() => binding?.tiers ?? NO_PINS, [binding]);
  const tiers = useSyncExternalStore(subscribe, readTiers, readTiers);
  // Read AFTER the subscription, deliberately. A write whose refusal CHANGED —
  // raised or cleared — emits on its own, so the component re-renders and this
  // getter is re-read; folding the refusal into the subscribed value instead would
  // change the map's identity on a write that did not change the map, and every
  // memoised row would re-render.
  const setTier = useCallback(setTierThrough(acquire), [acquire]);
  return { tiers, lastRefusal: binding?.lastRefusal, setTier };
}
