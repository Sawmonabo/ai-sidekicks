// The shipped Tier-1 families a console surface absorbed, and the seam one is handed.
//
// Three of the four families reach the screen through a console-authored surface
// rather than through a slot of their own, so this file covers the mounts those
// surfaces call and the guard two of them carry. The guard is a CLAIM — a helper
// that mounted its component past the check would look identical from the outside
// until it answered from the live daemon in a window showing fixture data. The
// roster's half carries a different claim: it is handed the bridge's own reads, so
// there is no window in which it could reach past them.
//
// The elements are inspected rather than rendered, and that is the point rather than
// a shortcut. Two of the components read `window.sidekicks` on mount, so MOUNTING
// them here would assert something about happy-dom's missing preload instead of
// about the wiring — and the wiring is the whole claim: which component, and which
// session id it is handed. A React element carries both before anything renders it.
//
// The node roster carries a third thing an element carries before it renders: the
// read seam this module built for it. So the cases below reach for `props.reads` and
// drive it directly against a real fixture bridge, which is how the refusal
// conversion — the only logic this module adds — is checked without mounting
// anything.

import { isValidElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";

import type { SessionId } from "@ai-sidekicks/contracts";

import { createFixtureBridge, type ConsoleBridge } from "../bridge/index.js";
import { COLLABORATION_SCENARIO } from "../bridge/scenarios/collaboration.js";
import { unscriptedScenario } from "../bridge/fixture/fixture-bridge.test-support.js";
import { ConsoleRefusalError } from "../core/index.js";
import { SurfaceAbsence } from "../primitives/index.js";
import { SETTINGS_SCENARIO } from "../bridge/scenarios/settings.js";
import { SETTINGS_RUNTIME_NODE_ATTACH_DRAFT } from "../bridge/scenarios/settings-runtime-nodes.js";
import { AttachFlow, NodeRoster, type NodeRosterReads } from "../../runtime-node-attach/index.js";
import { SessionBootstrap } from "../../session-bootstrap/index.js";
import {
  renderAbsorbedAttachFlow,
  renderAbsorbedNodeRoster,
  renderAbsorbedSessionProbe,
} from "./absorbed-surfaces.js";

/** The element a helper produced, or a failure that names what came back instead. */
function renderedElement(node: ReactNode): { type: unknown; props: Record<string, unknown> } {
  if (!isValidElement<Record<string, unknown>>(node)) {
    throw new Error(`expected a React element, got ${String(node)}`);
  }
  return { type: node.type, props: node.props };
}

/**
 * The `Nothing` inside a whole-surface absence, having first asserted that it IS one.
 *
 * Every arm here fills the entire pane, and a `Nothing` left in flow renders as a
 * strip in its top-left corner — a page that reads as having failed to finish
 * painting. That shipped once precisely because the assertions here reached straight
 * for `kind`: the kind was right and the placement was wrong, and no test named the
 * placement. Unwrapping through this helper pins both, and only the screenshot tier
 * could see the difference otherwise.
 */
function centredAbsence(node: ReactNode): { type: unknown; props: Record<string, unknown> } {
  const wrapper = renderedElement(node);
  expect(wrapper.type).toBe(SurfaceAbsence);
  return renderedElement(wrapper.props["children"] as ReactNode);
}

/**
 * The tick the collaboration script's roster first has rows at.
 *
 * Its first frame is empty — a session whose machines have not attached yet — and
 * the three arrive together at this one. Named here the way the fixture bridge's own
 * suite names its ticks; the node-id assertion below is what pins it, so a script
 * that moved the frame fails loudly rather than passing vacuously.
 */
const ROSTER_POPULATED_MS = 580;

/** One frame later: the runner's attachment ends while its heartbeat still reads healthy. */
const RUNNER_DEPARTURE_MS = 640;

/** A real fixture bridge over this family's own scenario. */
function fixtureBridge(): ConsoleBridge {
  return createFixtureBridge({ scenario: COLLABORATION_SCENARIO });
}

describe("absorbed surfaces — the families a console surface mounts", () => {
  it("mounts the session probe with no props to give it", () => {
    expect(renderedElement(renderAbsorbedSessionProbe("live")).type).toBe(SessionBootstrap);
  });

  it("hands the node roster the session its caller resolved", () => {
    const element = renderedElement(renderAbsorbedNodeRoster(fixtureBridge(), "session-9"));
    expect(element.type).toBe(NodeRoster);
    expect(element.props["sessionId"]).toBe("session-9");
  });

  it("keeps the fixture guard on the probe, because the guard is not the caller's", () => {
    // The whole reason these are helpers rather than exported components. A console
    // surface that imported `SessionBootstrap` directly would mount a component
    // reading the installed bridge into a window showing fixture data.
    expect(centredAbsence(renderAbsorbedSessionProbe("fixture")).props["kind"]).toBe("not-checked");
  });

  it("mounts the roster under the fixture, because it no longer needs that guard", () => {
    // The negative control for the case above, and the change this seam exists for:
    // the roster asks whichever bridge this window resolved, so a fixture build
    // renders the roster rather than saying the question was not put.
    const element = renderedElement(renderAbsorbedNodeRoster(fixtureBridge(), "session-9"));
    expect(element.type).toBe(NodeRoster);
  });

  it("says the console needs a session rather than mounting the roster without one", () => {
    // Reachable: the frame's context picker resolves a bare auxiliary address by
    // choosing a SESSION, and the agent-console grammar carries its agent with its
    // session — so a picked session arrives at the pane with no agent, and a pane
    // opened session-scoped in the deck carries none either.
    const element = centredAbsence(renderAbsorbedNodeRoster(fixtureBridge(), undefined));
    expect(element.type).not.toBe(NodeRoster);
    expect(element.props["kind"]).toBe("empty");
  });

  it("says nothing was asked when the mount resolved no bridge at all", () => {
    // The agent console types its own bridge prop as possibly absent, so this arm is
    // the helper's rather than the caller's — and it is `not-checked` because no read
    // failed: none was performed.
    const element = centredAbsence(renderAbsorbedNodeRoster(undefined, "session-9"));
    expect(element.type).not.toBe(NodeRoster);
    expect(element.props["kind"]).toBe("not-checked");
  });
});

describe("absorbed surfaces — the attach flow and the declaration it reviews", () => {
  /** A bridge over the one scenario whose deck supplies a node declaration. */
  function bridgeWithDeclaration(): ConsoleBridge {
    return createFixtureBridge({ scenario: SETTINGS_SCENARIO });
  }

  it("mounts the flow with the resolved declaration and this bridge's transport", () => {
    const element = renderedElement(
      renderAbsorbedAttachFlow(bridgeWithDeclaration(), SETTINGS_SCENARIO.sessionId),
    );
    expect(element.type).toBe(AttachFlow);
    expect(element.props["sessionId"]).toBe(SETTINGS_SCENARIO.sessionId);
    expect(element.props["attachDraft"]).toBe(SETTINGS_RUNTIME_NODE_ATTACH_DRAFT);
    // The transport is what makes this renderable at all: without a seam the view
    // reaches the installed preload, which under a fixture build is either absent or
    // the live daemon answering beside fixture data in the same window.
    expect(element.props["reads"]).not.toBe(undefined);
  });

  it("composes no declaration where the deck supplies none", () => {
    // The trust decision, made once here rather than at each caller: a helper that
    // could be handed a draft is a helper whose callers could compose one.
    const element = centredAbsence(
      renderAbsorbedAttachFlow(fixtureBridge(), COLLABORATION_SCENARIO.sessionId),
    );
    expect(element.type).not.toBe(AttachFlow);
    expect(element.props["kind"]).toBe("not-checked");
  });

  it("asks for a session before it offers to attach into one", () => {
    const element = centredAbsence(renderAbsorbedAttachFlow(bridgeWithDeclaration(), undefined));
    expect(element.type).not.toBe(AttachFlow);
    expect(element.props["kind"]).toBe("empty");
  });

  it("says nothing was asked when the mount resolved no bridge to attach through", () => {
    const element = centredAbsence(
      renderAbsorbedAttachFlow(undefined, SETTINGS_SCENARIO.sessionId),
    );
    expect(element.type).not.toBe(AttachFlow);
    expect(element.props["kind"]).toBe("not-checked");
  });
});

describe("absorbed surfaces — the read seam the roster is handed", () => {
  /** The scenario that names no roster at all — the "nobody asked" arm. */
  const NO_ROSTER_SCENARIO = unscriptedScenario("no-roster");

  /** The seam the helper built, off the element it returned. */
  function rosterReadsFor(bridge: ConsoleBridge, sessionId: string): NodeRosterReads {
    const element = renderedElement(renderAbsorbedNodeRoster(bridge, sessionId));
    return element.props["reads"] as NodeRosterReads;
  }

  it("serves the scenario's own roster rows through the read", async () => {
    const bridge = fixtureBridge();
    bridge.scenarioEngine?.advance(ROSTER_POPULATED_MS);

    const response = await rosterReadsFor(bridge, COLLABORATION_SCENARIO.sessionId).readRoster({
      sessionId: COLLABORATION_SCENARIO.sessionId as SessionId,
    });

    expect(response.nodes.map((node) => node.nodeId)).toStrictEqual([
      "node-sawyer-laptop",
      "node-priya-desktop",
      "node-tomas-runner",
    ]);
  });

  it("rejects with the refusal's own code when the scenario names no roster", async () => {
    // The conversion this module exists to perform: the bridge ANSWERS a refusal
    // because a surface rendering one wants a value, and this view renders one from
    // its error arm, which is reached by a rejection. An empty list here would be a
    // fabrication — "no machine is attached" is a session state, and "nobody asked"
    // is not.
    const bridge = createFixtureBridge({ scenario: NO_ROSTER_SCENARIO });
    const reads = rosterReadsFor(bridge, NO_ROSTER_SCENARIO.sessionId);

    const rejection = await reads
      .readRoster({ sessionId: NO_ROSTER_SCENARIO.sessionId as SessionId })
      .then(
        () => undefined,
        (raised: unknown) => raised,
      );

    expect(rejection).toBeInstanceOf(ConsoleRefusalError);
    expect((rejection as ConsoleRefusalError).refusal.code).toBe("roster-unscripted");
    expect((rejection as ConsoleRefusalError).refusal.origin).toBe("runtime-node-roster");
  });

  it("negative control: the same read resolves for a scenario that names one", async () => {
    // Without this, a seam that rejected every read would pass the case above.
    const bridge = fixtureBridge();
    bridge.scenarioEngine?.advance(ROSTER_POPULATED_MS);

    await expect(
      rosterReadsFor(bridge, COLLABORATION_SCENARIO.sessionId).readRoster({
        sessionId: COLLABORATION_SCENARIO.sessionId as SessionId,
      }),
    ).resolves.toBeDefined();
  });

  it("hands one seam per bridge, so the view can depend on its identity", () => {
    // The roster's effect re-subscribes when this object changes, and this helper
    // runs on every parent render. Composed fresh each call, the seam would churn
    // the subscription on every keystroke above the mount.
    const bridge = fixtureBridge();
    expect(rosterReadsFor(bridge, COLLABORATION_SCENARIO.sessionId)).toBe(
      rosterReadsFor(bridge, COLLABORATION_SCENARIO.sessionId),
    );
  });

  it("negative control: a different bridge gets a different seam", () => {
    // Without this, a seam cached on nothing at all — one module-level pair
    // reused for every bridge — would pass the case above while leaving a
    // replaced transport unnoticeable, which is the failure the identity exists
    // to make visible.
    expect(rosterReadsFor(fixtureBridge(), COLLABORATION_SCENARIO.sessionId)).not.toBe(
      rosterReadsFor(fixtureBridge(), COLLABORATION_SCENARIO.sessionId),
    );
  });

  it("reads the second bridge's rows through the second bridge's seam", () => {
    // Identity is only worth depending on if it tracks the transport: the seam a
    // replaced bridge hands back must ask THAT bridge.
    const firstBridge = fixtureBridge();
    const secondBridge = createFixtureBridge({ scenario: NO_ROSTER_SCENARIO });

    const firstSeam = rosterReadsFor(firstBridge, COLLABORATION_SCENARIO.sessionId);
    const secondSeam = rosterReadsFor(secondBridge, NO_ROSTER_SCENARIO.sessionId);

    expect(secondSeam).not.toBe(firstSeam);
  });

  it("hands back the bridge's own unsubscribe on a live subscription", () => {
    const bridge = fixtureBridge();
    let signals = 0;

    const release = rosterReadsFor(bridge, COLLABORATION_SCENARIO.sessionId).subscribePresence(
      COLLABORATION_SCENARIO.sessionId as SessionId,
      () => {
        signals += 1;
      },
    );
    bridge.scenarioEngine?.advance(ROSTER_POPULATED_MS);
    const signalsWhileSubscribed = signals;
    release();
    bridge.scenarioEngine?.advance(RUNNER_DEPARTURE_MS - ROSTER_POPULATED_MS);

    expect(signalsWhileSubscribed).toBeGreaterThan(0);
    // Released means released: the departure beat past the release reaches nobody.
    expect(signals).toBe(signalsWhileSubscribed);
  });
});
