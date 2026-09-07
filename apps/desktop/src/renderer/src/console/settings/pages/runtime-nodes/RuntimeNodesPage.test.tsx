// The nodes page renders both health axes' vocabulary, asks for a session, and
// invents no attachment.
//
// The absorbed roster now reads through the bridge this page already holds, so the
// cases with a session MOUNT it against a real fixture bridge and assert the rows
// the scenario scripts. That is the difference this seam makes: before it, every
// fixture build of this page said the question was not put where the roster
// belongs.

import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RuntimeNodesPage, registerRuntimeNodesPage } from "./RuntimeNodesPage.js";
import { SettingsPageRegistry, type SettingsPageContext } from "../../settings-page-registry.js";
import { createFixtureBridge, type ConsoleBridge } from "../../../bridge/index.js";
import { unscriptedScenario } from "../../../bridge/fixture/fixture-bridge.test-support.js";
import { SETTINGS_SCENARIO } from "../../../bridge/scenarios/settings.js";
import {
  PARTICIPANT_YOU,
  SETTINGS_RUNTIME_NODE_ATTACH_DRAFT,
} from "../../../bridge/scenarios/settings-runtime-nodes.js";
import { consoleTestUiStateStore } from "../../settings-page-mount.test-support.js";
import { settle } from "../../../core/settle.test-support.js";

/**
 * The tick this scenario's two machines are both online at, one axis apart.
 *
 * Its script degrades the builder's heartbeat while its attachment is still online,
 * so a reading here carries the disagreement the never-mask rule exists for. The
 * per-axis assertions below are what pin the tick.
 */
const BOTH_MACHINES_ONLINE_MS = 200;

/**
 * A tick inside the scenario's second roster frame, before the write lease is taken.
 *
 * Its first two frames carry a `null` holder and its last two carry this participant,
 * so one scenario reaches both readings of the shared-shell line and neither needs a
 * deck of its own. The frame's rows are what pin it: at this tick both machines are
 * admitted and neither has heartbeated.
 */
const BEFORE_THE_LEASE_IS_TAKEN_MS = 90;

function contextFor(
  bridge: ConsoleBridge,
  retainedSessionId: string | undefined,
): SettingsPageContext {
  return {
    bridge,
    openSection: () => undefined,
    retainedSessionId,
    retainedSessionStore: undefined,
    uiStateStore: consoleTestUiStateStore(),
  };
}

/** The real fixture bridge over the scenario whose script names two machines. */
function bridgeWithRoster(): ConsoleBridge {
  const bridge = createFixtureBridge({ scenario: SETTINGS_SCENARIO });
  bridge.scenarioEngine?.advance(BOTH_MACHINES_ONLINE_MS);
  return bridge;
}

describe("runtime nodes page", () => {
  it("names both health axes rather than one collapsed reading", () => {
    const { container } = render(
      <RuntimeNodesPage context={contextFor(bridgeWithRoster(), undefined)} />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Attachment state");
    expect(text).toContain("Heartbeat presence");
  });

  it("says the roster belongs to a session when this window has opened none", () => {
    const { container } = render(
      <RuntimeNodesPage context={contextFor(bridgeWithRoster(), undefined)} />,
    );
    expect(container.textContent ?? "").toContain("belongs to a session");
  });

  it("renders the scenario's rows with both health axes side by side", async () => {
    // The seam's whole point, at the surface a person opens. Both axes are read off
    // the row's own machine-readable facets rather than off prose, so a page that
    // collapsed them into one scalar fails here rather than in review.
    render(
      <RuntimeNodesPage context={contextFor(bridgeWithRoster(), SETTINGS_SCENARIO.sessionId)} />,
    );

    const roster = await screen.findByLabelText("node-roster-loaded");
    const rows = roster.querySelectorAll("li");
    expect(rows).toHaveLength(2);
    expect(
      roster.querySelector('li[data-node-state="online"][data-health-state="online"]'),
    ).not.toBeNull();
    // …and the machine whose two axes disagree is on the same list, not hidden.
    expect(
      roster.querySelector('li[data-node-state="online"][data-health-state="degraded"]'),
    ).not.toBeNull();
  });

  it("keeps a below-floor machine visible rather than dropping it", async () => {
    // Admitted read-only, never ejected: the script's second machine reports a
    // client version below this session's floor.
    render(
      <RuntimeNodesPage context={contextFor(bridgeWithRoster(), SETTINGS_SCENARIO.sessionId)} />,
    );

    const roster = await screen.findByLabelText("node-roster-loaded");
    expect(roster.querySelectorAll('li[data-read-only="true"]')).toHaveLength(1);
    expect(roster.querySelectorAll('li[data-read-only="false"]')).toHaveLength(1);
  });

  it("renders the refusal, not an empty roster, when the scenario names none", async () => {
    // "No machine is attached" is a session state a page draws; "nobody asked" is
    // not, and a page that drew an empty table for the second would be reporting a
    // reading nobody took.
    const scenario = unscriptedScenario("nodes-page-no-roster");
    render(
      <RuntimeNodesPage
        context={contextFor(createFixtureBridge({ scenario }), scenario.sessionId)}
      />,
    );

    const refusal = await screen.findByRole("alert", { name: "node-roster-error" });
    expect(refusal.textContent).toContain("roster-unscripted");
    expect(screen.queryByLabelText("node-roster-loaded")).toBeNull();
  });

  it("negative control: with no session it mounts no roster at all", async () => {
    // Without this, the refusal case above would pass over a page that rendered the
    // same sentence for an address that simply named no session — a different and
    // false statement about why nothing was read.
    render(<RuntimeNodesPage context={contextFor(bridgeWithRoster(), undefined)} />);

    await waitFor(() => {
      expect(screen.queryByLabelText("node-roster-loading")).toBeNull();
    });
    expect(screen.queryByLabelText("node-roster-loaded")).toBeNull();
    expect(screen.queryByRole("alert", { name: "node-roster-error" })).toBeNull();
  });

  it("offers the attach control against the declaration the deck supplies", async () => {
    // The control is REVIEW BEFORE SEND: the machine's whole claim is on screen and
    // the button is the participant's own act. A mount that fired on render would
    // pass a text assertion and be the wrong surface, so the declaration and the
    // un-fired state are asserted together.
    render(
      <RuntimeNodesPage context={contextFor(bridgeWithRoster(), SETTINGS_SCENARIO.sessionId)} />,
    );

    const control = await screen.findByLabelText("runtime-node-attach-idle");
    expect(control.getAttribute("data-attach-state")).toBe("idle");
    const declaration = control.querySelector('ul[aria-label="attach-node-declaration"]');
    expect(declaration?.textContent).toContain(SETTINGS_RUNTIME_NODE_ATTACH_DRAFT.nodeId);
    expect(declaration?.textContent).toContain(SETTINGS_RUNTIME_NODE_ATTACH_DRAFT.clientVersion);
    expect(screen.getByRole("button", { name: "Attach runtime node" })).not.toBeNull();
    // The assertions are the case and they are taken first. This mount put a roster
    // read on the wire, and a case that ends before it answers leaves the arrival to
    // land outside React's scope on a tree already coming down — an unwrapped-update
    // warning charged to whichever file ran next. Nothing above is waiting for it.
    await settle();
  });

  it("negative control: a scenario naming no declaration offers no attach control", async () => {
    // Without this the case above would pass over a page that composed a draft of its
    // own, which is the one thing `Spec-023 §Trust Stance` forbids this renderer to do.
    const scenario = unscriptedScenario("nodes-page-no-attach-draft");
    const { container } = render(
      <RuntimeNodesPage
        context={contextFor(createFixtureBridge({ scenario }), scenario.sessionId)}
      />,
    );

    expect(container.textContent ?? "").toContain("A machine attaches itself");
    expect(screen.queryByRole("button", { name: "Attach runtime node" })).toBeNull();
    await settle();
  });

  it("reports who holds the shared shell, off the roster the rows came from", async () => {
    render(
      <RuntimeNodesPage context={contextFor(bridgeWithRoster(), SETTINGS_SCENARIO.sessionId)} />,
    );

    const holderLine = await screen.findByText("Held by");
    const block = holderLine.closest("p");
    expect(block?.textContent).toContain(PARTICIPANT_YOU);
    await settle();
  });

  it("says the lease is unheld while the scenario's holder is null", async () => {
    // The frame before the holder takes it. Rendering "unheld" here and "held" above
    // from ONE read is the property the block exists for: a second `runtimenode.roster`
    // could answer a holder the rows beside it disagree with.
    const bridge = createFixtureBridge({ scenario: SETTINGS_SCENARIO });
    bridge.scenarioEngine?.advance(BEFORE_THE_LEASE_IS_TAKEN_MS);
    render(<RuntimeNodesPage context={contextFor(bridge, SETTINGS_SCENARIO.sessionId)} />);

    expect(await screen.findByText("Unheld")).not.toBeNull();
    expect(screen.queryByText("Held by")).toBeNull();
    await settle();
  });

  it("claims the nodes section with a search vocabulary", () => {
    const registry = new SettingsPageRegistry();
    registerRuntimeNodesPage(registry);
    const descriptor = registry.descriptorFor("nodes");
    expect(descriptor?.label).toBe("Runtime nodes");
    expect(descriptor?.keywords).toContain("heartbeat");
  });
});
