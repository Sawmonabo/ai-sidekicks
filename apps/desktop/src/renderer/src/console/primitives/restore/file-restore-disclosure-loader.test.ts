// The loader resolves to the module's own disclosure, and it is the same component.
//
// WHAT THIS EXISTS TO CATCH is a wrapper that drifted into standing in for what it defers
// to — a shim component, a memo that answers with a stale identity, a re-export that
// silently became something else. Identity is the whole assertion, because everything the
// disclosure DOES is pinned in `FileRestoreDisclosure.test.tsx` next door, and a second
// copy of those cases here would be two answers to what a restore says.
//
// IDENTITY IS ALSO THE ASSERTION THAT MATTERS TO THE HOST. `LoadedLazyBody` reconciles
// the mounted body by component identity, so a loader that answered with a fresh function
// per call would remount the disclosure — closing an enumeration a person had expanded —
// on every re-render of the run's intervention history.
//
// AND ONE CASE THAT IS NOT ABOUT IDENTITY. The deferral is only worth anything if the
// module map is the memo the loader's header claims it is, so a second call must answer
// the same module rather than a fresh one; the mount holds no cache of its own precisely
// because this is true.

import { describe, expect, it } from "vitest";

import { FileRestoreDisclosure } from "./FileRestoreDisclosure.js";
import { loadFileRestoreDisclosure } from "./file-restore-disclosure-loader.js";
import { PathEnumeration } from "./PathEnumeration.js";

describe("the file-restore disclosure's loader", () => {
  it("resolves to the disclosure the module beside it declares", async () => {
    expect((await loadFileRestoreDisclosure()).Body).toBe(FileRestoreDisclosure);
  });

  it("negative control: it answers with THAT component and not another of this directory", async () => {
    // What makes the case above a claim about WHICH component rather than about resolving
    // one at all. The mistake a renaming re-export is exposed to is naming a neighbour,
    // and every module in this directory exports a component of the same shape.
    expect((await loadFileRestoreDisclosure()).Body).not.toBe(PathEnumeration);
  });

  it("answers the same module twice, because the module map is the memo", async () => {
    const [first, second] = await Promise.all([
      loadFileRestoreDisclosure(),
      loadFileRestoreDisclosure(),
    ]);

    expect(first.Body).toBe(second.Body);
  });
});
