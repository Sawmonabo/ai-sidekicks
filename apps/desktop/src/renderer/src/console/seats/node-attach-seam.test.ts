// What the console hands the absorbed attach flow, and what it refuses to invent.
//
// Two claims, and they fail in opposite directions. The transport claim is that the
// seam reaches THIS window's bridge and carries the registered procedure name it was
// composed with — a seam that reached the installed preload instead would look
// identical here and answer from the live daemon in a fixture window. The declaration
// claim is that a draft is RESOLVED and never composed: the fixture supplies one and
// the live bridge supplies none, and a module that filled the gap in would be this
// renderer vouching for a machine on its own word.

import { describe, expect, it } from "vitest";

import type { RuntimeNodeAttachRequest, SessionId } from "@ai-sidekicks/contracts";

import { createFixtureBridge, type ConsoleBridge } from "../bridge/index.js";
import { SETTINGS_SCENARIO } from "../bridge/scenarios/settings.js";
import { SETTINGS_RUNTIME_NODE_ATTACH_DRAFT } from "../bridge/scenarios/settings-runtime-nodes.js";
import { COLLABORATION_SCENARIO } from "../bridge/scenarios/collaboration.js";
import { nodeAttachDraftFor, nodeAttachReadsFor } from "./node-attach-seam.js";

/** Past the scripted latency on the settings scenario's attach reply. */
const ATTACH_REPLY_DUE_MS = 120;

function settingsBridge(): ConsoleBridge {
  return createFixtureBridge({ scenario: SETTINGS_SCENARIO });
}

/** The whole request the flow would send, composed the way that flow composes it. */
function attachRequest(sessionId: string): RuntimeNodeAttachRequest {
  return { ...SETTINGS_RUNTIME_NODE_ATTACH_DRAFT, sessionId: sessionId as SessionId };
}

describe("node attach seam", () => {
  it("resolves the declaration the running scenario supplies", () => {
    expect(nodeAttachDraftFor(settingsBridge())).toBe(SETTINGS_RUNTIME_NODE_ATTACH_DRAFT);
  });

  it("answers nothing for a scenario that names no declaration", () => {
    // A reading rather than a gap, and the live bridge's ordinary answer: no
    // registered read delivers a local machine's self-description to this renderer.
    expect(nodeAttachDraftFor(createFixtureBridge({ scenario: COLLABORATION_SCENARIO }))).toBe(
      undefined,
    );
  });

  it("attaches through the bridge it was handed, at the registered procedure", async () => {
    const bridge = settingsBridge();
    const reads = nodeAttachReadsFor(bridge);
    const settled = reads.attachNode(attachRequest(SETTINGS_SCENARIO.sessionId));
    // The scripted reply is held until the scenario clock reaches its latency, which
    // is what proves the call went through THIS bridge's engine rather than anywhere
    // else: nothing but this engine can release it.
    bridge.scenarioEngine?.advance(ATTACH_REPLY_DUE_MS);

    const response = await settled;
    expect(response.state).toBe("registering");
    expect(response.readOnly).toBe(false);
    expect(response.attachmentId.length).toBeGreaterThan(0);
  });

  it("negative control: a scenario scripting no attach refuses rather than resolving", async () => {
    // Without this, the case above would pass over a seam that answered from a second
    // transport — an unscripted call is the fixture's own authoring refusal, and only
    // a seam bound to this engine can produce it.
    const bridge = createFixtureBridge({ scenario: COLLABORATION_SCENARIO });
    await expect(
      nodeAttachReadsFor(bridge).attachNode(attachRequest(COLLABORATION_SCENARIO.sessionId)),
    ).rejects.toThrow(/runtimenode\.attach/);
  });

  it("composes a fresh pair per call, because no subscription depends on its identity", () => {
    // The opposite of the roster's seam, deliberately: this one is read inside a click
    // handler, so a cache would be a lifetime to reason about for no behaviour.
    const bridge = settingsBridge();
    expect(nodeAttachReadsFor(bridge)).not.toBe(nodeAttachReadsFor(bridge));
  });
});
