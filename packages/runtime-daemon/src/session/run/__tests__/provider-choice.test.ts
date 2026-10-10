// A choice the provider holds a run on settles on its first answer: a late answer to it, even once
// the run waits on input again, is refused `run.invalid_transition`, sends nothing to the provider
// and appends nothing; an answer whose choice is settled while it is in flight is refused by the
// guard inside its write.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EventEnvelopeVersionSchema } from "@ai-sidekicks/contracts/event/envelope";
import type {
  RunRefusalChoiceRequestedPayload,
  RunRefusalChoiceResolvedPayload,
} from "@ai-sidekicks/contracts/run/provider-choice";

import { SessionEventAppender } from "../../../events/session/appender.js";
import type {
  AnswerProviderChoiceParams,
  AnswerProviderChoiceResult,
} from "../../../provider/driver/run-control.js";
import { ProviderChoiceResolver } from "../provider-choice.js";
import { openRunEngineFixture, type RunEngineFixture } from "./engine.test-support.js";

describe("ProviderChoiceResolver", () => {
  let fixture: RunEngineFixture;
  let resolver: ProviderChoiceResolver;
  let answers: AnswerProviderChoiceParams[];
  const driver = {
    answerProviderChoice: (params: AnswerProviderChoiceParams) => {
      answers.push(params);
      return Promise.resolve<AnswerProviderChoiceResult>({ status: "answered" });
    },
  };

  beforeEach(async () => {
    fixture = await openRunEngineFixture();
    resolver = new ProviderChoiceResolver({
      reader: fixture.database.reader,
      runs: fixture.runs,
      engine: fixture.engine,
    });
    answers = [];
  });

  afterEach(async () => {
    await fixture.close();
  });

  it("refuses a late answer to a settled refusal choice and leaves everything as it was", async () => {
    const runId = await fixture.runThrough(["starting", "running", "waiting_for_input"]);
    const requested: RunRefusalChoiceRequestedPayload = {
      sessionId: fixture.sessionId,
      runId,
      refusedModel: "claude-opus-4-1",
      fallbackModel: "claude-sonnet-4-5",
    };
    await new SessionEventAppender(
      { sessionEvents: fixture.sessionEvents },
      EventEnvelopeVersionSchema.parse("1.0"),
    ).append("run.refusal_choice_requested", requested, {});
    const first = await resolver.resolveRefusalChoice(
      { runId, choice: "retry_fallback" },
      {},
      driver,
    );
    expect(first).toMatchObject({ runId, newState: "running" });
    // The run waits on input again, for another reason; the settled choice stays settled.
    await fixture.engine.transition({ runId, newState: "waiting_for_input" });
    const runBefore = fixture.runs.getRun(runId);
    const eventsBefore = fixture.readRunEvents(runId);

    await expect(
      resolver.resolveRefusalChoice({ runId, choice: "edit_prompt" }, {}, driver),
    ).rejects.toMatchObject({ code: "run.invalid_transition" });

    expect(answers).toHaveLength(1);
    expect(fixture.runs.getRun(runId)).toEqual(runBefore);
    expect(fixture.readRunEvents(runId)).toEqual(eventsBefore);
  });

  it.each(["retry_fallback", "edit_prompt"] as const)(
    "refuses a %s answer whose choice was settled while it went to the provider, writing nothing",
    async (choice) => {
      const runId = await fixture.runThrough(["starting", "running", "waiting_for_input"]);
      const appender = new SessionEventAppender(
        { sessionEvents: fixture.sessionEvents },
        EventEnvelopeVersionSchema.parse("1.0"),
      );
      const requested: RunRefusalChoiceRequestedPayload = {
        sessionId: fixture.sessionId,
        runId,
        refusedModel: "claude-opus-4-1",
        fallbackModel: "claude-sonnet-4-5",
      };
      await appender.append("run.refusal_choice_requested", requested, {});
      const runBefore = fixture.runs.getRun(runId);
      // The driver settles the choice itself, as on an interrupt, before the answer is written.
      const settlingDriver = {
        answerProviderChoice: async (): Promise<AnswerProviderChoiceResult> => {
          const resolved: RunRefusalChoiceResolvedPayload = {
            sessionId: fixture.sessionId,
            runId,
            choice: "canceled",
          };
          await appender.append("run.refusal_choice_resolved", resolved, {});
          return { status: "answered" };
        },
      };
      // The driver's own settlement is the one row the refused answer leaves behind it.
      const settledEventCount = fixture.readRunEvents(runId).length + 1;

      await expect(
        resolver.resolveRefusalChoice({ runId, choice }, {}, settlingDriver),
      ).rejects.toMatchObject({ code: "run.invalid_transition" });

      expect(fixture.runs.getRun(runId)).toEqual(runBefore);
      expect(fixture.readRunEvents(runId)).toHaveLength(settledEventCount);
    },
  );
});
