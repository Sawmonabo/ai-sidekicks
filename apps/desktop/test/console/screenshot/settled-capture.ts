// The one call every screenshot capture goes through, and the settle it refuses.
//
// WHY A CAPTURE CAN BE WRONG WITHOUT BEING RED. A loader-backed pane body arrives as
// its own chunk, so between the pane mounting and its module landing the pane is its
// own chrome and nothing else. That frame is correct — it is what keeps the deferred
// body off the initial import graph — and it is a catastrophic thing to photograph: a
// reference minted from it records a pane that had not finished loading, and every
// later run is then compared against a picture of a half-built surface. Nothing about
// that is red. The image is stable, the comparison passes, and the surface the tier
// claims to pin is not the surface anyone sees.
//
// SO THE REFUSAL IS STRUCTURAL RATHER THAN A WAIT. There is no timer to tune and no
// "settled" heuristic to get wrong: `PendingPaneBody` stamps a marker while its module
// is in flight, `pendingPaneKindsIn` reads it back, and a capture whose tree carries one
// fails by name. A surface that needs its body first awaits it in its own mount helper —
// which is where the knowledge of what that surface is waiting for lives.
//
// EVERY CAPTURE, AND NOT MOST. The five capture files call this instead of
// `toMatchScreenshot`, so a reference cannot be minted around the check by an author
// who did not know it existed.

import { expect } from "vitest";

// The LEAF and not the family door: `pendingPaneKindsIn` has no production reader, so
// `console/seats/index.ts` carries no line for it — a door line only a test reaches is
// what `architecture/barrel-census.test.ts` reports.
import { pendingPaneKindsIn } from "../../../src/renderer/src/console/seats/pending-pane-body.js";

/**
 * Refuse a capture whose tree still holds an unloaded pane body.
 *
 * TAKES THE KINDS RATHER THAN THE ELEMENT, which is what makes the refusal itself
 * testable without a browser: the DOM read is `pendingPaneKindsIn`'s and has its own
 * suite beside the marker it reads, and this half is a pure function a node tier can
 * plant a failure into. Fused into one function, the only way to prove the refusal
 * fires would be to mint a real half-loaded capture, which is the thing it exists to
 * prevent.
 *
 * The message names the KINDS and the reference, because a failure that says "something
 * was pending" is a second debugging session and one that says `workflow-run` is a fix.
 */
export function assertNoPendingPaneBodies(
  pendingKinds: readonly string[],
  referenceName: string,
): void {
  if (pendingKinds.length === 0) {
    return;
  }
  throw new Error(
    `Refusing to capture ${referenceName}: ${String(pendingKinds.length)} pane body/bodies ` +
      `had not loaded (${pendingKinds.join(", ")}). Await the body in the mount helper ` +
      `before capturing, or the reference records a pane that was still arriving.`,
  );
}

/**
 * Capture one element against its committed reference, once it is whole.
 *
 * The order is load-bearing: the refusal runs BEFORE the capture, so a tree that is
 * still loading fails without minting or overwriting a reference. In `--update` mode
 * that is the difference between a run that refuses and a run that quietly commits a
 * picture of a fallback.
 */
export async function captureSettled(element: Element, referenceName: string): Promise<void> {
  assertNoPendingPaneBodies(pendingPaneKindsIn(element), referenceName);
  await expect(element).toMatchScreenshot(referenceName);
}
