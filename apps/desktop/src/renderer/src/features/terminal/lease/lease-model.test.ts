// The lease fold, which the pane's write gate opens on: the holder is the newest readable
// transition's, and every arm it cannot read leaves nobody holding the shell rather than the
// holder before it, so stdin is never left open on a guess.

import { describe, expect, it } from "vitest";
import { TERMINAL_LEASE_SCENARIO } from "../../../../../../fixtures/scenarios/terminal-lease.js";
import { projectTerminalLease } from "./lease-model.js";
import {
  COMMAND_ID,
  OTHER_DEVICE_ID,
  OTHER_SHELL_ID,
  RUN_ID,
  SHELL_ID,
  THIS_DEVICE_ID,
  leaseEventWithPayload,
  transitionEvent,
} from "./lease-model.test-support.js";

describe("the lease fold — what the wire said, and only that", () => {
  it("takes the holder from the newest transition's own payload", () => {
    const state = projectTerminalLease(
      [
        transitionEvent(1, "taken", OTHER_DEVICE_ID),
        transitionEvent(2, "auto_released_disconnect", null, OTHER_DEVICE_ID),
        transitionEvent(3, "taken", THIS_DEVICE_ID),
      ],
      { terminalId: SHELL_ID, thisDeviceId: THIS_DEVICE_ID },
    );
    expect(state.holding).toBe("held-by-this-device");
    expect(state.holderDeviceId).toBe(THIS_DEVICE_ID);
  });

  it("tells this device's hold apart from another device's", () => {
    const events = [transitionEvent(1, "taken", OTHER_DEVICE_ID)];
    expect(
      projectTerminalLease(events, { terminalId: SHELL_ID, thisDeviceId: THIS_DEVICE_ID }).holding,
    ).toBe("held-by-another-device");
    expect(
      projectTerminalLease(events, { terminalId: SHELL_ID, thisDeviceId: OTHER_DEVICE_ID }).holding,
    ).toBe("held-by-this-device");
    // No device read at all fails closed: nobody is told they may type on an unknown identity.
    expect(
      projectTerminalLease(events, { terminalId: SHELL_ID, thisDeviceId: undefined }).holding,
    ).toBe("held-by-another-device");
  });

  it("reads a run's hold as the run's, even where the run's machine is this device", () => {
    // The run's machine is the holding device; a device comparison alone would read this as
    // `held-by-this-device` and open stdin to a person while the run writes.
    const state = projectTerminalLease(
      [
        transitionEvent(1, "taken", THIS_DEVICE_ID, null, {
          holderRunId: RUN_ID,
          holderCommandId: COMMAND_ID,
        }),
      ],
      { terminalId: SHELL_ID, thisDeviceId: THIS_DEVICE_ID },
    );
    expect(state.holding).toBe("held-by-run");
    expect(state.holderRunId).toBe(RUN_ID);
    expect(state.holderCommandId).toBe(COMMAND_ID);
  });

  it("folds each shell apart: a move on another shell leaves this one where it was", () => {
    const events = [
      transitionEvent(1, "taken", THIS_DEVICE_ID),
      transitionEvent(2, "taken", OTHER_DEVICE_ID, null, { terminalId: OTHER_SHELL_ID }),
      transitionEvent(3, "seized", OTHER_DEVICE_ID, null, { terminalId: OTHER_SHELL_ID }),
    ];
    expect(
      projectTerminalLease(events, { terminalId: SHELL_ID, thisDeviceId: THIS_DEVICE_ID }).holding,
    ).toBe("held-by-this-device");
    // Negative control: the other shell reads its own moves, the unreadable one included.
    expect(
      projectTerminalLease(events, { terminalId: OTHER_SHELL_ID, thisDeviceId: THIS_DEVICE_ID })
        .holding,
    ).toBe("unrecognized-transition");
  });

  it("ignores every event that is not a lease transition", () => {
    const state = projectTerminalLease(
      [
        transitionEvent(1, "taken", OTHER_DEVICE_ID),
        {
          id: "event-2",
          sessionId: TERMINAL_LEASE_SCENARIO.sessionId,
          sequence: 2,
          kind: "session.created",
          occurredAt: "x",
        },
      ],
      { terminalId: SHELL_ID, thisDeviceId: THIS_DEVICE_ID },
    );
    // A `session.created` read as a lease event would be an unreadable transition after the
    // take, and the fold would then report no holder at all.
    expect(state.holding).toBe("held-by-another-device");
  });
});

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
});
