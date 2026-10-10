// `spawn/arguments.ts` with `spawn/settings.ts`: the command line each spawn path starts Claude
// Code with, at every level.

import type { PermissionLevel } from "@ai-sidekicks/contracts/session/controls/methods";
import { describe, expect, it } from "vitest";

import { composeClaudeArguments, type ClaudeConversationStart } from "../arguments.js";
import { composeClaudeSpawnSettings } from "../settings.js";

const LEVEL_MODES: readonly (readonly [PermissionLevel, string])[] = [
  ["readonly", "default"],
  ["ask", "acceptEdits"],
  ["reviewed", "auto"],
  ["sandboxed", "dontAsk"],
  ["yolo", "bypassPermissions"],
];

const CONVERSATIONS: readonly (readonly [ClaudeConversationStart, readonly string[]])[] = [
  [{ kind: "new", providerSessionId: "session-new" }, ["--session-id", "session-new"]],
  [{ kind: "resume", resumeHandle: "session-old" }, ["--resume", "session-old"]],
  [
    {
      kind: "fork",
      resumeHandle: "session-old",
      forkedProviderSessionId: "session-fork",
      resumeAtMessageUuid: "message-cut",
    },
    [
      "--resume",
      "session-old",
      "--fork-session",
      "--session-id",
      "session-fork",
      "--resume-session-at",
      "message-cut",
    ],
  ],
];

const TOOL_SERVER_URL = "http://127.0.0.1:4100/tools/session-1/sidekicks";

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

describe("composeClaudeArguments", () => {
  it("runs each level in its mode with only the daemon's tool server, on every path", () => {
    for (const [level, mode] of LEVEL_MODES) {
      for (const [conversation, conversationArguments] of CONVERSATIONS) {
        const settings = composeClaudeSpawnSettings({
          credentialDenyPaths: [],
          memoryFolders: [],
          advisorModel: null,
          outputStyle: null,
          executionPosture: {
            mode: level,
            writableRoots: ["/workspace"],
            credentialPolicyRef: "policy://default",
          },
        });
        const args = composeClaudeArguments({
          model: "claude-test-model",
          level,
          settings,
          toolServer: { name: "sidekicks", entry: { type: "http", url: TOOL_SERVER_URL } },
          outputSchema: undefined,
          withholdsHelperTool: false,
          conversation,
        });

        expect(valueAfter(args, "--permission-mode")).toBe(mode);
        // Without it a reply reaches the daemon only whole, once written.
        expect(args).toContain("--include-partial-messages");
        // Without the strict flag the person's own tool servers would load beside the daemon's.
        expect(args).toContain("--strict-mcp-config");
        expect(JSON.parse(valueAfter(args, "--mcp-config") ?? "")).toStrictEqual({
          mcpServers: { sidekicks: { type: "http", url: TOOL_SERVER_URL } },
        });
        expect(args.slice(args.indexOf("--strict-mcp-config") + 1)).toStrictEqual(
          conversationArguments,
        );
        // The Bash sandbox is the Sandboxed level; no other level runs inside it.
        const written = JSON.parse(valueAfter(args, "--settings") ?? "") as Record<string, unknown>;
        expect(written["sandbox"]).toStrictEqual(
          level === "sandboxed"
            ? {
                enabled: true,
                failIfUnavailable: true,
                excludedCommands: [],
                filesystem: { allowWrite: ["/workspace"] },
              }
            : undefined,
        );
      }
    }
  });
});
