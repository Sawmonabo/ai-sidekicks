// The code-to-words mapper reads a labeled code as its label and its reason after a middle dot,
// any other registered code in its own words with each root's screen word in place, and gives no
// words for a code the app wrote.

import { describe, expect, it } from "vitest";

import {
  WORKFLOW_SANDBOX_UNAVAILABLE_CODE,
  WORKFLOW_STEP_THREAD_FAILED_CODE,
  WORKFLOW_STEP_TIMED_OUT_CODE,
} from "@ai-sidekicks/contracts/workflow/run/failures";

import { refusalWords } from "./code-words.js";

describe("refusalWords — a code and its reason as the screen reads them", () => {
  it("reads each worded code exactly, the reason after a middle dot", () => {
    expect(refusalWords("agent.resolution_refused", "account_unavailable")).toBe(
      "Sidekick resolution refused · Account unavailable",
    );
    expect(refusalWords("workflow.start_denied")).toBe("Workflow start denied");
    expect(refusalWords(WORKFLOW_STEP_THREAD_FAILED_CODE, "out_of_memory")).toBe(
      "Step thread failed · Out of memory",
    );
    expect(refusalWords(WORKFLOW_STEP_TIMED_OUT_CODE)).toBe("Step timed out");
    expect(refusalWords(WORKFLOW_SANDBOX_UNAVAILABLE_CODE)).toBe("Sandbox unavailable");
    expect(refusalWords("transport.unavailable")).toBe("Connection lost");
    expect(refusalWords("provideraccount.not_authenticated")).toBe("Login expired");
    expect(refusalWords("repo.clone_refused", "destination_not_empty")).toBe(
      "Repository clone refused · Destination not empty",
    );
  });

  it("writes each root's screen word as cased, and the rest in sentence case", () => {
    expect(refusalWords("mcp.config_invalid")).toBe("MCP config invalid");
    expect(refusalWords("daemon.environment_name_refused")).toBe(
      "Background service environment name refused",
    );
    expect(refusalWords("provideraccount.in_use")).toBe("Account in use");
    expect(refusalWords("repo.not_found")).toBe("Project not found");
    expect(refusalWords("queue.change_refused", "order_mismatch")).toBe(
      "Queue change refused · Order mismatch",
    );
  });

  it("draws no words for a code the app wrote, so its sentence stands alone", () => {
    expect(refusalWords("request-unsendable")).toBeUndefined();
    expect(refusalWords("call-rejected")).toBeUndefined();
    expect(refusalWords("pane-layout-not-mounted")).toBeUndefined();
  });
});
