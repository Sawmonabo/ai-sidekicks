// What each permission level sends each provider decides who answers each kind of ask: the person's
// card, the provider's own reviewer, or the level's posture with no ask at all. The settings come
// from the drivers' own level mappings; each provider routes an ask under them by its documented
// rules, written once here, so a level whose settings drift raises a card where it should not, or
// none where it should.

import type { PermissionLevel } from "@ai-sidekicks/contracts/session/controls/methods";
import { describe, expect, it } from "vitest";

import type { ClaudePermissionMode } from "../claude/session/transport.js";
import { resolveClaudePermissionMode } from "../claude/spawn/arguments.js";
import { composeClaudeSpawnSettings } from "../claude/spawn/settings.js";
import {
  composeCodexConnectorDefaults,
  composeCodexLevelSettings,
  type CodexLevelSettings,
} from "../codex/permission-level.js";

// A shell command no rule allows, an edit outside the working folder, a removal the provider's own
// check flags, and a tool-server tool not marked read-only.
const ASK_KINDS = ["command", "outside_write", "flagged_removal", "tool_call"] as const;
type AskKind = (typeof ASK_KINDS)[number];

// Who answers an ask: the person on the approval card, the provider's own reviewer, or the
// level's posture, which runs or refuses the call with no ask.
type Answerer = "person" | "reviewer" | "posture";

const PERSON_FOR_ALL = ["person", "person", "person", "person"] as const;
const POSTURE_FOR_ALL = ["posture", "posture", "posture", "posture"] as const;
const YOLO = ["posture", "posture", "person", "posture"] as const;

// Who answers each kind of ask, in `ASK_KINDS` order, per provider and level.
const EXPECTED: Readonly<Record<"claude" | "codex", Record<PermissionLevel, readonly Answerer[]>>> =
  {
    claude: {
      readonly: PERSON_FOR_ALL,
      ask: PERSON_FOR_ALL,
      // The reviewer answers all but a flagged removal, which the `Bash(rm *)` ask rule brings to
      // the person instead of the refusal auto mode would give it.
      reviewed: ["reviewer", "reviewer", "person", "reviewer"],
      sandboxed: POSTURE_FOR_ALL,
      yolo: YOLO,
    },
    codex: {
      readonly: PERSON_FOR_ALL,
      ask: PERSON_FOR_ALL,
      reviewed: ["reviewer", "reviewer", "reviewer", "reviewer"],
      sandboxed: POSTURE_FOR_ALL,
      yolo: YOLO,
    },
  };

const LEVELS: readonly PermissionLevel[] = ["readonly", "ask", "reviewed", "sandboxed", "yolo"];

// Claude Code's routing by its permission mode: `dontAsk` never asks, bypass asks only before a
// removal its own check flags, auto hands every ask to its classifier and refuses a flagged
// removal unless an ask rule names it, and the default and accept-edits modes ask the person.
function routeClaudeAsk(
  mode: ClaudePermissionMode,
  askRules: readonly string[],
  kind: AskKind,
): Answerer {
  switch (mode) {
    case "dontAsk":
      return "posture";
    case "bypassPermissions":
      return kind === "flagged_removal" ? "person" : "posture";
    case "auto":
      if (kind !== "flagged_removal") {
        return "reviewer";
      }
      return askRules.includes("Bash(rm *)") ? "person" : "posture";
    default:
      return "person";
  }
}

// Codex's routing: approvals off never ask, its automatic reviewer answers every ask it is given,
// a connector tool asks unless its default approves it, a forced removal always asks, and full
// access runs every other call unasked.
function routeCodexAsk(
  settings: CodexLevelSettings,
  connectorApprovalMode: string | undefined,
  kind: AskKind,
): Answerer {
  if (settings.approvalPolicy === "never") {
    return "posture";
  }
  if (settings.approvalsReviewer === "auto_review") {
    return "reviewer";
  }
  switch (kind) {
    case "tool_call":
      return connectorApprovalMode === "approve" ? "posture" : "person";
    case "flagged_removal":
      return "person";
    default:
      return settings.permissions === ":danger-full-access" ? "posture" : "person";
  }
}

describe("each permission level's asks", () => {
  it("reach the person, the reviewer or no one, by kind, as each level's settings route them", () => {
    const routed = { claude: {}, codex: {} } as Record<
      "claude" | "codex",
      Record<string, readonly Answerer[]>
    >;
    for (const level of LEVELS) {
      const claudeSettings = composeClaudeSpawnSettings(
        {
          credentialDenyPaths: [],
          memoryFolders: [],
          advisorModel: null,
          outputStyle: null,
          executionPosture: {
            mode: level,
            writableRoots: [],
            credentialPolicyRef: "curated-credentials",
          },
        },
        [],
      );
      const claudeMode = resolveClaudePermissionMode(level);
      routed.claude[level] = ASK_KINDS.map((kind) =>
        routeClaudeAsk(claudeMode, claudeSettings.permissions.ask, kind),
      );
      const codexSettings = composeCodexLevelSettings(level, {
        workingDirectory: "/work/repo",
        gitCommonFolder: "/work/repo/.git",
        denyPaths: [],
      });
      const connectorApprovalMode =
        composeCodexConnectorDefaults(level)["apps._default.default_tools_approval_mode"];
      routed.codex[level] = ASK_KINDS.map((kind) =>
        routeCodexAsk(codexSettings, connectorApprovalMode, kind),
      );
    }

    expect(routed).toStrictEqual(EXPECTED);
  });
});
