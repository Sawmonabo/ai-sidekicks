// The code-to-words mapper reads a labeled code as its label and its reason after a middle dot,
// any other registered code in its own words with each root's screen word in place, and gives no
// words for a code the app wrote.

import { describe, expect, it } from "vitest";

import {
  WORKFLOW_SANDBOX_UNAVAILABLE_CODE,
  WORKFLOW_STEP_THREAD_FAILED_CODE,
  WORKFLOW_STEP_THREAD_FAILED_REASONS,
  WORKFLOW_STEP_TIMED_OUT_CODE,
} from "@ai-sidekicks/contracts/workflow/run/failures";
import { CONNECTION_UNAVAILABLE_CODE } from "@ai-sidekicks/contracts/jsonrpc/message";
import { MCP_SERVER_CONFIG_WRITE_CONFLICT_CODE } from "@ai-sidekicks/contracts/mcp/governance";
import { PROVIDER_ACCOUNT_NOT_AUTHENTICATED_CODE } from "@ai-sidekicks/contracts/provider/account/methods";
import { PROJECT_CLONE_REFUSED_CODE } from "@ai-sidekicks/contracts/repo/clone";
import {
  PREVIEW_ADDRESS_REFUSED_CODE,
  PREVIEW_ADDRESS_REFUSED_REASONS,
} from "@ai-sidekicks/contracts/preview/methods";
import { AGENT_QUEUE_ITEM_NOT_FOUND_CODE } from "@ai-sidekicks/contracts/run/queue";

import { refusalWords } from "./code-words.js";

describe("refusalWords — a code and its reason as the screen reads them", () => {
  it("reads each worded code exactly, the reason after a middle dot", () => {
    expect(refusalWords("agent.resolution_refused", "account_unavailable")).toBe(
      "Sidekick resolution refused · Account unavailable",
    );
    expect(refusalWords("workflow.start_denied")).toBe("Workflow start denied");
    expect(
      refusalWords(WORKFLOW_STEP_THREAD_FAILED_CODE, WORKFLOW_STEP_THREAD_FAILED_REASONS[0]),
    ).toBe("Step thread failed · Start failed");
    expect(refusalWords(WORKFLOW_STEP_TIMED_OUT_CODE)).toBe("Step timed out");
    expect(refusalWords(WORKFLOW_SANDBOX_UNAVAILABLE_CODE)).toBe("Sandbox unavailable");
    expect(refusalWords(CONNECTION_UNAVAILABLE_CODE)).toBe("Connection lost");
    expect(refusalWords(PROVIDER_ACCOUNT_NOT_AUTHENTICATED_CODE)).toBe("Login expired");
    expect(refusalWords(PROJECT_CLONE_REFUSED_CODE, "destinationNotEmpty")).toBe(
      "Repository clone refused · Destination not empty",
    );
  });

  it("writes each root's screen word as cased, and the rest in sentence case", () => {
    expect(refusalWords("mcp.config_invalid")).toBe("MCP config invalid");
    expect(refusalWords("daemon.environment_name_refused")).toBe(
      "Background service environment name refused",
    );
    expect(refusalWords("queue.change_refused", "order_mismatch")).toBe(
      "Queue change refused · Order mismatch",
    );
  });

  it("splits a wire name's lowerCamelCase segments and reasons into words", () => {
    expect(refusalWords(MCP_SERVER_CONFIG_WRITE_CONFLICT_CODE)).toBe(
      "MCP server config write conflict",
    );
    expect(refusalWords(AGENT_QUEUE_ITEM_NOT_FOUND_CODE)).toBe("Sidekick queue item not found");
    expect(refusalWords(PREVIEW_ADDRESS_REFUSED_CODE, PREVIEW_ADDRESS_REFUSED_REASONS[1])).toBe(
      "Preview address refused · Not an address",
    );
  });

  it("draws no words for a code the app wrote, so its sentence stands alone", () => {
    expect(refusalWords("request-unsendable")).toBeUndefined();
    expect(refusalWords("call-rejected")).toBeUndefined();
    expect(refusalWords("pane-layout-not-mounted")).toBeUndefined();
  });
});
