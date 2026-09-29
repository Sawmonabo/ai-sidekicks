// The private profile one launch gets, and the removal that is part of closing it.
//
// Electron's default profile carries a machine-wide `SingletonLock`, so every
// launch gets its own `--user-data-dir` under the system temporary directory —
// see `electron-harness.ts` for why that isolation is load-bearing rather than
// hygiene. What lives here is the pair: the directory is created in one place and
// removed in one place, because a creation whose removal is spelled out at each
// call site is how one of those call sites ends up not removing anything.
//
// A seam rather than two `node:fs` calls, for the reason every other collaborator
// of `BoundedCleanup` is one: a removal that FAILS is the case worth checking and
// it cannot be produced with a real directory on a POSIX runner, where `rmSync`
// over a directory this process owns does not fail. A profile whose `remove()`
// throws is one object literal.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * How many further attempts a removal gets before it is reported as failed.
 *
 * The case this exists for is the one that made the failure worth surfacing at
 * all: on Windows the profile can still be open when the process holding it has
 * only just been SIGKILLed, and that lock clears on its own. Node retries
 * `EBUSY`, `EPERM`, `ENOTEMPTY` and their siblings with a linear backoff of
 * `retryDelay` more milliseconds on each try (100 ms by default), so three
 * retries cost at most 600 ms — well inside the 2 000 ms every launching tier
 * must leave after the launch budget (`MINIMUM_SETTLEMENT_RESIDUAL_MS`). A
 * removal that still fails after them is a real leak and is reported as one.
 */
const PROFILE_REMOVAL_RETRIES = 3;

/** The prefix every launch profile's directory name carries. */
const PROFILE_DIRECTORY_PREFIX = "ai-sidekicks-console-";

/**
 * One launch's private profile directory, reduced to what cleanup needs of it.
 */
export interface LaunchProfile {
  /** The `--user-data-dir` this launch was given. */
  readonly directory: string;
  /** Remove it. Throws when it could not be removed. */
  readonly remove: () => void;
}

/**
 * A profile that outlived its launch, and why.
 *
 * Carries the directory rather than the whole profile: what a reader needs is a
 * path to look at, and a verdict that held a live `remove()` would invite a
 * second attempt from whoever received it.
 */
export interface ProfileRemovalFailure {
  /** The directory still on disk. */
  readonly directory: string;
  /** What `remove()` threw. */
  readonly failure: unknown;
}

/**
 * Mint a profile directory for one launch.
 */
export function createLaunchProfile(): LaunchProfile {
  const directory = mkdtempSync(join(tmpdir(), PROFILE_DIRECTORY_PREFIX));
  return {
    directory,
    remove: (): void => {
      rmSync(directory, { recursive: true, force: true, maxRetries: PROFILE_REMOVAL_RETRIES });
    },
  };
}

/**
 * Remove a profile, returning the failure rather than raising it.
 *
 * Returned rather than thrown because of WHERE this runs: cleanup has just
 * produced a verdict about the close, and a removal that raised from here would
 * displace it — the same inversion `closeAfterBody` exists to stop one level up.
 * So the removal joins the verdict instead, and the caller decides what to say
 * about the pair.
 */
export function removeLaunchProfile(profile: LaunchProfile): ProfileRemovalFailure | undefined {
  try {
    profile.remove();
    return undefined;
  } catch (failure: unknown) {
    return { directory: profile.directory, failure };
  }
}
