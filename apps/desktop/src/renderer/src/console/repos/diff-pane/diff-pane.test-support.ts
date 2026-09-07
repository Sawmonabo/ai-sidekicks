// What every diff-pane suite mounts the pane with.
//
// HOISTED WHEN THE PANE'S CASES SPLIT IN TWO. The pane answers two questions that are
// read for different reasons — what a pane holding NO model renders (its chrome, the
// create it offers, and the absence it owes every subject) and what a pane holding one
// renders (the compared states, the file list, the rows, and the toolbar) — and each
// half is a suite. Both mount the same pane over the same workspace, and both need the
// stated height the virtualized rows are laid out against, so those two live here
// rather than being written twice and drifting.
//
// THE LAYOUT DISCIPLINE IS A CALL AND NOT A CONSTANT, because what is shared is the
// pairing: an install with no restore leaks a stubbed geometry into whichever suite
// runs next, and a helper that handed back only the fixture would leave each caller to
// remember the second half.

import { afterEach, beforeEach } from "vitest";

import { paneContext } from "../pane-contexts.test-support.js";
import type { DiffPaneProps } from "./DiffPane.js";
import {
  DIFF_FIXTURE_VIEWPORT_HEIGHT_PX,
  DiffLayoutFixture,
} from "./diff-layout-fixture.test-support.js";

/** This pane's own address arm, taken from the prop rather than restated. */
export type DiffPaneContext = DiffPaneProps["context"];

/** The workspace both halves open the pane over. */
export const DIFF_PANE_WORKSPACE_ENTITY = {
  kind: "workspace",
  id: "workspace-sidekicks",
} as const;

/**
 * A pane context whose collaborators are never reached.
 *
 * These cases are about what the pane renders from the address, and a real bridge,
 * store pair, and persistence stack would be constructions none of them can observe —
 * so the builder is handed the address alone. The entity parameter is the arm's own, so
 * a subject a diff is never opened over fails to compile at the call site.
 */
export function diffPaneContextFor(entity: DiffPaneContext["entity"]): DiffPaneContext {
  return paneContext({ address: { kind: "diff", entity }, paneId: "pane-diff-1" });
}

/**
 * Give a suite the stated pane height its rows are laid out against.
 *
 * The rows are virtualized, so a case that reads one has to say how tall the pane is:
 * happy-dom lays nothing out, and a scroller with no height correctly holds no rows.
 */
export function installDiffPaneLayout(): void {
  const layout = new DiffLayoutFixture();
  beforeEach(() => {
    layout.install({ viewportHeightPx: DIFF_FIXTURE_VIEWPORT_HEIGHT_PX });
  });
  afterEach(() => {
    layout.restore();
  });
}
