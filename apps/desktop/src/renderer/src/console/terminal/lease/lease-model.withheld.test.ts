// The two arms where the fold refuses to answer, held to the lease line's
// prohibitions rather than to its own shape.
//
// Each is asserted as a PROPERTY rather than as an example output, and each has a
// negative control, because both would pass against a fold that simply returned
// the last payload it saw:
//
//   • a transition the reader REFUSED leaves nobody holding the shell rather than the
//     holder before it — ignorance about a write lease is not the old holder;
//   • a holder shape that CONTRADICTS its reason is unread rather than normalized, and
//     both malformed shapes used to be presented as confident states: a take that named
//     nobody read as a free lease, and a release that named this device read as its own
//     hold and opened stdin against a shell the daemon had already taken back.

import { describe, expect, it } from "vitest";

import { projectTerminalLease } from "./lease-model.js";
import {
  OTHER_USER,
  VIEWER_USER,
  leaseEventWithPayload,
  transitionEvent,
} from "./lease-model.test-support.js";

describe("an unread transition — ignorance about a write lease is not the old holder", () => {
  /**
   * The take that granted this device the lease, followed by a move this build
   * cannot read. This is the shape the surface has to get right: the console saw
   * itself take the shell, and then saw the daemon do something to it.
   */
  const grantedThenUnread = [
    transitionEvent(1, "taken", VIEWER_USER),
    transitionEvent(2, "auto_released_quota_exhausted", null, VIEWER_USER),
  ];

  it("stops reporting this device as the holder the moment a transition cannot be read", () => {
    const state = projectTerminalLease(grantedThenUnread, {
      viewerUserId: VIEWER_USER,
    });
    // The one reading that would keep stdin open for somebody who no longer holds
    // the shell. `TerminalPane` opens the write gate on exactly this value.
    expect(state.holding).not.toBe("held-by-you");
    expect(state.holding).toBe("unrecognized-transition");
    expect(state.holderUserId).toBeNull();
  });

  it("negative control: the same grant WITHOUT the unread move does hold", () => {
    // Without this the case above would pass against a fold that never reported
    // `held-by-you` at all, which is a different bug and not a fix.
    const state = projectTerminalLease(grantedThenUnread.slice(0, 1), {
      viewerUserId: VIEWER_USER,
    });
    expect(state.holding).toBe("held-by-you");
    expect(state.holderUserId).toBe(VIEWER_USER);
  });

  it("carries the reason the wire sent, so the operator has something to paste", () => {
    const state = projectTerminalLease(grantedThenUnread, {
      viewerUserId: VIEWER_USER,
    });
    expect(state.unreadTransition?.reason).toBe("auto_released_quota_exhausted");
    expect(state.unreadTransition?.sequence).toBe(2);
  });

  it("reports a transition with no reason at all as unread, with nothing to name", () => {
    // A `pty.control_changed` this build cannot read is unread whether the payload
    // named something outside the set or named nothing — both are the daemon moving
    // the lease somewhere this console cannot follow.
    const state = projectTerminalLease(
      [
        transitionEvent(1, "taken", VIEWER_USER),
        leaseEventWithPayload(2, { holderUserId: OTHER_USER }),
      ],
      { viewerUserId: VIEWER_USER },
    );
    expect(state.holding).toBe("unrecognized-transition");
    expect(state.unreadTransition?.reason).toBeUndefined();
  });

  it("recovers on the next transition it CAN read", () => {
    const state = projectTerminalLease(
      [...grantedThenUnread, transitionEvent(3, "taken", VIEWER_USER)],
      { viewerUserId: VIEWER_USER },
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
        transitionEvent(3, "taken", VIEWER_USER),
        transitionEvent(4, "seized", OTHER_USER),
      ],
      { viewerUserId: VIEWER_USER },
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
// nobody read as a free lease, and a release that named this device read as its own
// hold and opened stdin against a shell the daemon had already taken back.
describe("a holder shape that contradicts its reason is unread, not normalized", () => {
  it("refuses a `taken` that names nobody, rather than reading it as the free lease", () => {
    const state = projectTerminalLease(
      [transitionEvent(1, "taken", OTHER_USER), transitionEvent(2, "taken", null, OTHER_USER)],
      { viewerUserId: VIEWER_USER },
    );
    expect(state.holding).toBe("unrecognized-transition");
    expect(state.holderUserId).toBeNull();
    // The lease itself did not move: the readable take is still the only counted
    // transition, and the unread one is reported in its own right.
    expect(state.transitionCount).toBe(1);
    expect(state.transitions).toHaveLength(1);
    expect(state.unreadTransition?.sequence).toBe(2);
    expect(state.unreadTransition?.reason).toBe("taken");
  });

  it("refuses a `released` that names this device, rather than reading it as its hold", () => {
    const state = projectTerminalLease([transitionEvent(1, "released", VIEWER_USER, VIEWER_USER)], {
      viewerUserId: VIEWER_USER,
    });
    // The one reading that opens stdin for somebody the daemon has just taken the
    // shell from, and leaves them typing until the writes are rejected.
    expect(state.holding).not.toBe("held-by-you");
    expect(state.holding).toBe("unrecognized-transition");
    expect(state.holderUserId).toBeNull();
  });

  it("refuses an automatic release that names a holder too", () => {
    // The three automatic reasons are releases, so the same rule reads them: the
    // user a release took the shell FROM travels as the previous holder.
    const state = projectTerminalLease(
      [transitionEvent(1, "auto_released_disconnect", OTHER_USER, OTHER_USER)],
      { viewerUserId: VIEWER_USER },
    );
    expect(state.holding).toBe("unrecognized-transition");
  });

  it("negative control: both well-formed directions still read", () => {
    // Without this the three cases above would pass against a fold that called every
    // transition unreadable, which is a lease surface that never says anything.
    const takenByOther = projectTerminalLease([transitionEvent(1, "taken", OTHER_USER)], {
      viewerUserId: VIEWER_USER,
    });
    expect(takenByOther.holding).toBe("held-by-another");
    const releasedByOther = projectTerminalLease(
      [transitionEvent(1, "taken", OTHER_USER), transitionEvent(2, "released", null, OTHER_USER)],
      { viewerUserId: VIEWER_USER },
    );
    expect(releasedByOther.holding).toBe("unheld");
    expect(releasedByOther.transitionCount).toBe(2);
  });

  it("negative control: a holder member of the wrong TYPE is unread on a take", () => {
    // The tolerant read turned every non-string into the free lease, so a numeric or
    // absent holder on a take was the same silent normalization in a second shape.
    const state = projectTerminalLease(
      [leaseEventWithPayload(1, { reason: "taken", holderUserId: "" })],
      { viewerUserId: VIEWER_USER },
    );
    expect(state.holding).toBe("unrecognized-transition");
  });
});
