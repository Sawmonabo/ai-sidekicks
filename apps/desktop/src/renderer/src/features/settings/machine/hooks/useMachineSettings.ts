// The React binding for this window's machine-settings store.

import { useCallback, useSyncExternalStore } from "react";

import type { MachineSettings } from "@ai-sidekicks/contracts/machine-settings";
import type { Refusal } from "#renderer/lib/refusal/contract.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import { useKeyBoundValue } from "#renderer/hooks/useKeyBoundValue.js";
import type { MachineSettingsStore } from "../store.js";
import {
  NOTHING_CHOSEN,
  effectiveSettings,
  type MachineSettingsMember,
  type MachineSettingsSnapshot,
} from "../snapshot.js";
import { machineSettingsHolder } from "../holder.js";

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
  /** Sends a member's refused change again, as its `Try again` asks. */
  readonly retry: (member: MachineSettingsMember) => void;
  /** Opens the feed again, as a failed read's `Try again` asks. */
  readonly readAgain: () => void;
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
  // Held against the transport, so a second page in the window opens on the store the first
  // acquired, and a page carried across a scenario switch never reads the retired bridge's store.
  const { value: store, subscribe } = useKeyBoundValue(
    machineSettingsHolder,
    bridge,
    startMachineSettingsStore,
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
    retry: (member) => {
      void machineSettingsHolder.acquire(bridge).retry(member);
    },
    readAgain: () => {
      machineSettingsHolder.acquire(bridge).readAgain();
    },
  };
}

/** Subscribe a store to the service's feed. Idempotent, so strict mode subscribes once. */
function startMachineSettingsStore(store: MachineSettingsStore): void {
  store.start();
}
