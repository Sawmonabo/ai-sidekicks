// Releases what a spawned child was holding, once the child is actually gone.
//
// `electron-child.ts` owns the child's lifetime and, through `OrderedChildTeardown` in
// `electron-child-teardown.ts`, when the resource it held is released. This module covers the
// moment before that: a harness creates the temporary Chromium profile before the spawn (its path
// is a spawn argument), so a spawn that refuses, as `spawnManagedElectronChild` does when
// settle-time registration refuses, leaves the directory on disk with nothing naming it. The
// spawner already disposes the child before it rethrows, and both Electron spawners share this
// shape, which is why the guard lives here.
//
// The release is not registered here: under Vitest's stack order a second settle-time disposer
// would run first and remove the profile under a tree whose kill was refused. It travels into the
// spawn as `releaseAfterTermination` and the spawner sequences it.

import {
  spawnManagedElectronChild,
  type ChildRelease,
  type ElectronChildSpawnOptions,
} from "./electron-child.js";
import { type ManagedElectronChild } from "./managed-electron-child.js";

/**
 * Spawns a child that is already holding a resource, and releases it if the spawn refuses.
 *
 * On the refusal path `cleanUp` runs immediately: the recovery inside the spawn has already
 * disposed the child, so there is no later `close` to wait for, and removing the directory a
 * moment early beats never removing it. On every other path `cleanUp` is the spawn's own
 * `releaseAfterTermination`, so it runs only after the last termination attempt has settled.
 */
export function spawnChildCleanedUpAtSettleTime(
  options: ElectronChildSpawnOptions,
  cleanUp: ChildRelease,
): ManagedElectronChild {
  try {
    return spawnManagedElectronChild({ ...options, releaseAfterTermination: cleanUp });
  } catch (spawnRefusal: unknown) {
    cleanUp();
    throw spawnRefusal;
  }
}
