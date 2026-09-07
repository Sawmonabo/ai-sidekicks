// The first send into a session this console started, and what it does to the list.
//
// `Spec-023 §Console Design (Meridian)` §All-sessions list makes auto-pin on first
// send a setting, and until this wire existed the switch changed its own persisted
// value and nothing else: `autoPinDecision` had two readers, the explanatory
// sentences beside the switch and its own suite, and no send path consulted either.
// A person could turn the switch on, start a session, send into it, and watch the row
// stay exactly where it was.
//
// These cases drive the real hook over a real bridge, because the claim is about the
// SETTLED arm of a send: an intercepted command, a refusal, and a call still in
// flight must each leave the pin map alone, and none of that is observable from the
// port's own suite next door.

import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MAXIMUM_LIVE_DRAFT_COUNT } from "../../../console/core/index.js";
import { DraftStore } from "../../../console/persistence/index.js";
import type { ConsoleBridge } from "../../../console/bridge/index.js";
import { recordConsoleStartedSession } from "../../../console/seats/index.js";
import type { SessionOriginEvidence } from "../../../console/seats/index.js";
// Deep rather than through the door: the reading is the port's own record, its only
// readers are the two suites that drive it, and a door line no production module
// takes is a dead export the barrel census fails.
import {
  firstSendAutoPinSettlement,
  type AutoPinSettlement,
} from "../../../console/seats/session-auto-pin.js";
import type { SendController } from "./send-controller-contract.js";
import { useSendController } from "./send-controller.js";
import {
  CHANNEL_TARGET,
  QUEUE_CREATED,
  SESSION_ID,
  bridgeRecording,
  type DaemonCallMock,
} from "./send-router.test-support.js";

/** A session this window started: every marker known, none of them an exclusion. */
const STARTED_HERE: SessionOriginEvidence = {
  isDraftPlaceholder: true,
  arrivedByImport: false,
  openedForChildWork: false,
  startedByWorkflow: false,
};

interface RecordingAuthority {
  readonly pinned: string[];
  readonly readAutoPinOnFirstSend: () => boolean;
  readonly pinToFront: (sessionId: string) => void;
}

/** The durable half of the rule, recorded rather than performed. */
function recordingAuthority(isEnabled: boolean): RecordingAuthority {
  const pinned: string[] = [];
  return {
    pinned,
    readAutoPinOnFirstSend: () => isEnabled,
    pinToFront: (sessionId: string) => {
      pinned.push(sessionId);
    },
  };
}

/** Reports the controller out of the tree, so a case drives the real hook. */
function ControllerProbe(props: {
  readonly bridge: ConsoleBridge;
  readonly draftStore: DraftStore;
  readonly onController: (controller: SendController) => void;
}): null {
  const controller = useSendController({
    bridge: props.bridge,
    target: CHANNEL_TARGET,
    draftStore: props.draftStore,
  });
  props.onController(controller);
  return null;
}

interface DrivenComposer {
  readonly bridge: ConsoleBridge;
  send(body: string): Promise<void>;
  settlementFor(sessionId: string): AutoPinSettlement | undefined;
}

/**
 * A composer addressed at one session, over a bridge answering as the case says.
 *
 * A fresh bridge per case, which is what keeps the cases independent: the port's
 * record is keyed on the bridge, so two cases sharing one would share a ledger and
 * the second would settle as a repeat of the first.
 */
function driveComposer(
  call: DaemonCallMock = vi.fn().mockResolvedValue(QUEUE_CREATED),
): DrivenComposer {
  const bridge = bridgeRecording(call);
  const draftStore = new DraftStore({
    maximumDraftCount: MAXIMUM_LIVE_DRAFT_COUNT,
    restartNoticePending: false,
  });
  let latest: SendController | undefined;
  render(
    <ControllerProbe
      bridge={bridge}
      draftStore={draftStore}
      onController={(controller) => {
        latest = controller;
      }}
    />,
  );
  const controller = (): SendController => {
    if (latest === undefined) {
      throw new Error("the probe reported no controller");
    }
    return latest;
  };
  return {
    bridge,
    send: async (body: string) => {
      act(() => {
        controller().changeText(body);
      });
      await act(async () => {
        await controller().send();
      });
    },
    settlementFor: (sessionId: string) => firstSendAutoPinSettlement(bridge, sessionId),
  };
}

describe("useSendController — the first send settles the auto-pin rule", () => {
  it("pins a console-started session the first time a message lands in it", async () => {
    const driven = driveComposer();
    const authority = recordingAuthority(true);
    recordConsoleStartedSession({
      bridge: driven.bridge,
      sessionId: SESSION_ID,
      origin: STARTED_HERE,
      authority,
    });

    await driven.send("the first thing I said");

    expect(authority.pinned).toStrictEqual([SESSION_ID]);
    expect(driven.settlementFor(SESSION_ID)).toStrictEqual({ pinned: true });
  });

  it("pins nothing on the second send", async () => {
    // Auto-pin is a rule about a session's FIRST message, and a person who moved the
    // row back to the rear tier themselves has made a decision the next message must
    // not overwrite.
    const driven = driveComposer();
    const authority = recordingAuthority(true);
    recordConsoleStartedSession({
      bridge: driven.bridge,
      sessionId: SESSION_ID,
      origin: STARTED_HERE,
      authority,
    });

    await driven.send("the first thing I said");
    await driven.send("and the second");

    expect(authority.pinned).toStrictEqual([SESSION_ID]);
  });

  it("pins nothing while the switch is off, and records the switch as the reason", async () => {
    const driven = driveComposer();
    const authority = recordingAuthority(false);
    recordConsoleStartedSession({
      bridge: driven.bridge,
      sessionId: SESSION_ID,
      origin: STARTED_HERE,
      authority,
    });

    await driven.send("the first thing I said");

    expect(authority.pinned).toStrictEqual([]);
    expect(driven.settlementFor(SESSION_ID)).toStrictEqual({
      pinned: false,
      because: "setting-off",
    });
  });

  it("declines to guess for a session nothing reports an origin for", async () => {
    // Every session that reaches the composer from the node's directory read:
    // `GrowthSessionSummary` carries an id, a title and a state and no origin at all,
    // so the rule's fail-closed arm is the answer and no pin is written.
    const driven = driveComposer();

    await driven.send("the first thing I said");

    // Nothing was recorded, which is the second half of the claim: the ledger stays
    // proportional to the start presses a person made rather than to every session
    // they ever sent into.
    expect(driven.settlementFor(SESSION_ID)).toBeUndefined();
  });

  it("leaves the rule alone for a send the node refused", async () => {
    // The negative control for the ARM the consult sits in. A message that did not
    // land is not a first send, so a refusal must reach the rule through no path —
    // otherwise a failed send would pin a session nobody got a word into, and the
    // person's next attempt would settle as a repeat of a send that never happened.
    const driven = driveComposer(vi.fn().mockRejectedValue(new Error("the node refused")));
    const authority = recordingAuthority(true);
    recordConsoleStartedSession({
      bridge: driven.bridge,
      sessionId: SESSION_ID,
      origin: STARTED_HERE,
      authority,
    });

    await driven.send("the first thing I said");

    expect(authority.pinned).toStrictEqual([]);
    expect(driven.settlementFor(SESSION_ID)).toBeUndefined();
  });
});
