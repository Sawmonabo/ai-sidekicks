// What a Start press does once the create it performs has settled.
//
// Driven through the whole destination rather than against `settleSessionStart`
// directly, because the defect this closes was a MISSING WIRE and not a wrong body:
// the shipped probe created a session from its own mount effect and handed the
// settlement to nobody, so every step below was unreachable from a press however
// correctly it had been written. A case that called the act itself would have passed
// against the tree that had the defect.
//
// The bridge source is `live` in every case here, because the absorbed probe carries
// the fixture guard and renders "the question was not put" on any other — so the
// window this suite drives is the one where a start press reaches a wire, and
// `window.sidekicks` is the surface it reaches it through.

import { act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SidekicksBridge } from "@ai-sidekicks/contracts";

import { contextWith, renderSurface, settle } from "../session-surface.test-support.js";
import { settleFirstSendAutoPin } from "../../seats/index.js";
import type { ConsoleSurfaceContext } from "../../seats/index.js";

/** The session the daemon mints for these cases. */
const CREATED_SESSION_ID = "7f3c1a2b-4d5e-4f60-8a71-9c2d3e4f5061";

/**
 * The installed bridge the probe reads, answering `session.create` as the case says.
 *
 * `window.sidekicks` and not the console's own bridge, deliberately: the probe is a
 * shipped Tier-1 component that reads the preload directly, which is the whole reason
 * the console guards its mount on the bridge SOURCE rather than handing it one.
 */
function installProbeBridge(call: (method: string, params: unknown) => Promise<unknown>): void {
  (window as unknown as { sidekicks: SidekicksBridge }).sidekicks = {
    daemon: { call },
  } as unknown as SidekicksBridge;
}

/** A create that settles with a session, and the calls it recorded. */
function creatingBridge(): ReturnType<typeof vi.fn> {
  const call = vi.fn().mockResolvedValue({
    sessionId: CREATED_SESSION_ID,
    state: "active",
    memberships: [],
    channels: [],
  });
  installProbeBridge(call);
  return call;
}

/** Press Start, the way a person does. */
function pressStart(container: HTMLElement): void {
  const start = container.querySelector<HTMLButtonElement>(".meridian-sessions__start");
  if (start === null) {
    throw new Error("the destination rendered no start control");
  }
  act(() => {
    start.click();
  });
}

/** Mount the destination, press Start, and let the create settle. */
async function startASession(context: ConsoleSurfaceContext): Promise<HTMLElement> {
  const { container } = renderSurface(context);
  await settle();
  pressStart(container);
  await settle();
  return container;
}

describe("a settled start — what the console does with the session it just made", () => {
  afterEach(() => {
    delete (window as unknown as { sidekicks?: SidekicksBridge }).sidekicks;
    vi.clearAllMocks();
  });

  it("opens the session's store in this window", async () => {
    // A session this window created is a session this window has open. It matters
    // before the navigation rather than as a consequence of it: the all-sessions list
    // merges the node's directory with the registry's own set, so a create the node
    // has not answered for yet is on screen because the registry holds it.
    creatingBridge();
    const openedSessionIds: string[] = [];

    await startASession(contextWith({ bridgeSource: "live", openedSessionIds }));

    expect(openedSessionIds).toStrictEqual([CREATED_SESSION_ID]);
  });

  it("navigates into the session it created", async () => {
    creatingBridge();
    const navigations: unknown[] = [];

    await startASession(contextWith({ bridgeSource: "live", navigations }));

    expect(navigations).toStrictEqual([{ kind: "workspace", sessionId: CREATED_SESSION_ID }]);
  });

  it("records the four origin markers, so a first send has something to read", async () => {
    // Asserted THROUGH the rule rather than by reading the record back, because what
    // matters is that the stamp answers the question the composer asks: this console
    // is the only party that can report where a session came from, and the switch it
    // reads is resolved live off the destination's own durable binding.
    creatingBridge();
    const context = contextWith({ bridgeSource: "live" });

    await startASession(context);

    expect(settleFirstSendAutoPin(context.bridge, CREATED_SESSION_ID)).toStrictEqual({
      pinned: true,
    });
  });

  it("navigates nowhere and opens nothing when the create refuses", async () => {
    // A create that refused produced no session, so there is nothing to open, nothing
    // to stamp and nowhere to go — and the probe's own refusal is what a person sees.
    installProbeBridge(vi.fn().mockRejectedValue(new Error("session.create refused")));
    const navigations: unknown[] = [];
    const openedSessionIds: string[] = [];

    const container = await startASession(
      contextWith({ bridgeSource: "live", navigations, openedSessionIds }),
    );

    expect(navigations).toStrictEqual([]);
    expect(openedSessionIds).toStrictEqual([]);
    expect(container.textContent).toContain("session.create refused");
  });

  it("stamps nothing a session that was never started here", async () => {
    // The negative control for the stamp: the rule fails closed for every session the
    // console did not author, and the case above must be reading a real record rather
    // than a port that answers `pinned` to anything it is asked.
    creatingBridge();
    const context = contextWith({ bridgeSource: "live" });

    await startASession(context);

    expect(settleFirstSendAutoPin(context.bridge, "a-session-nobody-started")).toStrictEqual({
      pinned: false,
      because: "origin-unreported",
    });
  });

  it("does not open a store through a registry this window has already left", async () => {
    // `open` is the one registry call that raises rather than returning a refusal, so
    // a settlement landing after a bridge replacement would otherwise take the whole
    // act — the stamp and the navigation included — with it.
    creatingBridge();
    const navigations: unknown[] = [];

    await startASession(
      contextWith({ bridgeSource: "live", navigations, isRegistryDisposed: true }),
    );

    expect(navigations).toStrictEqual([{ kind: "workspace", sessionId: CREATED_SESSION_ID }]);
  });
});
