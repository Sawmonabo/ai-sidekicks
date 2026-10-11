// `intervention.ts`: a steer is one user message written into the running turn, steers keeping the
// order they came in; an interrupt is Claude Code's plain `interrupt`, whatever becomes of the
// waiting messages, which the run queue takes back itself.

import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
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
  TEST_SESSION_ID,
} from "../__fixtures__/transport-doubles.js";
import { drainMicrotasks } from "../../../__fixtures__/drain-microtasks.js";
import {
  FakeAttachmentResolver,
  STAGED_ATTACHMENT_IDS,
} from "../../__fixtures__/attachment-doubles.js";

class StubRunProcessLookup implements ClaudeRunProcessLookup {
  readonly channel: FakeClaudeProviderProcess | undefined;

  constructor(channel: FakeClaudeProviderProcess | undefined) {
    this.channel = channel;
  }

  sessionIdForRun(): SessionId | undefined {
    return this.channel === undefined ? undefined : TEST_SESSION_ID;
  }

  findProcessForRun(): ClaudeProviderProcess | undefined {
    return this.channel;
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

function buildHarness(): InterventionHarness {
  const channel = new FakeClaudeProviderProcess("provider-session-live");
  const steersSent: InterventionHarness["steersSent"] = [];
  const dispatcher = new ClaudeInterventionDispatcher({
    channelLookup: new StubRunProcessLookup(channel),
    settlement: SETTLEMENT_WITH_NO_CHOICE,
    attachments: new FakeAttachmentResolver(),
    onSteerSent: (runId, messageUuid) => {
      steersSent.push({ runId, messageUuid });
    },
    onSteerUnsent: () => undefined,
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

describe("ClaudeInterventionDispatcher steer order", () => {
  it("writes steers in the order they came, however long their files take to read", async () => {
    const filesRead = Promise.withResolvers<void>();
    const channel = new FakeClaudeProviderProcess("provider-session-live");
    const dispatcher = new ClaudeInterventionDispatcher({
      channelLookup: new StubRunProcessLookup(channel),
      settlement: SETTLEMENT_WITH_NO_CHOICE,
      attachments: {
        resolveAttachments: async (_sessionId, artifactIds) => {
          await filesRead.promise;
          return artifactIds.map((artifactId) => ({
            kind: "unresolved" as const,
            artifactId,
            cause: "deleted" as const,
          }));
        },
      },
      onSteerSent: () => undefined,
      onSteerUnsent: () => undefined,
    });

    const first = dispatcher.applyIntervention(
      buildSteerParams("first", [STAGED_ATTACHMENT_IDS.deleted]),
    );
    const second = dispatcher.applyIntervention({
      ...buildSteerParams("second"),
      clientIdempotencyKey: "3f1d2b4c-0000-4000-8000-000000000002",
    });
    await drainMicrotasks();
    // The second carries no file, yet waits for the first, whose file is still being read.
    expect(channel.sentUserFrames).toStrictEqual([]);
    filesRead.resolve();
    await Promise.all([first, second]);

    expect(channel.sentTexts).toStrictEqual(["first", "second"]);
  });
});

describe("ClaudeInterventionDispatcher interrupt", () => {
  // Mutation: answering `degraded` for a return to the draft fails the `returnToDraft` arm.
  it("sends a plain interrupt and applies it whatever the waiting messages' choice", async () => {
    for (const pending of ["returnToDraft", "nextTurn"] as const) {
      const harness = buildHarness();

      const result = await harness.dispatcher.applyIntervention(buildInterruptParams(pending));

      expect(harness.channel.controlRequests).toStrictEqual([{ subtype: "interrupt" }]);
      expect(result).toStrictEqual({ status: "applied" });
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
      channelLookup: new StubRunProcessLookup(undefined),
      settlement: SETTLEMENT_WITH_NO_CHOICE,
      attachments: new FakeAttachmentResolver(),
      onSteerSent: () => undefined,
      onSteerUnsent: () => undefined,
    });
    await expect(unrouted.applyIntervention(buildInterruptParams())).rejects.toBeInstanceOf(
      ClaudeSessionUnavailableError,
    );
  });
});
