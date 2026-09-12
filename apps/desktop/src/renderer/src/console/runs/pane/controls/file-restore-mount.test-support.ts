// The one place anything waits for the file-restore disclosure's chunk.
//
// WHY IT IS A MODULE AND NOT A LINE IN A SPEC. The package's test standard rejects a
// per-spec wait, and the reason is exactly this body's shape: three specs that wait and a
// fourth that races look identical in a diff, and the fourth is the one that mints the
// reference. One exported function, named where the mount is, and every suite that needs
// a settled disclosure calls it.
//
// AND THE CASE THAT NEEDS IT MOST IS THE NEGATIVE ONE. `InterventionHistory.test.tsx`
// asserts that a disposition which mutated no file renders NO working-tree section — an
// assertion an unloaded chunk satisfies for the wrong reason, silently, forever. Warming
// the mount first is what makes that absence a claim about the reading rather than about
// the fetch.
//
// A `load()` AND NOT A POLL: `LoadedLazyBody` memoises one in-flight promise, so this
// joins whatever is already running rather than starting a second, and a caller that
// arrives after the module has landed awaits a settled promise and costs nothing.

import { fileRestoreDisclosureMount } from "./file-restore-mount.js";

/**
 * Resolve the disclosure's module, so a later synchronous render draws the body itself.
 *
 * `LoadedLazyBody.render` reads the settled body at RENDER time, which is what lets a
 * caller await this once — in a `beforeAll`, say — and then mount as many times as it
 * likes without suspending or awaiting again.
 */
export async function resolveFileRestoreDisclosure(): Promise<void> {
  await fileRestoreDisclosureMount.load();
}
