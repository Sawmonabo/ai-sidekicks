// A running or waiting reading the service stopped renewing must age into idle, or a row claims
// work no one is doing. The service's reader ages a reading by the same case table, parsed strictly
// here with zod.
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { readCaseTable } from "../../__tests__/case-table.test-support.js";
import { sessionActivityAsOf } from "../activity.js";

const activitySchema = z.enum(["running", "waiting", "done", "failed", "idle"]);

const activityCases = readCaseTable(
  z.array(
    z
      .object({
        note: z.string(),
        activity: activitySchema,
        activityRenewedAt: z.string(),
        nowMs: z.int(),
        expected: activitySchema,
      })
      .strict(),
  ),
  "session/activity.json",
);

describe("reading a row's activity", () => {
  it.each(activityCases)("$note", ({ activity, activityRenewedAt, nowMs, expected }) => {
    expect(sessionActivityAsOf(activity, activityRenewedAt, nowMs)).toBe(expected);
  });
});
