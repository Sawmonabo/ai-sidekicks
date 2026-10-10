// Codex inbound frames: an unmapped method lands on a diagnostic, connection-scoped frames are
// never quarantined, and Codex's own approval of a tool-server call is an approval.

import { describe, expect, it } from "vitest";

import { makeSilentDriverDiagnostics } from "../../../__fixtures__/silent-driver-diagnostics.js";
import {
  classifyCodexFrameFamilyForRouting,
  reportCodexFrameOutsideTable,
} from "../event-normalizer.js";
import { CODEX_ROUTED_SERVER_REQUEST_DESCRIPTORS } from "../server-requests.js";

describe("reportCodexFrameOutsideTable", () => {
  it("reports an unmapped method once, and nothing for a method the table reads", () => {
    const diagnostics = makeSilentDriverDiagnostics();
    reportCodexFrameOutsideTable("thread/unheard-of", diagnostics);
    expect(diagnostics.emittedRecordCount()).toBe(1);
    reportCodexFrameOutsideTable("turn/completed", diagnostics);
    expect(diagnostics.emittedRecordCount()).toBe(1);
  });
});

describe("classifyCodexFrameFamilyForRouting", () => {
  it("classifies the account-plane and notice families connection-scoped", () => {
    for (const connectionScopedMethod of [
      "account/rateLimits/updated",
      "account/chatgptAuthTokens/refresh",
      "project/changed",
      // Its payload is the empty object, so it names no thread; an unlisted method quarantines,
      // which would emit a router diagnostic on every skill-file save.
      "skills/changed",
    ]) {
      expect(classifyCodexFrameFamilyForRouting(connectionScopedMethod)).toEqual({
        scope: "connection",
      });
    }
  });
});

describe("the elicitation descriptor's classifyAsk", () => {
  it(
    "records Codex's own tool-server-call approval as an approval, and a server's question as a " +
      "question",
    () => {
      const descriptor = CODEX_ROUTED_SERVER_REQUEST_DESCRIPTORS.get(
        "mcpServer/elicitation/request",
      );
      // Answered as a question, an approval would be an `accept` with content, which Codex runs.
      expect(
        descriptor?.classifyAsk({
          serverName: "probe",
          mode: "form",
          message: 'Allow the probe MCP server to run tool "probe_tool"?',
          requestedSchema: { type: "object", properties: {} },
          _meta: { codex_approval_kind: "mcp_tool_call", persist: ["session", "always"] },
        }),
      ).toBe("approval");
      expect(
        descriptor?.classifyAsk({
          serverName: "probe",
          mode: "form",
          message: "Which region?",
          requestedSchema: { type: "object", properties: { region: { enum: ["us", "eu"] } } },
        }),
      ).toBe("question");
    },
  );
});
