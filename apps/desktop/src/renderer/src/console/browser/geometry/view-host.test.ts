// 12.11's one platform-shaped decision, and the value that stands in for no host.
//
// The point of these cases is that "no host" is a VALUE: a consumer that forgets to
// check gets a sentence back rather than a dereference, and the wiring table selects
// on what it was handed rather than on `process.platform`.
//
// THE TABLE IS DRIVEN WITH REAL BRIDGES. It used to take an optional scripted host,
// and the only caller that ever supplied one was this file — the pane called it with
// an empty bag, so the attached arm these cases proved existed was reachable by
// nothing that shipped. Both arms are now the two bridges the console actually runs
// on: the fixture, which publishes a scripted host, and the live one, which does not.

import { describe, expect, it } from "vitest";

import { createFixtureBridge, type ConsoleBridge } from "../../bridge/index.js";
// Both deep, and both for the same reason: neither name is on the bridge door,
// because no cross-family production module takes either one through it.
import { SCRIPTED_PANE_VIEW_HOST_TRANSPORT } from "../../bridge/fixture/pane-view-host-script.js";
import { createLiveBridge } from "../../bridge/live-bridge.js";
import { BROWSER_SCENARIO } from "../../bridge/scenarios/browser.js";
import { isConsoleRefusal } from "../../core/index.js";
import type { PaneGeometrySample } from "./pane-geometry.js";
import {
  PANE_VIEW_HOST_REFUSAL_CODES,
  PANE_VIEW_HOST_REFUSAL_ORIGIN,
  resolvePaneViewHost,
  unavailablePaneViewHost,
} from "./view-host.js";

const PANE_ID = "pane-browser-1";

const SAMPLE = {
  rect: { x: 0, y: 0, width: 100, height: 100 },
  key: "0,0,100,100",
} as unknown as PaneGeometrySample;

/** The bridge a fixture or end-to-end run hands the pane. */
function fixtureBridge(): ConsoleBridge {
  return createFixtureBridge({ scenario: BROWSER_SCENARIO });
}

/**
 * The bridge a live window hands the pane, over the same preload contract.
 *
 * Built from the fixture's own `sidekicks` namespace rather than a hand-made object:
 * that value IS the preload contract, so this is the real live wrapper answering for
 * a window that has no view host, which is the arm the table has to reach today.
 */
function liveBridge(): ConsoleBridge {
  return createLiveBridge(fixtureBridge().sidekicks);
}

describe("unavailablePaneViewHost", () => {
  it("is a value carrying a refusal, never a null", () => {
    const host = unavailablePaneViewHost("No view host is wired in this window.");
    expect(host.state).toBe("unavailable");
    expect(isConsoleRefusal(host.refusal)).toBe(true);
    expect(host.refusal.origin).toBe(PANE_VIEW_HOST_REFUSAL_ORIGIN);
    expect(PANE_VIEW_HOST_REFUSAL_CODES).toContain(host.refusal.code);
    expect(host.refusal.detail).toBe("No view host is wired in this window.");
  });
});

describe("resolvePaneViewHost", () => {
  it("takes the fixture bridge's scripted host, and says how it is reached", () => {
    const host = resolvePaneViewHost({ bridge: fixtureBridge(), paneId: PANE_ID });
    expect(host.state).toBe("attached");
    if (host.state !== "attached") {
      throw new Error("unreachable");
    }
    expect(host.transport).toBe("scripted");
    expect(host.setRect(SAMPLE)).toStrictEqual({ status: "accepted" });
  });

  it("falls to unavailable — and says so in a sentence — under the live bridge", () => {
    const host = resolvePaneViewHost({ bridge: liveBridge(), paneId: PANE_ID });
    expect(host.state).toBe("unavailable");
    if (host.state !== "unavailable") {
      throw new Error("unreachable");
    }
    expect(host.refusal.code).toBe("host-unavailable");
    expect(host.refusal.detail.length).toBeGreaterThan(0);
  });

  it("rejects for a pane the scripted host no longer holds, with that host's sentence", () => {
    // The refusing arm the fixture never takes, driven the way a test drives it and
    // the way a main-process host will answer once one exists. The CODE is this
    // module's — the bridge decides whether the pane is addressable and nothing
    // else, so the refusal vocabulary is declared in exactly one place.
    const gone = "The pane was destroyed while this window still held it.";
    const bridge: ConsoleBridge = {
      ...fixtureBridge(),
      paneViewHostScript: {
        transport: SCRIPTED_PANE_VIEW_HOST_TRANSPORT,
        holdsPane: () => ({ holds: false, detail: gone }),
      },
    };
    const host = resolvePaneViewHost({ bridge, paneId: PANE_ID });
    if (host.state !== "attached") {
      throw new Error("unreachable");
    }
    const outcome = host.setRect(SAMPLE);
    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") {
      throw new Error("unreachable");
    }
    expect(outcome.refusal.origin).toBe(PANE_VIEW_HOST_REFUSAL_ORIGIN);
    expect(outcome.refusal.code).toBe("pane-gone");
    expect(outcome.refusal.detail).toBe(gone);
  });

  it("binds the pane it was resolved for, so a host is never asked about another", () => {
    // The address is bound at resolution rather than travelling on the sample: a
    // publisher holds one host for the life of its binding, and a stale one asking
    // about the pane it was minted for is a bug the pane can see rather than a
    // rectangle silently filed under somebody else's address.
    const asked: string[] = [];
    const bridge: ConsoleBridge = {
      ...fixtureBridge(),
      paneViewHostScript: {
        transport: SCRIPTED_PANE_VIEW_HOST_TRANSPORT,
        holdsPane: (paneId) => {
          asked.push(paneId);
          return { holds: true };
        },
      },
    };
    const host = resolvePaneViewHost({ bridge, paneId: "pane-browser-7" });
    if (host.state !== "attached") {
      throw new Error("unreachable");
    }
    host.setRect(SAMPLE);
    expect(asked).toStrictEqual(["pane-browser-7"]);
  });

  it("negative control: the table does not answer the same arm for both bridges", () => {
    // Without this, a wiring table that ignored its argument and always refused
    // would satisfy the unavailable case above — which is exactly what the pane got
    // for every fixture and end-to-end run while it called this with an empty bag.
    expect(resolvePaneViewHost({ bridge: fixtureBridge(), paneId: PANE_ID }).state).not.toBe(
      resolvePaneViewHost({ bridge: liveBridge(), paneId: PANE_ID }).state,
    );
  });
});
