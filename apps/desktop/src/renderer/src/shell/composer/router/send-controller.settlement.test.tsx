// A send that settles after the composer has been re-addressed, and a success that
// lands beside another operation's refusal.
//
// The hook-level half of the settlement-identity rules `send-settlement.test.ts`
// states over literals. These drive the real hook over a real `DraftStore` and a
// bridge whose calls settle when the case says so, because the defect is about
// TIMING — a call in flight across a re-address — and no literal can express that.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ParkedDaemonCalls } from "../parked-daemon-calls.test-support.js";
import type { ConsoleBridge } from "../../../console/bridge/index.js";
import { DraftStore } from "../../../console/persistence/index.js";
import type {
  ComposerChannelTarget,
  ComposerRunTarget,
  ComposerTarget,
} from "../chips/chip-models.js";
import type { SendController } from "./send-controller-contract.js";
import { useSendController } from "./send-controller.js";
import { QUEUE_CREATED, SESSION_ID } from "./send-router.test-support.js";

const CHANNEL_A = "1b2c3d4e-5f60-4172-8384-ab5c6d7e8f90";
const CHANNEL_B = "2c3d4e5f-6071-4283-8495-bc6d7e8f9012";
/** `RunIdSchema` is a branded UUID and the stop path parses the run before it calls. */
const RUN_ID = "b3f0a1c2-4d5e-4f60-8a71-9c2d3e4f5061";
const AGENT_A = "agent-alpha";
const AGENT_B = "agent-beta";

const QUEUE_FULL_CODE = "queue.full";
const QUEUE_FULL_MESSAGE = "That channel's queue is full.";

function channelTarget(channelId: string): ComposerChannelTarget {
  return {
    path: "channel-message",
    sessionId: SESSION_ID,
    channelId,
    workspaceId: undefined,
    channelLabel: undefined,
  };
}

/**
 * The other send path, addressed to an agent.
 *
 * Stop is only reachable here: a channel-addressed Stop refuses without a wire call,
 * so a Stop that is still TRAVELLING — which is what the re-address cases are about
 * — cannot be produced on the channel path at all.
 */
function runTarget(agentId: string): ComposerRunTarget {
  return {
    path: "provider-bound",
    sessionId: SESSION_ID,
    agentId,
    agentName: undefined,
    driverName: undefined,
    targetRunId: RUN_ID,
    expectedRunVersion: 4,
    runState: undefined,
    providerFailureDetail: undefined,
  };
}

/** Reports the controller out of the tree at whichever address the case supplies. */
function AddressableProbe(props: {
  readonly bridge: ConsoleBridge;
  readonly draftStore: DraftStore;
  readonly target: ComposerTarget;
  readonly onController: (controller: SendController) => void;
}): null {
  const controller = useSendController({
    bridge: props.bridge,
    target: props.target,
    draftStore: props.draftStore,
  });
  props.onController(controller);
  return null;
}

interface DrivenComposer {
  readonly calls: ParkedDaemonCalls;
  latest(): SendController;
  /** Type a body, start its send, and hand back the promise unawaited. */
  beginSend(body: string): Promise<void>;
  /** Dispatch one exact body without touching the line — the resend offer's path. */
  beginResend(body: string): Promise<void>;
  /** Press Stop and hand back the promise unawaited, so the case owns the interval. */
  beginStop(): Promise<void>;
  reAddressTo(addressId: string): void;
}

/**
 * Mount one composer at an address the case names, and let it be re-addressed.
 *
 * The address axis is a parameter because both send paths have one and the rules
 * under test are about the axis rather than about either path: a channel-addressed
 * composer is re-addressed by its channel, an agent-addressed one by its agent, and
 * `composerDraftKey` reads both as the same kind of move.
 */
function driveAddressableComposer(
  targetAt: (addressId: string) => ComposerTarget = channelTarget,
  initialAddressId: string = CHANNEL_A,
): DrivenComposer {
  const calls = new ParkedDaemonCalls();
  const draftStore = new DraftStore({ restartNoticePending: false });
  let latest: SendController | undefined;
  const renderAt = (addressId: string): React.JSX.Element => (
    <AddressableProbe
      bridge={calls.bridge}
      draftStore={draftStore}
      target={targetAt(addressId)}
      onController={(controller) => {
        latest = controller;
      }}
    />
  );
  const view = render(renderAt(initialAddressId));
  const latestController = (): SendController => {
    if (latest === undefined) {
      throw new Error("the probe reported no controller");
    }
    return latest;
  };
  // Started inside `act` so the synchronous half of the dispatch — the latch and the
  // sending status — lands under React's own batching, and returned unawaited so the
  // case decides when the daemon answers.
  const begin = (start: () => Promise<void>): Promise<void> => {
    let pending: Promise<void> | undefined;
    act(() => {
      pending = start();
    });
    if (pending === undefined) {
      throw new Error("the dispatch never started");
    }
    return pending;
  };
  return {
    calls,
    latest: latestController,
    beginSend: (body: string) => {
      act(() => {
        latestController().changeText(body);
      });
      return begin(() => latestController().send());
    },
    beginResend: (body: string) => begin(() => latestController().resend(body)),
    beginStop: () => begin(() => latestController().stop()),
    reAddressTo: (addressId: string) => {
      act(() => {
        view.rerender(renderAt(addressId));
      });
    },
  };
}

describe("useSendController — a settlement is keyed to the address it was sent under", () => {
  it("never renders a refusal for one target under the target the composer moved to", async () => {
    // The finding: a send to channel A awaiting the daemon while the person
    // re-addresses to channel B. The refusal that comes back is a verdict on a
    // message B never carried.
    const driven = driveAddressableComposer();
    const pending = driven.beginSend("ship it");
    driven.reAddressTo(CHANNEL_B);

    await act(async () => {
      driven.calls.refuseOldest(QUEUE_FULL_CODE, QUEUE_FULL_MESSAGE);
      await pending;
    });

    expect(driven.latest().refusal).toBeUndefined();
  });

  it("negative control: the same refusal renders when the composer stayed put", async () => {
    // Without this the case above would hold over a controller that had simply
    // stopped rendering refusals at all.
    const driven = driveAddressableComposer();
    const pending = driven.beginSend("ship it");

    await act(async () => {
      driven.calls.refuseOldest(QUEUE_FULL_CODE, QUEUE_FULL_MESSAGE);
      await pending;
    });

    expect(driven.latest().refusal?.code).toBe(QUEUE_FULL_CODE);
  });

  it("does not resurrect a discarded settlement when the composer returns to its address", async () => {
    // A refusal that reappears later, attached to nothing the person just did, is a
    // worse answer than no refusal at all — so a discarded settlement is dropped
    // where it lands rather than parked for a later render to find. The line it was
    // written on is still there, because a refused send keeps its text.
    const driven = driveAddressableComposer();
    const pending = driven.beginSend("ship it");
    driven.reAddressTo(CHANNEL_B);

    await act(async () => {
      driven.calls.refuseOldest(QUEUE_FULL_CODE, QUEUE_FULL_MESSAGE);
      await pending;
    });
    driven.reAddressTo(CHANNEL_A);

    expect(driven.latest().refusal).toBeUndefined();
    expect(driven.latest().text).toBe("ship it");
  });

  it("frees Send on a return visit whose earlier call has not settled", async () => {
    // The only ordering in which the latch and the status disagree, and the one the
    // suite stopped one step short of: A → B → A with A's first call STILL PARKED.
    // The holder re-seeds on the return, so the bar renders `idle` and the line is
    // writable; a latch keyed on the draft key alone still held A's slot, so the
    // second press claimed nothing, returned, and did nothing at all — no send, no
    // refusal, no status change, no chip.
    const driven = driveAddressableComposer();
    const firstSend = driven.beginSend("ship it");
    expect(driven.calls.parkedCount).toBe(1);

    driven.reAddressTo(CHANNEL_B);
    driven.reAddressTo(CHANNEL_A);
    expect(driven.latest().status).toBe("idle");

    const secondSend = driven.beginSend("actually, hold on");
    expect(driven.calls.parkedCount).toBe(2);

    // And the first visit's settlement does not reach across into the second's line.
    // The draft store is keyed by ADDRESS, so the captured key names a draft with
    // the same name and different text; an unconditional clear erased the words the
    // person had just typed, with nothing rendered to say why.
    await act(async () => {
      driven.calls.refuseOldest(QUEUE_FULL_CODE, QUEUE_FULL_MESSAGE);
      await firstSend;
    });

    expect(driven.latest().text).toBe("actually, hold on");
    expect(driven.latest().refusal).toBeUndefined();

    await act(async () => {
      driven.calls.refuseOldest(QUEUE_FULL_CODE, QUEUE_FULL_MESSAGE);
      await secondSend;
    });

    // The second visit's own settlement IS current and does render.
    expect(driven.latest().refusal?.code).toBe(QUEUE_FULL_CODE);
  });
});

describe("useSendController — one operation's settlement never erases another's", () => {
  it("keeps a Stop's refusal standing when a send succeeds beside it", async () => {
    // The shared slot's other half. This composer addresses a channel, so Stop
    // refuses without reaching the wire — a real settlement of the stop operation —
    // and the send that follows it succeeds. Under one slot the success cleared the
    // Stop's refusal; under one slot per operation it clears its own and no other.
    //
    // The send travels the RESEND path deliberately: typing would clear every slot
    // by the edit rule, which is a different clearing from the one under test.
    const driven = driveAddressableComposer();
    await act(async () => {
      await driven.latest().stop();
    });
    expect(driven.latest().refusal?.code).toBe("no-running-turn");

    const pending = driven.beginResend("ship it");
    await act(async () => {
      driven.calls.resolveOldest(QUEUE_CREATED);
      await pending;
    });

    expect(driven.latest().refusal?.code).toBe("no-running-turn");
  });

  it("negative control: an edit clears every slot, including the Stop's", () => {
    // The rule the case above must not be read as contradicting: a person composing
    // again has moved past both acts, so the next keystroke clears the record.
    const driven = driveAddressableComposer();
    act(() => {
      void driven.latest().stop();
    });
    act(() => {
      driven.latest().changeText("a");
    });

    expect(driven.latest().refusal).toBeUndefined();
  });
});

describe("useSendController — an operation's busy state belongs to the address it was issued at", () => {
  it("leaves the next address idle while a send for the previous one is still going", async () => {
    // The finding: the sending status and the single-flight latch were hook-wide, so
    // a message still travelling to one channel left the composer read-only for the
    // channel the person had moved to — until the first call settled, and forever
    // where it never did.
    const driven = driveAddressableComposer();
    const pending = driven.beginSend("ship it");
    expect(driven.calls.parkedCount).toBe(1);

    driven.reAddressTo(CHANNEL_B);

    expect(driven.latest().status).toBe("idle");
    await act(async () => {
      driven.calls.resolveOldest({});
      await pending;
    });
  });

  it("negative control: the address that issued the send is the one that reads sending", async () => {
    // Without this, a controller that had simply stopped reporting `sending` at all
    // would pass the case above while never locking the line it should.
    const driven = driveAddressableComposer();
    const pending = driven.beginSend("ship it");

    expect(driven.latest().status).toBe("sending");
    await act(async () => {
      driven.calls.resolveOldest({});
      await pending;
    });
  });

  it("still latches the address the composer is on, so one press sends once", async () => {
    // The rule the keying must not be read as relaxing: two presses at ONE address
    // inside one tick are still one send.
    const driven = driveAddressableComposer();
    driven.reAddressTo(CHANNEL_B);
    const pending = driven.beginSend("ship it");
    const second = driven.latest().send();

    expect(driven.calls.parkedCount).toBe(1);
    await act(async () => {
      driven.calls.resolveOldest({});
      await Promise.all([pending, second]);
    });
  });

  it("frees the slot of the address a late settlement belongs to, and no other", async () => {
    // The disposition for the settlement itself: it releases the address it was
    // issued at, so returning there finds a composer that can send again rather than
    // one wedged by its own answered call.
    const driven = driveAddressableComposer();
    const pending = driven.beginSend("ship it");
    driven.reAddressTo(CHANNEL_B);
    await act(async () => {
      driven.calls.resolveOldest({});
      await pending;
    });

    expect(driven.latest().status).toBe("idle");
    driven.reAddressTo(CHANNEL_A);
    const resumed = driven.beginSend("ship it again");

    expect(driven.calls.parkedCount).toBe(1);
    await act(async () => {
      driven.calls.resolveOldest({});
      await resumed;
    });
  });

  it("leaves the next agent's Stop available while the previous agent's is going", async () => {
    // Stop's own half of the same finding, on the path where a Stop reaches the
    // wire at all. An interrupt still travelling for one agent marked the control
    // busy for the agent the composer had moved to.
    const driven = driveAddressableComposer(runTarget, AGENT_A);
    const pending = driven.beginStop();
    expect(driven.calls.parkedCount).toBe(1);

    driven.reAddressTo(AGENT_B);

    expect(driven.latest().isStopping).toBe(false);
    await act(async () => {
      driven.calls.resolveOldest({});
      await pending;
    });
  });

  it("negative control: the agent whose Stop is travelling reads stopping", async () => {
    const driven = driveAddressableComposer(runTarget, AGENT_A);
    const pending = driven.beginStop();

    expect(driven.latest().isStopping).toBe(true);
    await act(async () => {
      driven.calls.resolveOldest({});
      await pending;
    });
  });
});
