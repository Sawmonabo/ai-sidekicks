// The session's limit verbs are the only way a person sets a limit the daemon enforces, so a bad
// value or a caller-supplied spend figure must never parse.
import { describe, it } from "vitest";

import { accepts, refuses } from "../../../__tests__/safe-parse.test-support.js";
import {
  SessionMaxStepsUpdateRequestSchema,
  SessionSpendLimitUpdateRequestSchema,
  SessionTokensPerRunUpdateRequestSchema,
} from "../methods.js";

const sessionId = "550e8400-e29b-41d4-a716-446655440000";

describe("the session limit requests", () => {
  it("clear a limit with null and refuse a step or token bound below one", () => {
    accepts(SessionMaxStepsUpdateRequestSchema, { sessionId, maxStepsPerTurn: null });
    refuses(SessionMaxStepsUpdateRequestSchema, { sessionId, maxStepsPerTurn: 0 });
    accepts(SessionTokensPerRunUpdateRequestSchema, { sessionId, tokensPerRun: null });
    refuses(SessionTokensPerRunUpdateRequestSchema, { sessionId, tokensPerRun: 0 });
  });

  it("refuse a negative or fractional spend limit and a caller's own committed spend", () => {
    accepts(SessionSpendLimitUpdateRequestSchema, { sessionId, spendLimitUsdMicros: null });
    accepts(SessionSpendLimitUpdateRequestSchema, { sessionId, spendLimitUsdMicros: 5_000_000 });
    refuses(SessionSpendLimitUpdateRequestSchema, { sessionId, spendLimitUsdMicros: -1 });
    refuses(SessionSpendLimitUpdateRequestSchema, { sessionId, spendLimitUsdMicros: 1.5 });
    refuses(SessionSpendLimitUpdateRequestSchema, {
      sessionId,
      spendLimitUsdMicros: null,
      committedSpendUsdMicros: 0,
    });
    refuses(SessionTokensPerRunUpdateRequestSchema, {
      sessionId,
      tokensPerRun: null,
      committedSpendUsdMicros: 0,
    });
  });
});
