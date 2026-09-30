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
  OTHER_DEVICE_ID,
  SHELL_ID,
  THIS_DEVICE_ID,
  leaseEventWithPayload,
  transitionEvent,
} from "./lease-model.test-support.js";

describe("an unread transition — ignorance about a write lease is not the old holder", () => {
  /**
   * The take that granted this device the lease, followed by a move this build
   * cannot read. This is the shape the lease line has to get right: the console saw
   * itself take the shell, and then saw the daemon do something to it.
   */
  const grantedThenUnread = [
    transitionEvent(1, "taken", THIS_DEVICE_ID),
    transitionEvent(2, "auto_released_quota_exhausted", null, THIS_DEVICE_ID),
  ];

  it("stops reporting this device as the holder the moment a transition cannot be read", () => {
    const state = projectTerminalLease(grantedThenUnread, {
      terminalId: SHELL_ID,
      thisDeviceId: THIS_DEVICE_ID,
    });
    // The one reading that would keep stdin open for somebody who no longer holds
    // the shell. `TerminalPane` opens the write gate on exactly this value.
    expect(state.holding).not.toBe("held-by-this-device");
    expect(state.holding).toBe("unrecognized-transition");
    expect(state.holderDeviceId).toBeNull();
  });

  it("negative control: the same grant WITHOUT the unread move does hold", () => {
    // Without this the case above would pass against a fold that never reported
    // `held-by-this-device` at all, which is a different bug and not a fix.
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
    // A hold ends only when another device takes the shell or the holding connection
    // ends, so the wire has no release to report. A `released` after this device's
    // take is a move this build does not understand, and it must not read as a free
    // lease this device may take back or as a hold it still has.
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
    // A `pty.control_changed` this build cannot read is unread whether the payload
    // named something outside the set or named nothing — both are the daemon moving
    // the lease somewhere this console cannot follow.
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
    // The console understands the current state again, and the state it understands
    // is that transition's — an unread transition is not a latch.
    expect(state.unreadTransition).toBeUndefined();
    expect(state.holding).toBe("held-by-this-device");
  });

  it("stays unread when the readable transition came FIRST", () => {
    // Order is the whole claim: a readable transition before the unread one says
    // nothing about the state after it.
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

// A holder shape that contradicts its reason is refused by the contract the reader
// parses through; what the fold owes is that the refusal reads as ignorance rather than
// as a confident state. A release that named this device used to read as its own hold
// and opened stdin against a shell the daemon had already taken back.
describe("a holder shape that contradicts its reason is unread, not normalized", () => {
  it("refuses a release that names this device, rather than reading it as its hold", () => {
    const state = projectTerminalLease(
      [transitionEvent(1, "auto_released_run_idle", THIS_DEVICE_ID, THIS_DEVICE_ID)],
      { terminalId: SHELL_ID, thisDeviceId: THIS_DEVICE_ID },
    );
    // The one reading that opens stdin for somebody the daemon has just taken the
    // shell from, and leaves them typing until the writes are rejected.
    expect(state.holding).toBe("unrecognized-transition");
    expect(state.holderDeviceId).toBeNull();
  });

  it("negative control: both well-formed directions still read", () => {
    // Without this the case above would pass against a fold that called every
    // transition unreadable, which is a lease line that never says anything.
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
