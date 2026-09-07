// How many sessions a burst of Start presses may create, and when the control returns.
//
// THE DEFECT, AND WHY IT COST TWO SESSIONS AND GAVE ONE. The destination mounted the
// absorbed probe keyed on the press count, and the probe creates a session from its
// own mount effect. A second press while the first create was still in flight bumped
// that key: React unmounted the first probe, its cleanup set the flag that suppresses
// `onCreated`, and the session that create went on to produce was named to nobody —
// not opened, not recorded, not navigated to — while a SECOND durable session was
// created beside it.
//
// DRIVEN THROUGH THE WHOLE DESTINATION rather than against the flight hook, because
// what is being asserted is how many calls reach the wire. A case that drove the hook
// would pass against a surface that took the slot and mounted the probe anyway.
//
// The bridge source is `live` in every case, because the absorbed probe carries the
// fixture guard: on any other source it renders "the question was not put" and no
// call is made at all — which is also why the flight holds nothing there, and why the
// last case below asserts exactly that.

import { act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { contextWith, renderSurface, settle } from "../session-surface.test-support.js";
import {
  CREATED_SESSION_ID,
  installProbeBridge,
  pressStart,
  startIsOffered,
  uninstallProbeBridge,
} from "./probe-bridge.test-support.js";

/** One `session.create` that never answers, and the calls it recorded. */
function heldCreateBridge(): ReturnType<typeof vi.fn> {
  const call = vi.fn().mockReturnValue(new Promise<never>(() => undefined));
  installProbeBridge(call);
  return call;
}

/** How many `session.create` calls a recorded bridge was asked to put. */
function createCallCount(call: ReturnType<typeof vi.fn>): number {
  return call.mock.calls.filter(([method]) => method === "session.create").length;
}

describe("starting a session — one create at a time", () => {
  afterEach(() => {
    uninstallProbeBridge();
    vi.clearAllMocks();
  });

  it("puts one create for two presses while the first is still running", async () => {
    // The defect, stated as the wire sees it. Two presses in a row against a create
    // that has not answered used to remount the probe and put a second
    // `session.create` — two durable sessions for one intended act.
    const call = heldCreateBridge();
    const { container } = renderSurface(contextWith({ bridgeSource: "live" }));
    await settle();

    pressStart(container);
    pressStart(container);
    await settle();

    expect(createCallCount(call)).toBe(1);
  });

  it("puts one create for a burst inside a single frame", async () => {
    // Every click here is dispatched before React re-renders, so each handler reads
    // the disabled state from the render that produced it and finds the control idle
    // — the key taken inside the tick is what refuses the second and third. Stated as
    // a wire count rather than as a claim about the key, because what must not happen
    // is a second `session.create`, however the surface comes to avoid it.
    const call = heldCreateBridge();
    const { container } = renderSurface(contextWith({ bridgeSource: "live" }));
    await settle();

    const start = container.querySelector<HTMLButtonElement>(".meridian-sessions__start");
    act(() => {
      start?.click();
      start?.click();
      start?.click();
    });
    await settle();

    expect(createCallCount(call)).toBe(1);
  });

  it("names the outstanding create on the control rather than going quiet", async () => {
    // A control that is disabled with its reason off screen is indistinguishable from
    // one that is broken.
    heldCreateBridge();
    const { container } = renderSurface(contextWith({ bridgeSource: "live" }));
    await settle();

    pressStart(container);
    await settle();

    expect(startIsOffered(container)).toBe(false);
    expect(container.textContent ?? "").toContain("A session is being created");
  });

  it("gives the slot back when the create settles with a session", async () => {
    // The positive control for the release: without it the three cases above are
    // satisfied by a surface that takes the slot once and never returns it.
    const call = vi.fn().mockResolvedValue({
      sessionId: CREATED_SESSION_ID,
      state: "active",
      memberships: [],
      channels: [],
    });
    installProbeBridge(call);
    const { container } = renderSurface(contextWith({ bridgeSource: "live" }));
    await settle();

    pressStart(container);
    await settle();
    pressStart(container);
    await settle();

    expect(createCallCount(call)).toBe(2);
  });

  it("gives the slot back when the create is REFUSED", async () => {
    // The arm a settlement reported only on success would miss. A refused create
    // produced no session and still ended the act, so a slot released on the created
    // arm alone would leave Start dead for the life of the destination — with the
    // reason nowhere on screen, which is the shape the local-runtime page's own
    // dispatch latch shipped once already.
    const call = vi.fn().mockRejectedValue(new Error("the daemon refused the create"));
    installProbeBridge(call);
    const { container } = renderSurface(contextWith({ bridgeSource: "live" }));
    await settle();

    pressStart(container);
    await settle();

    expect(startIsOffered(container)).toBe(true);
    pressStart(container);
    await settle();
    expect(createCallCount(call)).toBe(2);
  });

  it("holds nothing where the probe puts no call at all", async () => {
    // Under the fixture the guarded mount renders an absence and dispatches nothing,
    // so no settlement will ever arrive to give a slot back. A flight that took one
    // anyway would kill the control on its first press for a call never made.
    const { container } = renderSurface(contextWith({}));
    await settle();

    pressStart(container);
    await settle();

    expect(startIsOffered(container)).toBe(true);
    expect(container.textContent ?? "").toContain("running on the fixture");
  });
});
