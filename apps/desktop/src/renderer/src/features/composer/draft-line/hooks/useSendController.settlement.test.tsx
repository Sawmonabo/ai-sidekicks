// A send that settles after the composer has been re-addressed.
//
// The hook-level half of the settlement-identity rules `send-settlement.test.ts`
// states over literals. These drive the real hook over a real `DraftStore` and a
// bridge whose calls settle when the case says so, because the defect is about
// TIMING — a call in flight across a re-address — and no literal can express that.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ParkedDaemonCalls } from "./parked-daemon-calls.test-support.js";
import type { ConsoleBridge } from "@renderer/console/bridge/console-bridge.js";
import type { ComposerSendCalls } from "../send-dispatch.js";
import { MAXIMUM_LIVE_DRAFT_COUNT } from "@renderer/console/core/constants/persistence-caps.js";
import { DraftStore } from "@renderer/store/draft-store.js";
import type { ComposerRunTarget } from "@renderer/shell/composer/chips/chip-models.js";
import type { SendController } from "../send-controller-contract.js";
import { useSendController } from "./useSendController.js";
import { RUN_TARGET, STEER_APPLIED } from "../send-router.test-support.js";

const SESSION_A = "1b2c3d4e-5f60-4172-8384-ab5c6d7e8f90";
const SESSION_B = "2c3d4e5f-6071-4283-8495-bc6d7e8f9012";

const REJECTION_REASON = "run_not_paused";

function sessionTarget(sessionId: string): ComposerRunTarget {
  return { ...RUN_TARGET, sessionId };
}

/** Reports the controller out of the tree at whichever address the case supplies. */
function AddressableProbe(props: {
  readonly bridge: ConsoleBridge;
  readonly calls: ComposerSendCalls;
  readonly draftStore: DraftStore;
  readonly target: ComposerRunTarget;
  readonly onController: (controller: SendController) => void;
}): null {
  const controller = useSendController({
    bridge: props.bridge,
    calls: props.calls,
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
  reAddressTo(sessionId: string): void;
}

/** Mount one composer on a session the case names, and let it be re-addressed. */
function driveAddressableComposer(initialSessionId: string = SESSION_A): DrivenComposer {
  const calls = new ParkedDaemonCalls();
  const draftStore = new DraftStore({
    maximumDraftCount: MAXIMUM_LIVE_DRAFT_COUNT,
  });
  let latest: SendController | undefined;
  const renderAt = (sessionId: string): React.JSX.Element => (
    <AddressableProbe
      bridge={calls.bridge}
      calls={calls.calls}
      draftStore={draftStore}
      target={sessionTarget(sessionId)}
      onController={(controller) => {
        latest = controller;
      }}
    />
  );
  const view = render(renderAt(initialSessionId));
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
    reAddressTo: (sessionId: string) => {
      act(() => {
        view.rerender(renderAt(sessionId));
      });
    },
  };
}

describe("useSendController — a settlement is keyed to the address it was sent under", () => {
  it("never renders a refusal for one target under the target the composer moved to", async () => {
    // The finding: a send to session A awaiting the daemon while the person
    // re-addresses to session B. The refusal that comes back is a verdict on a
    // message B never carried.
    const driven = driveAddressableComposer();
    const pending = driven.beginSend("ship it");
    driven.reAddressTo(SESSION_B);

    await act(async () => {
      driven.calls.rejectOldest(REJECTION_REASON);
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
      driven.calls.rejectOldest(REJECTION_REASON);
      await pending;
    });

    expect(driven.latest().refusal?.code).toBe(REJECTION_REASON);
    // A refused steer keeps its words, so the person can send again.
    expect(driven.latest().text).toBe("ship it");
  });

  it("does not resurrect a discarded settlement when the composer returns to its address", async () => {
    // A refusal that reappears later, attached to nothing the person just did, is a
    // worse answer than no refusal at all — so a discarded settlement is dropped
    // where it lands rather than parked for a later render to find. The line it was
    // written on is still there, because a refused steer keeps its text.
    const driven = driveAddressableComposer();
    const pending = driven.beginSend("ship it");
    driven.reAddressTo(SESSION_B);

    await act(async () => {
      driven.calls.rejectOldest(REJECTION_REASON);
      await pending;
    });
    driven.reAddressTo(SESSION_A);

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

    driven.reAddressTo(SESSION_B);
    driven.reAddressTo(SESSION_A);
    expect(driven.latest().status).toBe("idle");

    const secondSend = driven.beginSend("actually, hold on");
    expect(driven.calls.parkedCount).toBe(2);

    // And the first visit's settlement does not reach across into the second's line.
    // The draft store is keyed by ADDRESS, so the captured key names a draft with
    // the same name and different text; an unconditional clear erased the words the
    // person had just typed, with nothing rendered to say why.
    await act(async () => {
      driven.calls.rejectOldest(REJECTION_REASON);
      await firstSend;
    });

    expect(driven.latest().text).toBe("actually, hold on");
    expect(driven.latest().refusal).toBeUndefined();

    await act(async () => {
      driven.calls.rejectOldest(REJECTION_REASON);
      await secondSend;
    });

    // The second visit's own settlement IS current and does render.
    expect(driven.latest().refusal?.code).toBe(REJECTION_REASON);
  });
});

describe("useSendController — an operation's busy state belongs to the address it was issued at", () => {
  it("leaves the next address idle while a send for the previous one is still going", async () => {
    // The finding: the sending status and the single-flight latch were hook-wide, so
    // a message still travelling to one session left the composer read-only for the
    // session the person had moved to — until the first call settled, and forever
    // where it never did.
    const driven = driveAddressableComposer();
    const pending = driven.beginSend("ship it");
    expect(driven.calls.parkedCount).toBe(1);

    driven.reAddressTo(SESSION_B);

    expect(driven.latest().status).toBe("idle");
    await act(async () => {
      driven.calls.resolveOldest(STEER_APPLIED);
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
      driven.calls.resolveOldest(STEER_APPLIED);
      await pending;
    });
  });

  it("still latches the address the composer is on, so one press sends once", async () => {
    // The rule the keying must not be read as relaxing: two presses at ONE address
    // inside one tick are still one send.
    const driven = driveAddressableComposer();
    driven.reAddressTo(SESSION_B);
    const pending = driven.beginSend("ship it");
    const second = driven.latest().send();

    expect(driven.calls.parkedCount).toBe(1);
    await act(async () => {
      driven.calls.resolveOldest(STEER_APPLIED);
      await Promise.all([pending, second]);
    });
  });

  it("frees the slot of the address a late settlement belongs to, and no other", async () => {
    // The disposition for the settlement itself: it releases the address it was
    // issued at, so returning there finds a composer that can send again rather than
    // one wedged by its own answered call.
    const driven = driveAddressableComposer();
    const pending = driven.beginSend("ship it");
    driven.reAddressTo(SESSION_B);
    await act(async () => {
      driven.calls.resolveOldest(STEER_APPLIED);
      await pending;
    });

    expect(driven.latest().status).toBe("idle");
    driven.reAddressTo(SESSION_A);
    const resumed = driven.beginSend("ship it again");

    expect(driven.calls.parkedCount).toBe(1);
    await act(async () => {
      driven.calls.resolveOldest(STEER_APPLIED);
      await resumed;
    });
  });
});
