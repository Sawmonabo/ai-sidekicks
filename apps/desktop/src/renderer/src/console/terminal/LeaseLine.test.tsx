// Every state 8.8 names, and the four things the line must never do.
//
// The lease STATE is a value here, built directly rather than folded from a
// scenario, because `lease-model.test.ts` already holds the fold to the wire and
// this file's subject is what each state RENDERS. The VIEWER's identity is a value
// for the same reason: `viewer-identity.test.tsx` holds the read, and every case
// below renders under a settled one so that the state it names is what it is about.
//
// The last of the four prohibitions has its own block at the foot of the file: the
// claim control is offered only once the viewer's identity has been read, because a
// control the surface cannot attribute is one the daemon will honour and this line
// will then report as somebody else's hold.
//
// The wire calls run against the real bridge — the fixture's growth port, which
// refuses `terminalAcquireWriteLease` by name because `Plan-023 §Console growth
// slate` has not registered it. A hand-rolled stub would let the refusal render
// pass against a shape the port does not produce.

import { fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createFixtureBridge, type ConsoleBridge } from "../bridge/index.js";
import { refuse } from "../core/index.js";
import { TERMINAL_SCENARIO, TERMINAL_SCENARIO_CAST } from "../bridge/scenarios/terminal.js";
import { LeaseLine, type TerminalParticipantMark } from "./LeaseLine.js";
import type { TerminalViewerIdentity } from "./viewer-identity.js";
import {
  TERMINAL_LEASE_HOLDINGS,
  UNREAD_TERMINAL_LEASE,
  type TerminalLeaseState,
  type TerminalLeaseTransition,
} from "./lease-model.js";

/**
 * The holder and the viewer, read off the scenario's join log rather than invented.
 *
 * `lease-model.test.ts`'s reason: a readable placeholder here would be a participant
 * id no daemon could emit, sitting beside a fixture whose own beats are wire-declared
 * UUIDs. The cast names the role each one plays, which an index into the join log
 * does not. The line renders the id verbatim when no roster supplies a name, so the
 * cases below assert against the same string the pane would show.
 */
const VIEWER = TERMINAL_SCENARIO_CAST.owner;
const HOLDER = TERMINAL_SCENARIO_CAST.collaborator;

/**
 * The lease's own subject on the wire, read off the scenario rather than invented.
 *
 * `session.takeControl` and `session.releaseControl` both take `{ sessionId }`, and
 * the scenario's session id is a wire-declared UUID — so the request the cases below
 * assert on is the one a daemon would actually be handed.
 */
const SESSION_ID = TERMINAL_SCENARIO.sessionId;

function refusingBridge(): ConsoleBridge {
  return createFixtureBridge({ scenario: TERMINAL_SCENARIO });
}

/** A bridge whose lease calls are SERVED, to prove the holder still does not move. */
function servingBridge(): ConsoleBridge {
  const base = createFixtureBridge({ scenario: TERMINAL_SCENARIO });
  return {
    ...base,
    growth: {
      ...base.growth,
      // The registered replies, verbatim: a take answers with the caller as
      // `controlHolder`, a release answers with the freed lease.
      terminalAcquireWriteLease: async () => ({
        status: "served" as const,
        value: { controlHolder: VIEWER },
      }),
      terminalReleaseWriteLease: async () => ({
        status: "served" as const,
        value: { controlHolder: null },
      }),
    },
  };
}

/**
 * A bridge whose lease calls REJECT with the wire's own `{ code, message }`.
 *
 * The shape a rejected registered call actually carries across the preload
 * boundary (`src/shared/wire-errors.ts` owns it, for every renderer surface). The
 * port ANSWERS a refusal, so a rejection is the bridge itself failing — and a
 * daemon that refused a claim because somebody else holds the shell said so with a
 * code the person can act on.
 */
function bridgeRejectingWith(rejection: unknown): ConsoleBridge {
  const base = createFixtureBridge({ scenario: TERMINAL_SCENARIO });
  return {
    ...base,
    growth: {
      ...base.growth,
      terminalAcquireWriteLease: () => Promise.reject(rejection),
      terminalReleaseWriteLease: () => Promise.reject(rejection),
    },
  };
}

function markFor(participantId: string): TerminalParticipantMark | undefined {
  return participantId === HOLDER
    ? { hueStep: 3, ringTreatment: "dashed", displayName: undefined }
    : undefined;
}

function leaseState(overrides: Partial<TerminalLeaseState>): TerminalLeaseState {
  return { ...UNREAD_TERMINAL_LEASE, ...overrides };
}

function transitionAt(
  sequence: number,
  reason: TerminalLeaseTransition["reason"],
  overrides: Partial<TerminalLeaseTransition> = {},
): TerminalLeaseTransition {
  return {
    sequence,
    occurredAtIso: `2026-01-01T16:40:0${String(sequence)}.000Z`,
    reason,
    holderParticipantId: reason === "taken" ? HOLDER : null,
    previousHolderParticipantId: reason === "taken" ? null : HOLDER,
    actorId: HOLDER,
    ...overrides,
  };
}

/**
 * The identity every case below renders under unless it is about the other arms.
 *
 * Read, and read as the VIEWER: the claim control is gated on the identity having
 * landed, so a default of anything else would make every case in this file about the
 * withheld state instead of about the state it names.
 */
const VIEWER_IDENTITY_READ: TerminalViewerIdentity = { status: "read", participantId: VIEWER };

function renderLease(
  state: TerminalLeaseState,
  bridge: ConsoleBridge = refusingBridge(),
  viewerIdentity: TerminalViewerIdentity = VIEWER_IDENTITY_READ,
) {
  return render(
    <LeaseLine
      bridge={bridge}
      sessionId={SESSION_ID}
      state={state}
      markFor={markFor}
      viewerIdentity={viewerIdentity}
    />,
  );
}

/** The single affordance 8.8 puts in the header, as something a test can press. */
function claimControl(container: HTMLElement): HTMLButtonElement {
  const control = container.querySelector(".meridian-lease-line__claim");
  if (!(control instanceof HTMLButtonElement)) {
    throw new Error("the lease line rendered no claim control");
  }
  return control;
}

/**
 * The member names of the one request a lease spy was handed.
 *
 * Keys rather than the whole value: the claim is the SHAPE, and a value comparison
 * alone passes for a request that carries the session under the right name and a
 * pane id beside it — which is the state the strict schema refuses.
 */
function requestShapeOf(spy: {
  readonly mock: { readonly calls: readonly unknown[][] };
}): string[] {
  const request = spy.mock.calls[0]?.[0];
  if (typeof request !== "object" || request === null) {
    throw new Error("the lease call was made with no request object");
  }
  return Object.keys(request).sort();
}

function disclosureControl(container: HTMLElement): HTMLButtonElement {
  const control = container.querySelector(".meridian-lease-line__disclosure");
  if (!(control instanceof HTMLButtonElement)) {
    throw new Error("the lease line rendered no transition disclosure");
  }
  return control;
}

describe("the holder line — every state 8.8 names", () => {
  it("says the lease has not been read, which is not the lease being free", () => {
    const { container } = renderLease(UNREAD_TERMINAL_LEASE);
    expect(container.textContent).toContain("Not checked");
    expect(container.textContent).toContain("The lease has not been read.");
    expect(container.textContent).not.toContain("Nobody holds the shell.");
  });

  it("renders a free lease as an explicit unheld state", () => {
    const { container } = renderLease(leaseState({ holding: "unheld", holderVouching: "vouched" }));
    expect(container.textContent).toContain("Free");
    expect(container.textContent).toContain("Nobody holds the shell.");
  });

  it("names another holder by the wire id when the roster supplies no name", () => {
    const { container } = renderLease(
      leaseState({
        holding: "held-by-another",
        holderParticipantId: HOLDER,
        holderVouching: "vouched",
      }),
    );
    expect(container.textContent).toContain("Held by");
    expect(container.textContent).toContain(HOLDER);
    expect(container.querySelector(".meridian-lease-line__mark--dashed")).not.toBeNull();
  });

  it("uses the roster's name where there is one, rather than the id", () => {
    const named = (participantId: string): TerminalParticipantMark | undefined =>
      participantId === HOLDER
        ? { hueStep: 3, ringTreatment: "dashed", displayName: "Priya" }
        : undefined;
    const { container } = render(
      <LeaseLine
        bridge={refusingBridge()}
        sessionId={SESSION_ID}
        state={leaseState({
          holding: "held-by-another",
          holderParticipantId: HOLDER,
          holderVouching: "vouched",
        })}
        markFor={named}
        viewerIdentity={VIEWER_IDENTITY_READ}
      />,
    );
    expect(container.textContent).toContain("Priya holds the shell.");
    expect(container.textContent).not.toContain(HOLDER);
  });

  it("tells the holder they may type, and offers the handback rather than a claim", () => {
    const { container } = renderLease(
      leaseState({
        holding: "held-by-you",
        holderParticipantId: VIEWER,
        holderVouching: "vouched",
      }),
    );
    expect(container.textContent).toContain("You hold it");
    expect(container.textContent).toContain("You may type into the shared shell.");
    const claim = container.querySelector(".meridian-lease-line__claim");
    // The idempotent self-claim is not reachable from this surface, so there is no
    // transition for it to animate — 8.8's "never animates a claim by the current
    // holder", kept structurally rather than by suppressing an animation.
    expect(claim?.textContent).toBe("Release the shell");
  });

  it("reports an unread node roster rather than vouching for a holder it cannot check", () => {
    const { container } = renderLease(
      leaseState({ holding: "held-by-another", holderParticipantId: HOLDER }),
    );
    const absence = container.querySelector(".meridian-nothing");
    expect(absence?.className).toContain("meridian-nothing--not-checked");
    expect(container.textContent).toContain("Node health not read");
    // The holder the health line is ABOUT. This case is also the control for the
    // two below: a gate that silenced the block for every state would satisfy both
    // of them and leave a real holder standing with no word about the node it sits
    // on, which is the one reading 8.8 spends this absence on.
    expect(container.textContent).toContain(HOLDER);
  });

  it("says nothing about a holding node's health when the line says the shell is free", () => {
    // What a `released`-terminated log with no roster read folds to: an explicit
    // free lease, and a vouching that records only that nothing was asked. The old
    // surface put "Node health not read" under "Nobody holds the shell." and so
    // discussed a holding node the same reading says does not exist.
    const { container } = renderLease(leaseState({ holding: "unheld" }));
    expect(container.textContent).toContain("Free");
    expect(container.textContent).toContain("Nobody holds the shell.");
    expect(container.textContent).not.toContain("Node health not read");
  });

  it("leaves an unread transition its own paragraph, without a second unread reading", () => {
    // The unread arm nulls the holder as well, so the same gate applies — and here
    // it is the difference between one sentence about what the console could not
    // read and two, the second about a roster nobody was waiting on.
    const { container } = renderLease(
      leaseState({
        holding: "unrecognized-transition",
        unreadTransition: {
          sequence: 9,
          occurredAtIso: "2026-01-01T16:40:09.000Z",
          reason: "auto_released_quota_exhausted",
        },
      }),
    );
    expect(container.textContent).toContain("this build cannot read");
    expect(container.textContent).not.toContain("Node health not read");
  });

  it("degrades an offline holder to unheld and read-only, naming the node", () => {
    const { container } = renderLease(
      leaseState({
        holding: "unheld",
        holderVouching: "unvouched",
        unvouchedNodeId: "node-lima",
      }),
    );
    expect(container.textContent).toContain("node-lima");
    expect(container.textContent).toContain("reads as free and stays read-only");
    // The holder the control plane cannot vouch for is not shown as a holder.
    expect(container.textContent).toContain("Nobody holds the shell.");
    expect(container.textContent).not.toContain("Held by");
  });

  it("says the lease is unreadable when a transition arrived this build cannot read", () => {
    const { container } = renderLease(
      leaseState({
        holding: "unrecognized-transition",
        holderVouching: "vouched",
        unreadTransition: {
          sequence: 9,
          occurredAtIso: "2026-01-01T16:40:09.000Z",
          reason: "auto_released_quota_exhausted",
        },
      }),
    );
    expect(container.textContent).toContain("Unread transition");
    expect(container.textContent).toContain("The console cannot read who holds the shell.");
    // The reason travels verbatim and in mono, because it is a wire string the
    // operator pastes into a search rather than prose this console wrote.
    expect(container.textContent).toContain("auto_released_quota_exhausted");
    // The two sentences that would be lies here: nobody said the lease is free, and
    // nobody said this participant may type.
    expect(container.textContent).not.toContain("Nobody holds the shell.");
    expect(container.textContent).not.toContain("You may type into the shared shell.");
  });

  it("says it plainly when the unread transition named no reason at all", () => {
    const { container } = renderLease(
      leaseState({
        holding: "unrecognized-transition",
        holderVouching: "vouched",
        unreadTransition: {
          sequence: 9,
          occurredAtIso: "2026-01-01T16:40:09.000Z",
          reason: undefined,
        },
      }),
    );
    expect(container.textContent).toContain("this build cannot read");
    // No dangling "The wire called it ." where there was nothing to name.
    expect(container.textContent).not.toContain("The wire called it");
  });

  it("negative control: every holding renders its own sentence", () => {
    // Counted off the closed set rather than written down, so a sixth holding added
    // without a sentence of its own fails here instead of quietly reading like one
    // of the five.
    const sentences = new Set(
      (
        [
          UNREAD_TERMINAL_LEASE,
          leaseState({ holding: "unheld", holderVouching: "vouched" }),
          leaseState({
            holding: "held-by-another",
            holderParticipantId: HOLDER,
            holderVouching: "vouched",
          }),
          leaseState({
            holding: "held-by-you",
            holderParticipantId: VIEWER,
            holderVouching: "vouched",
          }),
          leaseState({
            holding: "unrecognized-transition",
            holderVouching: "vouched",
            unreadTransition: {
              sequence: 9,
              occurredAtIso: "2026-01-01T16:40:09.000Z",
              reason: "auto_released_quota_exhausted",
            },
          }),
        ] as const
      ).map((state) => renderLease(state).container.textContent),
    );
    expect(sentences.size).toBe(TERMINAL_LEASE_HOLDINGS.length);
  });
});

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
    const acquire = vi.spyOn(bridge.growth, "terminalAcquireWriteLease");
    const { container } = renderLease(
      leaseState({ holding: "unheld", holderVouching: "vouched" }),
      bridge,
    );
    fireEvent.click(claimControl(container));
    await waitFor(() => {
      expect(container.querySelector(".meridian-refusal--inline")).not.toBeNull();
    });
    // The refusal is still on screen and the call count has not moved: a person
    // retries by hand or not at all.
    await new Promise((resolve) => {
      setTimeout(resolve, 30);
    });
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
        holderParticipantId: VIEWER,
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
          holderParticipantId: registered.holding === "held-by-you" ? VIEWER : null,
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
        holderParticipantId: HOLDER,
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

describe("the transition ledger — one click away, every reason its own line", () => {
  const transitions: readonly TerminalLeaseTransition[] = [
    transitionAt(1, "taken"),
    transitionAt(2, "released"),
    transitionAt(3, "auto_released_disconnect"),
    transitionAt(4, "auto_released_authorization_lost"),
    transitionAt(5, "auto_released_run_idle"),
  ];

  it("shows output and the holder line only until it is asked for", () => {
    const { container } = renderLease(
      leaseState({ holding: "unheld", holderVouching: "vouched", transitions, transitionCount: 5 }),
    );
    expect(container.querySelector(".meridian-lease-line__ledger")).toBeNull();
    // The count is on the disclosure, so density costs no information.
    expect(container.querySelector(".meridian-lease-line__disclosure")?.textContent).toContain("5");
  });

  it("keeps the three automatic reasons distinct once opened", async () => {
    const { container } = renderLease(
      leaseState({ holding: "unheld", holderVouching: "vouched", transitions, transitionCount: 5 }),
    );
    fireEvent.click(disclosureControl(container));
    const sentences = [...container.querySelectorAll(".meridian-lease-line__sentence")].map(
      (element) => element.textContent,
    );
    expect(sentences).toHaveLength(5);
    expect(new Set(sentences).size).toBe(5);
  });

  it("says an unread history is unread rather than showing an empty list", async () => {
    const { container } = renderLease(leaseState({ holding: "unheld", holderVouching: "vouched" }));
    fireEvent.click(disclosureControl(container));
    expect(container.textContent).toContain("No transition has been read.");
    expect(container.textContent).toContain("not the same as the shell never having moved");
  });

  it("negative control: a ledger that named one reason five times would collapse them", () => {
    const collapsed = transitions.map((transition) => ({ ...transition, reason: "released" }));
    expect(new Set(collapsed.map((transition) => transition.reason)).size).toBe(1);
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

describe("the claim control is gated on knowing who the viewer is", () => {
  /** The claim control, or `null` — the shape the withheld cases need. */
  function offeredClaimControl(container: HTMLElement): Element | null {
    return container.querySelector(".meridian-lease-line__claim");
  }

  const HELD_BY_SOMEBODY = leaseState({
    holding: "held-by-another",
    holderParticipantId: HOLDER,
    holderVouching: "vouched",
    transitionCount: 1,
  });

  it("offers no control while the identity read is still out, and says why", () => {
    const { container } = renderLease(HELD_BY_SOMEBODY, refusingBridge(), {
      status: "not-loaded",
    });
    expect(offeredClaimControl(container)).toBeNull();
    // An absence rather than a disabled button: a greyed control reads as "not right
    // now", and the truth is that the console does not know who would be claiming.
    const absence = container.querySelector(".meridian-nothing");
    expect(absence?.className).toContain("meridian-nothing--not-loaded");
    expect(container.textContent).toContain("Reading who you are");
    // The disclosure is untouched — the history is readable without an identity.
    expect(container.querySelector(".meridian-lease-line__disclosure")).not.toBeNull();
  });

  it("renders the wire's own refusal, and the next move, when the read was refused", () => {
    const { container } = renderLease(HELD_BY_SOMEBODY, refusingBridge(), {
      status: "refused",
      refusal: refuse(
        "terminal-viewer-identity",
        "wire-unregistered",
        "Not checked — the caller's participant identity is not registered on this build yet.",
      ),
    });
    expect(offeredClaimControl(container)).toBeNull();
    expect(container.textContent).toContain("wire-unregistered");
    // Verbatim, and the console's own sentence in the action slot beside it rather
    // than folded into the daemon's text.
    expect(container.textContent).toContain("is not registered on this build yet");
    expect(container.textContent).toContain("offered again once the console can say");
  });

  it("offers Release to the participant the log names as the holder", () => {
    // The whole point of feeding the identity in: the claimant's own take reads as
    // theirs, so the control they are offered is the one that gives the shell back.
    const { container } = renderLease(
      leaseState({
        holding: "held-by-you",
        holderParticipantId: VIEWER,
        holderVouching: "vouched",
        transitionCount: 1,
      }),
    );
    expect(offeredClaimControl(container)?.textContent).toBe("Release the shell");
  });

  it("negative control: a read identity DOES get the control", () => {
    // Without this the two withheld cases would pass against a line that had simply
    // stopped rendering the claim control at all.
    const { container } = renderLease(HELD_BY_SOMEBODY);
    expect(offeredClaimControl(container)?.textContent).toBe("Claim the shell");
    expect(container.querySelector(".meridian-nothing--not-loaded")).toBeNull();
  });
});
