// How React binds this window's machine-settings store.

import { useCallback, useEffect, useSyncExternalStore } from "react";

import type { MachineSettings } from "@ai-sidekicks/contracts";
import type { PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { useSubjectScopedState } from "@renderer/hooks/subject-scoped/useSubjectScopedState.js";
import type { MachineSettingsStore } from "../machine-settings-store.js";
import {
  NOTHING_CHOSEN,
  effectiveSettings,
  type MachineSettingsMember,
  type MachineSettingsSnapshot,
} from "../machine-settings-snapshot.js";
import { machineSettingsHolder } from "../machine-settings-holder.js";

/** What a page reads and what it presses. One object, so a row takes one prop set. */
export interface MachineSettingsBinding {
  readonly snapshot: MachineSettingsSnapshot;
  /** The effective settings: what the service answered, or the defaults. */
  readonly settings: MachineSettings;
  readonly isPending: (member: MachineSettingsMember) => boolean;
  readonly choose: <Member extends MachineSettingsMember>(
    member: Member,
    value: MachineSettings[Member],
  ) => void;
}

/**
 * Bind this window's machine settings over the bridge's `machineSettings`.
 *
 * THE STORE IS ACQUIRED IN AN EFFECT AND ONLY READ DURING RENDER, because acquiring
 * can dispose the store a replaced bridge left behind and a memo is not a safe place
 * for that. The effect has no teardown: this store's lifetime is the WINDOW's and a
 * page unmount is not the window closing; the one disposal there is belongs to the
 * replacement, inside `acquire`, after a commit.
 *
 * A page that renders before the effect settles gets the unanswered snapshot, never a
 * disposed store: the store answered is this mount's own only while the holder still
 * holds it for this bridge.
 */
export function useMachineSettings(bridge: PlatformBridge): MachineSettingsBinding {
  // Held against the TRANSPORT, through the console's one holder. The seed reads the
  // pure lookup so the SECOND page to bind in a window opens on the store the first
  // one acquired rather than on one frame of the opening arm — and because the seed
  // is re-read in the render that first sees a new bridge, a page carried across a
  // scenario switch never reads the retired bridge's store even for a frame.
  const { value: acquiredStore, publish: publishAcquiredStore } = useSubjectScopedState<
    MachineSettingsStore | undefined
  >(bridge, undefined, () => machineSettingsHolder.storeIfCurrent(bridge));

  useEffect(() => {
    const store = machineSettingsHolder.acquire(bridge);
    // Idempotent, so strict mode's second invocation subscribes once.
    store.start();
    publishAcquiredStore(store);
  }, [bridge, publishAcquiredStore]);

  const liveStore = machineSettingsHolder.storeIfCurrent(bridge);
  const store = acquiredStore === liveStore ? acquiredStore : undefined;

  const subscribe = useCallback(
    (onStoreChange: () => void) => store?.subscribe(onStoreChange) ?? noSettingsSubscription,
    [store],
  );
  const read = useCallback(() => store?.snapshot() ?? NOTHING_CHOSEN, [store]);
  const snapshot = useSyncExternalStore(subscribe, read, read);
  return {
    snapshot,
    settings: effectiveSettings(snapshot),
    isPending: (member) => snapshot.pendingMembers.has(member),
    choose: (member, value) => {
      // Reached from an event handler and never from a render, so this acquires
      // rather than reads: a press must move a store rather than be swallowed by
      // the frame before the effect ran, and the handler settles on the same store
      // that effect acquired because a press cannot outrun a passive effect.
      void machineSettingsHolder.acquire(bridge).choose(member, value);
    },
  };
}

/** The unsubscribe a mount whose effect has not acquired a store yet hands React. */
function noSettingsSubscription(): void {
  return undefined;
}
