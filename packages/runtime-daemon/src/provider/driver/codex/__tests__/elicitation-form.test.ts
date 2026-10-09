// A tool server's form read into the questions card's prompts at the Codex boundary.

import { describe, expect, it } from "vitest";

import { QuestionAskedPayloadSchema } from "@ai-sidekicks/contracts/question";

import { readCodexElicitationQuestions } from "../delivery/elicitation-form.js";
import { RUN_ID, SESSION_ID } from "../__fixtures__/app-server-doubles.js";

describe("a form field whose bounds cross", () => {
  it("asks the field unbounded, so the card still opens", () => {
    // The card refuses a prompt whose largest number is below its smallest, which would leave the
    // server's question unanswerable.
    const questions = readCodexElicitationQuestions({
      serverName: "deploys",
      message: "Pick the rollout",
      mode: "form",
      requestedSchema: {
        type: "object",
        properties: {
          percent: { type: "integer", title: "Percent", minimum: 50, maximum: 10 },
          replicas: { type: "integer", title: "Replicas", minimum: 1, maximum: 9 },
        },
      },
    });

    expect(questions.map((question) => [question.minimum, question.maximum])).toStrictEqual([
      [undefined, undefined],
      [1, 9],
    ]);
    expect(
      QuestionAskedPayloadSchema.safeParse({
        questionId: "77777777-7777-4777-8777-777777777777",
        sessionId: SESSION_ID,
        runId: RUN_ID,
        isAgentWaiting: true,
        questions,
      }).success,
    ).toBe(true);
  });
});
