// Releasing what a spawned child was holding, once the child is actually gone.
//
// `electron-child.ts` owns the child's LIFETIME — when it is signalled, how many
// times, and, since the ordering fix its `OrderedChildTeardown` records, WHEN the
// resource that child held is released. This module owns the one question that
// sits one moment earlier and outside every one of those: the resource exists
// BEFORE the child does, so a spawn that REFUSES leaves it on disk with nothing
// anywhere that names it.
//
// THE WINDOW IS NOT HYPOTHETICAL. A harness creates the temporary Chromium
// profile before the spawn — the path is a spawn argument — and
// `spawnManagedElectronChild` throws when its settle-time registration refuses,
// which is what a spawn from `beforeAll` reaches. The kill is already covered
// there: the door disposes the child before it rethrows. What survived was the
// directory alone, and both of this package's Electron spawners had that shape
// identically, which is why the guard is here rather than twice at the call sites.
//
// AND THE RELEASE IS NOT REGISTERED HERE, WHICH IS THE OTHER HALF. It used to
// be: this module registered a second settle-time disposer of its own, after the
// one the spawn armed — and Vitest runs those in registration STACK order, so
// the removal ran first, under a tree whose kill the platform had refused, while
// the door's own disposer killed it afterwards with no removal behind it. So the
// release travels INTO the spawn as `releaseAfterTermination` and the door
// sequences both. `OrderedChildTeardown` in `electron-child.ts` has the leak.

import {
  spawnManagedElectronChild,
  type ChildRelease,
  type ElectronChildSpawnOptions,
} from "./electron-child.js";
import { type ManagedElectronChild } from "./managed-electron-child.js";

/**
 * Spawn a child that is already holding a resource, and release it if the spawn
 * refuses.
 *
 * THE ORDER IS THE WHOLE POINT, and getting it wrong is invisible on every
 * ordinary run. From `mkdtempSync` to a settled spawn there is a directory on
 * disk that only this process knows about, and the refusal propagates out of the
 * promise executor with the caller's own recovery unreached.
 *
 * `cleanUp` on the refusal path runs IMMEDIATELY rather than after a wait for
 * the child's `close`, which is the one thing this arm cannot offer: the child
 * has just been disposed by the recovery inside the spawn and there is no later
 * path to hang the removal on. It is the same best-effort removal both spawners
 * already spell, and a directory removed a moment early is a smaller fact than
 * one never removed at all.
 *
 * On every other path `cleanUp` is the spawn's OWN `releaseAfterTermination`, so
 * one function serves both and the settled path releases only after the last
 * termination attempt has settled.
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
