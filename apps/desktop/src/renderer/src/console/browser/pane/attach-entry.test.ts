// The composer's attach row: what it puts on the conversation, and what it never calls.
//
// It refuses locally on exactly one fact — that no pane is focused — and hands every
// other refusal back verbatim from the wire. So the cases below are one local refusal
// and two wire ones, and the wire cases assert that the code on screen is the port's
// own rather than a sentence this entry composed.
//
// AND ONE CASE IS ABOUT WHAT IT DOES NOT DO. This row used to dispatch the PANE's view
// attach, discard its answer, and report `attached` — a conversation that gained nothing
// and a pane left holding a second view. Both halves are asserted: what reaches the
// composer, and that the pane lifecycle's own operation is not called from here.

import { describe, expect, it } from "vitest";

import { createFixtureBridge, type ConsoleBridge } from "../../bridge/index.js";
import { BROWSER_SCENARIO } from "../../bridge/scenario/browser.js";
import { browserAttachMenuEntry } from "./attach-entry.js";

function fixtureBridge(): ConsoleBridge {
  return createFixtureBridge({ scenario: BROWSER_SCENARIO });
}

/** A bridge whose capture rejects rather than answering, the transport's own arm. */
function rejectingBridge(): ConsoleBridge {
  const base = fixtureBridge();
  return {
    ...base,
    growth: {
      ...base.growth,
      browserCapture: async () => {
        throw new Error("the channel went away");
      },
    },
  };
}

/** A bridge whose capture is served, and that records every pane operation reached. */
function capturingBridge(): { readonly bridge: ConsoleBridge; readonly reached: string[] } {
  const base = fixtureBridge();
  const reached: string[] = [];
  return {
    reached,
    bridge: {
      ...base,
      growth: {
        ...base.growth,
        browserCapture: async ({ paneId }) => {
          reached.push(`capture:${paneId}`);
          return {
            status: "served" as const,
            value: { artifactId: "artifact-1", mediaType: "image/png", byteLength: 2048 },
          };
        },
        browserPaneAttach: async ({ paneId }) => {
          reached.push(`pane-attach:${paneId}`);
          return base.growth.browserPaneAttach({ paneId });
        },
      },
    },
  };
}

describe("the browser attach entry", () => {
  it("names itself, its owner, and what picking it does", () => {
    expect(browserAttachMenuEntry.id).toBe("browser.attach-page");
    expect(browserAttachMenuEntry.owner).toBe("browser");
    expect(browserAttachMenuEntry.label).toBe("Attach page");
    expect(browserAttachMenuEntry.detail.length).toBeGreaterThan(0);
  });

  it("refuses by name when no pane is focused", async () => {
    const outcome = await browserAttachMenuEntry.attach({
      bridge: fixtureBridge(),
      sessionId: "session-1",
      focusedPaneId: undefined,
    });
    expect(outcome.status).toBe("refused");
    if (outcome.status === "refused") {
      expect(outcome.refusal.code).toBe("no-focused-pane");
    }
  });

  it("hands the composer the artifact the page was captured into", async () => {
    const capturing = capturingBridge();
    const outcome = await browserAttachMenuEntry.attach({
      bridge: capturing.bridge,
      sessionId: "session-1",
      focusedPaneId: "pane-1",
    });

    expect(outcome).toStrictEqual({
      status: "attached",
      attachment: { artifactId: "artifact-1", mediaType: "image/png", byteLength: 2048 },
    });
    // The negative control, and the defect this case was written for: a row that
    // dispatched the pane's own view attach reported `attached` while the conversation
    // gained nothing, and the assertion above alone cannot see the extra call.
    expect(capturing.reached).toStrictEqual(["capture:pane-1"]);
  });

  it("hands back the port's own refusal for a wire that is on the slate", async () => {
    const outcome = await browserAttachMenuEntry.attach({
      bridge: fixtureBridge(),
      sessionId: "session-1",
      focusedPaneId: "pane-1",
    });
    expect(outcome.status).toBe("refused");
    if (outcome.status === "refused") {
      // The growth port's own code, not one this entry composed — which is what makes
      // the ledger on it (the operation, the slate row, the owing document) reachable.
      expect(outcome.refusal.code).not.toBe("no-focused-pane");
      expect(outcome.refusal.detail.length).toBeGreaterThan(0);
    }
  });

  it("normalizes a call that never answered rather than throwing at the menu", async () => {
    const outcome = await browserAttachMenuEntry.attach({
      bridge: rejectingBridge(),
      sessionId: "session-1",
      focusedPaneId: "pane-1",
    });
    expect(outcome.status).toBe("refused");
    if (outcome.status === "refused") {
      expect(outcome.refusal.code).toBe("pane-attach-failed");
    }
  });
});
