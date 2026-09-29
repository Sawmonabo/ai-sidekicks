// One event, read on its own terms.
//
// The reader is driveable with a single payload and no session, which is the whole
// reason it is a module: every case below states what ONE `pty.control_changed`
// obliges, without a device or an ordering standing between the
// payload and the answer. The fold's response to a refusal is `lease-model.test.ts`'s
// — those are two different claims, and asserting the reader only through the fold is
// what made the second one carry both.
//
// Two of the surface's "never" clauses are properties of THIS module: the holder
// comes off the wire and nowhere else, and a reason and a holder shape that disagree
// are not a transition. Each has a negative control, because both would pass against
// a reader that simply returned the payload it saw.

import { describe, expect, it } from "vitest";

import {
  TERMINAL_LEASE_TRANSITION_REASONS,
  asTerminalLeaseTransitionReason,
  readTerminalLeaseTransition,
  readTerminalLeaseUnreadTransition,
} from "./lease-transition.js";
import {
  OTHER_DEVICE_ID,
  THIS_DEVICE_ID,
  leaseEventWithPayload,
} from "./lease-model.test-support.js";

/** Every event below sits at the same position; what varies is the payload on it. */
const READER_EVENT_SEQUENCE = 1;

describe("reading one transition — the holder is the wire's, and both halves agree", () => {
  it("reads a take, carrying the holder the payload named", () => {
    const transition = readTerminalLeaseTransition(
      leaseEventWithPayload(READER_EVENT_SEQUENCE, {
        reason: "taken",
        holderUserId: OTHER_DEVICE_ID,
        previousHolderUserId: THIS_DEVICE_ID,
      }),
    );
    expect(transition?.reason).toBe("taken");
    expect(transition?.holderUserId).toBe(OTHER_DEVICE_ID);
  });

  it("reads a release as naming nobody, which is the free lease explicitly", () => {
    const transition = readTerminalLeaseTransition(
      leaseEventWithPayload(READER_EVENT_SEQUENCE, {
        reason: "released",
        holderUserId: null,
        previousHolderUserId: OTHER_DEVICE_ID,
      }),
    );
    expect(transition?.holderUserId).toBeNull();
  });

  it("refuses a `taken` that names nobody, rather than reading it as the free lease", () => {
    // The expensive direction: a shell the daemon has just handed to someone, offered
    // as one anybody may take.
    expect(
      readTerminalLeaseTransition(
        leaseEventWithPayload(READER_EVENT_SEQUENCE, {
          reason: "taken",
          holderUserId: null,
        }),
      ),
    ).toBeUndefined();
  });

  it("refuses a release that names a holder, however it was released", () => {
    // The other expensive direction, in all four of its spellings: the user a
    // release took the shell FROM travels as the previous holder, so a release naming
    // a holder is a payload contradicting itself.
    for (const reason of TERMINAL_LEASE_TRANSITION_REASONS.filter(
      (candidate) => candidate !== "taken",
    )) {
      expect(
        readTerminalLeaseTransition(
          leaseEventWithPayload(READER_EVENT_SEQUENCE, {
            reason,
            holderUserId: THIS_DEVICE_ID,
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
          holderUserId: null,
        }),
      ),
    ).toBeUndefined();
    expect(
      readTerminalLeaseTransition(
        leaseEventWithPayload(READER_EVENT_SEQUENCE, { holderUserId: OTHER_DEVICE_ID }),
      ),
    ).toBeUndefined();
    expect(
      readTerminalLeaseTransition(leaseEventWithPayload(READER_EVENT_SEQUENCE, undefined)),
    ).toBeUndefined();
  });

  it("negative control: a holder member of the wrong TYPE is not a holder", () => {
    // The tolerant read turned every non-string into the free lease, so a numeric,
    // empty, or absent holder on a take was the same silent normalization in a second
    // shape. Without this control the cases above would pass against a reader that
    // only ever checked the reason.
    for (const holderUserId of ["", 4, null, undefined]) {
      expect(
        readTerminalLeaseTransition(
          leaseEventWithPayload(READER_EVENT_SEQUENCE, { reason: "taken", holderUserId }),
        ),
      ).toBeUndefined();
    }
    expect(
      readTerminalLeaseTransition(
        leaseEventWithPayload(READER_EVENT_SEQUENCE, {
          reason: "taken",
          holderUserId: OTHER_DEVICE_ID,
        }),
      )?.holderUserId,
    ).toBe(OTHER_DEVICE_ID);
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
