// A send that settles after the composer has been re-addressed. Drives the real hook over a
// real `DraftStore` and calls that settle when the case says so, since the rules are about
// timing across a re-address; `send/settlement.test.ts` states them over literals.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ParkedDaemonCalls } from "../../hooks/parked-daemon-calls.test-support.js";
import type { PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import type { ComposerSendCalls } from "../dispatch.js";
import { MAXIMUM_LIVE_DRAFT_COUNT } from "@renderer/store/persistence/caps.js";
import { DraftStore } from "@renderer/store/draft-store.js";
import type { ComposerRunTarget } from "@renderer/features/composer/composer-target.js";
import { composerDraftKey } from "../../draft-key.js";
import type { SendController } from "../controller-contract.js";
import { useSendController } from "./useSendController.js";
import { RUN_TARGET } from "../router.test-support.js";

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
  draftAt(sessionId: string): string | undefined;
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
  let currentSessionId = initialSessionId;
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
    draftAt: (sessionId: string) =>
      draftStore.read(composerDraftKey(sessionTarget(sessionId)))?.text,
    beginSend: (body: string) => {
      draftStore.write(composerDraftKey(sessionTarget(currentSessionId)), body);
      return begin(() => latestController().send());
    },
    reAddressTo: (sessionId: string) => {
      currentSessionId = sessionId;
      act(() => {
        view.rerender(renderAt(sessionId));
      });
    },
  };
}

describe("useSendController — a settlement is keyed to the address it was sent under", () => {
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

    expect(driven.draftAt(SESSION_A)).toBe("actually, hold on");
    expect(driven.latest().refusal).toBeUndefined();

    await act(async () => {
      driven.calls.rejectOldest(REJECTION_REASON);
      await secondSend;
    });

    // The second visit's own settlement is current and does render.
    expect(driven.latest().refusal?.code).toBe(REJECTION_REASON);
  });
});
