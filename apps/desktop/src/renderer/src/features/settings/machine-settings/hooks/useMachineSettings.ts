// How React binds this window's machine-settings store.

import { useCallback, useEffect, useSyncExternalStore } from "react";

import type { ConsoleBridge } from "@renderer/console/bridge/console-bridge.js";
import {
  NO_TRIGGERING_EVENT_KINDS,
  useWindowReadTriggers,
  type ReadTriggerTarget,
} from "@renderer/console/store/read/read-triggers.js";
import { useSubjectScopedState } from "@renderer/hooks/subject-scoped/useSubjectScopedState.js";
import type { MachineSettingsStore, ShellPreferenceCarrier } from "../machine-settings-store.js";
import {
  NOTHING_CHOSEN,
  effectivePreference,
  type MachineSettingKey,
  type MachineSettingsSnapshot,
} from "../machine-settings-snapshot.js";
import { machineSettingsHolder } from "../machine-settings-holder.js";

/** What a page reads and what it presses. One object, so a row takes one prop set. */
export interface MachineSettingsBinding {
  readonly snapshot: MachineSettingsSnapshot;
  /** The effective value: what the carrier holds, or the default. */
  readonly isEnabled: (key: MachineSettingKey) => boolean;
  readonly isPending: (key: MachineSettingKey) => boolean;
  readonly choose: (key: MachineSettingKey, enabled: boolean) => void;
}

/**
 * The target the window triggers are wired to while no store is held.
 *
 * A hook may not be called conditionally and the acquired store is `undefined` for
 * the render that first sees a new bridge, so the triggers need something to hold in
 * that frame. Asking it for a read does nothing, which is the honest answer: there is
 * no transport to ask. At module scope so the hook's dependency compares one identity
 * across renders rather than a fresh literal each pass.
 */
const NO_STORE_HELD: ReadTriggerTarget = {
  triggeringEventKinds: NO_TRIGGERING_EVENT_KINDS,
  requestRead: () => undefined,
};

/**
 * Bind this window's shell preferences over `carrier`, the machine's settings file. The
 * caller holds `carrier` stable, because it is an effect dependency.
 *
 * THE STORE IS ACQUIRED IN AN EFFECT AND ONLY READ DURING RENDER, because acquiring
 * can dispose the store a replaced bridge left behind and a memo is not a safe place
 * for that. The effect has no teardown: this store's lifetime is the WINDOW's and a
 * page unmount is not the window closing; the one disposal there is belongs to the
 * replacement, inside `acquire`, after a commit.
 *
 * A page that renders before the effect settles gets the `not-read` snapshot, never a
 * disposed store: the store answered is this mount's own only while the holder still
 * holds it for this bridge.
 */
export function useMachineSettings(
  bridge: ConsoleBridge,
  carrier: ShellPreferenceCarrier,
): MachineSettingsBinding {
  // Held against the TRANSPORT, through the console's one holder. The seed reads the
  // pure lookup so the SECOND page to bind in a window opens on the store the first
  // one acquired rather than on one frame of the opening arm — and because the seed
  // is re-read in the render that first sees a new bridge, a page carried across a
  // scenario switch never reads the retired bridge's store even for a frame.
  const { value: acquiredStore, publish: publishAcquiredStore } = useSubjectScopedState<
    MachineSettingsStore | undefined
  >(bridge, undefined, () => machineSettingsHolder.storeIfCurrent(bridge));

  useEffect(() => {
    const store = machineSettingsHolder.acquire(bridge, carrier);
    // Idempotent, so strict mode's second invocation asks nothing twice.
    store.start();
    publishAcquiredStore(store);
  }, [bridge, carrier, publishAcquiredStore]);

  const liveStore = machineSettingsHolder.storeIfCurrent(bridge);
  const store = acquiredStore === liveStore ? acquiredStore : undefined;

  // The window half only: the preferences are per user rather than per session, so
  // no session's repair and no session's timeline bear on them. The window half now
  // carries the transport's own reconnect, which a per-user reading needs exactly as
  // much as a session-scoped one — a preference read that refused while the wire was
  // away is a row rendering its default with nothing asking again.
  useWindowReadTriggers(store ?? NO_STORE_HELD, bridge.transportReconnect);

  const subscribe = useCallback(
    (onStoreChange: () => void) => store?.subscribe(onStoreChange) ?? noPreferenceSubscription,
    [store],
  );
  const read = useCallback(() => store?.snapshot() ?? NOTHING_CHOSEN, [store]);
  const snapshot = useSyncExternalStore(subscribe, read, read);
  return {
    snapshot,
    isEnabled: (key) => effectivePreference(snapshot, key),
    isPending: (key) => snapshot.pendingKeys.has(key),
    choose: (key, enabled) => {
      // Reached from an event handler and never from a render, so this acquires
      // rather than reads: a press must move a store rather than be swallowed by
      // the frame before the effect ran, and the handler settles on the same store
      // that effect acquired because a press cannot outrun a passive effect.
      void machineSettingsHolder.acquire(bridge, carrier).choose(key, enabled);
    },
  };
}

/** The unsubscribe a mount whose effect has not acquired a store yet hands React. */
function noPreferenceSubscription(): void {
  return undefined;
}
