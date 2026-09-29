// The bridge is replaced under a screen that has already been answered.
//
// SEPARATE FROM `WorkflowsScreen.test.tsx` BECAUSE THE SUBJECT IS THE SWAP. That file
// varies what a person opens against one bridge; every case here opens the same thing
// and then replaces the bridge under the mounted console.
//
// The screen holds one answer made from what a bridge served: which pane is open. An
// address carried across a swap opens a pane on a run the new bridge has never heard of.

import { beforeAll, describe, expect, it } from "vitest";

import {
  composeWindow,
  loadRunPaneBody,
  mountWorkflowsScreen,
  pressOpenRun,
  remountWorkflowsScreen,
  withReplacedBridge,
} from "./WorkflowsScreen.test-support.js";
import { settle } from "./workflows-probe.test-support.js";

/** Whether the screen is showing an opened pane rather than the runs. */
function isShowingOpenedPane(container: HTMLElement): boolean {
  return container.querySelector(".meridian-workflows-open-pane") !== null;
}

beforeAll(loadRunPaneBody);

describe("a bridge replaced under an answered screen", () => {
  it("closes a pane opened from the previous bridge rather than addressing this one with it", async () => {
    const composed = composeWindow();
    const rendered = mountWorkflowsScreen(composed);
    await settle();
    pressOpenRun(rendered.container);
    await settle();
    // The premise: a pane really was open, addressed by a run the previous bridge listed.
    expect(isShowingOpenedPane(rendered.container)).toBe(true);

    remountWorkflowsScreen(rendered, withReplacedBridge(composed));
    await settle();

    expect(isShowingOpenedPane(rendered.container)).toBe(false);
  });

  it("negative control: a re-render at the SAME bridge keeps the open pane", async () => {
    // Without this, the case above would pass over a screen that discarded the open pane
    // on every render, which would make no pane openable at all.
    const composed = composeWindow();
    const rendered = mountWorkflowsScreen(composed);
    await settle();
    pressOpenRun(rendered.container);
    await settle();

    remountWorkflowsScreen(rendered, composed);
    await settle();

    expect(isShowingOpenedPane(rendered.container)).toBe(true);
  });

  it("negative control: the replacement really is a different bridge", () => {
    // The premise of both cases above, asserted rather than assumed: identity is the
    // whole of what separates two fixture bridges, and identity is what the holder
    // re-mints on.
    const composed = composeWindow();
    const replaced = withReplacedBridge(composed);

    expect(replaced.context.bridge).not.toBe(composed.context.bridge);
    expect(replaced.context.frameStore).toBe(composed.context.frameStore);
  });
});
