// What every diff-pane suite mounts the pane with: the shared workspace address and the pane
// height the virtualized rows are laid out against. The layout install is a call, not a
// constant, because it pairs an install with its restore, so a stubbed geometry cannot leak
// into the next suite.

import { afterEach, beforeEach } from "vitest";

import { bridgeOnClock } from "@test/helpers/fixture-bridge.js";
import { paneContext } from "@test/helpers/pane-context.js";
import type { DiffPaneProps } from "./DiffPane.js";
import {
  DIFF_FIXTURE_VIEWPORT_HEIGHT_PX,
  DiffLayoutFixture,
} from "@test/helpers/diff-layout-fixture.js";

/** This pane's own address arm, taken from the prop rather than restated. */
export type DiffPaneContext = DiffPaneProps["context"];

/** The workspace both halves open the pane over. */
export const DIFF_PANE_WORKSPACE_ENTITY = {
  kind: "workspace",
  id: "workspace-sidekicks",
} as const;

/**
 * A pane context over a bridge that scripts nothing and no session: these cases render from the
 * address alone. The entity is the arm's own, so a subject a diff never opens over fails to
 * compile.
 */
export function diffPaneContextFor(entity: DiffPaneContext["entity"]): DiffPaneContext {
  return paneContext(
    { kind: "diff", entity },
    { bridge: bridgeOnClock("diff-pane").bridge, sessionStore: undefined, paneId: "pane-diff-1" },
  );
}

/**
 * Give a suite the pane height its rows are laid out against. happy-dom lays nothing out, and
 * a scroller with no height correctly holds no rows.
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
