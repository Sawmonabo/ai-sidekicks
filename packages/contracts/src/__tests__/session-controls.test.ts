// The `session.notice` payload the daemon writes: a lowered permission level must be more careful
// than the level asked for, so the notice never tells the person a session is safer than it is.
import { describe, expect, it } from "vitest";

import { SessionNoticePayloadSchema } from "../session-controls.js";

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
const AGENT_ID = "0190a2b4-7c3d-7e5f-8a1b-2c3d4e5f6a7b";

const accepts = (schema: { safeParse: (value: unknown) => { success: boolean } }, value: unknown) =>
  schema.safeParse(value).success;

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
