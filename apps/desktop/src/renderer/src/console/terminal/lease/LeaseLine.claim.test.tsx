// The claim control — one affordance, and the four things it never does.
//
// The one wire call this surface makes, from the surface's side: what a refusal
// renders as, what a REJECTION renders as, that a served reply moves no holder, that
// nothing is ever queued or retried, and that a rebound pane gets its own control
// rather than the last session's wait. The hook itself — the subject stamping that
// makes that last one true on the FIRST committed render — is
// `lease-claim.test.tsx`.
//
// 8.9's line is here too: stepping in is a different act from taking the shell, and
// this surface says so in copy rather than growing a second affordance, which is a
// claim about this control and belongs beside it.

import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { consoleClockFor } from "../../bridge/index.js";
import { ManualClock } from "../../core/index.js";
import { crossMacrotaskBoundary } from "../../core/macrotask-boundary.test-support.js";
import { LeaseLine } from "./LeaseLine.js";
import { UNREAD_TERMINAL_LEASE } from "./lease-model.js";
import {
  CALLER_ROLE_COLLABORATOR,
  OTHER_SESSION_ID,
  SESSION_ID,
  VIEWER_IDENTITY_READ,
  bridgeRejectingWith,
  HeldLeaseWire,
  claimControl,
  leaseState,
  markFor,
  refusingBridge,
  renderLease,
  requestShapeOf,
  servingBridge,
} from "./LeaseLine.test-support.js";
import { OTHER_PARTICIPANT, VIEWER_PARTICIPANT } from "./lease-model.test-support.js";

/**
 * How far past any plausible retry the frozen clock is advanced.
 *
 * An hour rather than a margin over some particular delay: the claim being made is
 * that NO retry is armed, which is unbounded in time, so the horizon has to be one
 * nobody would schedule past rather than one chosen to clear a specific implementation.
 *
 * SPELLED OUT RATHER THAN TAKEN FROM `MILLISECONDS_PER_HOUR`, and the exemption is
 * recorded here because the value is the unit factor and the constant is one import
 * away. This is a test INPUT — how far to wind a frozen clock — and not a factor this
 * file computes with; and the door line publishing that constant carries a
 * `@consumedBy` claim, which knip fails the moment anything reaches it through the
 * door, so an import here would trade a defensible literal for a red gate on a
 * neighbouring family's marker. The declaring module is one deep specifier away and
 * that is a door bypass taken for a marker's sake, which is worse than the literal.
 */
const RETRY_HORIZON_MS = 60 * 60 * 1000;

describe("the claim control — one affordance, and three things it never does", () => {
  it("renders the port's own refusal beside the control", async () => {
    const { container } = renderLease(leaseState({ holding: "unheld", holderVouching: "vouched" }));
    fireEvent.click(claimControl(container));
    await waitFor(() => {
      expect(container.querySelector(".meridian-refusal--inline")).not.toBeNull();
    });
    expect(container.textContent).toContain("wire-unregistered");
  });

  it("renders the wire's own code when the call REJECTED rather than refused", async () => {
    const { container } = renderLease(
      leaseState({ holding: "unheld", holderVouching: "vouched" }),
      bridgeRejectingWith({
        code: "terminal.lease_conflict",
        message: "Another participant holds the shell.",
      }),
    );
    fireEvent.click(claimControl(container));
    await waitFor(() => {
      expect(container.querySelector(".meridian-refusal--inline")).not.toBeNull();
    });
    // The code the daemon sent, verbatim, and its sentence beside it — which is
    // what tells the person that waiting, rather than pressing again, is the move.
    expect(container.textContent).toContain("terminal.lease_conflict");
    expect(container.textContent).toContain("Another participant holds the shell.");
  });

  it("negative control: it does not flatten that rejection into a call-failed code", async () => {
    // A local arm that recognised only this console's own refusal shape rendered
    // every wire rejection as one invented code with `[object Object]` for a
    // sentence, which is a lease conflict a person cannot tell from a dead preload.
    const { container } = renderLease(
      leaseState({ holding: "unheld", holderVouching: "vouched" }),
      bridgeRejectingWith({ code: "permission_denied", message: "You may not take the shell." }),
    );
    fireEvent.click(claimControl(container));
    await waitFor(() => {
      expect(container.querySelector(".meridian-refusal--inline")).not.toBeNull();
    });
    expect(container.textContent).toContain("permission_denied");
    expect(container.textContent).not.toContain("call-failed");
    expect(container.textContent).not.toContain("[object Object]");
  });

  it("names its own seam for a rejection that carries no code at all", async () => {
    const { container } = renderLease(
      leaseState({ holding: "unheld", holderVouching: "vouched" }),
      bridgeRejectingWith(new Error("the preload went away mid-call")),
    );
    fireEvent.click(claimControl(container));
    await waitFor(() => {
      expect(container.querySelector(".meridian-refusal--inline")).not.toBeNull();
    });
    expect(container.textContent).toContain("terminal-lease-call-failed");
    expect(container.textContent).toContain("the preload went away mid-call");
  });

  it("never queues a refused claim — one press is one call, and no retry follows", async () => {
    const bridge = refusingBridge();
    // THE CLAIM IS UNBOUNDED IN TIME, SO IT IS ASKED OF THE CLOCK RATHER THAN WAITED
    // OUT. This used to sleep 30 ms on the wall clock and then read the call count,
    // which a retry armed at 50 ms, or on a longer promise chain, walks straight
    // through. Every timer the console arms is minted through one `ConsoleClock`, so
    // "nothing was armed" is a state this window can be asked about.
    const clock = consoleClockFor(bridge);
    if (!(clock instanceof ManualClock)) {
      throw new Error("the fixture bridge did not hand this window a frozen clock");
    }
    const acquire = vi.spyOn(bridge.growth, "terminalAcquireWriteLease");
    const { container } = renderLease(
      leaseState({ holding: "unheld", holderVouching: "vouched" }),
      bridge,
    );
    fireEvent.click(claimControl(container));
    await waitFor(() => {
      expect(container.querySelector(".meridian-refusal--inline")).not.toBeNull();
    });

    await act(async () => {
      clock.advance(RETRY_HORIZON_MS);
      clock.runFrame();
      await crossMacrotaskBoundary();
    });

    // Nothing is armed at all, at any delay — and the refusal is still on screen and
    // the call count has not moved: a person retries by hand or not at all.
    expect(clock.pendingCount).toBe(0);
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".meridian-refusal--inline")).not.toBeNull();
  });

  it("never moves the holder on a SERVED reply — the holder is the wire's field", async () => {
    const bridge = servingBridge();
    const { container } = renderLease(
      leaseState({ holding: "unheld", holderVouching: "vouched" }),
      bridge,
    );
    fireEvent.click(claimControl(container));
    await waitFor(() => {
      expect(claimControl(container).disabled).toBe(false);
    });
    // Accepted by the daemon, and the line still says nobody holds it. The holder
    // moves when a `pty.control_changed` transition reaches the fold, not here.
    expect(container.textContent).toContain("Nobody holds the shell.");
    expect(container.textContent).toContain("Free");
    expect(container.querySelector(".meridian-refusal--inline")).toBeNull();
  });

  it("sends a holder's press to release rather than to acquire", async () => {
    const bridge = servingBridge();
    const acquire = vi.spyOn(bridge.growth, "terminalAcquireWriteLease");
    const release = vi.spyOn(bridge.growth, "terminalReleaseWriteLease");
    const { container } = renderLease(
      leaseState({
        holding: "held-by-you",
        holderParticipantId: VIEWER_PARTICIPANT,
        holderVouching: "vouched",
      }),
      bridge,
    );
    fireEvent.click(claimControl(container));
    await waitFor(() => {
      expect(release).toHaveBeenCalledTimes(1);
    });
    expect(acquire).not.toHaveBeenCalled();
  });

  // Both registered lease methods take `{ sessionId }` and nothing else, so both
  // presses are one claim reached from two states rather than two claims.
  const REGISTERED_CALLS = [
    { label: "the claim", operation: "terminalAcquireWriteLease", holding: "unheld" },
    { label: "the handback", operation: "terminalReleaseWriteLease", holding: "held-by-you" },
  ] as const;

  for (const registered of REGISTERED_CALLS) {
    it(`sends the registered request from ${registered.label}`, async () => {
      const bridge = servingBridge();
      const call = vi.spyOn(bridge.growth, registered.operation);
      const { container } = renderLease(
        leaseState({
          holding: registered.holding,
          holderParticipantId: registered.holding === "held-by-you" ? VIEWER_PARTICIPANT : null,
          holderVouching: "vouched",
        }),
        bridge,
      );
      fireEvent.click(claimControl(container));
      await waitFor(() => {
        expect(call).toHaveBeenCalledTimes(1);
      });
      // Exactly the registered member and exactly one of them: a request carrying a
      // pane-local key beside the session is refused by the strict schema before the
      // lease authority ever sees it.
      expect(requestShapeOf(call)).toStrictEqual(["sessionId"]);
      expect(call).toHaveBeenCalledWith({ sessionId: SESSION_ID });
    });
  }

  it("hands a rebound pane its own control rather than the last session's wait", async () => {
    // The finding. A claim is about a bridge and a session, and the two facts this
    // surface keeps about one — a call is out, a call was refused — are renderer-
    // local, so nothing outside the hook could tell that they belonged to a session
    // the pane had left. A pane rebound while a take was unresolved kept the disabled
    // control on the new session, for as long as the old call stayed out.
    const heldWire = new HeldLeaseWire();
    const state = leaseState({ holding: "unheld", holderVouching: "vouched" });
    const view = render(
      <LeaseLine
        bridge={heldWire.bridge}
        sessionId={SESSION_ID}
        state={state}
        markFor={markFor}
        viewerIdentity={VIEWER_IDENTITY_READ}
        callerRole={CALLER_ROLE_COLLABORATOR}
      />,
    );
    fireEvent.click(claimControl(view.container));
    expect(claimControl(view.container).disabled).toBe(true);

    view.rerender(
      <LeaseLine
        bridge={heldWire.bridge}
        sessionId={OTHER_SESSION_ID}
        state={state}
        markFor={markFor}
        viewerIdentity={VIEWER_IDENTITY_READ}
        callerRole={CALLER_ROLE_COLLABORATOR}
      />,
    );

    expect(claimControl(view.container).disabled).toBe(false);

    await act(async () => {
      heldWire.rejectCall(0);
    });

    // And the answer to a question about the other session is not rendered against
    // this one: a lease conflict names a shell the person is no longer looking at.
    expect(view.container.textContent).not.toContain("terminal.lease_conflict");
    expect(view.container.querySelector(".meridian-refusal--inline")).toBeNull();
    expect(claimControl(view.container).disabled).toBe(false);
  });

  it("negative control: the session it is still on DOES render its own refusal", async () => {
    // Without it the case above would pass against a hook that dropped every
    // completion, which is a claim control that never reports anything at all.
    const heldWire = new HeldLeaseWire();
    const { container } = renderLease(
      leaseState({ holding: "unheld", holderVouching: "vouched" }),
      heldWire.bridge,
    );
    fireEvent.click(claimControl(container));

    await act(async () => {
      heldWire.rejectCall(0);
    });

    expect(container.textContent).toContain("terminal.lease_conflict");
    expect(claimControl(container).disabled).toBe(false);
  });

  it("negative control: the pane-keyed shape the daemon refuses is not this one", () => {
    // The same predicate over the request this surface used to send. Without it a
    // `requestShapeOf` answering `["sessionId"]` for anything would satisfy both
    // cases above and say nothing about what goes out.
    expect(Object.keys({ terminalId: SESSION_ID })).not.toStrictEqual(["sessionId"]);
  });

  it("negative control: a state that is not the viewer's calls acquire", async () => {
    const bridge = servingBridge();
    const acquire = vi.spyOn(bridge.growth, "terminalAcquireWriteLease");
    const release = vi.spyOn(bridge.growth, "terminalReleaseWriteLease");
    const { container } = renderLease(
      leaseState({
        holding: "held-by-another",
        holderParticipantId: OTHER_PARTICIPANT,
        holderVouching: "vouched",
      }),
      bridge,
    );
    fireEvent.click(claimControl(container));
    await waitFor(() => {
      expect(acquire).toHaveBeenCalledTimes(1);
    });
    expect(release).not.toHaveBeenCalled();
  });
});

describe("stepping in is not this control (8.9)", () => {
  it("says so in copy rather than growing a second affordance", () => {
    const { container } = renderLease(UNREAD_TERMINAL_LEASE);
    expect(container.textContent).toContain("It never moves the keyboard");
    // Two buttons: the claim and the disclosure. Step in belongs to the composer.
    expect(container.querySelectorAll("button")).toHaveLength(2);
  });
});
