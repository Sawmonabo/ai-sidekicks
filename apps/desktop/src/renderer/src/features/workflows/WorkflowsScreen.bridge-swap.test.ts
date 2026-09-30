// Replacing the bridge under a mounted screen. An open pane's address names a run the old
// bridge listed, so carrying it across the swap would open a pane on a run the new bridge has
// never heard of.

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
    expect(isShowingOpenedPane(rendered.container)).toBe(true);

    remountWorkflowsScreen(rendered, withReplacedBridge(composed));
    await settle();

    expect(isShowingOpenedPane(rendered.container)).toBe(false);
  });

  it("negative control: a re-render at the SAME bridge keeps the open pane", async () => {
    // Guards against a screen that drops the open pane on every render.
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
    // Identity is all that separates two fixture bridges, and the screen keys its state on it.
    const composed = composeWindow();
    const replaced = withReplacedBridge(composed);

    expect(replaced.context.bridge).not.toBe(composed.context.bridge);
    expect(replaced.context.frameStore).toBe(composed.context.frameStore);
  });
});
