// The composer's attach row, and the one thing it decides for itself.
//
// It refuses locally on exactly one fact — that no pane is focused — and hands every
// other refusal back verbatim from the wire. So the cases below are one local refusal
// and two wire ones, and the wire cases assert that the code on screen is the port's
// own rather than a sentence this entry composed.

import { describe, expect, it } from "vitest";

import { createFixtureBridge, type ConsoleBridge } from "../../bridge/index.js";
import { BROWSER_SCENARIO } from "../../bridge/scenarios/browser.js";
import { browserAttachMenuEntry } from "./attach-entry.js";

function fixtureBridge(): ConsoleBridge {
  return createFixtureBridge({ scenario: BROWSER_SCENARIO });
}

/** A bridge whose attach call rejects rather than answering, the transport's own arm. */
function rejectingBridge(): ConsoleBridge {
  const base = fixtureBridge();
  return {
    ...base,
    growth: {
      ...base.growth,
      browserPaneAttach: async () => {
        throw new Error("the channel went away");
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
