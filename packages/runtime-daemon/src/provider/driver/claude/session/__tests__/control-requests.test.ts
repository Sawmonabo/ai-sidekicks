// `session/control-requests.ts`: a control request Claude Code never answers fails on its deadline
// or when the process exits, and a request opened after the exit fails at once.

import { describe, expect, it } from "vitest";

import { makeManualScheduler } from "../../../../__fixtures__/manual-scheduler.js";
import { ClaudeControlRequestTable } from "../control-requests.js";
import { ClaudeRequestTimeoutError, ClaudeSessionUnavailableError } from "../errors.js";

const DEADLINE_MS = 60_000;

describe("ClaudeControlRequestTable", () => {
  it("fails an unanswered request on its deadline and leaves an answered one settled", async () => {
    const scheduler = makeManualScheduler();
    const table = new ClaudeControlRequestTable(scheduler.schedule);
    const unanswered = table.open("interrupt", DEADLINE_MS);
    const answered = table.open("get_settings", DEADLINE_MS);
    const answer = { subtype: "success", response: { mode: "default" } } as const;
    expect(table.settle(answered.requestId, answer)).toBe(true);

    scheduler.fireAll();

    await expect(unanswered.settled).rejects.toBeInstanceOf(ClaudeRequestTimeoutError);
    await expect(answered.settled).resolves.toStrictEqual(answer);
    // The deadline took the request out, so a late answer finds nothing to settle.
    expect(table.settle(unanswered.requestId, answer)).toBe(false);
  });

  it("fails every pending request when the process exits, and every later one", async () => {
    const scheduler = makeManualScheduler();
    const table = new ClaudeControlRequestTable(scheduler.schedule);
    const first = table.open("interrupt", DEADLINE_MS);
    const second = table.open("mcp_set_servers", DEADLINE_MS);

    table.failAllOnExit("exit code 1");

    const later = table.open("get_settings", DEADLINE_MS);
    const outcomes = await Promise.allSettled(
      [first, second, later].map((opened) => opened.settled),
    );

    for (const outcome of outcomes) {
      expect(outcome.status).toBe("rejected");
      const failure = (outcome as PromiseRejectedResult).reason as unknown;
      expect(failure).toBeInstanceOf(ClaudeSessionUnavailableError);
      expect((failure as ClaudeSessionUnavailableError).fields.reason).toBe("process_exited");
    }
    // Both deadlines were canceled, so nothing fires after the exit.
    expect(scheduler.pendingCount()).toBe(0);
  });
});
