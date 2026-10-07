// The workflows screens read one live stream. These tests hold the rules its readers depend on:
// the hold, a removal and a definition's removal parse, and a removal names its runs.
import { describe, expect, it } from "vitest";

import { WorkflowSubscribeNotificationSchema } from "../subscription.js";

const PARENT_RUN_ID = "33333333-3333-4333-8333-333333333333";
const RUN_ID = "44444444-4444-4444-8444-444444444444";

describe("workflow.subscribe", () => {
  it("accepts the hold, a removal and a definition's removal", () => {
    for (const notification of [
      { kind: "runsPause", paused: true, waitingStartCount: 3 },
      { kind: "runsRemoved", workflowRunIds: [PARENT_RUN_ID, RUN_ID] },
      { kind: "definitionRemoved", definitionId: "wfd-1" },
    ]) {
      expect(WorkflowSubscribeNotificationSchema.safeParse(notification).success).toBe(true);
    }
  });

  it("refuses a removal that names no run", () => {
    const empty = { kind: "runsRemoved", workflowRunIds: [] };
    expect(WorkflowSubscribeNotificationSchema.safeParse(empty).success).toBe(false);
  });
});
