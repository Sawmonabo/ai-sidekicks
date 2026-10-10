// `intervention.ts`: a steer is one user message written into the running turn; an interrupt drops
// the waiting messages only when they return to the draft and the process can drop them, and its
// receipt says whether it did.

import type { RunId } from "@ai-sidekicks/contracts/run/id";
import { describe, expect, it } from "vitest";

import {
  ClaudeInterventionDispatcher,
  type ClaudeInterventionSettlement,
} from "../intervention.js";
import { ClaudeSessionUnavailableError } from "../session/errors.js";
import type { ClaudeProviderProcess, ClaudeRunProcessLookup } from "../session/transport.js";
import {
  buildInterruptParams,
  buildSteerParams,
  FakeClaudeProviderProcess,
} from "../__fixtures__/transport-doubles.js";

const CANCEL_QUEUED_CAPABILITY = "interrupt_cancel_queued_v1";

class StubRunProcessLookup implements ClaudeRunProcessLookup {
  readonly channel: FakeClaudeProviderProcess | undefined;
  readonly capabilities: ReadonlySet<string>;

  constructor(channel: FakeClaudeProviderProcess | undefined, capabilities: readonly string[]) {
    this.channel = channel;
    this.capabilities = new Set(capabilities);
  }

  findProcessForRun(): ClaudeProviderProcess | undefined {
    return this.channel;
  }

  advertisedCapabilitiesForRun(): ReadonlySet<string> {
    return this.capabilities;
  }
}

// No choice is held, and each interrupt's turn end is the stream's to settle.
const SETTLEMENT_WITH_NO_CHOICE: ClaudeInterventionSettlement = {
  settleChoiceForInterrupt: async () => await Promise.resolve(false),
  settleChoiceForMessage: async () => await Promise.resolve(undefined),
  sendAsNextTurn: async () =>
    await Promise.reject(new Error("no choice is held, so no message starts a next turn")),
  holdTurnEndForInterrupt: () => undefined,
  settleInterrupt: () => undefined,
  stopApartRun: () => false,
};

interface InterventionHarness {
  readonly dispatcher: ClaudeInterventionDispatcher;
  readonly channel: FakeClaudeProviderProcess;
  readonly steersSent: { readonly runId: RunId; readonly messageUuid: string }[];
}

function buildHarness(
  capabilities: readonly string[] = [CANCEL_QUEUED_CAPABILITY],
): InterventionHarness {
  const channel = new FakeClaudeProviderProcess("provider-session-live");
  const steersSent: InterventionHarness["steersSent"] = [];
  const dispatcher = new ClaudeInterventionDispatcher({
    channelLookup: new StubRunProcessLookup(channel, capabilities),
    settlement: SETTLEMENT_WITH_NO_CHOICE,
    onSteerSent: (runId, messageUuid) => {
      steersSent.push({ runId, messageUuid });
    },
  });
  return { dispatcher, channel, steersSent };
}

describe("ClaudeInterventionDispatcher steer", () => {
  it("writes one user frame under the steer's own key and applies it", async () => {
    const harness = buildHarness();
    const params = buildSteerParams("try the other fix");

    await expect(harness.dispatcher.applyIntervention(params)).resolves.toStrictEqual({
      status: "applied",
    });

    // The key is the message's id, so a withdraw can name the same message.
    expect(harness.channel.sentUserFrames).toStrictEqual([
      {
        type: "user",
        uuid: params.clientIdempotencyKey,
        message: { role: "user", content: "try the other fix" },
      },
    ]);
    expect(harness.channel.controlRequests).toStrictEqual([]);
    expect(harness.steersSent).toStrictEqual([
      { runId: params.targetRunId, messageUuid: params.clientIdempotencyKey },
    ]);
  });
});

describe("ClaudeInterventionDispatcher interrupt", () => {
  it("drops waiting messages only when they return to the draft and the process can", async () => {
    const cases = [
      { pending: "returnToDraft", capabilities: [CANCEL_QUEUED_CAPABILITY], cancels: true },
      { pending: "nextTurn", capabilities: [CANCEL_QUEUED_CAPABILITY], cancels: false },
      { pending: "returnToDraft", capabilities: [], cancels: false },
    ] as const;
    for (const { pending, capabilities, cancels } of cases) {
      const harness = buildHarness(capabilities);
      // Survivors after an interrupt that keeps its waiting messages are what it promises.
      harness.channel.controlResponse = {
        subtype: "success",
        response: { still_queued: ["3f1b0c22-0000-4000-8000-000000000001"] },
      };

      const result = await harness.dispatcher.applyIntervention(buildInterruptParams(pending));

      expect(harness.channel.controlRequests).toStrictEqual([
        cancels ? { subtype: "interrupt", cancel_queued: true } : { subtype: "interrupt" },
      ]);
      expect(result).toStrictEqual(cancels ? { status: "degraded" } : { status: "applied" });
    }
  });

  it("applies a cancel whose receipt lists no survivors or an unreadable list", async () => {
    for (const receipt of [{ still_queued: [] }, { still_queued: "not-a-list" }, {}]) {
      const harness = buildHarness();
      harness.channel.controlResponse = { subtype: "success", response: receipt };

      await expect(
        harness.dispatcher.applyIntervention(buildInterruptParams("returnToDraft")),
      ).resolves.toStrictEqual({ status: "applied" });
    }
  });

  it("degrades with no fallback on a typed refusal and throws with no live channel", async () => {
    const harness = buildHarness();
    harness.channel.controlResponse = {
      subtype: "error",
      error: "Unsupported control request subtype: interrupt",
    };
    await expect(
      harness.dispatcher.applyIntervention(buildInterruptParams()),
    ).resolves.toStrictEqual({ status: "degraded" });

    const unrouted = new ClaudeInterventionDispatcher({
      channelLookup: new StubRunProcessLookup(undefined, []),
      settlement: SETTLEMENT_WITH_NO_CHOICE,
      onSteerSent: () => undefined,
    });
    await expect(unrouted.applyIntervention(buildInterruptParams())).rejects.toBeInstanceOf(
      ClaudeSessionUnavailableError,
    );
  });
});
