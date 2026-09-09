// The hand-off over a real fixture bridge, on both of the arms that bridge has.
//
// ITS OWN SUITE BESIDE `aux-handoff.test.ts`, which drives the four gates against a
// hand-written plane and is the right place for the gates themselves. What is asserted
// here is the other half: which of the two arms a fixture build takes, and that each
// arm answers the truth about the process it is running in.
//
// THE ARM IS WHETHER A SHELL IS INSTALLED, never the `define` gate. The same fixture
// bundle is loaded inside Electron and in a browser-mode run, so the fixture asks
// whether a preload put a bridge on the window — and these cases install one, and
// leave it uninstalled, to drive both answers.
//
// WHAT THE NO-SHELL ARM MUST NOT DO. It used to mint a synthetic handle and answer
// `served`, so the deck suppressed the pane's body and drew a placeholder for a window
// that did not exist — the person lost the pane until they pressed return. The pane
// staying in the deck, with the refusal stated, is the property that replaces it.

import { afterEach, describe, expect, it } from "vitest";

import type { SidekicksBridge } from "@ai-sidekicks/contracts";

import { AUXILIARY_WINDOW_CHANNELS } from "@ai-sidekicks/contracts";

import { SIDEKICKS_BRIDGE_NAMESPACES } from "../../bridge/bridge-shape.js";
import { createFixtureBridge } from "../../bridge/index.js";
import { FLAGSHIP_SCENARIO } from "../../bridge/scenario/flagship/flagship.js";
import { AuxiliaryHandoff } from "./aux-handoff.js";

/** The pane these cases move into a window. */
const PANE_ID = "pane-timeline-1";

/** One detach request, as every case here makes it. */
const TIMELINE_DETACH = {
  paneId: PANE_ID,
  kind: "timeline",
  sessionId: FLAGSHIP_SCENARIO.sessionId,
} as const;

/** What a shell was asked to open, recorded by the stand-in below. */
interface ShellCallLog {
  readonly detached: { paneId: string; route: string; sessionId?: string }[];
  readonly focused: string[];
}

/**
 * Put a bridge on the window the way a preload does, with one real `window` namespace.
 *
 * ONLY THE NAMESPACE UNDER TEST IS REAL. `readInstalledBridge` probes that every
 * contract namespace is an object and nothing more, so the rest are empty objects —
 * a fuller stand-in would be a second declaration of the preload contract, which is
 * the thing `bridge-shape.test.ts` exists to compare against rather than duplicate.
 * The namespace NAMES are read off the contract's own table for the same reason: a
 * hand-written list here went stale the moment the contract grew a namespace, and
 * the probe then read these cases' shell as absent.
 */
function installBridgeWith(namespace: SidekicksBridge["window"]): void {
  const bridge = Object.fromEntries(SIDEKICKS_BRIDGE_NAMESPACES.map((name) => [name, {}]));
  (globalThis as { sidekicks?: unknown }).sidekicks = { ...bridge, window: namespace };
}

/** Install a `window` namespace the way a preload does, and record what reaches it. */
function installShell(): ShellCallLog {
  const log: ShellCallLog = { detached: [], focused: [] };
  const namespace: SidekicksBridge["window"] = {
    detachPane: async (request) => {
      log.detached.push({ ...request });
      return { windowId: "shell-window-1" };
    },
    focusAuxiliary: async (handle) => {
      log.focused.push(handle.windowId);
    },
    closeAuxiliary: async () => undefined,
    subscribePaneErrors: () => () => undefined,
    subscribePaneReturns: () => () => undefined,
  };
  installBridgeWith(namespace);
  return log;
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "sidekicks");
});

/**
 * Install a `window` namespace whose calls reject the way an UNHANDLED channel does.
 *
 * `ipcRenderer.invoke` on a channel `ipcMain` holds no handler for rejects with this
 * sentence, so this is the state a build is in when the preload shipped the namespace
 * and the main process never registered the other half — the shape a shell-side
 * regression takes, and the one a fixture that answered out of a map of its own could
 * not have produced at all.
 */
function installShellWithNoHandlers(): void {
  const rejectUnhandled = async (): Promise<never> => {
    throw new Error(`No handler registered for '${AUXILIARY_WINDOW_CHANNELS.detachPane}'`);
  };
  const namespace: SidekicksBridge["window"] = {
    detachPane: rejectUnhandled,
    focusAuxiliary: rejectUnhandled,
    closeAuxiliary: rejectUnhandled,
    subscribePaneErrors: () => () => undefined,
    subscribePaneReturns: () => () => undefined,
  };
  installBridgeWith(namespace);
}

function handoffOverFixture(): AuxiliaryHandoff {
  const bridge = createFixtureBridge({ scenario: FLAGSHIP_SCENARIO });
  return new AuxiliaryHandoff({ auxiliaryWindows: bridge.auxiliaryWindows });
}

describe("the hand-off over the fixture bridge, with a shell installed", () => {
  it("reaches the shell's own handler, carrying the route and its context", async () => {
    // THE DEFECT THIS REPLACES. The fixture used to answer out of a map of its own, so
    // a detach in a fixture build opened nothing at all and the shell's handler — the
    // one that actually constructs a `BrowserWindow` — had no caller anywhere.
    const shell = installShell();
    const handoff = handoffOverFixture();

    const outcome = await handoff.detach(TIMELINE_DETACH);

    expect(outcome.outcome).toBe("detached");
    expect(shell.detached).toStrictEqual([
      { paneId: PANE_ID, route: "timeline", sessionId: FLAGSHIP_SCENARIO.sessionId },
    ]);
    // The handle the deck records is the SHELL's, not one this process invented.
    expect(handoff.detachedPane(PANE_ID)?.windowId).toBe("shell-window-1");
  });

  it("addresses that window by the handle the shell gave back", async () => {
    const shell = installShell();
    const handoff = handoffOverFixture();
    await handoff.detach(TIMELINE_DETACH);

    expect(await handoff.focus(PANE_ID)).toBeUndefined();

    expect(shell.focused).toStrictEqual(["shell-window-1"]);
  });

  it("still refuses a pane kind that has no window route, over the same bridge", async () => {
    // The negative control for the served arm: gate 1 is a local fact and a served
    // wire must not have moved it. A plane that answered for any pane at all would
    // open a hardened window onto a route this build cannot render.
    installShell();
    const handoff = handoffOverFixture();

    const outcome = await handoff.detach({
      paneId: "pane-approvals-1",
      kind: "approvals",
      sessionId: FLAGSHIP_SCENARIO.sessionId,
    });

    expect(outcome.outcome).toBe("refused");
    if (outcome.outcome === "refused") {
      expect(outcome.refusal.code).toBe("kind-not-detachable");
    }
    // And nothing reached the shell, which is the half a refusal that fired too late
    // would still pass: gate 1 refuses BEFORE a window can flash open.
    expect(handoff.detachedPane("pane-approvals-1")).toBeUndefined();
  });
});

describe("the hand-off over the fixture bridge, with no shell", () => {
  it("refuses rather than reporting a window, and leaves the pane in the deck", async () => {
    // The pane is what matters here. A build with nothing behind the placeholder that
    // answered `served` took the pane's body away and gave nothing back for it.
    const handoff = handoffOverFixture();

    const outcome = await handoff.detach(TIMELINE_DETACH);

    expect(outcome.outcome).toBe("refused");
    if (outcome.outcome === "refused") {
      expect(outcome.refusal.code).toBe("shell-absent");
      expect(outcome.refusal.detail).toContain("no window shell");
    }
    // Nothing is suppressed and nothing is recorded, so the deck goes on drawing the
    // pane it already had.
    expect(handoff.detached()).toStrictEqual([]);
    expect(handoff.lostWindows()).toStrictEqual([]);
  });

  it("refuses the window signals too, so the placeholder never claims calm", async () => {
    const handoff = handoffOverFixture();

    await handoff.watchWindowSignals();

    expect(handoff.paneErrorRefusal?.code).toBe("shell-absent");
    expect(handoff.paneReturnRefusal?.code).toBe("shell-absent");
    handoff.stopWatchingWindowSignals();
  });
});

describe("the hand-off over the fixture bridge, with a shell that holds no handlers", () => {
  it("refuses rather than recording a handle, and keeps the pane in the deck", async () => {
    // The unregistered-handler state, end to end. Every layer between the press and
    // `ipcMain` exists and answers; only the handler is missing, so the rejection is
    // the ONLY thing that can carry the fact — and a plane that let it escape would
    // leave the press answered by nothing at all.
    installShellWithNoHandlers();
    const handoff = handoffOverFixture();

    const outcome = await handoff.detach(TIMELINE_DETACH);

    expect(outcome.outcome).toBe("refused");
    if (outcome.outcome === "refused") {
      expect(outcome.refusal.code).toBe("wire-rejected");
      // The shell's own sentence, carried rather than replaced: it names the channel
      // nobody is serving, which is what a person debugging this needs.
      expect(outcome.refusal.detail).toContain(AUXILIARY_WINDOW_CHANNELS.detachPane);
    }
    // And no synthetic handle: the deck has nothing detached, so the pane's body is
    // still drawn where it was.
    expect(handoff.detached()).toStrictEqual([]);
    expect(handoff.detachedPane(PANE_ID)).toBeUndefined();
  });
});
