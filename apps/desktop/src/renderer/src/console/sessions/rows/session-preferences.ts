// The destination's own switches, and where they live.
//
// One today: whether a session a person starts and then sends into is pinned to the
// front tier for them. `Spec-023 §Console Design (Meridian)` §All-sessions list makes
// pins renderer-local view state persisted to shell-local config, and this is a rule
// ABOUT pins, so it lives in the same place they do — the persistence layer's global
// partition, under the `preference` value class, through `UiStateStore` like every
// other durable byte in this console.
//
// A SEPARATE RECORD FROM THE PIN MAP, and deliberately: the pin map is keyed by
// session and this is keyed by nothing, so folding the switch in would need a
// reserved session id that is not a session — the smuggling shape the closed value
// classes exist to refuse. Two records, two classes, one store.
//
// DEFAULTS ARE NOT WRITTEN. The switch is on by default, so a person who has never
// touched it has no record at all and turning it back on DELETES the entry rather
// than storing the default — the rule the pin map next door already follows, for the
// same reason: the durable record stays proportional to the decisions somebody
// actually made.

import { useCallback, useSyncExternalStore } from "react";

import type { ConsoleRefusal } from "../../core/index.js";
import type { UiStateStore } from "../../persistence/index.js";
import {
  noDurableViewSubscription,
  useDurableViewBinding,
} from "../durable-view/durable-view-binding.js";
import { DurableViewState } from "../durable-view/durable-view-state.js";

/** The record key inside the global partition. Identifier-shaped, as the store requires. */
export const SESSION_PREFERENCES_KEY = "session-preferences";

/** The one switch this record holds today, as its stored name. */
export const AUTO_PIN_ON_FIRST_SEND = "auto-pin-on-first-send";

/**
 * On unless a person turned it off.
 *
 * `Spec-023 §Console Design (Meridian)` §All-sessions list states the default, and it
 * is stated here as a constant rather than as a `?? true` at each reader: two readers
 * disagreeing about a default is a switch that reads as on in one place and off in
 * another.
 */
export const AUTO_PIN_ON_FIRST_SEND_DEFAULT = true;

/** The persisted record: switch name to state, exceptions only. */
export type SessionPreferenceMap = Readonly<Record<string, boolean>>;

/**
 * Everything a subscribed surface reads, as one value it can compare.
 *
 * A RECORD AND NOT THE BOOLEAN, because the switch is not the whole of what the
 * surface renders. A refused write leaves the switch exactly where the person put it
 * — the state machine records the refusal rather than rolling the value back — and
 * changes only `lastRefusal`. A snapshot carrying the boolean alone was therefore
 * `Object.is`-equal across precisely the settlement somebody needed to see: the state
 * emitted, React compared, found nothing moved, and suppressed the render, so a
 * quota or storage refusal stayed off screen until an unrelated render happened to
 * bring it. Both fields ride one snapshot now, so the emission and the comparison
 * are about the same thing.
 */
export interface SessionPreferenceSnapshot {
  readonly isAutoPinOnFirstSendEnabled: boolean;
  readonly lastRefusal: ConsoleRefusal | undefined;
}

const NO_PREFERENCES: SessionPreferenceMap = {};

/**
 * Narrow a stored record back into a preference map, dropping entries that do not
 * survive.
 *
 * Per ENTRY rather than per record, on the pin map's own reasoning: one unrecognised
 * value should cost that switch and not every other one a person has set.
 */
export function narrowSessionPreferenceMap(raw: unknown): SessionPreferenceMap | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const narrowed: Record<string, boolean> = {};
  for (const [name, state] of Object.entries(raw as Readonly<Record<string, unknown>>)) {
    if (typeof state === "boolean") {
      narrowed[name] = state;
    }
  }
  return narrowed;
}

/** The switches, durable. One per window; the surface builds it once and holds it. */
export class SessionPreferenceStore {
  readonly #state: DurableViewState<SessionPreferenceMap>;
  /**
   * The last snapshot handed out, kept so an unchanged reading stays the same object.
   *
   * `undefined` until the first read rather than seeded with the default pair: a
   * seeded literal would be a second statement of what the two getters below already
   * answer, free to disagree with them the day either one grows a rule.
   */
  #snapshot: SessionPreferenceSnapshot | undefined;

  public constructor(store: UiStateStore) {
    this.#state = new DurableViewState<SessionPreferenceMap>({
      store,
      key: SESSION_PREFERENCES_KEY,
      valueClass: "preference",
      initial: NO_PREFERENCES,
      narrow: narrowSessionPreferenceMap,
    });
  }

  public get isAutoPinOnFirstSendEnabled(): boolean {
    return this.#state.value[AUTO_PIN_ON_FIRST_SEND] ?? AUTO_PIN_ON_FIRST_SEND_DEFAULT;
  }

  /** The last refused write, so the surface renders it instead of hiding it. */
  public get lastRefusal(): ConsoleRefusal | undefined {
    return this.#state.lastRefusal;
  }

  /**
   * Both facts at once, as one value that re-identifies only when one of them moves.
   *
   * MEMOISED HERE RATHER THAN COMPOSED AT THE READER, because `useSyncExternalStore`
   * calls its snapshot getter on every render and compares the answer with
   * `Object.is`: a record built fresh each call is a new object every time, which
   * React reads as a store that changed on every render — an infinite re-render
   * rather than the suppressed one this replaces.
   *
   * The refusal is compared by IDENTITY, which is what the state machine next door
   * publishes: two refusals for the same cause are two objects, and the second one is
   * this write's own reason rather than the last one's, so it is a change and a
   * surface showing it again is showing something new.
   */
  public get snapshot(): SessionPreferenceSnapshot {
    const isAutoPinOnFirstSendEnabled = this.isAutoPinOnFirstSendEnabled;
    const lastRefusal = this.lastRefusal;
    const held = this.#snapshot;
    if (
      held !== undefined &&
      held.isAutoPinOnFirstSendEnabled === isAutoPinOnFirstSendEnabled &&
      held.lastRefusal === lastRefusal
    ) {
      return held;
    }
    const taken: SessionPreferenceSnapshot = { isAutoPinOnFirstSendEnabled, lastRefusal };
    this.#snapshot = taken;
    return taken;
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

  /** Set one switch, writing nothing where the state is already the default. */
  public async setEnabled(name: string, isEnabled: boolean): Promise<void> {
    const next: Record<string, boolean> = { ...this.#state.value };
    if (isEnabled === AUTO_PIN_ON_FIRST_SEND_DEFAULT && name === AUTO_PIN_ON_FIRST_SEND) {
      delete next[name];
    } else {
      next[name] = isEnabled;
    }
    await this.#state.commit(next);
  }
}

/** What a surface holds: the switch, the refusal, and the one act that changes it. */
export interface SessionPreferenceBinding {
  readonly isAutoPinOnFirstSendEnabled: boolean;
  readonly lastRefusal: ConsoleRefusal | undefined;
  readonly setAutoPinOnFirstSend: (isEnabled: boolean) => void;
}

/** How a preference store is minted. Module-level, because the holder reads it once. */
function mintSessionPreferenceStore(store: UiStateStore): SessionPreferenceStore {
  return new SessionPreferenceStore(store);
}

/**
 * What a mount whose acquiring effect has not run yet reads.
 *
 * Frozen at module level for the same reason the store memoises its own: a literal
 * built inside the read callback would be a new object on every render of the opening
 * arm, and `useSyncExternalStore` would read that as a store changing under it.
 */
const NO_BINDING_SNAPSHOT: SessionPreferenceSnapshot = {
  isAutoPinOnFirstSendEnabled: AUTO_PIN_ON_FIRST_SEND_DEFAULT,
  lastRefusal: undefined,
};

/** The switch act, bound to whatever store the acquirer is holding when it is pressed. */
function setAutoPinThrough(acquire: () => SessionPreferenceStore): (isEnabled: boolean) => void {
  return (isEnabled) => {
    // Not awaited, and the rejection cannot escape: the store declares its failure as
    // a recorded refusal rather than as a rejection, which is what lets a pin that
    // failed to persist surface as its own failure rather than as the act's.
    void acquire().setEnabled(AUTO_PIN_ON_FIRST_SEND, isEnabled);
  };
}

/**
 * Bind the switches into a component.
 *
 * Through the same holder the pin binding uses, and for the same reason its own
 * header gives: a store built by a `useState` initializer stays attached to the
 * database the window closed when the bridge or scenario changed.
 *
 * BOTH RENDERED FACTS COME OFF THE SUBSCRIBED SNAPSHOT, and the refusal is the reason
 * it has to. Read beside the subscription instead — off the binding, during the
 * render — it was a value nothing told React had moved: the state emits when a write
 * is refused, React compared a snapshot that carried only the switch, found it
 * unchanged, and suppressed the render that would have put the refusal on screen.
 */
export function useSessionPreferences(store: UiStateStore): SessionPreferenceBinding {
  const { binding, acquire } = useDurableViewBinding(store, mintSessionPreferenceStore);
  const subscribe = useCallback(
    (onStoreChange: () => void) => binding?.subscribe(onStoreChange) ?? noDurableViewSubscription,
    [binding],
  );
  const readSnapshot = useCallback(() => binding?.snapshot ?? NO_BINDING_SNAPSHOT, [binding]);
  const snapshot = useSyncExternalStore(subscribe, readSnapshot, readSnapshot);
  const setAutoPinOnFirstSend = useCallback(setAutoPinThrough(acquire), [acquire]);
  return {
    isAutoPinOnFirstSendEnabled: snapshot.isAutoPinOnFirstSendEnabled,
    lastRefusal: snapshot.lastRefusal,
    setAutoPinOnFirstSend,
  };
}
