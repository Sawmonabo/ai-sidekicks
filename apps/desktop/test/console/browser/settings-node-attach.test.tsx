// The browser tier: the attach control is operable by keyboard, in a real engine.
//
// An attach is the one act on the nodes page that changes anything, and every claim
// worth making about it is a claim happy-dom cannot decide:
//
//   • SEQUENTIAL FOCUS NAVIGATION IS THE ENGINE'S. happy-dom runs none at all — `{Tab}`
//     moves nothing there — so "a person can reach this control without a pointer" is
//     unfalsifiable in the unit tier and decided here. It matters more than usual for
//     this control: the declaration above it is a list, so the button is the first and
//     only stop, and a surface that made it unreachable would look identical in a DOM
//     that never moves focus.
//   • FOCUS AFTER THE CONTROL LEAVES THE TREE IS THE ENGINE'S TOO. The shipped flow
//     removes the button rather than disabling it — that is its structural guard
//     against a double-fire — so a real browser has to put the ring somewhere, and it
//     resets to the document body. A tolerant DOM would happily report focus still on
//     a detached node, which is the state this case exists to refuse.
//
// The scenario is the settings deck's, whose scripted attach reply is held on the
// frozen clock, so the pending arm is reached by a real activation rather than by a
// stub — and the resolved arm only after this test advances that clock.

import { describe, expect, it } from "vitest";
import { act } from "@testing-library/react";

import { pressKeys, renderSettled } from "../console-harness.js";
import { crossMacrotaskBoundary } from "../../../src/renderer/src/console/core/macrotask-boundary.test-support.js";

import {
  createFixtureBridge,
  type ConsoleBridge,
} from "../../../src/renderer/src/console/bridge/index.js";
import { SETTINGS_SCENARIO } from "../../../src/renderer/src/console/bridge/scenarios/settings.js";
import { SETTINGS_RUNTIME_NODE_ATTACH_DRAFT } from "../../../src/renderer/src/console/bridge/scenarios/settings-runtime-nodes.js";
import { RuntimeNodesPage } from "../../../src/renderer/src/console/settings/pages/runtime-nodes/RuntimeNodesPage.js";
import type { SettingsPageContext } from "../../../src/renderer/src/console/settings/settings-page-registry.js";
import { consoleTestUiStateStore } from "../../../src/renderer/src/console/settings/settings-page-mount.test-support.js";

/** Both machines online, one axis apart — the tick the page's own suite renders at. */
const BOTH_MACHINES_ONLINE_MS = 200;

/** Past the latency the scenario holds its attach reply for. */
const ATTACH_REPLY_DUE_MS = 120;

/** More stops than this page has; the loop below asserts it landed, not that it ran. */
const FOCUS_STOPS_TO_TRY = 12;

function bridgeWithRoster(): ConsoleBridge {
  const bridge = createFixtureBridge({ scenario: SETTINGS_SCENARIO });
  bridge.scenarioEngine?.advance(BOTH_MACHINES_ONLINE_MS);
  return bridge;
}

function contextFor(bridge: ConsoleBridge): SettingsPageContext {
  return {
    bridge,
    openSection: () => undefined,
    retainedSessionId: SETTINGS_SCENARIO.sessionId,
    retainedSessionStore: undefined,
    uiStateStore: consoleTestUiStateStore(),
  };
}

/** The attach control's current branch, or a failure naming that it drew none. */
function attachSection(container: HTMLElement): HTMLElement {
  const section = container.querySelector<HTMLElement>("section[data-attach-state]");
  if (section === null) {
    throw new Error("the nodes page drew no attach control");
  }
  return section;
}

/** Walk the focus ring to the attach button, and say how far it got if it never lands. */
async function tabToAttachButton(container: HTMLElement): Promise<HTMLElement> {
  const button = attachSection(container).querySelector<HTMLElement>("button");
  if (button === null) {
    throw new Error("the attach control drew no button to reach");
  }
  for (let stop = 0; stop < FOCUS_STOPS_TO_TRY; stop += 1) {
    await pressKeys("{Tab}");
    if (document.activeElement === button) {
      return button;
    }
  }
  throw new Error(
    `the attach button is not reachable by keyboard within ${String(FOCUS_STOPS_TO_TRY)} stops`,
  );
}

describe("browser — attaching a node from the settings nodes page", () => {
  it("reaches the attach control by keyboard and settles the attach with Enter", async () => {
    const bridge = bridgeWithRoster();
    const { container } = await renderSettled(<RuntimeNodesPage context={contextFor(bridge)} />);

    // The declaration is on screen BEFORE anything is sent — the control is a review,
    // and an attach that fired because something rendered would be the wrong surface.
    expect(attachSection(container).getAttribute("data-attach-state")).toBe("idle");
    expect(attachSection(container).textContent).toContain(
      SETTINGS_RUNTIME_NODE_ATTACH_DRAFT.nodeId,
    );

    const button = await tabToAttachButton(container);
    expect(button.textContent).toBe("Attach runtime node");

    await pressKeys("{Enter}");

    // In flight: the button is GONE rather than disabled, so the ring cannot be left
    // sitting on a node the document no longer contains.
    const pending = attachSection(container);
    expect(pending.getAttribute("data-attach-state")).toBe("pending");
    expect(pending.getAttribute("aria-busy")).toBe("true");
    expect(pending.querySelector("button")).toBeNull();
    expect(document.activeElement).toBe(document.body);
    expect(button.isConnected).toBe(false);

    // Only the clock releases the scripted reply, which is what proves the activation
    // put a real call on this bridge rather than settling from anything local.
    await act(async () => {
      bridge.scenarioEngine?.advance(ATTACH_REPLY_DUE_MS);
      await crossMacrotaskBoundary();
    });

    const resolved = attachSection(container);
    expect(resolved.getAttribute("data-attach-state")).toBe("resolved");
    // The verdict is rendered as the daemon returned it: a fresh attachment is
    // registering, and this surface synthesizes no "online" for it.
    expect(resolved.getAttribute("data-node-state")).toBe("registering");
    expect(resolved.getAttribute("data-read-only")).toBe("false");
  });

  it("negative control: nothing settles the attach while the clock has not moved", async () => {
    // Without this the case above would pass over a control that resolved locally, and
    // the whole claim — that a real activation reached a real transport — would be
    // vacuous. The pending arm has to survive a full settling pass.
    const { container } = await renderSettled(
      <RuntimeNodesPage context={contextFor(bridgeWithRoster())} />,
    );

    await tabToAttachButton(container);
    await pressKeys("{Enter}");
    await act(async () => {
      await crossMacrotaskBoundary();
    });

    expect(attachSection(container).getAttribute("data-attach-state")).toBe("pending");
  });
});
