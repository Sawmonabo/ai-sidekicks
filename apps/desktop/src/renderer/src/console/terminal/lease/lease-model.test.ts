// The lease fold: what the wire said, and only that.
//
// The fold's ordinary answer — who the log's transitions leave holding the shell, how
// many there were, and what the ledger keeps when there are more than its cap. The
// three arms where the fold refuses to answer are
// `lease-model.withheld.test.ts`'s, and they are a different claim: this file is about
// what a well-formed ordering produces, that one about what an ill-formed or
// unvouchable one does NOT.
//
// The READER's own claims are `lease-transition.test.ts`'s — a payload's reason and
// holder shape agreeing, and the five sentences staying distinct, are answerable with
// one event and no session.

import { describe, expect, it } from "vitest";

import { TERMINAL_LEASE_LEDGER_CAP } from "../../core/index.js";
import { UNREAD_TERMINAL_LEASE, projectTerminalLease } from "./lease-model.js";
import {
  OTHER_PARTICIPANT,
  VIEWER_PARTICIPANT,
  transitionEvent,
} from "./lease-model.test-support.js";

describe("the lease fold — what the wire said, and only that", () => {
  it("reads nothing as `not-checked`, which is not the free lease", () => {
    const state = projectTerminalLease([], { viewerParticipantId: VIEWER_PARTICIPANT });
    expect(state).toStrictEqual(UNREAD_TERMINAL_LEASE);
    // The whole point of the fifth state: an unread lease and a free one are two
    // different facts, and a surface that collapsed them would offer a claim
    // against a shell it has never asked about as though it knew it was free.
    expect(state.holding).not.toBe("unheld");
  });

  it("takes the holder from the newest transition's own payload", () => {
    const state = projectTerminalLease(
      [
        transitionEvent(1, "taken", OTHER_PARTICIPANT),
        transitionEvent(2, "released", null, OTHER_PARTICIPANT),
        transitionEvent(3, "taken", VIEWER_PARTICIPANT),
      ],
      { viewerParticipantId: VIEWER_PARTICIPANT },
    );
    expect(state.holding).toBe("held-by-you");
    expect(state.holderParticipantId).toBe(VIEWER_PARTICIPANT);
    expect(state.transitionCount).toBe(3);
  });

  it("renders a null holder as the free lease, explicitly", () => {
    const state = projectTerminalLease(
      [
        transitionEvent(1, "taken", OTHER_PARTICIPANT),
        transitionEvent(2, "auto_released_disconnect", null, OTHER_PARTICIPANT),
      ],
      { viewerParticipantId: VIEWER_PARTICIPANT },
    );
    expect(state.holding).toBe("unheld");
    expect(state.holderParticipantId).toBeNull();
  });

  it("tells the viewer's hold apart from somebody else's", () => {
    const events = [transitionEvent(1, "taken", OTHER_PARTICIPANT)];
    expect(projectTerminalLease(events, { viewerParticipantId: VIEWER_PARTICIPANT }).holding).toBe(
      "held-by-another",
    );
    expect(projectTerminalLease(events, { viewerParticipantId: OTHER_PARTICIPANT }).holding).toBe(
      "held-by-you",
    );
    // No viewer read at all is the console's state today, and it fails closed:
    // nobody is ever told they may type on the strength of an unknown identity.
    expect(projectTerminalLease(events, { viewerParticipantId: undefined }).holding).toBe(
      "held-by-another",
    );
  });

  it("gives a reason outside the closed set no ledger row and no sentence", () => {
    const state = projectTerminalLease(
      [
        transitionEvent(1, "taken", OTHER_PARTICIPANT),
        transitionEvent(2, "auto_released_timeout", null, OTHER_PARTICIPANT),
      ],
      { viewerParticipantId: VIEWER_PARTICIPANT },
    );
    // One READABLE transition, so one row and one count. The other is reported as
    // the unread transition rather than rendered as a nameless one — inventing a
    // sentence for it is how a surface starts asserting things nobody sent.
    expect(state.transitionCount).toBe(1);
    expect(state.transitions).toHaveLength(1);
    expect(state.unreadTransition?.sequence).toBe(2);
  });

  it("ignores every event that is not a lease transition", () => {
    const state = projectTerminalLease(
      [
        {
          id: "event-1",
          sessionId: "session-terminal",
          sequence: 1,
          kind: "session.created",
          occurredAt: "x",
        },
        transitionEvent(2, "taken", OTHER_PARTICIPANT),
      ],
      { viewerParticipantId: VIEWER_PARTICIPANT },
    );
    expect(state.transitionCount).toBe(1);
  });

  it("caps the ledger while still counting every transition it saw", () => {
    const events = Array.from({ length: TERMINAL_LEASE_LEDGER_CAP + 5 }, (_unused, index) =>
      transitionEvent(
        index + 1,
        index % 2 === 0 ? "taken" : "released",
        index % 2 === 0 ? OTHER_PARTICIPANT : null,
      ),
    );
    const state = projectTerminalLease(events, { viewerParticipantId: VIEWER_PARTICIPANT });
    expect(state.transitions).toHaveLength(TERMINAL_LEASE_LEDGER_CAP);
    expect(state.transitionCount).toBe(TERMINAL_LEASE_LEDGER_CAP + 5);
    // The cap drops the OLDEST, so the newest transition — the one the holder is
    // read from — is always present.
    expect(state.transitions.at(-1)?.sequence).toBe(events.length);
  });

  it("counts every transition it could not read, including the ones a later one cleared", () => {
    // `unreadTransition` is cleared by the next readable transition, because the
    // HOLDER is known again. The ledger's completeness is not: neither unreadable
    // move ever became a row, so a count that only kept the trailing one would let a
    // three-row ledger claim to be the whole history of five moves.
    const state = projectTerminalLease(
      [
        transitionEvent(1, "taken", OTHER_PARTICIPANT),
        transitionEvent(2, "seized", OTHER_PARTICIPANT),
        transitionEvent(3, "released", null, OTHER_PARTICIPANT),
        transitionEvent(4, "auto_released_quota_exhausted", null, OTHER_PARTICIPANT),
        transitionEvent(5, "taken", VIEWER_PARTICIPANT),
      ],
      { viewerParticipantId: VIEWER_PARTICIPANT },
    );
    expect(state.unreadableTransitionCount).toBe(2);
    expect(state.unreadTransition).toBeUndefined();
    expect(state.transitionCount).toBe(3);
  });

  it("negative control: a log the fold read whole counts no unreadable transition", () => {
    // Without it the case above would pass against a counter that incremented on
    // every event, which would put a notice on every ledger the console renders.
    const state = projectTerminalLease(
      [
        transitionEvent(1, "taken", OTHER_PARTICIPANT),
        transitionEvent(2, "released", null, OTHER_PARTICIPANT),
      ],
      { viewerParticipantId: VIEWER_PARTICIPANT },
    );
    expect(state.unreadableTransitionCount).toBe(0);
  });

  it("negative control: a fold that echoed the payload would pass every case above", () => {
    // It would not pass this one. A payload naming a holder is not a holder when
    // the reason it arrived under is not one the console understands.
    const state = projectTerminalLease([transitionEvent(1, "seized", OTHER_PARTICIPANT)], {
      viewerParticipantId: VIEWER_PARTICIPANT,
    });
    expect(state.holderParticipantId).toBeNull();
    expect(state.holding).toBe("unrecognized-transition");
  });
});
