// The session controls' wire contract: each method accepts the design's shape and
// refuses the bad cases the design names, and each flow-row payload the daemon
// writes parses only in its closed form. The daemon validates requests and its own
// emissions against these schemas, so each refusal here is one it makes.
import { describe, expect, it } from "vitest";

import {
  ModerationReviewFlaggedPayloadSchema,
  RunStepLimitReachedPayloadSchema,
  SessionAutoCompactUpdateRequestSchema,
  SessionMaxStepsUpdateRequestSchema,
  SessionMcpServerListSchema,
  SessionMcpServerUpdateRequestSchema,
  SessionModeUpdateRequestSchema,
  SessionNoticePayloadSchema,
  SessionPermissionLevelUpdateRequestSchema,
  SessionProviderCommandListSchema,
  SessionReviewStartRequestSchema,
  SessionSideQuestionAskRequestSchema,
  SessionTerminalCodexListRequestSchema,
  SessionTerminalCodexListResponseSchema,
} from "../session-controls.js";
import {
  DRIVER_MCP_SERVER_NAME_MAX_LEN,
  DRIVER_PROVIDER_COMMAND_ENTRIES_MAX,
} from "../provider-driver.js";

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
const AGENT_ID = "0190a2b4-7c3d-7e5f-8a1b-2c3d4e5f6a7b";
const RUN_ID = "0190a2b4-7c3d-7e5f-8a1b-2c3d4e5f6a7c";

const accepts = (schema: { safeParse: (value: unknown) => { success: boolean } }, value: unknown) =>
  schema.safeParse(value).success;

describe("the permission level and the mode", () => {
  it("takes one of the five levels, and never plan, which is a mode", () => {
    const level = (value: string) => ({ sessionId: SESSION_ID, level: value });
    expect(accepts(SessionPermissionLevelUpdateRequestSchema, level("reviewed"))).toBe(true);
    expect(accepts(SessionPermissionLevelUpdateRequestSchema, level("plan"))).toBe(false);
    expect(accepts(SessionPermissionLevelUpdateRequestSchema, level("workspace-sandboxed"))).toBe(
      false,
    );
  });

  it("takes build or plan as the mode", () => {
    expect(accepts(SessionModeUpdateRequestSchema, { sessionId: SESSION_ID, mode: "plan" })).toBe(
      true,
    );
    expect(accepts(SessionModeUpdateRequestSchema, { sessionId: SESSION_ID, mode: "ask" })).toBe(
      false,
    );
  });
});

describe("session.autoCompactUpdate", () => {
  it("takes a percent of the window, or null to return to the Settings default", () => {
    for (const percent of [83.5, null]) {
      expect(
        accepts(SessionAutoCompactUpdateRequestSchema, { sessionId: SESSION_ID, percent }),
      ).toBe(true);
    }
  });

  it("refuses a percent that is no share of the window", () => {
    for (const percent of [0, 101]) {
      expect(
        accepts(SessionAutoCompactUpdateRequestSchema, { sessionId: SESSION_ID, percent }),
      ).toBe(false);
    }
  });
});

describe("tool servers", () => {
  const server = {
    serverName: "github",
    status: "needs-auth",
    reason: "The server asked for a sign-in.",
    enabled: true,
    pendingUntilNextTurn: false,
  };

  it("lists each server with its status, its switch and a pending flip", () => {
    expect(accepts(SessionMcpServerListSchema, { sessionId: SESSION_ID, servers: [server] })).toBe(
      true,
    );
  });

  it("refuses a status outside the daemon's five", () => {
    expect(
      accepts(SessionMcpServerListSchema, {
        sessionId: SESSION_ID,
        servers: [{ ...server, status: "connecting" }],
      }),
    ).toBe(false);
  });

  it("switches one server by name, and refuses an over-long name or a missing switch", () => {
    const update = { sessionId: SESSION_ID, serverName: "github", enabled: false };
    expect(accepts(SessionMcpServerUpdateRequestSchema, update)).toBe(true);
    expect(
      accepts(SessionMcpServerUpdateRequestSchema, {
        ...update,
        serverName: "s".repeat(DRIVER_MCP_SERVER_NAME_MAX_LEN + 1),
      }),
    ).toBe(false);
    expect(
      accepts(SessionMcpServerUpdateRequestSchema, { sessionId: SESSION_ID, serverName: "github" }),
    ).toBe(false);
  });
});

describe("session.providerCommandsSubscribe emission", () => {
  const command = {
    name: "security-review",
    kind: "command",
    binding: { driverName: "claude", providerAccountId: null },
  };

  it("carries the process's commands and each working server's prompts", () => {
    expect(
      accepts(SessionProviderCommandListSchema, {
        sessionId: SESSION_ID,
        commands: [command],
        serverPrompts: [{ serverName: "github", name: "summarize-pr", title: "Summarize a PR" }],
        complete: true,
      }),
    ).toBe(true);
  });

  it("refuses more commands than one list carries", () => {
    expect(
      accepts(SessionProviderCommandListSchema, {
        sessionId: SESSION_ID,
        commands: Array.from({ length: DRIVER_PROVIDER_COMMAND_ENTRIES_MAX + 1 }, () => command),
        serverPrompts: [],
        complete: false,
      }),
    ).toBe(false);
  });
});

describe("the side question and the review", () => {
  it("asks a question with words in it", () => {
    const ask = (question: string) => ({ sessionId: SESSION_ID, question });
    expect(accepts(SessionSideQuestionAskRequestSchema, ask("Why is the cache cold?"))).toBe(true);
    expect(accepts(SessionSideQuestionAskRequestSchema, ask("   "))).toBe(false);
  });

  it("reviews one of the three targets the console owns", () => {
    const review = (target: string) => ({ sessionId: SESSION_ID, target });
    expect(accepts(SessionReviewStartRequestSchema, review("staged"))).toBe(true);
    expect(accepts(SessionReviewStartRequestSchema, review("unstaged"))).toBe(false);
  });
});

describe("the step bound", () => {
  it("sets a whole number of steps, or null to return to the machine's value", () => {
    for (const maxStepsPerTurn of [40, null]) {
      expect(
        accepts(SessionMaxStepsUpdateRequestSchema, { sessionId: SESSION_ID, maxStepsPerTurn }),
      ).toBe(true);
    }
  });

  it("refuses a bound below one or a fraction of a step", () => {
    for (const maxStepsPerTurn of [0, 1.5]) {
      expect(
        accepts(SessionMaxStepsUpdateRequestSchema, { sessionId: SESSION_ID, maxStepsPerTurn }),
      ).toBe(false);
    }
  });

  it("records the bound a turn reached, never zero", () => {
    const reached = (count: number) => ({ sessionId: SESSION_ID, runId: RUN_ID, count });
    expect(accepts(RunStepLimitReachedPayloadSchema, reached(40))).toBe(true);
    expect(accepts(RunStepLimitReachedPayloadSchema, reached(0))).toBe(false);
  });
});

describe("session.terminalCodexList", () => {
  it("takes no input", () => {
    expect(accepts(SessionTerminalCodexListRequestSchema, {})).toBe(true);
    expect(accepts(SessionTerminalCodexListRequestSchema, { sessionId: SESSION_ID })).toBe(false);
  });

  it("names each terminal session as working, idle or unreachable", () => {
    const listed = (state: string) => ({
      sessions: [{ name: "fix tests", threadId: "t-1", state }],
    });
    expect(accepts(SessionTerminalCodexListResponseSchema, listed("unreachable"))).toBe(true);
    expect(accepts(SessionTerminalCodexListResponseSchema, listed("stopped"))).toBe(false);
  });
});

describe("session.notice payload", () => {
  const notice = (members: Record<string, unknown>) => ({ sessionId: SESSION_ID, ...members });

  it("accepts every kind in the closed set in its own shape", () => {
    const kinds = [
      { kind: "settings_ignored", provider: "codex", file: "/home/.codex/config.toml", line: 4 },
      { kind: "settings_ignored", provider: "claude", file: ".claude/settings.json" },
      {
        kind: "settings_ignored",
        provider: "claude",
        file: ".claude/settings.json",
        key: "permissions.defaultMode",
      },
      { kind: "conversation_reloaded" },
      { kind: "permission_level_lowered", requestedLevel: "reviewed", level: "ask" },
      { kind: "review_started", target: "branch" },
      { kind: "review_finished" },
      { kind: "goal_not_met", agentId: AGENT_ID },
      { kind: "goal_check_unfinished", agentId: AGENT_ID },
    ];
    for (const members of kinds) {
      expect(accepts(SessionNoticePayloadSchema, notice(members))).toBe(true);
    }
  });

  it("refuses a Codex settings notice without its line, and a line on a Claude Code one", () => {
    expect(
      accepts(
        SessionNoticePayloadSchema,
        notice({ kind: "settings_ignored", provider: "codex", file: "config.toml" }),
      ),
    ).toBe(false);
    expect(
      accepts(
        SessionNoticePayloadSchema,
        notice({ kind: "settings_ignored", provider: "claude", file: "settings.json", line: 4 }),
      ),
    ).toBe(false);
  });

  it("refuses a kind outside the closed set", () => {
    expect(
      accepts(SessionNoticePayloadSchema, notice({ kind: "warning", message: "Deprecated flag" })),
    ).toBe(false);
  });

  it("refuses a lowered level that is not more careful than the one asked for", () => {
    for (const level of ["reviewed", "yolo"]) {
      expect(
        accepts(
          SessionNoticePayloadSchema,
          notice({ kind: "permission_level_lowered", requestedLevel: "reviewed", level }),
        ),
      ).toBe(false);
    }
  });
});

describe("moderation.review_flagged payload", () => {
  const flagged = {
    sessionId: SESSION_ID,
    runId: RUN_ID,
    agentId: AGENT_ID,
    eventId: "item-7",
    signal: "review_required",
    text: "This request requires additional safety checks, some tool calls might take extra time",
  };

  it("carries one of the two reviewer signals and the row's words", () => {
    expect(accepts(ModerationReviewFlaggedPayloadSchema, flagged)).toBe(true);
    expect(
      accepts(ModerationReviewFlaggedPayloadSchema, { ...flagged, signal: "review_blocked" }),
    ).toBe(false);
    const { text: _text, ...wordless } = flagged;
    expect(accepts(ModerationReviewFlaggedPayloadSchema, wordless)).toBe(false);
  });
});
