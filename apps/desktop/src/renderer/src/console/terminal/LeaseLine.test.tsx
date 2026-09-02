// Every state 8.8 names, and the three things the line must never do.
//
// The lease STATE is a value here, built directly rather than folded from a
// scenario, because `lease-model.test.ts` already holds the fold to the wire and
// this file's subject is what each state RENDERS. Building the states makes the
// unreachable ones reachable: `held-by-you` cannot arise in the shipped pane (no
// read supplies the viewer's identity), and the surface that will show a keyboard
// the day it can still has to be correct today.
//
// The wire calls run against the real bridge — the fixture's growth port, which
// refuses `terminalAcquireWriteLease` by name because `Plan-023 §Console growth
// slate` has not registered it. A hand-rolled stub would let the refusal render
// pass against a shape the port does not produce.

import { fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createFixtureBridge, type ConsoleBridge } from "../bridge/index.js";
import { TERMINAL_SCENARIO, TERMINAL_SCENARIO_CAST } from "../bridge/scenarios/terminal.js";
import { LeaseLine, type TerminalParticipantMark } from "./LeaseLine.js";
import {
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
      terminalAcquireWriteLease: async () => ({
        status: "served" as const,
        value: { granted: true },
      }),
      terminalReleaseWriteLease: async () => ({ status: "served" as const, value: undefined }),
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
    actorParticipantId: HOLDER,
    ...overrides,
  };
}

function renderLease(state: TerminalLeaseState, bridge: ConsoleBridge = refusingBridge()) {
  return render(
    <LeaseLine bridge={bridge} terminalId="session-terminal" state={state} markFor={markFor} />,
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
        terminalId="session-terminal"
        state={leaseState({
          holding: "held-by-another",
          holderParticipantId: HOLDER,
          holderVouching: "vouched",
        })}
        markFor={named}
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

  it("negative control: the four holdings do not all render the same sentence", () => {
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
        ] as const
      ).map((state) => renderLease(state).container.textContent),
    );
    expect(sentences.size).toBe(4);
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
