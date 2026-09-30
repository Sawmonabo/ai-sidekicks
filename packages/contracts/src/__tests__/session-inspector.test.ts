// The inspector's wire contract: the context reading that feeds the ring and the
// `Context` section, the auto-memory switch, and the hooks list. The daemon
// validates its replies and emissions against these schemas, so each refusal here
// is one it makes.
import { describe, expect, it } from "vitest";

import {
  SessionAutoMemoryUpdateResponseSchema,
  SessionContextReadingSchema,
  SessionHookListResponseSchema,
} from "../session-inspector.js";

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";

const accepts = (schema: { safeParse: (value: unknown) => { success: boolean } }, value: unknown) =>
  schema.safeParse(value).success;

describe("session.contextSubscribe emission", () => {
  const compaction = {
    boundPercent: 80,
    topStopPercent: 96.7,
    bottomStopPercent: 18,
    sessionOverride: true,
  };

  it("carries Claude Code's buckets, deferred ones and named parts included", () => {
    expect(
      accepts(SessionContextReadingSchema, {
        sessionId: SESSION_ID,
        windowTokens: 1_000_000,
        compaction,
        usage: {
          usedTokens: 41_000,
          usedPercent: 4.1,
          breakdown: {
            provider: "claude",
            categories: [
              { name: "System tools", tokens: 12_000, kind: "used" },
              {
                name: "MCP tools",
                tokens: 9_000,
                kind: "deferred",
                parts: [{ name: "github", tokens: 9_000 }],
              },
              { name: "Free space", tokens: 900_000, kind: "free" },
            ],
          },
        },
      }),
    ).toBe(true);
  });

  it("carries a Codex session before its first usage report, its bottom stop unknown", () => {
    expect(
      accepts(SessionContextReadingSchema, {
        sessionId: SESSION_ID,
        windowTokens: 258_400,
        compaction: { ...compaction, bottomStopPercent: null, sessionOverride: false },
        usage: null,
      }),
    ).toBe(true);
  });

  it("refuses buckets on Codex, which reports totals only, and a bucket kind outside the four", () => {
    const codexWithBuckets = {
      provider: "codex",
      cachedInputTokens: 1,
      inputTokens: 2,
      outputTokens: 3,
      reasoningTokens: 4,
      categories: [],
    };
    const claudeWithUnknownKind = {
      provider: "claude",
      categories: [{ name: "Messages", tokens: 5, kind: "cached" }],
    };
    for (const breakdown of [codexWithBuckets, claudeWithUnknownKind]) {
      expect(
        accepts(SessionContextReadingSchema, {
          sessionId: SESSION_ID,
          windowTokens: 200_000,
          compaction,
          usage: { usedTokens: 10, usedPercent: 1, breakdown },
        }),
      ).toBe(false);
    }
  });
});

describe("memory and hooks", () => {
  it("says when the auto-memory switch takes effect, in one of two ways", () => {
    const reply = (appliesAt: string) => ({ sessionId: SESSION_ID, enabled: false, appliesAt });
    expect(accepts(SessionAutoMemoryUpdateResponseSchema, reply("next_start"))).toBe(true);
    expect(accepts(SessionAutoMemoryUpdateResponseSchema, reply("later"))).toBe(false);
  });

  it("lists Codex's hooks per folder and Claude Code's hook files, and never mixes the arms", () => {
    const codex = {
      sessionId: SESSION_ID,
      provider: "codex",
      folders: [
        {
          folder: "/work/app",
          hooks: [
            {
              key: "project:preToolUse:0",
              event: "preToolUse",
              handlerType: "command",
              command: "./check.sh",
              timeoutSeconds: 30,
              sourcePath: "/work/app/.codex/config.toml",
              source: "project",
              enabled: true,
              managed: false,
              hash: "sha256:abc",
              trustStatus: "untrusted",
            },
          ],
          errors: [{ path: "/work/app/.codex/hooks.toml", message: "expected a table" }],
          warnings: [],
        },
      ],
    };
    const claude = {
      sessionId: SESSION_ID,
      provider: "claude",
      files: [{ path: "/work/app/.claude/settings.json" }],
    };
    expect(accepts(SessionHookListResponseSchema, codex)).toBe(true);
    expect(accepts(SessionHookListResponseSchema, claude)).toBe(true);
    expect(accepts(SessionHookListResponseSchema, { ...claude, folders: codex.folders })).toBe(
      false,
    );
  });
});
