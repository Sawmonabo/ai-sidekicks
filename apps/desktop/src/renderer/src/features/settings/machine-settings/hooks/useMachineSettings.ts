// The React binding for this window's machine-settings store.

import { useCallback, useEffect, useSyncExternalStore } from "react";

import type { MachineSettings } from "@ai-sidekicks/contracts";
import type { Refusal } from "@renderer/lib/refusal.js";
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

/** What a page reads and what it presses, as one object so a row takes one prop set. */
export interface MachineSettingsBinding {
  readonly snapshot: MachineSettingsSnapshot;
  /** The effective settings: what the service answered, or the defaults. */
  readonly settings: MachineSettings;
  readonly isPending: (member: MachineSettingsMember) => boolean;
  /** The refusal the member's last write was answered with, or `undefined` where none was. */
  readonly refusalFor: (member: MachineSettingsMember) => Refusal | undefined;
  readonly choose: <Member extends MachineSettingsMember>(
    member: Member,
    value: MachineSettings[Member],
  ) => void;
}

/**
 * Bind this window's machine settings over the bridge's `machineSettings`.
 *
 * The store is acquired in an effect and only read during render, because acquiring can
 * dispose the store a replaced bridge left behind. The effect has no teardown: the store
 * lives as long as the window. A page that renders before the effect settles gets the
 * unanswered snapshot, never a disposed store.
 */
export function useMachineSettings(bridge: PlatformBridge): MachineSettingsBinding {
  // Held against the transport. The seed reads the pure lookup so a second page in the window
  // opens on the store the first acquired, and a page carried across a scenario switch never
  // reads the retired bridge's store.
  const { value: acquiredStore, publish: publishAcquiredStore } = useSubjectScopedState<
    MachineSettingsStore | undefined
  >(bridge, undefined, () => machineSettingsHolder.storeIfCurrent(bridge));

  useEffect(() => {
    const store = machineSettingsHolder.acquire(bridge);
    // Idempotent, so strict mode subscribes once.
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
    refusalFor: (member) => snapshot.refusalByMember.get(member),
    choose: (member, value) => {
      // Acquire rather than read: a press must move a store, and an event handler runs after
      // the passive effect that acquired it. The write never rejects: a refusal lands in the
      // snapshot.
      void machineSettingsHolder.acquire(bridge).choose(member, value);
    },
  };
}

/** The unsubscribe a mount whose effect has not acquired a store yet hands React. */
function noSettingsSubscription(): void {
  return undefined;
}
