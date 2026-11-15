// A send that settles after the composer has been re-addressed. Drives the real hook over a
// real `DraftStore` and calls that settle when the case says so, since the rules are about
// timing across a re-address; `send/settlement.test.ts` states them over literals.

import { act, render } from "@testing-library/react";
import { useMemo } from "react";
import { describe, expect, it, vi } from "vitest";

import { ParkedDaemonCalls } from "../../hooks/parked-daemon-calls.test-support.js";
import { ManualClock } from "#renderer/lib/clock.js";
import { SessionStore } from "#renderer/store/session/store.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import type { ComposerSendCalls } from "../dispatch.js";
import { MAXIMUM_LIVE_DRAFT_COUNT } from "#renderer/store/persistence/caps.js";
import { DraftStore } from "#renderer/store/drafts.js";
import type { ComposerRunTarget } from "#renderer/features/composer/target.js";
import { composerDraftKey } from "../../draft-key.js";
import type { DraftLineCaret, SendController } from "../controller-contract.js";
import { useSendController } from "./useSendController.js";
import { ComposerHeldDraft } from "#renderer/features/composer/held-draft/holder.js";
import { RUN_TARGET } from "../router.test-support.js";

const SESSION_A = "1b2c3d4e-5f60-4172-8384-ab5c6d7e8f90";
const SESSION_B = "2c3d4e5f-6071-4283-8495-bc6d7e8f9012";

const REJECTION_REASON = "agent.queueItem.persistenceUnavailable";

/** A line with no caret to read or put back. */
const NO_LINE_CARET: DraftLineCaret = { read: () => undefined, place: () => undefined };

function runTargetIn(sessionId: string): ComposerRunTarget {
  return { ...RUN_TARGET, sessionId };
}

function AddressableProbe(props: {
  readonly bridge: PlatformBridge;
  readonly calls: ComposerSendCalls;
  readonly draftStore: DraftStore;
  readonly target: ComposerRunTarget;
  readonly onController: (controller: SendController) => void;
}): null {
  const heldDraft = useMemo(
    () =>
      new ComposerHeldDraft({
        draftStore: props.draftStore,
        draftKey: composerDraftKey(props.target.sessionId),
      }),
    [props.draftStore, props.target.sessionId],
  );
  const sessionStore = useMemo(
    () => new SessionStore({ sessionId: props.target.sessionId }),
    [props.target.sessionId],
  );
  const clock = useMemo(() => new ManualClock(), []);
  const controller = useSendController({
    bridge: props.bridge,
    calls: props.calls,
    target: props.target,
    draftStore: props.draftStore,
    heldDraft,
    sessionStore,
    clock,
    providerName: undefined,
    lineCaret: NO_LINE_CARET,
    raiseRefusalBanner: () => undefined,
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
      target={runTargetIn(sessionId)}
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
    draftAt: (sessionId: string) => draftStore.read(composerDraftKey(sessionId))?.text,
    beginSend: (body: string) => {
      draftStore.write(composerDraftKey(currentSessionId), body);
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
    // The send waits for a dropped file's copy before it calls, so the call parks a few ticks on.
    await vi.waitFor(() => {
      expect(driven.calls.parkedCount).toBe(1);
    });

    driven.reAddressTo(SESSION_B);
    driven.reAddressTo(SESSION_A);
    expect(driven.latest().status).toBe("idle");

    const secondSend = driven.beginSend("actually, hold on");
    await vi.waitFor(() => {
      expect(driven.calls.parkedCount).toBe(2);
    });

    // Each failed message comes back to the session it left, ahead of what was typed since, and
    // draws no refusal under the line: its line stands in the transcript.
    await act(async () => {
      driven.calls.rejectOldest(REJECTION_REASON);
      await firstSend;
    });

    expect(driven.draftAt(SESSION_A)).toBe("ship it");
    expect(driven.latest().refusal).toBeUndefined();

    await act(async () => {
      driven.calls.rejectOldest(REJECTION_REASON);
      await secondSend;
    });

    expect(driven.draftAt(SESSION_A)).toBe("actually, hold on\nship it");
    expect(driven.latest().refusal).toBeUndefined();
  });
});
