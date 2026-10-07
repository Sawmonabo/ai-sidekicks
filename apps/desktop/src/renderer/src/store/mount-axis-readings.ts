// The two axes a mount reads on, lifecycle and health: one table each, total over its wire union,
// and never collapsed into one chip (a `detached` mount is finished, an `unreachable` one cannot
// be asked). Health is the daemon's status read as words: the console never probes a path or
// ranks failing verdicts. Only a failed health verdict is colored; a detached or archived mount
// needs no one, so its lifecycle stays neutral.

import type { RepoMountHealth, RepoMountState } from "@ai-sidekicks/contracts/repo/mount";
import type { ChipTone } from "#renderer/components/Chip/Chip.js";
import { codeWords } from "#renderer/lib/code-words.js";

/**
 * One axis as a mount's card or row renders it. `label` is the wire word read as words;
 * `sentence` is the console's prose for the next move.
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

/** How a mount's health reads. */
export function mountHealthReading(health: RepoMountHealth): MountAxisReading {
  return { ...HEALTH_READINGS[health.status], label: codeWords(health.status) };
}

/** How a mount's lifecycle position reads. */
export function mountLifecycleReading(state: RepoMountState): MountAxisReading {
  return { ...LIFECYCLE_READINGS[state], label: codeWords(state) };
}
