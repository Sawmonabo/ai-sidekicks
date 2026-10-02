// The private profile one launch gets, and the removal that is part of closing it.
//
// Electron's default profile carries a machine-wide `SingletonLock`, so every launch gets its own
// `--user-data-dir` under the system temp directory (`electron-harness.ts` says why). Creation and
// removal live together so no call site can forget to remove. It is a seam so a removal that
// fails, which a real directory on a POSIX runner cannot produce, is one object literal.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * How many further attempts a removal gets before it is reported as failed. On Windows the
 * profile can still be open just after the holding process is SIGKILLed, and that lock clears on
 * its own. Node retries `EBUSY`, `EPERM`, `ENOTEMPTY` and siblings with a linear backoff (100 ms
 * steps by default), so three retries cost at most 600 ms, inside the 2 000 ms
 * `MINIMUM_SETTLEMENT_RESIDUAL_MS`. A removal that still fails is a real leak.
 */
const PROFILE_REMOVAL_RETRIES = 3;

/** The prefix every launch profile's directory name carries. */
const PROFILE_DIRECTORY_PREFIX = "ai-sidekicks-launch-profile-";

/** One launch's private profile directory, reduced to what cleanup needs of it. */
export interface LaunchProfile {
  /** The `--user-data-dir` this launch was given. */
  readonly directory: string;
  /** Remove it. Throws when it could not be removed. */
  readonly remove: () => void;
}

/**
 * A profile that outlived its launch, and why. It carries the directory, not the profile, so the
 * verdict does not invite a second `remove()` from whoever receives it.
 */
export interface ProfileRemovalFailure {
  /** The directory still on disk. */
  readonly directory: string;
  /** What `remove()` threw. */
  readonly failure: unknown;
}

/** Mint a profile directory for one launch. */
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
 * Remove a profile, returning the failure rather than raising it. Cleanup has just produced a
 * verdict about the close, and a raised removal would displace it (the inversion `closeAfterBody`
 * stops one level up), so the removal joins the verdict and the caller words the pair.
 */
export function removeLaunchProfile(profile: LaunchProfile): ProfileRemovalFailure | undefined {
  try {
    profile.remove();
    return undefined;
  } catch (failure: unknown) {
    return { directory: profile.directory, failure };
  }
}
