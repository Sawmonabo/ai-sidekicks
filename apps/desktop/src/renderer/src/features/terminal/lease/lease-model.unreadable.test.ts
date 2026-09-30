// The arms where the fold refuses to answer. A transition the reader refused leaves nobody
// holding the shell rather than the holder before it, and a holder shape that contradicts its
// reason is unread rather than normalized. Each case has a negative control, because a fold
// that returned the last payload it saw would pass the rest.

import { describe, expect, it } from "vitest";

import { projectTerminalLease } from "./lease-model.js";
import {
  OTHER_DEVICE_ID,
  SHELL_ID,
  THIS_DEVICE_ID,
  leaseEventWithPayload,
  transitionEvent,
} from "./lease-model.test-support.js";

describe("an unread transition — ignorance about a write lease is not the old holder", () => {
  // The take that granted this device the lease, then a move this build cannot read.
  const grantedThenUnread = [
    transitionEvent(1, "taken", THIS_DEVICE_ID),
    transitionEvent(2, "auto_released_quota_exhausted", null, THIS_DEVICE_ID),
  ];

  it("stops reporting this device as the holder the moment a transition cannot be read", () => {
    const state = projectTerminalLease(grantedThenUnread, {
      terminalId: SHELL_ID,
      thisDeviceId: THIS_DEVICE_ID,
    });
    // The one reading that would keep stdin open for somebody who no longer holds the shell;
    // `SessionTerminalPane` opens the write gate on exactly this value.
    expect(state.holding).not.toBe("held-by-this-device");
    expect(state.holding).toBe("unrecognized-transition");
    expect(state.holderDeviceId).toBeNull();
  });

  it("negative control: the same grant WITHOUT the unread move does hold", () => {
    // Without this the case above would pass against a fold that never reported
    // `held-by-this-device` at all, which is a different bug.
    const state = projectTerminalLease(grantedThenUnread.slice(0, 1), {
      terminalId: SHELL_ID,
      thisDeviceId: THIS_DEVICE_ID,
    });
    expect(state.holding).toBe("held-by-this-device");
    expect(state.holderDeviceId).toBe(THIS_DEVICE_ID);
  });

  it("reads a move that names no shell as this shell's, so it cannot leave stdin open", () => {
    // A move that lost its shell could be about any shell, this one included; only a
    // move that names ANOTHER shell is someone else's.
    const state = projectTerminalLease(
      [
        transitionEvent(1, "taken", THIS_DEVICE_ID),
        leaseEventWithPayload(2, { reason: "seized", holderDeviceId: null }),
      ],
      { terminalId: SHELL_ID, thisDeviceId: THIS_DEVICE_ID },
    );
    expect(state.holding).toBe("unrecognized-transition");
  });

  it("carries the reason the wire sent, so the operator has something to paste", () => {
    const state = projectTerminalLease(grantedThenUnread, {
      terminalId: SHELL_ID,
      thisDeviceId: THIS_DEVICE_ID,
    });
    expect(state.unreadTransition?.reason).toBe("auto_released_quota_exhausted");
  });

  it("reads a `released` as unread, because no device can release a shell", () => {
    // The wire has no device-initiated release: a hold ends by another take, the holder's
    // connection ending, or its run leaving the running state. A `released` after this device's
    // take is a move this build does not understand, so it must read as neither a free lease
    // nor a hold this device still has.
    const state = projectTerminalLease(
      [
        transitionEvent(1, "taken", THIS_DEVICE_ID),
        transitionEvent(2, "released", null, THIS_DEVICE_ID),
      ],
      { terminalId: SHELL_ID, thisDeviceId: THIS_DEVICE_ID },
    );
    expect(state.holding).toBe("unrecognized-transition");
    expect(state.holderDeviceId).toBeNull();
    expect(state.unreadTransition?.reason).toBe("released");
  });

  it("reports a transition with no reason at all as unread, with nothing to name", () => {
    // Unread whether the payload named a reason outside the set or none at all.
    const state = projectTerminalLease(
      [
        transitionEvent(1, "taken", THIS_DEVICE_ID),
        leaseEventWithPayload(2, { terminalId: SHELL_ID, holderDeviceId: OTHER_DEVICE_ID }),
      ],
      { terminalId: SHELL_ID, thisDeviceId: THIS_DEVICE_ID },
    );
    expect(state.holding).toBe("unrecognized-transition");
    expect(state.unreadTransition?.reason).toBeUndefined();
  });

  it("recovers on the next transition it CAN read", () => {
    const state = projectTerminalLease(
      [...grantedThenUnread, transitionEvent(3, "taken", THIS_DEVICE_ID)],
      { terminalId: SHELL_ID, thisDeviceId: THIS_DEVICE_ID },
    );
    // The state it understands is that transition's: an unread transition is not a latch.
    expect(state.unreadTransition).toBeUndefined();
    expect(state.holding).toBe("held-by-this-device");
  });

  it("stays unread when the readable transition came FIRST", () => {
    // Order is the whole claim: a readable transition before the unread one says nothing about
    // the state after it.
    const state = projectTerminalLease(
      [
        ...grantedThenUnread,
        transitionEvent(3, "taken", THIS_DEVICE_ID),
        transitionEvent(4, "seized", OTHER_DEVICE_ID),
      ],
      { terminalId: SHELL_ID, thisDeviceId: THIS_DEVICE_ID },
    );
    expect(state.holding).toBe("unrecognized-transition");
    expect(state.unreadTransition?.reason).toBe("seized");
  });
});

// The contract refuses a holder shape that contradicts its reason; the fold owes that the
// refusal reads as ignorance rather than as a confident state.
describe("a holder shape that contradicts its reason is unread, not normalized", () => {
  it("refuses a release that names this device, rather than reading it as its hold", () => {
    const state = projectTerminalLease(
      [transitionEvent(1, "auto_released_run_idle", THIS_DEVICE_ID, THIS_DEVICE_ID)],
      { terminalId: SHELL_ID, thisDeviceId: THIS_DEVICE_ID },
    );
    // The one reading that opens stdin for somebody the daemon just took the shell from.
    expect(state.holding).toBe("unrecognized-transition");
    expect(state.holderDeviceId).toBeNull();
  });

  it("negative control: both well-formed directions still read", () => {
    // Without this the case above would pass against a fold that called every transition
    // unreadable.
    const takenByOther = projectTerminalLease([transitionEvent(1, "taken", OTHER_DEVICE_ID)], {
      terminalId: SHELL_ID,
      thisDeviceId: THIS_DEVICE_ID,
    });
    expect(takenByOther.holding).toBe("held-by-another-device");
    const releasedByOther = projectTerminalLease(
      [
        transitionEvent(1, "taken", OTHER_DEVICE_ID),
        transitionEvent(2, "auto_released_disconnect", null, OTHER_DEVICE_ID),
      ],
      { terminalId: SHELL_ID, thisDeviceId: THIS_DEVICE_ID },
    );
    expect(releasedByOther.holding).toBe("unheld");
  });
});
