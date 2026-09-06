// The bridge is replaced under a slot that has already been answered.
//
// SEPARATE FROM `WorkflowsPaneHost.test.tsx` BECAUSE THE SUBJECT IS THE SWAP. That file
// varies what a person presses against one bridge; every case here presses the same
// things and then replaces the port, which is what the fixture's scenario switch does to
// a mounted console.
//
// WHY THE TWO HALVES ARE TWO CASES. The host holds two answers made from what a bridge
// served — which session this surface reads from, and which pane is open — and they fail
// independently: a scope carried across a swap scopes both of the destination's reads to
// a session the new port was never asked about, and an address carried across it opens a
// pane on a run the new port has never heard of. Each case moves one of them and leaves
// the other where the previous case proved it belongs.

import { describe, expect, it } from "vitest";

import { WORKFLOWS_SESSION_ID } from "../bridge/scenarios/workflow-fixture-ids.js";
import {
  composeWindow,
  mountWorkflowsSlot,
  pressFirst,
  remountWorkflowsSlot,
  chooseSessionInPicker,
  withReplacedBridge,
} from "./WorkflowsPaneHost.test-support.js";
import { settle } from "./WorkflowsBrowser.test-support.js";

/**
 * A window that has opened one session and RETAINED none.
 *
 * Retention absent is what makes the assertions sharp: with nothing retained, a scope
 * that has re-minted resolves to no session and the surface is back at its question,
 * where a scope that survived the swap resolves to the session a person chose under the
 * previous port and the surface goes on showing that session's lists.
 */
const CHOOSING_WINDOW = { openSessionIds: [WORKFLOWS_SESSION_ID] } as const;

/** Whether the slot is showing the question it puts before it can read anything. */
function isAskingWhichSession(container: HTMLElement): boolean {
  return container.querySelector(".meridian-workflows-scope-picker") !== null;
}

/** Whether the slot is showing an opened pane rather than the destination's lists. */
function isShowingOpenedPane(container: HTMLElement): boolean {
  return container.querySelector(".meridian-workflows-pane-host") !== null;
}

describe("a port replaced under an answered slot", () => {
  it("puts the session question again rather than reading under a choice this port never served", async () => {
    const composed = composeWindow(CHOOSING_WINDOW);
    const rendered = mountWorkflowsSlot(composed);
    await settle();
    await chooseSessionInPicker(rendered.container);
    // The premise: the choice really did take, and the surface really did leave the
    // question behind for this port's own lists.
    expect(isAskingWhichSession(rendered.container)).toBe(false);

    remountWorkflowsSlot(rendered, withReplacedBridge(composed));
    await settle();

    expect(isAskingWhichSession(rendered.container)).toBe(true);
  });

  it("closes a pane opened from the previous port rather than addressing this one with it", async () => {
    const composed = composeWindow(CHOOSING_WINDOW);
    const rendered = mountWorkflowsSlot(composed);
    await settle();
    await chooseSessionInPicker(rendered.container);
    pressFirst(rendered.container, ".meridian-definition-row__open");
    await settle();
    // The premise: a pane really was open, addressed by a definition this port listed.
    expect(isShowingOpenedPane(rendered.container)).toBe(true);

    remountWorkflowsSlot(rendered, withReplacedBridge(composed));
    await settle();

    expect(isShowingOpenedPane(rendered.container)).toBe(false);
  });

  it("negative control: a re-render at the SAME port keeps both answers", async () => {
    // Without this, the two cases above would pass over a host that discarded the
    // choice and the open pane on every render — which would make the destination
    // unusable and no pane openable at all.
    const composed = composeWindow(CHOOSING_WINDOW);
    const rendered = mountWorkflowsSlot(composed);
    await settle();
    await chooseSessionInPicker(rendered.container);
    pressFirst(rendered.container, ".meridian-definition-row__open");
    await settle();

    remountWorkflowsSlot(rendered, composed);
    await settle();

    expect(isShowingOpenedPane(rendered.container)).toBe(true);
    expect(isAskingWhichSession(rendered.container)).toBe(false);
  });

  it("negative control: the replacement really is a different port", async () => {
    // The premise of both cases above, asserted rather than assumed: two fixture
    // bridges over one scenario serve the same rows, so identity is the whole of what
    // separates them — and identity is what the holder re-mints on.
    const composed = composeWindow(CHOOSING_WINDOW);
    const replaced = withReplacedBridge(composed);

    expect(replaced.context.bridge.growth).not.toBe(composed.context.bridge.growth);
    expect(replaced.context.frameStore).toBe(composed.context.frameStore);
  });
});
