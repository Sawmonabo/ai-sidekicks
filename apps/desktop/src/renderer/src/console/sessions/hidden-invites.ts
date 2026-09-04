// Invitations a person has set aside, and why setting one aside is all this does.
//
// `InviteState` on the wire is exactly `pending | accepted | revoked | expired`
// (`packages/contracts/src/invites.ts`), and its own header states the reason
// there is no fifth: "Declining is implicit in V1 … there is no explicit
// `declined` state in V1. Adding `declined` here is a contract break." There is
// therefore no decline verb anywhere for a shelf to call.
//
// So **Not now** is a local hide and says so. It writes nothing to the daemon, it
// tells the inviter nothing, and it is reversible from the shelf's own
// "set aside" disclosure — because a hide a person cannot undo is a delete they
// did not agree to.
//
// WHAT KEYS THE HIDE. The invitation's `inviteId`, which is the identity every
// invite reply carries. Not its token's `jti`: that claim lives INSIDE the opaque
// PASETO body and appears on no invite response in `packages/contracts` at all, so
// a shelf keying on it would be keying on a value it can never read.
//
// WHAT IS NOT STORED. The expiry. It is a wire figure that belongs to the wire,
// and a durable copy of it would be a second source of truth that goes stale the
// moment the invitation is revoked early. Pruning happens against a SERVED read
// instead: an identifier the daemon no longer lists has nothing left to hide, for
// whichever reason it left. A refused read prunes nothing, because a refusal is
// not evidence that an invitation is gone.

import { useCallback, useSyncExternalStore } from "react";

import type { ConsoleRefusal } from "../core/index.js";
import type { UiStateStore } from "../persistence/index.js";
import { HIDDEN_INVITE_CAP } from "../core/index.js";
import { noDurableViewSubscription, useDurableViewBinding } from "./durable-view-binding.js";
import { DurableViewState } from "./durable-view-state.js";

/** The record key inside the global partition. Identifier-shaped, as the store requires. */
export const HIDDEN_INVITES_KEY = "hidden-invites";

/** The persisted set: invite identifiers, oldest hide first. */
export type HiddenInviteIds = readonly string[];

const NOTHING_HIDDEN: HiddenInviteIds = [];

/**
 * Narrow a stored record back into the hide set.
 *
 * Per ENTRY, like the pin map's: a non-string member is dropped and the rest
 * survive, because refusing the whole record would silently re-surface every
 * invitation a person had set aside.
 */
export function narrowHiddenInviteIds(raw: unknown): HiddenInviteIds | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  return raw.filter((member): member is string => typeof member === "string");
}

/** The hide set, durable. One per window; the shelf builds it once and holds it. */
export class HiddenInviteStore {
  readonly #state: DurableViewState<HiddenInviteIds>;
  readonly #cap: number;

  public constructor(store: UiStateStore, cap: number = HIDDEN_INVITE_CAP) {
    this.#cap = cap;
    this.#state = new DurableViewState<HiddenInviteIds>({
      store,
      key: HIDDEN_INVITES_KEY,
      valueClass: "expansion",
      initial: NOTHING_HIDDEN,
      narrow: narrowHiddenInviteIds,
    });
  }

  public get hiddenInviteIds(): HiddenInviteIds {
    return this.#state.value;
  }

  /** The last refused write, so the shelf renders it instead of hiding it. */
  public get lastRefusal(): ConsoleRefusal | undefined {
    return this.#state.lastRefusal;
  }

  public isHidden(inviteId: string): boolean {
    return this.#state.value.includes(inviteId);
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
   * Set one invitation aside.
   *
   * Past the cap the oldest hide is dropped, which re-surfaces the invitation
   * rather than losing it — the fail-open direction, and the right one: an
   * invitation on screen is a decision a person can still make, and an invitation
   * silently dropped from a full cache is one they cannot.
   */
  public async hide(inviteId: string): Promise<void> {
    if (this.isHidden(inviteId)) {
      return;
    }
    const appended = [...this.#state.value, inviteId];
    await this.#state.commit(appended.slice(Math.max(0, appended.length - this.#cap)));
  }

  /** Bring one back. The reverse of **Not now**, and the reason it is safe to press. */
  public async reveal(inviteId: string): Promise<void> {
    if (!this.isHidden(inviteId)) {
      return;
    }
    await this.#state.commit(this.#state.value.filter((held) => held !== inviteId));
  }

  /**
   * Drop hides the daemon no longer has an invitation for.
   *
   * Called ONLY with the identifiers a served read carried. A refused or unasked
   * read carries none, and pruning against none would clear the whole set on a
   * wire that never answered.
   */
  public async pruneAgainst(servedInviteIds: readonly string[]): Promise<void> {
    const survivors = this.#state.value.filter((held) => servedInviteIds.includes(held));
    if (survivors.length === this.#state.value.length) {
      return;
    }
    await this.#state.commit(survivors);
  }
}

/** What the shelf holds: the set, the refusal, and the two acts that change it. */
export interface HiddenInviteBinding {
  readonly hiddenInviteIds: HiddenInviteIds;
  readonly lastRefusal: ConsoleRefusal | undefined;
  readonly hide: (inviteId: string) => void;
  readonly reveal: (inviteId: string) => void;
  readonly pruneAgainst: (servedInviteIds: readonly string[]) => void;
}

/** How a hide-set store is minted. Module-level, because the holder reads it once. */
function mintHiddenInviteStore(store: UiStateStore): HiddenInviteStore {
  return new HiddenInviteStore(store);
}

/**
 * Bind the hide set into a component.
 *
 * Same shape as `useSessionPins`, and for the same reasons: the binding is keyed on
 * the durable store's identity through the holder both share, so a store the window
 * replaced takes its hide set with it rather than leaving this shelf writing into a
 * closed database; the hydrate rides the holder's effect; and every act declares its
 * failure as a recorded refusal, so nothing here has a rejection to catch.
 */
export function useHiddenInvites(store: UiStateStore): HiddenInviteBinding {
  const { binding, acquire } = useDurableViewBinding(store, mintHiddenInviteStore);
  const subscribe = useCallback(
    (onStoreChange: () => void) => binding?.subscribe(onStoreChange) ?? noDurableViewSubscription,
    [binding],
  );
  const readHidden = useCallback(() => binding?.hiddenInviteIds ?? NOTHING_HIDDEN, [binding]);
  const hiddenInviteIds = useSyncExternalStore(subscribe, readHidden, readHidden);
  const hide = useCallback(
    (inviteId: string) => {
      void acquire().hide(inviteId);
    },
    [acquire],
  );
  const reveal = useCallback(
    (inviteId: string) => {
      void acquire().reveal(inviteId);
    },
    [acquire],
  );
  const pruneAgainst = useCallback(
    (servedInviteIds: readonly string[]) => {
      void acquire().pruneAgainst(servedInviteIds);
    },
    [acquire],
  );
  // Read after the subscription, for `useSessionPins`' reason: a write whose
  // refusal changed — raised or cleared — emits on its own, so the re-render is
  // what makes this getter current.
  return { hiddenInviteIds, lastRefusal: binding?.lastRefusal, hide, reveal, pruneAgainst };
}
