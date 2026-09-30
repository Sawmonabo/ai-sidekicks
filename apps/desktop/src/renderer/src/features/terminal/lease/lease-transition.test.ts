// Reading one `pty.control_changed` on its own terms: no device, no ordering. Which holder
// shapes each reason admits is the contract's own suite; here the reader is held to reading
// through that contract and recording what it refuses.

import { describe, expect, it } from "vitest";

import {
  readTerminalLeaseShell,
  readTerminalLeaseTransition,
  readTerminalLeaseUnreadTransition,
} from "./lease-transition.js";
import {
  COMMAND_ID,
  OTHER_DEVICE_ID,
  RUN_ID,
  SHELL_ID,
  THIS_DEVICE_ID,
  leaseEventWithPayload,
  transitionEvent,
} from "./lease-model.test-support.js";

/** Every event below sits at the same position; what varies is the payload on it. */
const READER_EVENT_SEQUENCE = 1;

describe("reading one transition — the holder is the wire's", () => {
  it("reads a take, carrying the shell and the device the payload named", () => {
    const transition = readTerminalLeaseTransition(
      transitionEvent(READER_EVENT_SEQUENCE, "taken", OTHER_DEVICE_ID, THIS_DEVICE_ID),
    );
    expect(transition).toStrictEqual({
      terminalId: SHELL_ID,
      reason: "taken",
      holderDeviceId: OTHER_DEVICE_ID,
      holderRunId: undefined,
      holderCommandId: undefined,
    });
  });

  it("reads a run's take, carrying the run and its command beside the machine's own device", () => {
    const transition = readTerminalLeaseTransition(
      transitionEvent(READER_EVENT_SEQUENCE, "taken", THIS_DEVICE_ID, null, {
        holderRunId: RUN_ID,
        holderCommandId: COMMAND_ID,
      }),
    );
    expect(transition?.holderRunId).toBe(RUN_ID);
    expect(transition?.holderCommandId).toBe(COMMAND_ID);
  });

  it("refuses a `taken` that names nobody, rather than reading it as the free lease", () => {
    // The expensive direction: a shell just handed to someone, offered as free. The refusal is
    // the contract's; this case holds that the reader goes through it.
    expect(
      readTerminalLeaseTransition(transitionEvent(READER_EVENT_SEQUENCE, "taken", null)),
    ).toBeUndefined();
  });

  it("negative control: a payload without its shell is not a transition", () => {
    const { terminalId: _terminalId, ...payload } =
      transitionEvent(READER_EVENT_SEQUENCE, "taken", OTHER_DEVICE_ID).payload ?? {};
    expect(
      readTerminalLeaseTransition(leaseEventWithPayload(READER_EVENT_SEQUENCE, payload)),
    ).toBeUndefined();
  });
});

describe("reading the transition it could NOT read", () => {
  it("carries the reason the wire sent, so the operator has something to paste", () => {
    const unread = readTerminalLeaseUnreadTransition(
      leaseEventWithPayload(READER_EVENT_SEQUENCE, { reason: "auto_released_quota_exhausted" }),
    );
    expect(unread.reason).toBe("auto_released_quota_exhausted");
  });

  it("negative control: a payload with nothing to name carries nothing", () => {
    // Without it the case above would pass against a reader that stringified whatever the
    // member held.
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

  it("reads the shell an unreadable move names, and none where it names none", () => {
    expect(
      readTerminalLeaseShell(
        leaseEventWithPayload(READER_EVENT_SEQUENCE, { terminalId: SHELL_ID, reason: "seized" }),
      ),
    ).toBe(SHELL_ID);
    expect(
      readTerminalLeaseShell(leaseEventWithPayload(READER_EVENT_SEQUENCE, { reason: "seized" })),
    ).toBeUndefined();
  });
});
