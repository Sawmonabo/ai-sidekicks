// The one edge into the file-restore disclosure's chunk, and the only one that is
// asynchronous.
//
// WHAT IS ON WHICH SIDE. This module holds no restore knowledge: it imports the
// disclosure only as a TYPE — a line the compiler erases — fetches the disclosure's
// chunk by `import()`, and pairs that with the pending region the substrate draws.
// A static import of the component would put it on the initial graph, because a symbol
// reachable both statically and dynamically is assigned to the STATIC chunk.
//
// A `LoadedLazyBody` RATHER THAN A `lazy()` OF THIS MODULE'S OWN, because that class is
// already the console's one answer to a loader-backed body: one in-flight promise however
// many rows ask, one component identity so a re-render of the intervention history does
// not remount a disclosure a person has expanded, a fresh payload only where a load
// rejected so the error boundary's retry reaches a live loader, and the settled body
// rendered directly once the chunk has landed — so the second settled rollback in a run's
// history never suspends at all.
//
// ONE `const` AND NOT A MODULE-LEVEL `let`: the memo is the class's own private field,
// which is what the package's state-and-views rule asks for, and every row of
// every run's history draws the same disclosure, so there is nothing to key it on.

import { LoadedLazyBody, reservedBodyRegion } from "../../../seats/index.js";
import type { FileRestoreDisclosureProps } from "../../../primitives/index.js";

/**
 * What a pending disclosure stamps, so a refused capture says WHICH body was loading.
 *
 * Not a pane kind — this is a body inside a pane's own intervention history rather than a
 * pane — so the value is the body's own name.
 */
const FILE_RESTORE_DISCLOSURE_PENDING_BODY = "file-restore-disclosure";

/** The disclosure, mounted from its chunk. The rollback settlement's one reader. */
export const fileRestoreDisclosureMount: LoadedLazyBody<FileRestoreDisclosureProps> =
  new LoadedLazyBody(
    () => import("../../../primitives/restore/file-restore-disclosure-body.js"),
    () => reservedBodyRegion(FILE_RESTORE_DISCLOSURE_PENDING_BODY),
  );
