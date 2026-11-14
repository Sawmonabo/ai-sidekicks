// The lease fold, which the pane's write gate opens on: the holder is the newest reading's by lease
// version, the shell list's or a transition's, and a device's hold read before this device's id is
// known reads `not-checked` rather than a free shell, so stdin is never left open on a guess.

import { describe, expect, it } from "vitest";
import { canTypeIntoShell, projectTerminalLease, TERMINAL_LEASE_HOLDERS } from "./state.js";
import {
  COMMAND_ID,
  OTHER_DEVICE_ID,
  OTHER_SHELL_ID,
  RUN_ID,
  SHELL_ID,
  THIS_DEVICE_ID,
  transitionEvent,
} from "./state.test-support.js";

describe("the lease fold — what the wire said, and only that", () => {
  it("reads a run's release that hands the shell back as the hold of the device it names", () => {
    const events = [
      transitionEvent(1, "taken", THIS_DEVICE_ID),
      transitionEvent(2, "taken", THIS_DEVICE_ID, THIS_DEVICE_ID, {
        holderRunId: RUN_ID,
        holderCommandId: COMMAND_ID,
      }),
      transitionEvent(3, "autoReleasedCommandEnded", THIS_DEVICE_ID, THIS_DEVICE_ID),
    ];
    expect(
      projectTerminalLease(events, { terminalId: SHELL_ID, thisDeviceId: THIS_DEVICE_ID }).holder,
    ).toBe("held-by-this-device");
    expect(
      projectTerminalLease(events, { terminalId: SHELL_ID, thisDeviceId: OTHER_DEVICE_ID }).holder,
    ).toBe("held-by-another-device");
  });

  it("lets this device type only while it holds the shell or nobody does", () => {
    expect(TERMINAL_LEASE_HOLDERS.filter((holder) => canTypeIntoShell(holder))).toEqual([
      "unheld",
      "held-by-this-device",
    ]);
  });

  it("takes the holder from the newest transition's own payload", () => {
    const state = projectTerminalLease(
      [
        transitionEvent(1, "taken", OTHER_DEVICE_ID),
        transitionEvent(2, "autoReleasedDisconnect", null, OTHER_DEVICE_ID),
        transitionEvent(3, "taken", THIS_DEVICE_ID),
      ],
      { terminalId: SHELL_ID, thisDeviceId: THIS_DEVICE_ID },
    );
    expect(state.holder).toBe("held-by-this-device");
    expect(state.holderDeviceId).toBe(THIS_DEVICE_ID);
  });

  it("keeps whichever of the listed holder and a transition is newer by lease version", () => {
    const listedLease = { holder: { holderDeviceId: THIS_DEVICE_ID }, leaseVersion: 5 };
    // The log delivers an older change after the list was read: the list's newer holder stands.
    const olderAfterList = [
      transitionEvent(9, "taken", OTHER_DEVICE_ID, null, { leaseVersion: 4 }),
    ];
    expect(
      projectTerminalLease(olderAfterList, {
        terminalId: SHELL_ID,
        thisDeviceId: THIS_DEVICE_ID,
        listedLease,
      }).holder,
    ).toBe("held-by-this-device");
    // A newer change replaces it, and a free listing at a newer version frees the shell.
    const newer = [
      transitionEvent(10, "takenByForce", OTHER_DEVICE_ID, THIS_DEVICE_ID, { leaseVersion: 6 }),
    ];
    expect(
      projectTerminalLease(newer, {
        terminalId: SHELL_ID,
        thisDeviceId: THIS_DEVICE_ID,
        listedLease,
      }).holder,
    ).toBe("held-by-another-device");
    expect(
      projectTerminalLease(newer, {
        terminalId: SHELL_ID,
        thisDeviceId: THIS_DEVICE_ID,
        listedLease: { holder: null, leaseVersion: 7 },
      }).holder,
    ).toBe("unheld");
  });

  it("tells this device's hold apart from another device's", () => {
    const events = [transitionEvent(1, "taken", OTHER_DEVICE_ID)];
    expect(
      projectTerminalLease(events, { terminalId: SHELL_ID, thisDeviceId: THIS_DEVICE_ID }).holder,
    ).toBe("held-by-another-device");
    expect(
      projectTerminalLease(events, { terminalId: SHELL_ID, thisDeviceId: OTHER_DEVICE_ID }).holder,
    ).toBe("held-by-this-device");
    // Before this device's id is known a device's hold is unread: no live body, and no
    // `Take the shell` offered against a hold that may be this device's own.
    expect(
      projectTerminalLease(events, { terminalId: SHELL_ID, thisDeviceId: undefined }).holder,
    ).toBe("not-checked");
    // A run's hold and a free shell need no device id, so they read as they are.
    const runHold = [
      transitionEvent(1, "taken", OTHER_DEVICE_ID, null, {
        holderRunId: RUN_ID,
        holderCommandId: COMMAND_ID,
      }),
    ];
    expect(
      projectTerminalLease(runHold, { terminalId: SHELL_ID, thisDeviceId: undefined }).holder,
    ).toBe("held-by-run");
    expect(
      projectTerminalLease([], {
        terminalId: SHELL_ID,
        thisDeviceId: undefined,
        listedLease: { holder: null, leaseVersion: 3 },
      }).holder,
    ).toBe("unheld");
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
    expect(state.holder).toBe("held-by-run");
    expect(state.holderRunId).toBe(RUN_ID);
    expect(state.holderCommandId).toBe(COMMAND_ID);
  });

  it("folds each shell apart: a move on another shell leaves this one where it was", () => {
    const events = [
      transitionEvent(1, "taken", THIS_DEVICE_ID),
      transitionEvent(2, "taken", OTHER_DEVICE_ID, null, { terminalId: OTHER_SHELL_ID }),
    ];
    expect(
      projectTerminalLease(events, { terminalId: SHELL_ID, thisDeviceId: THIS_DEVICE_ID }).holder,
    ).toBe("held-by-this-device");
    // Negative control: the other shell reads its own move.
    expect(
      projectTerminalLease(events, { terminalId: OTHER_SHELL_ID, thisDeviceId: THIS_DEVICE_ID })
        .holder,
    ).toBe("held-by-another-device");
  });
});
