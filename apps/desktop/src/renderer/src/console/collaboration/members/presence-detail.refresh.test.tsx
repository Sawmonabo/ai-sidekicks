// The open row's device fan-out, while the devices behind it keep moving.
//
// THE DEFECT THESE CASES EXIST FOR. The roster beside this detail is push-driven — it
// re-reads on every `presence.subscribe` signal — and the fan-out behind an expanded
// row was asked once, at the moment the row was opened, and never again. So a person
// who opened a row and watched it saw the aggregate on the row move as devices came
// and went while the list underneath it went on naming the devices that were present
// at the instant they clicked, for as long as they left it open. Two reads of one
// person's presence on one screen, disagreeing, with the newer one on the row.
//
// The cases drive the real hook over a real fixture bridge and read the FRAME each
// commit carried, rather than counting signals: a push that fires and a read that has
// moved are two different claims, and only the second one is what a person sees.

import { act } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  fixtureBridgeWithGrowth,
  growthAnswering,
  unscriptedScenario,
  withCapturedStream,
  type StreamUnderTest,
} from "../../bridge/fixture/call-plane/bridge.test-support.js";
import { PRESENCE_EVENT_STREAM, type ConsoleBridge } from "../../bridge/index.js";
import type { GrowthPresenceDetail } from "../../bridge/index.js";
import { PAST_REFRESH_DEBOUNCE_MS, settle } from "../../core/settle.test-support.js";
import {
  latestCommitted,
  observeSubjectRead,
} from "../../store/subject-read-commits.test-support.js";
import {
  presenceDetailValue,
  usePresenceDetail,
  type PresenceDetailState,
} from "./presence-detail.js";

const SESSION_ID = "session-presence-detail-refresh";
const PARTICIPANT_ID = "participant-priya";

const TWO_DEVICES: GrowthPresenceDetail = {
  participantId: PARTICIPANT_ID,
  aggregateState: "online",
  devices: [
    { deviceId: "device-desk", state: "online", lastSeen: "2026-01-01T10:00:00.000Z" },
    { deviceId: "device-phone", state: "idle", lastSeen: "2026-01-01T09:58:00.000Z" },
  ],
};

const ONE_DEVICE: GrowthPresenceDetail = {
  participantId: PARTICIPANT_ID,
  aggregateState: "idle",
  devices: [{ deviceId: "device-desk", state: "idle", lastSeen: "2026-01-01T10:01:00.000Z" }],
};

/**
 * The fan-out as a person whose devices change between reads.
 *
 * A class rather than a captured `let`, per this package's state rule. Each read takes
 * the next scripted answer and the last one stands for every read after it, so a case
 * that reads more often than it scripts sees a settled fan-out rather than an error.
 */
class ScriptedDeviceAnswers {
  readonly #answers: readonly GrowthPresenceDetail[];
  #readCount = 0;

  public constructor(answers: readonly GrowthPresenceDetail[]) {
    this.#answers = answers;
  }

  /** How many times the detail read actually reached the port. */
  public get readCount(): number {
    return this.#readCount;
  }

  /** The fan-out this read answers with. */
  public next(): GrowthPresenceDetail {
    const answer =
      this.#answers[Math.min(this.#readCount, this.#answers.length - 1)] ?? TWO_DEVICES;
    this.#readCount += 1;
    return answer;
  }
}

/** A fixture bridge answering the detail read, with the presence stream captured. */
function detailStream(answers: ScriptedDeviceAnswers): StreamUnderTest {
  return withCapturedStream(
    fixtureBridgeWithGrowth(unscriptedScenario("presence-detail-refresh"), {
      participantPresenceDetailRead: growthAnswering<GrowthPresenceDetail>(async () =>
        Promise.resolve(answers.next()),
      ),
    }),
    PRESENCE_EVENT_STREAM,
  );
}

/**
 * The hook as the section calls it, with the session bound and the open row the axis.
 *
 * Declared at module level so the probe drives one identity: which row is open is the
 * subject that moves, and the session behind it does not.
 */
function useDetailForOpenRow(
  bridge: ConsoleBridge,
  participantId: string | undefined,
): PresenceDetailState {
  return usePresenceDetail(bridge, SESSION_ID, participantId);
}

/** Carry the debounced read past its window on the fixture's own frozen clock. */
async function settleDetailRead(bridge: ConsoleBridge): Promise<void> {
  await act(async () => {
    bridge.scenarioEngine?.advance(PAST_REFRESH_DEBOUNCE_MS);
  });
  await settle();
}

describe("presence detail — what refreshes an open row's fan-out", () => {
  it("re-reads when presence changes, and shows the devices that are there now", async () => {
    const answers = new ScriptedDeviceAnswers([TWO_DEVICES, ONE_DEVICE]);
    const stream = detailStream(answers);
    const probe = observeSubjectRead<ConsoleBridge, PresenceDetailState, string>(
      useDetailForOpenRow,
      {
        source: stream.bridge,
        subject: PARTICIPANT_ID,
      },
    );
    await settleDetailRead(stream.bridge);

    expect(presenceDetailValue(latestCommitted(probe.committed))?.devices).toHaveLength(2);

    // One device disconnects. The aggregate on the row moves because the roster is
    // push-driven; this asserts the list underneath it moves with it.
    await act(async () => {
      stream.deliver(undefined);
    });
    await settleDetailRead(stream.bridge);

    expect(answers.readCount).toBe(2);
    expect(presenceDetailValue(latestCommitted(probe.committed))?.devices).toHaveLength(1);
  });

  it("coalesces a burst of presence pushes into one read", async () => {
    const answers = new ScriptedDeviceAnswers([TWO_DEVICES, ONE_DEVICE]);
    const stream = detailStream(answers);
    observeSubjectRead<ConsoleBridge, PresenceDetailState, string>(useDetailForOpenRow, {
      source: stream.bridge,
      subject: PARTICIPANT_ID,
    });
    await settleDetailRead(stream.bridge);

    await act(async () => {
      stream.deliver(undefined);
      stream.deliver(undefined);
      stream.deliver(undefined);
    });
    await settleDetailRead(stream.bridge);

    expect(answers.readCount).toBe(2);
  });

  it("negative control: asks nothing at all while no row is open", async () => {
    // Without this the cases above would hold over a read that asked an owner-only
    // question about somebody the moment the section mounted, which is the whole
    // reason this read is opened by a row rather than by the roster.
    const answers = new ScriptedDeviceAnswers([TWO_DEVICES]);
    const stream = detailStream(answers);
    observeSubjectRead<ConsoleBridge, PresenceDetailState, string>(useDetailForOpenRow, {
      source: stream.bridge,
      subject: undefined,
    });
    await settleDetailRead(stream.bridge);

    expect(answers.readCount).toBe(0);
  });

  it("negative control: closing the row releases the subscription behind it", async () => {
    // A refresh that outlived the row it was opened for would put a wire call behind
    // every presence push for the rest of the visit, for a panel nobody is looking at.
    const answers = new ScriptedDeviceAnswers([TWO_DEVICES, ONE_DEVICE]);
    const stream = detailStream(answers);
    const probe = observeSubjectRead<ConsoleBridge, PresenceDetailState, string>(
      useDetailForOpenRow,
      {
        source: stream.bridge,
        subject: PARTICIPANT_ID,
      },
    );
    await settleDetailRead(stream.bridge);

    // The subscription is proven live first, so the refusal below is a release rather
    // than a subscription that was never taken.
    await act(async () => {
      stream.deliver(undefined);
    });
    await settleDetailRead(stream.bridge);

    await act(async () => {
      probe.readdress({ source: stream.bridge, subject: undefined });
    });
    await settleDetailRead(stream.bridge);

    expect(() => {
      stream.deliver(undefined);
    }).toThrow(PRESENCE_EVENT_STREAM);
    expect(answers.readCount).toBe(2);
  });
});
