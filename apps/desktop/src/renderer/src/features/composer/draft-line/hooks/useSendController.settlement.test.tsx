// A send that settles after the composer has been re-addressed. Drives the real hook over a
// real `DraftStore` and calls that settle when the case says so, since the rules are about
// timing across a re-address; `send-settlement.test.ts` states them over literals.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ParkedDaemonCalls } from "./parked-daemon-calls.test-support.js";
import type { PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import type { ComposerSendCalls } from "../send-dispatch.js";
import { MAXIMUM_LIVE_DRAFT_COUNT } from "@renderer/store/persistence-caps.js";
import { DraftStore } from "@renderer/store/draft-store.js";
import type { ComposerRunTarget } from "../../composer-target.js";
import type { SendController } from "../send-controller-contract.js";
import { useSendController } from "./useSendController.js";
import { RUN_TARGET, STEER_APPLIED } from "../send-router.test-support.js";

const SESSION_A = "1b2c3d4e-5f60-4172-8384-ab5c6d7e8f90";
const SESSION_B = "2c3d4e5f-6071-4283-8495-bc6d7e8f9012";

const REJECTION_REASON = "run_not_paused";

function sessionTarget(sessionId: string): ComposerRunTarget {
  return { ...RUN_TARGET, sessionId };
}

function AddressableProbe(props: {
  readonly bridge: PlatformBridge;
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
  beginSend(body: string): Promise<void>;
  reAddressTo(sessionId: string): void;
}

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
  // Started inside `act` so the synchronous half of the dispatch lands under React's batching,
  // and returned unawaited so the case decides when the daemon answers.
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
    // A send to A awaiting the daemon while the person re-addresses to B: the refusal that
    // comes back is a verdict on a message B never carried.
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
    // Without this, the case above would also pass a controller that never renders refusals.
    const driven = driveAddressableComposer();
    const pending = driven.beginSend("ship it");

    await act(async () => {
      driven.calls.rejectOldest(REJECTION_REASON);
      await pending;
    });

    expect(driven.latest().refusal?.code).toBe(REJECTION_REASON);
    // A refused steer keeps its words.
    expect(driven.latest().text).toBe("ship it");
  });

  it("does not resurrect a discarded settlement when the composer returns to its address", async () => {
    // A late refusal attached to nothing the person just did is worse than none, so it is
    // dropped where it lands, not parked. The line keeps its text.
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
    // A -> B -> A with A's first call still parked. The holder re-seeds on the return, so the
    // bar renders `idle`; a latch keyed on the draft key alone would still hold A's claim and
    // the second press would do nothing at all.
    const driven = driveAddressableComposer();
    const firstSend = driven.beginSend("ship it");
    expect(driven.calls.parkedCount).toBe(1);

    driven.reAddressTo(SESSION_B);
    driven.reAddressTo(SESSION_A);
    expect(driven.latest().status).toBe("idle");

    const secondSend = driven.beginSend("actually, hold on");
    expect(driven.calls.parkedCount).toBe(2);

    // The first visit's settlement must not reach into the second's line: the draft store is
    // keyed by address, so an unconditional clear would erase the newly typed words.
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

    // The second visit's own settlement is current and does render.
    expect(driven.latest().refusal?.code).toBe(REJECTION_REASON);
  });
});

describe("useSendController — an operation's busy state belongs to the address it was issued at", () => {
  it("leaves the next address idle while a send for the previous one is still going", async () => {
    // The sending status and the latch are per address: a message still traveling to one
    // session must not leave the composer read-only for the next.
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
    // Without this, a controller that never reported `sending` would pass the case above.
    const driven = driveAddressableComposer();
    const pending = driven.beginSend("ship it");

    expect(driven.latest().status).toBe("sending");
    await act(async () => {
      driven.calls.resolveOldest(STEER_APPLIED);
      await pending;
    });
  });

  it("still latches the address the composer is on, so one press sends once", async () => {
    // Keying must not relax this: two presses at one address in one tick are one send.
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

  it("frees the claim of the address a late settlement belongs to, and no other", async () => {
    // A late settlement releases the address it was issued at, so returning there can send.
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
