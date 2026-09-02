// The lease fold, held to 8.8's prohibitions rather than to its own shape.
//
// Three of the design's "never" clauses are properties of THIS module and are
// asserted here as properties rather than as example outputs: the holder comes off
// the wire and nowhere else, an unvouchable holder collapses to the free lease
// before anyone is compared to it, and the five reasons render five distinct
// sentences. Each has a negative control, because every one of them would pass
// against a fold that simply returned the last payload it saw.

import { describe, expect, it } from "vitest";

import type { ConsoleSessionEvent } from "../store/index.js";
import { TERMINAL_LEASE_LEDGER_CAP } from "./constants.js";
import {
  TERMINAL_LEASE_EVENT_KIND,
  TERMINAL_LEASE_TRANSITION_REASONS,
  UNREAD_TERMINAL_LEASE,
  asTerminalLeaseTransitionReason,
  projectTerminalLease,
  terminalLeaseTransitionSentence,
  type TerminalLeaseTransition,
  type TerminalLeaseTransitionReason,
} from "./lease-model.js";

const VIEWER = "participant-you";
const OTHER = "participant-priya";

function transitionEvent(
  sequence: number,
  reason: string,
  holderParticipantId: string | null,
  previousHolderParticipantId: string | null = null,
  actorParticipantId: string | undefined = holderParticipantId ?? undefined,
): ConsoleSessionEvent {
  return {
    sessionId: "session-terminal",
    sequence,
    kind: TERMINAL_LEASE_EVENT_KIND,
    occurredAt: `2026-01-01T16:40:0${String(sequence % 10)}.000Z`,
    ...(actorParticipantId === undefined ? {} : { actorParticipantId }),
    payload: { holderParticipantId, previousHolderParticipantId, reason },
  };
}

function transitionOf(reason: TerminalLeaseTransitionReason): TerminalLeaseTransition {
  return {
    sequence: 1,
    occurredAtIso: "2026-01-01T16:40:00.000Z",
    reason,
    holderParticipantId: reason === "taken" ? OTHER : null,
    previousHolderParticipantId: reason === "taken" ? null : OTHER,
    actorParticipantId: OTHER,
  };
}

describe("the lease fold — what the wire said, and only that", () => {
  it("reads nothing as `not-checked`, which is not the free lease", () => {
    const state = projectTerminalLease([], { viewerParticipantId: VIEWER });
    expect(state).toStrictEqual(UNREAD_TERMINAL_LEASE);
    // The whole point of the fifth state: an unread lease and a free one are two
    // different facts, and a surface that collapsed them would offer a claim
    // against a shell it has never asked about as though it knew it was free.
    expect(state.holding).not.toBe("unheld");
  });

  it("takes the holder from the newest transition's own payload", () => {
    const state = projectTerminalLease(
      [
        transitionEvent(1, "taken", OTHER),
        transitionEvent(2, "released", null, OTHER),
        transitionEvent(3, "taken", VIEWER),
      ],
      { viewerParticipantId: VIEWER },
    );
    expect(state.holding).toBe("held-by-you");
    expect(state.holderParticipantId).toBe(VIEWER);
    expect(state.transitionCount).toBe(3);
  });

  it("renders a null holder as the free lease, explicitly", () => {
    const state = projectTerminalLease(
      [
        transitionEvent(1, "taken", OTHER),
        transitionEvent(2, "auto_released_disconnect", null, OTHER),
      ],
      { viewerParticipantId: VIEWER },
    );
    expect(state.holding).toBe("unheld");
    expect(state.holderParticipantId).toBeNull();
  });

  it("tells the viewer's hold apart from somebody else's", () => {
    const events = [transitionEvent(1, "taken", OTHER)];
    expect(projectTerminalLease(events, { viewerParticipantId: VIEWER }).holding).toBe(
      "held-by-another",
    );
    expect(projectTerminalLease(events, { viewerParticipantId: OTHER }).holding).toBe(
      "held-by-you",
    );
    // No viewer read at all is the console's state today, and it fails closed:
    // nobody is ever told they may type on the strength of an unknown identity.
    expect(projectTerminalLease(events, { viewerParticipantId: undefined }).holding).toBe(
      "held-by-another",
    );
  });

  it("skips a reason outside the closed set rather than rendering a nameless transition", () => {
    const state = projectTerminalLease(
      [
        transitionEvent(1, "taken", OTHER),
        transitionEvent(2, "auto_released_timeout", null, OTHER),
      ],
      { viewerParticipantId: VIEWER },
    );
    expect(state.transitionCount).toBe(1);
    expect(state.holderParticipantId).toBe(OTHER);
  });

  it("ignores every event that is not a lease transition", () => {
    const state = projectTerminalLease(
      [
        { sessionId: "session-terminal", sequence: 1, kind: "session.created", occurredAt: "x" },
        transitionEvent(2, "taken", OTHER),
      ],
      { viewerParticipantId: VIEWER },
    );
    expect(state.transitionCount).toBe(1);
  });

  it("caps the ledger while still counting every transition it saw", () => {
    const events = Array.from({ length: TERMINAL_LEASE_LEDGER_CAP + 5 }, (_unused, index) =>
      transitionEvent(
        index + 1,
        index % 2 === 0 ? "taken" : "released",
        index % 2 === 0 ? OTHER : null,
      ),
    );
    const state = projectTerminalLease(events, { viewerParticipantId: VIEWER });
    expect(state.transitions).toHaveLength(TERMINAL_LEASE_LEDGER_CAP);
    expect(state.transitionCount).toBe(TERMINAL_LEASE_LEDGER_CAP + 5);
    // The cap drops the OLDEST, so the newest transition — the one the holder is
    // read from — is always present.
    expect(state.transitions.at(-1)?.sequence).toBe(events.length);
  });

  it("negative control: a fold that echoed the payload would pass every case above", () => {
    // It would not pass this one. A payload naming a holder is not a holder when
    // the reason it arrived under is not one the console understands.
    const state = projectTerminalLease([transitionEvent(1, "seized", OTHER)], {
      viewerParticipantId: VIEWER,
    });
    expect(state.holderParticipantId).toBeNull();
    expect(state.holding).toBe("not-checked");
  });
});

describe("vouching — a holder the control plane cannot vouch for is not shown", () => {
  const held = [transitionEvent(1, "taken", VIEWER)];

  it("reports `not-checked` when no roster read was performed", () => {
    const state = projectTerminalLease(held, { viewerParticipantId: VIEWER });
    expect(state.holderVouching).toBe("not-checked");
    expect(state.unvouchedNodeId).toBeUndefined();
    expect(state.holding).toBe("held-by-you");
  });

  it("keeps the holder when the roster says the node is reachable", () => {
    const state = projectTerminalLease(held, {
      viewerParticipantId: VIEWER,
      holdingNode: { nodeId: "node-1", isReachable: true },
    });
    expect(state.holderVouching).toBe("vouched");
    expect(state.holding).toBe("held-by-you");
  });

  it("collapses to the free lease when the holding node reads offline, and names it", () => {
    const state = projectTerminalLease(held, {
      viewerParticipantId: VIEWER,
      holdingNode: { nodeId: "node-1", isReachable: false },
    });
    expect(state.holding).toBe("unheld");
    expect(state.holderParticipantId).toBeNull();
    expect(state.unvouchedNodeId).toBe("node-1");
  });

  it("negative control: the collapse runs BEFORE the viewer comparison", () => {
    // A fold that compared first and collapsed second would answer `held-by-you`
    // here, which is the one answer that lets a person type into a shell held on
    // a node nobody can reach.
    const state = projectTerminalLease(held, {
      viewerParticipantId: VIEWER,
      holdingNode: { nodeId: "node-1", isReachable: false },
    });
    expect(state.holding).not.toBe("held-by-you");
  });
});

describe("transition sentences — five reasons, five sentences", () => {
  const labelFor = (participantId: string): string =>
    participantId === OTHER ? "Priya" : participantId;

  it("gives every reason in the closed set a distinct sentence", () => {
    const sentences = TERMINAL_LEASE_TRANSITION_REASONS.map((reason) =>
      terminalLeaseTransitionSentence(transitionOf(reason), labelFor),
    );
    expect(new Set(sentences).size).toBe(TERMINAL_LEASE_TRANSITION_REASONS.length);
  });

  it("keeps the three automatic reasons apart from each other and from a release", () => {
    const [, released, disconnect, authorizationLost, runIdle] = TERMINAL_LEASE_TRANSITION_REASONS;
    const sentenceFor = (reason: TerminalLeaseTransitionReason): string =>
      terminalLeaseTransitionSentence(transitionOf(reason), labelFor);
    expect(sentenceFor(released)).toContain("released the shell");
    expect(sentenceFor(disconnect)).toContain("disconnected");
    expect(sentenceFor(authorizationLost)).toContain("lost authorization");
    expect(sentenceFor(runIdle)).toContain("running state");
  });

  it("names the participant the label function knows, and the wire id when it does not", () => {
    expect(terminalLeaseTransitionSentence(transitionOf("taken"), labelFor)).toContain("Priya");
    expect(
      terminalLeaseTransitionSentence(transitionOf("taken"), (participantId) => participantId),
    ).toContain(OTHER);
  });

  it("negative control: a collapsed table would fail the distinctness claim", () => {
    const collapsed = TERMINAL_LEASE_TRANSITION_REASONS.map(() => "The lease changed.");
    expect(new Set(collapsed).size).not.toBe(TERMINAL_LEASE_TRANSITION_REASONS.length);
  });
});

describe("the reason guard", () => {
  it("admits every member of the closed set", () => {
    for (const reason of TERMINAL_LEASE_TRANSITION_REASONS) {
      expect(asTerminalLeaseTransitionReason(reason)).toBe(reason);
    }
  });

  it("negative control: refuses a plausible non-member and a non-string", () => {
    expect(asTerminalLeaseTransitionReason("auto_released_timeout")).toBeUndefined();
    expect(asTerminalLeaseTransitionReason(undefined)).toBeUndefined();
    expect(asTerminalLeaseTransitionReason(4)).toBeUndefined();
  });
});
