// The lease fold, held to 8.8's prohibitions rather than to its own shape.
//
// Two of the design's "never" clauses are properties of THIS module and are asserted
// here as properties rather than as example outputs: an unvouchable holder collapses
// to the free lease before anyone is compared to it, and a transition the reader
// refused leaves nobody holding the shell rather than the holder before it. Each has
// a negative control, because both would pass against a fold that simply returned the
// last payload it saw.
//
// The READER's own claims are `lease-transition.test.ts`'s — a payload's reason and
// holder shape agreeing, and the five sentences staying distinct, are answerable with
// one event and no session. What is asserted here is the fold's ANSWER to a refusal,
// which is a different claim and needs an ordering to state at all.

import { describe, expect, it } from "vitest";

import { TERMINAL_SCENARIO_CAST } from "../bridge/scenarios/terminal.js";
import type { ConsoleSessionEvent } from "../store/index.js";
import { TERMINAL_LEASE_LEDGER_CAP } from "../core/index.js";
import { UNREAD_TERMINAL_LEASE, projectTerminalLease } from "./lease-model.js";
import { TERMINAL_LEASE_EVENT_KIND } from "./lease-transition.js";

/**
 * Two participants, taken from the scenario rather than written down.
 *
 * The fold treats a participant id as an opaque string, so a readable placeholder
 * would pass every case here — and would be the one participant id in this family
 * that no daemon could ever emit, sitting beside beats the scenario deliberately
 * moved onto wire-declared UUIDs. Reading them off the join log keeps the family's
 * fixtures saying one thing about what a participant id is.
 */
const VIEWER = TERMINAL_SCENARIO_CAST.owner;
const OTHER = TERMINAL_SCENARIO_CAST.collaborator;

function transitionEvent(
  sequence: number,
  reason: string,
  holderParticipantId: string | null,
  previousHolderParticipantId: string | null = null,
  actorId: string | undefined = holderParticipantId ?? undefined,
): ConsoleSessionEvent {
  return {
    // Distinct per position, and readable rather than UUID-shaped: the fold reads
    // this member for nothing, so `store/failure-modes.test-support.ts`'s spelling
    // is the one to match. The participant ids above are the opposite case — those
    // reach a surface, which is why they are read off the scenario's wire-declared
    // cast.
    id: `event-${String(sequence)}`,
    sessionId: "session-terminal",
    sequence,
    kind: TERMINAL_LEASE_EVENT_KIND,
    occurredAt: `2026-01-01T16:40:0${String(sequence % 10)}.000Z`,
    ...(actorId === undefined ? {} : { actorId }),
    payload: { holderParticipantId, previousHolderParticipantId, reason },
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

  it("gives a reason outside the closed set no ledger row and no sentence", () => {
    const state = projectTerminalLease(
      [
        transitionEvent(1, "taken", OTHER),
        transitionEvent(2, "auto_released_timeout", null, OTHER),
      ],
      { viewerParticipantId: VIEWER },
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
    expect(state.holding).toBe("unrecognized-transition");
  });
});

describe("an unread transition — ignorance about a write lease is not the old holder", () => {
  /**
   * The take that granted the VIEWER the lease, followed by a move this build
   * cannot read. This is the shape the surface has to get right: the console saw
   * itself take the shell, and then saw the daemon do something to it.
   */
  const grantedThenUnread = [
    transitionEvent(1, "taken", VIEWER),
    transitionEvent(2, "auto_released_quota_exhausted", null, VIEWER),
  ];

  it("stops reporting the viewer as the holder the moment a transition cannot be read", () => {
    const state = projectTerminalLease(grantedThenUnread, { viewerParticipantId: VIEWER });
    // The one reading that would keep stdin open for somebody who no longer holds
    // the shell. `TerminalPane` opens the write gate on exactly this value.
    expect(state.holding).not.toBe("held-by-you");
    expect(state.holding).toBe("unrecognized-transition");
    expect(state.holderParticipantId).toBeNull();
  });

  it("negative control: the same grant WITHOUT the unread move does hold", () => {
    // Without this the case above would pass against a fold that never reported
    // `held-by-you` at all, which is a different bug and not a fix.
    const state = projectTerminalLease(grantedThenUnread.slice(0, 1), {
      viewerParticipantId: VIEWER,
    });
    expect(state.holding).toBe("held-by-you");
    expect(state.holderParticipantId).toBe(VIEWER);
  });

  it("carries the reason the wire sent, so the operator has something to paste", () => {
    const state = projectTerminalLease(grantedThenUnread, { viewerParticipantId: VIEWER });
    expect(state.unreadTransition?.reason).toBe("auto_released_quota_exhausted");
    expect(state.unreadTransition?.sequence).toBe(2);
  });

  it("reports a transition with no reason at all as unread, with nothing to name", () => {
    // A `pty.control_changed` this build cannot read is unread whether the payload
    // named something outside the set or named nothing — both are the daemon moving
    // the lease somewhere this console cannot follow.
    const state = projectTerminalLease(
      [
        transitionEvent(1, "taken", VIEWER),
        {
          id: "event-2",
          sessionId: "session-terminal",
          sequence: 2,
          kind: TERMINAL_LEASE_EVENT_KIND,
          occurredAt: "2026-01-01T16:40:02.000Z",
          payload: { holderParticipantId: OTHER },
        },
      ],
      { viewerParticipantId: VIEWER },
    );
    expect(state.holding).toBe("unrecognized-transition");
    expect(state.unreadTransition?.reason).toBeUndefined();
  });

  it("recovers on the next transition it CAN read", () => {
    const state = projectTerminalLease(
      [...grantedThenUnread, transitionEvent(3, "taken", VIEWER)],
      { viewerParticipantId: VIEWER },
    );
    // The console understands the current state again, and the state it understands
    // is that transition's — an unread transition is not a latch.
    expect(state.unreadTransition).toBeUndefined();
    expect(state.holding).toBe("held-by-you");
    expect(state.transitionCount).toBe(2);
  });

  it("stays unread when the readable transition came FIRST", () => {
    // Order is the whole claim: a readable transition before the unread one says
    // nothing about the state after it.
    const state = projectTerminalLease(
      [
        ...grantedThenUnread,
        transitionEvent(3, "taken", VIEWER),
        transitionEvent(4, "seized", OTHER),
      ],
      { viewerParticipantId: VIEWER },
    );
    expect(state.holding).toBe("unrecognized-transition");
    expect(state.unreadTransition?.sequence).toBe(4);
  });
});

// A reason alone is not a reading. The holder member is the other half, and the two
// have to agree: a take names who holds it, and every release — the operator's own
// and the three automatic ones — leaves nobody holding it.
//
// Both malformed shapes below used to be presented as CONFIDENT states rather than as
// the ignorance they are, and each is the expensive direction: a take that named
// nobody read as a free lease, and a release that named the viewer read as their own
// hold and opened stdin against a shell the daemon had already taken back.
describe("a holder shape that contradicts its reason is unread, not normalised", () => {
  it("refuses a `taken` that names nobody, rather than reading it as the free lease", () => {
    const state = projectTerminalLease(
      [transitionEvent(1, "taken", OTHER), transitionEvent(2, "taken", null, OTHER)],
      { viewerParticipantId: VIEWER },
    );
    expect(state.holding).toBe("unrecognized-transition");
    expect(state.holderParticipantId).toBeNull();
    // The lease itself did not move: the readable take is still the only counted
    // transition, and the unread one is reported in its own right.
    expect(state.transitionCount).toBe(1);
    expect(state.transitions).toHaveLength(1);
    expect(state.unreadTransition?.sequence).toBe(2);
    expect(state.unreadTransition?.reason).toBe("taken");
  });

  it("refuses a `released` that names the viewer, rather than reading it as their hold", () => {
    const state = projectTerminalLease([transitionEvent(1, "released", VIEWER, VIEWER)], {
      viewerParticipantId: VIEWER,
    });
    // The one reading that opens stdin for somebody the daemon has just taken the
    // shell from, and leaves them typing until the writes are rejected.
    expect(state.holding).not.toBe("held-by-you");
    expect(state.holding).toBe("unrecognized-transition");
    expect(state.holderParticipantId).toBeNull();
  });

  it("refuses an automatic release that names a holder too", () => {
    // The three automatic reasons are releases, so the same rule reads them: the
    // participant a release took the shell FROM travels as the previous holder.
    const state = projectTerminalLease(
      [transitionEvent(1, "auto_released_disconnect", OTHER, OTHER)],
      { viewerParticipantId: VIEWER },
    );
    expect(state.holding).toBe("unrecognized-transition");
  });

  it("negative control: both well-formed directions still read", () => {
    // Without this the three cases above would pass against a fold that called every
    // transition unreadable, which is a lease surface that never says anything.
    const takenByOther = projectTerminalLease([transitionEvent(1, "taken", OTHER)], {
      viewerParticipantId: VIEWER,
    });
    expect(takenByOther.holding).toBe("held-by-another");
    const releasedByOther = projectTerminalLease(
      [transitionEvent(1, "taken", OTHER), transitionEvent(2, "released", null, OTHER)],
      { viewerParticipantId: VIEWER },
    );
    expect(releasedByOther.holding).toBe("unheld");
    expect(releasedByOther.transitionCount).toBe(2);
  });

  it("negative control: a holder member of the wrong TYPE is unread on a take", () => {
    // The tolerant read turned every non-string into the free lease, so a numeric or
    // absent holder on a take was the same silent normalisation in a second shape.
    const state = projectTerminalLease(
      [
        {
          id: "event-1",
          sessionId: "session-terminal",
          sequence: 1,
          kind: TERMINAL_LEASE_EVENT_KIND,
          occurredAt: "2026-01-01T16:40:01.000Z",
          payload: { reason: "taken", holderParticipantId: "" },
        },
      ],
      { viewerParticipantId: VIEWER },
    );
    expect(state.holding).toBe("unrecognized-transition");
  });
});

describe("vouching — a holder the control plane cannot vouch for is not shown", () => {
  const held = [transitionEvent(1, "taken", VIEWER)];

  it("reports `not-checked` when no roster read was performed", () => {
    const state = projectTerminalLease(held, { viewerParticipantId: VIEWER });
    expect(state.holderVouching).toBe("not-checked");
    expect(state.offlineNode).toBeUndefined();
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
    // The node AND what it did: this reading is the one where an offline host took
    // a holder off the screen, which is a different sentence from an offline host
    // under a lease that was already free.
    expect(state.offlineNode).toStrictEqual({ nodeId: "node-1", effect: "holder-collapsed" });
  });

  it("keeps the offline node without a holder claim when the lease was already free", () => {
    // The finding. A `released` transition and then the sole node dropping: the
    // fold nulled the holder because the wire said nobody holds it, and projected an
    // unvouched HOLDER beside it anyway, so the line said "Nobody holds the shell"
    // and "The holding node … is offline" at once.
    const state = projectTerminalLease(
      [transitionEvent(1, "taken", VIEWER), transitionEvent(2, "released", null, VIEWER)],
      { viewerParticipantId: VIEWER, holdingNode: { nodeId: "node-1", isReachable: false } },
    );
    expect(state.holding).toBe("unheld");
    expect(state.holderParticipantId).toBeNull();
    // Still worth saying — the host is down and that is why the shell is read-only —
    // and said without claiming there is a holder the node reading took away.
    expect(state.offlineNode).toStrictEqual({ nodeId: "node-1", effect: "no-holder-shown" });
    // The roster reading itself is unchanged: a read happened and found the host
    // offline, which is a fact about the READ and not about who holds the lease.
    expect(state.holderVouching).toBe("unvouched");
  });

  it("claims no holder either when the transition that moved the lease was unread", () => {
    // The other way this surface shows nobody. "The holding node is offline, so the
    // shell reads as free" would contradict the paragraph beside it, which says the
    // console cannot read who holds the shell at all.
    const state = projectTerminalLease(
      [transitionEvent(1, "taken", VIEWER), transitionEvent(2, "seized", OTHER)],
      { viewerParticipantId: VIEWER, holdingNode: { nodeId: "node-1", isReachable: false } },
    );
    expect(state.holding).toBe("unrecognized-transition");
    expect(state.offlineNode).toStrictEqual({ nodeId: "node-1", effect: "no-holder-shown" });
  });

  it("negative control: a reachable node produces no offline reading at all", () => {
    // Without it the cases above would pass against a fold that reported an offline
    // node for every roster read, which would put a host-down sentence on a healthy
    // session.
    const state = projectTerminalLease(
      [transitionEvent(1, "taken", VIEWER), transitionEvent(2, "released", null, VIEWER)],
      { viewerParticipantId: VIEWER, holdingNode: { nodeId: "node-1", isReachable: true } },
    );
    expect(state.offlineNode).toBeUndefined();
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
