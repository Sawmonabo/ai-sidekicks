// A send that settles after the composer has been re-addressed, and a success that
// lands beside another operation's refusal.
//
// The hook-level half of the settlement-identity rules `send-settlement.test.ts`
// states over literals. These drive the real hook over a real `DraftStore` and a
// bridge whose calls settle when the case says so, because the defect is about
// TIMING — a call in flight across a re-address — and no literal can express that.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ParkedDaemonCalls } from "../parked-daemon-calls.js";
import type { ConsoleBridge } from "../../../console/bridge/index.js";
import { DraftStore } from "../../../console/persistence/index.js";
import type { ComposerChannelTarget } from "../chips/chip-models.js";
import { useSendController, type SendController } from "./send-controller.js";

const SESSION_ID = "0a1b2c3d-4e5f-4061-8273-9a4b5c6d7e8f";
const CHANNEL_A = "1b2c3d4e-5f60-4172-8384-ab5c6d7e8f90";
const CHANNEL_B = "2c3d4e5f-6071-4283-8495-bc6d7e8f9012";

const QUEUE_FULL_CODE = "queue.full";
const QUEUE_FULL_MESSAGE = "That channel's queue is full.";

/**
 * The registered `run.queueCreate` reply, so the send below actually succeeds.
 *
 * The router parses the response before reporting a send, so an empty object is the
 * unreadable-reply refusal rather than the success this case sets beside the Stop's
 * own refusal.
 */
const QUEUE_CREATED: Readonly<Record<string, unknown>> = {
  queueItemId: "5e6f7a8b-9c0d-4e1f-8a2b-7c8d9e0f1a2b",
  state: "queued",
  createdAt: "2026-09-02T09:00:00.000Z",
};

function channelTarget(channelId: string): ComposerChannelTarget {
  return {
    path: "channel-message",
    sessionId: SESSION_ID,
    channelId,
    workspaceId: undefined,
    channelLabel: undefined,
  };
}

/** Reports the controller out of the tree at whichever address the case supplies. */
function AddressableProbe(props: {
  readonly bridge: ConsoleBridge;
  readonly draftStore: DraftStore;
  readonly channelId: string;
  readonly onController: (controller: SendController) => void;
}): null {
  const controller = useSendController({
    bridge: props.bridge,
    target: channelTarget(props.channelId),
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
  reAddressTo(channelId: string): void;
}

function driveAddressableComposer(): DrivenComposer {
  const calls = new ParkedDaemonCalls();
  const draftStore = new DraftStore({ restartNoticePending: false });
  let latest: SendController | undefined;
  const renderAt = (channelId: string): React.JSX.Element => (
    <AddressableProbe
      bridge={calls.bridge}
      draftStore={draftStore}
      channelId={channelId}
      onController={(controller) => {
        latest = controller;
      }}
    />
  );
  const view = render(renderAt(CHANNEL_A));
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
    reAddressTo: (channelId: string) => {
      act(() => {
        view.rerender(renderAt(channelId));
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
