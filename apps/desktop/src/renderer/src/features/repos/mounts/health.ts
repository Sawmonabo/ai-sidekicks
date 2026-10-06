// The two axes a mount card reads on: lifecycle and health, one table each and total over its
// wire union, never collapsed into one chip (a `detached` row is finished, an `unreachable` one
// cannot be asked). Health is the daemon's status string: the console never probes a path or
// ranks failing verdicts. `identity_mismatch` means the root answers but holds another repository.

import type { RepoMountHealth } from "@ai-sidekicks/contracts/repo/mount";
import type { RepoMountReadResponse } from "@ai-sidekicks/contracts/repo/folders";
import type { RepoMountState } from "@ai-sidekicks/contracts/repo/mount";
import type { ChipTone } from "#renderer/components/Chip/Chip.js";

/**
 * One axis reading as a card renders it. `label` is the wire word, rendered verbatim so it can
 * be searched in the daemon's vocabulary; `sentence` is the console's prose for the next move.
 */
export interface MountAxisReading {
  readonly tone: ChipTone;
  readonly label: string;
  readonly sentence: string;
}

/** What the console writes for one wire word: everything but the word. */
type MountAxisPresentation = Omit<MountAxisReading, "label">;

/** The health axis, keyed off the contract's own union. */
const HEALTH_READINGS: Readonly<Record<RepoMountHealth["status"], MountAxisPresentation>> = {
  healthy: {
    tone: "neutral",
    sentence: "The root was reachable when it was last probed.",
  },
  unreachable: {
    tone: "failure",
    // No further question can be put to a root that cannot be probed. Not softened to
    // "temporarily unavailable": precedence between failing verdicts is the daemon's.
    sentence:
      "The root could not be probed, so nothing further can be asked " +
      "of it. Binds and runs on this mount refuse until it is " +
      "reachable again.",
  },
  identity_mismatch: {
    tone: "failure",
    // Waiting is the wrong move here: `unreachable` can resolve on its own, but this path holds
    // a different repository. The sentence says the refusal is permanent for this row and names
    // the recovery, since a user reads the card before pressing anything.
    sentence:
      "The root is reachable but is no longer the repository this " +
      "mount was attached as. Binds and runs on this mount refuse " +
      "permanently; re-attaching the path mints a new mount and leaves " +
      "this row as history.",
  },
};

/** The lifecycle axis. Total over `RepoMountState`. */
const LIFECYCLE_READINGS: Readonly<Record<RepoMountState, MountAxisPresentation>> = {
  attached: {
    tone: "neutral",
    sentence: "This mount is live in the session.",
  },
  detached: {
    tone: "neutral",
    // Terminal: there is no `detached -> attached` transition.
    sentence:
      "Detached is where a mount ends. Attaching the same path again " +
      "mints a new mount; this row stays as history.",
  },
  archived: {
    tone: "neutral",
    sentence: "This mount was archived and is kept as history.",
  },
};

/**
 * Whether a card offers its bind controls. The withheld arm carries the sentence saying why,
 * so a control is never disabled without a reason.
 */
export type BindControlAvailability =
  | { readonly available: true }
  | { readonly available: false; readonly unavailableBecause: string };

/** How this mount's health reads. */
export function mountHealthReading(health: RepoMountHealth): MountAxisReading {
  return { ...HEALTH_READINGS[health.status], label: health.status };
}

/** How this mount's lifecycle position reads. */
export function mountLifecycleReading(state: RepoMountState): MountAxisReading {
  return { ...LIFECYCLE_READINGS[state], label: state };
}

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
      unavailableBecause: LIFECYCLE_READINGS[mount.state].sentence,
    };
  }
  if (mount.health.status !== "healthy") {
    return {
      available: false,
      unavailableBecause: HEALTH_READINGS[mount.health.status].sentence,
    };
  }
  return BIND_CONTROLS_AVAILABLE;
}

/** The sentence a workspace's binding controls are closed with, or `undefined` while open. */
export function controlHoldSentence(availability: BindControlAvailability): string | undefined {
  return availability.available ? undefined : availability.unavailableBecause;
}
