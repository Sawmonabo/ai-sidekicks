// The private profile one launch gets, and the removal that is part of closing it.
//
// Electron's default profile carries a machine-wide `SingletonLock`, so every launch gets its own
// `--user-data-dir` under the system temp directory (`electron/harness.ts` says why). Creation and
// removal live together so no call site can forget to remove.
//
// A fresh profile has no compiled GPU pipelines, so its first scroll waits on shader compiles an
// installed app pays once. A `GpuCacheCarry` hands Chromium's GPU caches from one launch's
// profile to the next, so only a test's first launch starts cold.

import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
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

/** The prefix a launch profile's directory name carries unless its caller names another. */
const PROFILE_DIRECTORY_PREFIX = "ai-sidekicks-launch-profile-";

/** The profile folders where Chromium keeps the GPU pipelines and shaders it compiled. */
const GPU_CACHE_DIRECTORIES: readonly string[] = [
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "GPUCache",
];

/** The prefix of the directory a `GpuCacheCarry` keeps its copy in. */
const GPU_CACHE_CARRY_PREFIX = "ai-sidekicks-gpu-cache-";

/**
 * Chromium's GPU caches, kept between launches in a temporary directory of their own. A profile
 * minted with it starts from the caches the last profile closed with. `remove()` deletes the copy;
 * a profile closing after that keeps nothing.
 */
export class GpuCacheCarry {
  /** Where the copy is kept. */
  readonly directory: string = mkdtempSync(join(tmpdir(), GPU_CACHE_CARRY_PREFIX));
  #isRemoved = false;

  /** Copy the kept caches into a new profile, returning the names of the folders copied. */
  copyInto(profileDirectory: string): readonly string[] {
    const copied = GPU_CACHE_DIRECTORIES.filter((name) => existsSync(join(this.directory, name)));
    for (const name of copied) {
      cpSync(join(this.directory, name), join(profileDirectory, name), { recursive: true });
    }
    return copied;
  }

  /** Keep a closed profile's caches for the next launch, in place of the ones kept before. */
  keepFrom(profileDirectory: string): void {
    if (this.#isRemoved) {
      return;
    }
    for (const name of GPU_CACHE_DIRECTORIES) {
      const kept = join(this.directory, name);
      rmSync(kept, { recursive: true, force: true });
      if (existsSync(join(profileDirectory, name))) {
        cpSync(join(profileDirectory, name), kept, { recursive: true });
      }
    }
  }

  /** Delete the kept copy. Throws when it could not be removed. */
  remove(): void {
    this.#isRemoved = true;
    rmSync(this.directory, { recursive: true, force: true, maxRetries: PROFILE_REMOVAL_RETRIES });
  }
}

/** One launch's private profile directory, reduced to what cleanup needs of it. */
export interface LaunchProfile {
  /** The `--user-data-dir` this launch was given. */
  readonly directory: string;
  /** Remove it. Throws when it could not be removed. */
  readonly remove: () => void;
}

/** A launch profile as minted, with the GPU cache folders it was handed. */
export interface MintedLaunchProfile extends LaunchProfile {
  /** The GPU cache folders copied in from the last launch; empty for a cold start. */
  readonly carriedGpuCaches: readonly string[];
}

/** How to mint a launch profile. */
export interface LaunchProfileOptions {
  /** The start of the directory's name. */
  readonly directoryPrefix?: string;
  /** Where the GPU caches come from and go back to; without it the profile starts cold. */
  readonly gpuCacheCarry?: GpuCacheCarry | undefined;
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

/**
 * Mint a profile directory for one launch. With a `gpuCacheCarry` it starts from the caches the
 * carry holds, and its removal hands its own back to the carry first.
 */
export function createLaunchProfile({
  directoryPrefix = PROFILE_DIRECTORY_PREFIX,
  gpuCacheCarry,
}: LaunchProfileOptions = {}): MintedLaunchProfile {
  const directory = mkdtempSync(join(tmpdir(), directoryPrefix));
  return {
    directory,
    carriedGpuCaches: gpuCacheCarry?.copyInto(directory) ?? [],
    remove: (): void => {
      gpuCacheCarry?.keepFrom(directory);
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
