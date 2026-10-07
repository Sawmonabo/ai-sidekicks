// Whether a mount card offers its bind controls: a projection of the mount's lifecycle and health
// as the daemon reports them, saying why whenever it withholds them.

import type { RepoMountReadResponse } from "@ai-sidekicks/contracts/repo/folders";
import { mountHealthReading, mountLifecycleReading } from "#renderer/store/mount-axis-readings.js";

/**
 * Whether a card offers its bind controls. The withheld arm carries the sentence saying why,
 * so a control is never disabled without a reason.
 */
export type BindControlAvailability =
  | { readonly available: true }
  | { readonly available: false; readonly unavailableBecause: string };

const BIND_CONTROLS_AVAILABLE: BindControlAvailability = { available: true };

/**
 * A fail-closed projection of daemon-reported state, not an eligibility rule: the daemon alone
 * decides whether a bind is admissible. Lifecycle is checked before health, so a detached row
 * never reads as unreachable.
 */
export function readBindControlAvailability(mount: RepoMountReadResponse): BindControlAvailability {
  if (mount.state !== "attached") {
    return {
      available: false,
      unavailableBecause: mountLifecycleReading(mount.state).sentence,
    };
  }
  if (mount.health.status !== "healthy") {
    return {
      available: false,
      unavailableBecause: mountHealthReading(mount.health).sentence,
    };
  }
  return BIND_CONTROLS_AVAILABLE;
}

/** The sentence a workspace's binding controls are closed with, or `undefined` while open. */
export function controlHoldSentence(availability: BindControlAvailability): string | undefined {
  return availability.available ? undefined : availability.unavailableBecause;
}
