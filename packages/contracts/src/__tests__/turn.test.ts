// The working line reads one turn's received tokens and its task list from the
// daemon. These tests hold the readings it draws: a whole-number running total and
// a whole list whose items carry one of three states.
import { describe, expect, it } from "vitest";

import {
  TurnSubscribeRequestSchema,
  TurnTasksUpdateSchema,
  TurnUsageUpdateSchema,
} from "../turn.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";

describe("turn subscriptions", () => {
  it("follow one run of one session", () => {
    expect(
      TurnSubscribeRequestSchema.safeParse({ sessionId: SESSION_ID, runId: RUN_ID }).success,
    ).toBe(true);
    expect(TurnSubscribeRequestSchema.safeParse({ sessionId: SESSION_ID }).success).toBe(false);
  });
});

describe("turn.usage", () => {
  it("accepts the turn's running total and refuses a negative or fractional one", () => {
    const update = { runId: RUN_ID, turnId: "turn-1", tokensReceived: 840 };
    expect(TurnUsageUpdateSchema.safeParse(update).success).toBe(true);
    expect(TurnUsageUpdateSchema.safeParse({ ...update, tokensReceived: -1 }).success).toBe(false);
    expect(TurnUsageUpdateSchema.safeParse({ ...update, tokensReceived: 8.4 }).success).toBe(false);
  });
});

describe("turn.tasks", () => {
  it("accepts the whole list and refuses a state outside the three", () => {
    const update = {
      runId: RUN_ID,
      turnId: "turn-1",
      tasks: [
        { text: "Read the schema", state: "done" },
        { text: "Write the migration", state: "in_progress" },
      ],
    };
    expect(TurnTasksUpdateSchema.safeParse(update).success).toBe(true);
    expect(
      TurnTasksUpdateSchema.safeParse({
        ...update,
        tasks: [{ text: "Write the migration", state: "blocked" }],
      }).success,
    ).toBe(false);
  });
});
