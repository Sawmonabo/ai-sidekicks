// One event, read on its own terms.
//
// The reader is driveable with a single payload and no session, which is the whole
// reason it is a module: every case below states what ONE `pty.control_changed`
// obliges, without a viewer, a holding node, or an ordering standing between the
// payload and the answer. The fold's response to a refusal is `lease-model.test.ts`'s
// — those are two different claims, and asserting the reader only through the fold is
// what made the second one carry both.
//
// Three of 8.8's "never" clauses are properties of THIS module: the holder comes off
// the wire and nowhere else, a reason and a holder shape that disagree are not a
// transition, and the five reasons render five distinct sentences. Each has a
// negative control, because every one of them would pass against a reader that simply
// returned the payload it saw.

import { describe, expect, it } from "vitest";

import {
  TERMINAL_LEASE_TRANSITION_REASONS,
  asTerminalLeaseTransitionReason,
  readTerminalLeaseTransition,
  readTerminalLeaseUnreadTransition,
  terminalLeaseTransitionSentence,
  type TerminalLeaseTransition,
  type TerminalLeaseTransitionReason,
} from "./lease-transition.js";
import {
  OTHER_PARTICIPANT,
  VIEWER_PARTICIPANT,
  leaseEventWithPayload,
} from "./lease-model.test-support.js";

/** Every event below sits at the same position; what varies is the payload on it. */
const READER_EVENT_SEQUENCE = 1;

function transitionOf(reason: TerminalLeaseTransitionReason): TerminalLeaseTransition {
  return {
    sequence: 1,
    occurredAtIso: "2026-01-01T16:40:00.000Z",
    reason,
    holderParticipantId: reason === "taken" ? OTHER_PARTICIPANT : null,
    previousHolderParticipantId: reason === "taken" ? null : OTHER_PARTICIPANT,
    actorId: OTHER_PARTICIPANT,
  };
}

describe("reading one transition — the holder is the wire's, and both halves agree", () => {
  it("reads a take, carrying the holder and the previous holder the payload named", () => {
    const transition = readTerminalLeaseTransition(
      leaseEventWithPayload(READER_EVENT_SEQUENCE, {
        reason: "taken",
        holderParticipantId: OTHER_PARTICIPANT,
        previousHolderParticipantId: VIEWER_PARTICIPANT,
      }),
    );
    expect(transition?.reason).toBe("taken");
    expect(transition?.holderParticipantId).toBe(OTHER_PARTICIPANT);
    expect(transition?.previousHolderParticipantId).toBe(VIEWER_PARTICIPANT);
    expect(transition?.sequence).toBe(1);
    expect(transition?.actorId).toBe(OTHER_PARTICIPANT);
  });

  it("reads a release as naming nobody, which is the free lease explicitly", () => {
    const transition = readTerminalLeaseTransition(
      leaseEventWithPayload(READER_EVENT_SEQUENCE, {
        reason: "released",
        holderParticipantId: null,
        previousHolderParticipantId: OTHER_PARTICIPANT,
      }),
    );
    expect(transition?.holderParticipantId).toBeNull();
    expect(transition?.previousHolderParticipantId).toBe(OTHER_PARTICIPANT);
  });

  it("refuses a `taken` that names nobody, rather than reading it as the free lease", () => {
    // The expensive direction: a shell the daemon has just handed to someone, offered
    // as one anybody may claim.
    expect(
      readTerminalLeaseTransition(
        leaseEventWithPayload(READER_EVENT_SEQUENCE, {
          reason: "taken",
          holderParticipantId: null,
        }),
      ),
    ).toBeUndefined();
  });

  it("refuses a release that names a holder, however it was released", () => {
    // The other expensive direction, in all four of its spellings: the participant a
    // release took the shell FROM travels as the previous holder, so a release naming
    // a holder is a payload contradicting itself.
    for (const reason of TERMINAL_LEASE_TRANSITION_REASONS.filter(
      (candidate) => candidate !== "taken",
    )) {
      expect(
        readTerminalLeaseTransition(
          leaseEventWithPayload(READER_EVENT_SEQUENCE, {
            reason,
            holderParticipantId: VIEWER_PARTICIPANT,
          }),
        ),
      ).toBeUndefined();
    }
  });

  it("refuses a reason outside the closed set, and a payload with no reason at all", () => {
    expect(
      readTerminalLeaseTransition(
        leaseEventWithPayload(READER_EVENT_SEQUENCE, {
          reason: "auto_released_timeout",
          holderParticipantId: null,
        }),
      ),
    ).toBeUndefined();
    expect(
      readTerminalLeaseTransition(
        leaseEventWithPayload(READER_EVENT_SEQUENCE, { holderParticipantId: OTHER_PARTICIPANT }),
      ),
    ).toBeUndefined();
    expect(
      readTerminalLeaseTransition(leaseEventWithPayload(READER_EVENT_SEQUENCE, undefined)),
    ).toBeUndefined();
  });

  it("negative control: a holder member of the wrong TYPE is not a holder", () => {
    // The tolerant read turned every non-string into the free lease, so a numeric,
    // empty, or absent holder on a take was the same silent normalisation in a second
    // shape. Without this control the cases above would pass against a reader that
    // only ever checked the reason.
    for (const holderParticipantId of ["", 4, null, undefined]) {
      expect(
        readTerminalLeaseTransition(
          leaseEventWithPayload(READER_EVENT_SEQUENCE, { reason: "taken", holderParticipantId }),
        ),
      ).toBeUndefined();
    }
    expect(
      readTerminalLeaseTransition(
        leaseEventWithPayload(READER_EVENT_SEQUENCE, {
          reason: "taken",
          holderParticipantId: OTHER_PARTICIPANT,
        }),
      )?.holderParticipantId,
    ).toBe(OTHER_PARTICIPANT);
  });
});

describe("reading the transition it could NOT read", () => {
  it("carries the reason the wire sent, so the operator has something to paste", () => {
    const unread = readTerminalLeaseUnreadTransition(
      leaseEventWithPayload(READER_EVENT_SEQUENCE, { reason: "auto_released_quota_exhausted" }),
    );
    expect(unread.reason).toBe("auto_released_quota_exhausted");
    expect(unread.sequence).toBe(1);
    expect(unread.occurredAtIso).toBe("2026-01-01T00:00:01.000Z");
  });

  it("negative control: a payload with nothing to name carries nothing", () => {
    // Without it the case above would pass against a reader that stringified whatever
    // the member held, which is the surface inventing a vocabulary.
    expect(
      readTerminalLeaseUnreadTransition(
        leaseEventWithPayload(READER_EVENT_SEQUENCE, { reason: "" }),
      ).reason,
    ).toBeUndefined();
    expect(
      readTerminalLeaseUnreadTransition(leaseEventWithPayload(READER_EVENT_SEQUENCE, { reason: 4 }))
        .reason,
    ).toBeUndefined();
    expect(
      readTerminalLeaseUnreadTransition(leaseEventWithPayload(READER_EVENT_SEQUENCE, undefined))
        .reason,
    ).toBeUndefined();
  });
});

describe("transition sentences — five reasons, five sentences", () => {
  const labelFor = (participantId: string): string =>
    participantId === OTHER_PARTICIPANT ? "Priya" : participantId;

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
    ).toContain(OTHER_PARTICIPANT);
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
