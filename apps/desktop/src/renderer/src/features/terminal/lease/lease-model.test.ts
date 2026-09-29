// The lease fold: what the wire said, and only that.
//
// The fold's ordinary answer — who the log's transitions leave holding the shell. The
// two arms where the fold refuses to answer are
// `lease-model.unreadable.test.ts`'s, and they are a different claim: this file is about
// what a well-formed ordering produces, that one about what an ill-formed one does NOT.
//
// The READER's own claim is `lease-transition.test.ts`'s — a payload's reason and
// holder shape agreeing is answerable with one event and no session.

import { describe, expect, it } from "vitest";

import { UNREAD_TERMINAL_LEASE, projectTerminalLease } from "./lease-model.js";
import { OTHER_DEVICE_ID, THIS_DEVICE_ID, transitionEvent } from "./lease-model.test-support.js";

describe("the lease fold — what the wire said, and only that", () => {
  it("reads nothing as `not-checked`, which is not the free lease", () => {
    const state = projectTerminalLease([], { thisDeviceId: THIS_DEVICE_ID });
    expect(state).toStrictEqual(UNREAD_TERMINAL_LEASE);
    // The whole point of the fifth state: an unread lease and a free one are two
    // different facts, and a surface that collapsed them would offer a take
    // against a shell it has never asked about as though it knew it was free.
    expect(state.holding).not.toBe("unheld");
  });

  it("takes the holder from the newest transition's own payload", () => {
    const state = projectTerminalLease(
      [
        transitionEvent(1, "taken", OTHER_DEVICE_ID),
        transitionEvent(2, "auto_released_disconnect", null, OTHER_DEVICE_ID),
        transitionEvent(3, "taken", THIS_DEVICE_ID),
      ],
      { thisDeviceId: THIS_DEVICE_ID },
    );
    expect(state.holding).toBe("held-by-this-device");
    expect(state.holderUserId).toBe(THIS_DEVICE_ID);
  });

  it("renders a null holder as the free lease, explicitly", () => {
    const state = projectTerminalLease(
      [
        transitionEvent(1, "taken", OTHER_DEVICE_ID),
        transitionEvent(2, "auto_released_disconnect", null, OTHER_DEVICE_ID),
      ],
      { thisDeviceId: THIS_DEVICE_ID },
    );
    expect(state.holding).toBe("unheld");
    expect(state.holderUserId).toBeNull();
  });

  it("tells this device's hold apart from another device's", () => {
    const events = [transitionEvent(1, "taken", OTHER_DEVICE_ID)];
    expect(projectTerminalLease(events, { thisDeviceId: THIS_DEVICE_ID }).holding).toBe(
      "held-by-another-device",
    );
    expect(projectTerminalLease(events, { thisDeviceId: OTHER_DEVICE_ID }).holding).toBe(
      "held-by-this-device",
    );
    // No device read at all is the console's state today, and it fails closed:
    // nobody is ever told they may type on the strength of an unknown identity.
    expect(projectTerminalLease(events, { thisDeviceId: undefined }).holding).toBe(
      "held-by-another-device",
    );
  });

  it("ignores every event that is not a lease transition", () => {
    const state = projectTerminalLease(
      [
        transitionEvent(1, "taken", OTHER_DEVICE_ID),
        {
          id: "event-2",
          sessionId: "session-terminal",
          sequence: 2,
          kind: "session.created",
          occurredAt: "x",
        },
      ],
      { thisDeviceId: THIS_DEVICE_ID },
    );
    // A `session.created` read as a lease event would be an unreadable transition after
    // the take, and the fold would then report no holder at all.
    expect(state.holding).toBe("held-by-another-device");
  });

  it("negative control: a fold that echoed the payload would pass every case above", () => {
    // It would not pass this one. A payload naming a holder is not a holder when
    // the reason it arrived under is not one the console understands.
    const state = projectTerminalLease([transitionEvent(1, "seized", OTHER_DEVICE_ID)], {
      thisDeviceId: THIS_DEVICE_ID,
    });
    expect(state.holderUserId).toBeNull();
    expect(state.holding).toBe("unrecognized-transition");
  });
});
