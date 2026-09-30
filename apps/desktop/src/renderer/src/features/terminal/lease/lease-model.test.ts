// The lease fold's ordinary answers for a well-formed log. The arms where the fold refuses to
// answer are in `lease-model.unreadable.test.ts`; reading one event is `lease-transition.test.ts`.

import { describe, expect, it } from "vitest";

import { TERMINAL_LEASE_SCENARIO } from "../../../../../../fixtures/scenarios/terminal-lease.js";
import { UNREAD_TERMINAL_LEASE, projectTerminalLease } from "./lease-model.js";
import {
  COMMAND_ID,
  OTHER_DEVICE_ID,
  OTHER_SHELL_ID,
  RUN_ID,
  SHELL_ID,
  THIS_DEVICE_ID,
  transitionEvent,
} from "./lease-model.test-support.js";

describe("the lease fold — what the wire said, and only that", () => {
  it("reads nothing as `not-checked`, which is not the free lease", () => {
    const state = projectTerminalLease([], { terminalId: SHELL_ID, thisDeviceId: THIS_DEVICE_ID });
    expect(state).toStrictEqual(UNREAD_TERMINAL_LEASE);
    // Unread and free are different facts: collapsing them would offer a take against a shell
    // never asked about as though it were known to be free.
    expect(state.holding).not.toBe("unheld");
  });

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

  it("renders a null holder as the free lease, explicitly", () => {
    const state = projectTerminalLease(
      [
        transitionEvent(1, "taken", OTHER_DEVICE_ID),
        transitionEvent(2, "auto_released_disconnect", null, OTHER_DEVICE_ID),
      ],
      { terminalId: SHELL_ID, thisDeviceId: THIS_DEVICE_ID },
    );
    expect(state.holding).toBe("unheld");
    expect(state.holderDeviceId).toBeNull();
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

  it("negative control: a fold that echoed the payload would pass every case above", () => {
    // It would not pass this one: a payload naming a holder is not a holder when its reason is
    // not one the console understands.
    const state = projectTerminalLease([transitionEvent(1, "seized", OTHER_DEVICE_ID)], {
      terminalId: SHELL_ID,
      thisDeviceId: THIS_DEVICE_ID,
    });
    expect(state.holderDeviceId).toBeNull();
    expect(state.holding).toBe("unrecognized-transition");
  });
});
