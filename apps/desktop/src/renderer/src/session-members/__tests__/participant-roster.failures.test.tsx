// Plan-002 Phase 6 T6.3 — how ParticipantRoster surfaces a refused presence read.
//
// The failure half of the suite next door, and its own program because it is its own
// claim — the seam, not a line count. Four cases and one claim between them: a read or
// a subscribe that
// refuses reaches the participant as the `role="alert"` envelope and never as a view
// stranded in `loading` — including the case where the refusal arrives FIRST and the
// read it raced resolves afterwards, which is the one a per-branch reading misses.
//
// The fixtures, the mock bridge, and its teardown belong to
// `participant-roster.test-support.ts`, and the lifecycle cases to
// `participant-roster.test.tsx`.
//
// Vitest 4 `globals: true` (renderer project) supplies `describe`/`it`/`expect`/`vi`/
// `afterEach`; the renderer test tsconfig adds `vitest/globals` to `types`.

import { act, render, screen } from "@testing-library/react";

import { NotImplementedAtTier1Error } from "@ai-sidekicks/contracts";
import type { PresenceReadResponse } from "@ai-sidekicks/contracts";

import { ParticipantRoster } from "../participant-roster.js";
import {
  KNOWN_SESSION_ID,
  PARTICIPANT_ONLINE,
  SNAPSHOT_ONE,
  createDeferred,
  installMockBridge,
  noopUnsubscribe,
  removeMockBridge,
} from "./participant-roster.test-support.js";

describe("ParticipantRoster — a refused presence read", () => {
  afterEach(() => {
    removeMockBridge();
    vi.clearAllMocks();
  });

  it("renders the error envelope when presence.read rejects asynchronously", async () => {
    // Async-rejection branch on the initial read — the Tier-1 production path
    // rejects with `NotImplementedAtTier1Error`. The view surfaces the
    // `role="alert"` envelope and is not stranded in loading.
    const tier1Error = new NotImplementedAtTier1Error("presence.read");
    const daemonCall = vi.fn().mockRejectedValue(tier1Error);
    const daemonSubscribe = vi.fn(() => noopUnsubscribe);
    installMockBridge(daemonCall, daemonSubscribe);

    render(<ParticipantRoster sessionId={KNOWN_SESSION_ID} />);

    const errorSection = await screen.findByLabelText("participant-roster-error");
    expect(errorSection).toBeDefined();
    expect(errorSection.getAttribute("role")).toBe("alert");
    expect(errorSection.textContent).toContain("NotImplementedAtTier1Error");
    expect(errorSection.textContent).toContain("presence.read");
    expect(screen.queryByLabelText("participant-roster-loading")).toBeNull();
  });

  it("renders the error envelope when presence.read throws synchronously", async () => {
    // LOAD-BEARING sync-throw case on the read path. At Tier 1, `daemon.call`
    // throws SYNCHRONOUSLY (`() => tier1Throw("daemon.call")`). The view's
    // `refreshSnapshot` wraps the call in a void async IIFE so `await` funnels the
    // sync throw into the same `catch` as an async rejection — a regression that
    // bypassed that would let the throw escape and strand the view in loading.
    const tier1Error = new NotImplementedAtTier1Error("presence.read");
    const daemonCall = vi.fn(() => {
      throw tier1Error;
    });
    const daemonSubscribe = vi.fn(() => noopUnsubscribe);
    installMockBridge(daemonCall, daemonSubscribe);

    render(<ParticipantRoster sessionId={KNOWN_SESSION_ID} />);

    const errorSection = await screen.findByLabelText("participant-roster-error");
    expect(errorSection).toBeDefined();
    expect(errorSection.getAttribute("role")).toBe("alert");
    expect(errorSection.textContent).toContain("NotImplementedAtTier1Error");
    expect(screen.queryByLabelText("participant-roster-loading")).toBeNull();
  });

  it("renders the error envelope when presence.subscribe throws synchronously", async () => {
    // LOAD-BEARING sync-throw case on the SUBSCRIBE path. The synchronous
    // `subscribePresence(...)` call has its OWN `try/catch` in the effect because
    // at Tier 1 it throws synchronously (`() => tier1Throw("daemon.subscribe")`);
    // an uncaught throw there would crash the effect callback (React does not
    // catch effect-callback throws) and strand the view. This case proves that
    // catch drives the error state.
    //
    // The initial `refreshSnapshot()` lives INSIDE the subscribe `try`, AFTER the
    // subscribe assignment — so a synchronous subscribe-throw jumps straight to
    // the catch and the read is NEVER reached. We assert exactly that: the read
    // mock is arranged to fail the test if it is ever invoked, and we verify it
    // was not called. (No never-settling-read contortion is needed: the read does
    // not run at all on a subscribe-throw, so there is no late `loaded` setState
    // that could clobber the error — see the no-clobber test below.)
    const subscribeError = new NotImplementedAtTier1Error("presence.subscribe");
    const daemonCall = vi.fn(() => {
      throw new Error("presence.read must not be called when subscribe throws");
    });
    const daemonSubscribe = vi.fn(() => {
      throw subscribeError;
    });
    installMockBridge(daemonCall, daemonSubscribe);

    render(<ParticipantRoster sessionId={KNOWN_SESSION_ID} />);

    const errorSection = await screen.findByLabelText("participant-roster-error");
    expect(errorSection).toBeDefined();
    expect(errorSection.getAttribute("role")).toBe("alert");
    expect(errorSection.textContent).toContain("NotImplementedAtTier1Error");
    expect(errorSection.textContent).toContain("presence.subscribe");
    // The subscribe was attempted, the read was gated out by the subscribe-throw,
    // and the view is not stranded in loading.
    expect(daemonSubscribe).toHaveBeenCalledTimes(1);
    expect(daemonCall).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("participant-roster-loading")).toBeNull();
  });

  it("holds the subscribe-throw error and never flips to loaded when the read later resolves", async () => {
    // No-clobber outcome: distinct failure mode from the test above. That test
    // pins that the read is never INVOKED on a subscribe-throw (`daemonCall` not
    // called); this one pins the user-visible CONSEQUENCE of the gate — that the
    // error envelope HOLDS and the view never flips to `loaded`. We arrange a read
    // that resolves a VALID snapshot, resolve it AFTER the subscribe-throw error
    // is on screen, and assert the error still holds.
    //
    // The resolve is wrapped in `act` so that IF a read were in flight (the bug),
    // its `await`-resumed `setRosterState({ loaded })` would commit before we
    // assert — making this a genuine discriminator. Verified empirically: with the
    // read gated out (the fix) the error holds; with the initial read ungated (the
    // bug), the resolved snapshot drives a `loaded` commit and this fails — which
    // is the exact mislead being prevented: a static snapshot with no live channel.
    const subscribeError = new NotImplementedAtTier1Error("presence.subscribe");
    const heldRead = createDeferred<PresenceReadResponse>();
    const daemonCall = vi.fn(() => heldRead.promise);
    const daemonSubscribe = vi.fn(() => {
      throw subscribeError;
    });
    installMockBridge(daemonCall, daemonSubscribe);

    render(<ParticipantRoster sessionId={KNOWN_SESSION_ID} />);

    const errorSection = await screen.findByLabelText("participant-roster-error");
    expect(errorSection.textContent).toContain("presence.subscribe");

    await act(async () => {
      heldRead.resolve(SNAPSHOT_ONE);
    });

    expect(screen.getByLabelText("participant-roster-error")).toBeDefined();
    expect(screen.queryByLabelText("participant-roster-loaded")).toBeNull();
    expect(screen.queryByText(`participant id: ${PARTICIPANT_ONLINE}`)).toBeNull();
  });
});
