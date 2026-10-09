// The two axes a mount reads on, lifecycle and health: one table each, total over its wire union
// but for a folder that is a different repository now, which reads with its folder, and never
// collapsed into one chip (a `detached` mount is finished, an `unreachable` one cannot be asked).
// Health is the daemon's status read as words: the console never probes a path or ranks failing
// verdicts. Only a failed health verdict is colored; a detached or archived mount needs no one, so
// its lifecycle stays neutral.

import type { RepoMountReadResponse } from "@ai-sidekicks/contracts/repo/folders";
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

/** Every health verdict but a different repository, keyed off the contract's own union. */
const HEALTH_READINGS: Readonly<
  Record<Exclude<RepoMountHealth["status"], "identity_mismatch">, MountAxisPresentation>
> = {
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

/** How a mount's health reads; a folder that is a different repository now is named. */
export function mountHealthReading(
  mount: Pick<RepoMountReadResponse, "health" | "canonicalRoot">,
): MountAxisReading {
  const { status } = mount.health;
  if (status === "identity_mismatch") {
    return {
      tone: "failure",
      label: "A different repository now",
      sentence: `${mount.canonicalRoot} is a different repository now · new runs are stopped`,
    };
  }
  return { ...HEALTH_READINGS[status], label: codeWords(status) };
}

/** How a mount's lifecycle position reads. */
export function mountLifecycleReading(state: RepoMountState): MountAxisReading {
  return { ...LIFECYCLE_READINGS[state], label: codeWords(state) };
}
