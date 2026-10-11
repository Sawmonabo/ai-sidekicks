// The daemon's own checks at Codex's pre-tool hook: a background Claude Code command is refused,
// however it is wrapped, and a command, a file change or a tool server's call on a subject whose
// rule was revoked is held for a card, read through the shell wrapper Codex runs a command in,
// whose answer lets the call run or refuses it, and which is taken back when the call stops
// waiting or its session closes.

import { describe, expect, it } from "vitest";

import type { RunId } from "@ai-sidekicks/contracts/run/id";

import { RUN_ID, SESSION_ID, THREAD_ID } from "../__fixtures__/app-server-doubles.js";
import type { PermissionAskPort, ProviderPermissionAsk } from "../../../port/permission-ask.js";
import { PortRegistration } from "../../../port/registration.js";
import type { SessionRulePort } from "../../../port/session-rules.js";
import { CodexCallChecks } from "../hooks/call-checks.js";
import { CODEX_HOOK_DEADLINE_REASON, type CodexHookInput } from "../hooks/server.js";

const TURN_ID = "turn-1";
const CALL_FOLDER = "/work/repo";
// The subjects whose rules the session made and revoked.
const REVOKED_FILE = "/work/repo/src/revoked.ts";
const REVOKED_TOOL = "mcp__docs__search";

interface CheckHarness {
  readonly checks: CodexCallChecks;
  readonly asks: ProviderPermissionAsk[];
  readonly withdrawals: { sessionId: string; requestId: string }[];
}

// Checks whose session revoked its `npm test`, revoked-file and docs-search rules, with the call's
// run known for `TURN_ID`.
function buildChecks(): CheckHarness {
  const asks: ProviderPermissionAsk[] = [];
  const withdrawals: CheckHarness["withdrawals"] = [];
  const permissionAsks = new PortRegistration<PermissionAskPort>("permission asks");
  permissionAsks.register({
    takeAsk: async (ask) => {
      asks.push(ask);
    },
    withdrawAsk: async (withdrawal) => {
      withdrawals.push(withdrawal);
    },
  });
  const sessionRules = new PortRegistration<SessionRulePort>("session rules");
  sessionRules.register({
    readSessionRules: () => [],
    findRevokedRule: (_sessionId, action) =>
      (action.kind === "command" && action.command.startsWith("npm test")) ||
      (action.kind === "file_change" && action.paths[0] === REVOKED_FILE) ||
      (action.kind === "tool" && action.toolName === REVOKED_TOOL)
        ? { kind: "session", sense: "allow", action: action.kind, subject: "revoked" }
        : undefined,
  });
  const checks = new CodexCallChecks({
    permissionAsks,
    sessionRules,
    findCallRun: (threadId, turnId) =>
      threadId === THREAD_ID && turnId === TURN_ID
        ? { sessionId: SESSION_ID, runId: RUN_ID as RunId }
        : undefined,
  });
  return { checks, asks, withdrawals };
}

function call(toolName: string, toolInput: unknown, toolUseId = "call-1"): CodexHookInput {
  return {
    eventName: "PreToolUse",
    threadId: THREAD_ID,
    turnId: TURN_ID,
    toolName,
    toolUseId,
    toolInput,
    cwd: CALL_FOLDER,
  };
}

function bash(command: string, toolUseId = "call-1"): CodexHookInput {
  return call("Bash", { command }, toolUseId);
}

// A patch as Codex's `apply_patch` hook hands it, touching `files` relative to the call's folder.
function patch(files: readonly string[], toolUseId = "call-1"): CodexHookInput {
  const body = files.map((file) => `*** Update File: ${file}\n@@\n-old\n+new`).join("\n");
  return call("apply_patch", { command: `*** Begin Patch\n${body}\n*** End Patch` }, toolUseId);
}

describe("CodexCallChecks", () => {
  it("refuses a background Claude Code command, and leaves every other call to the next answerer", () => {
    const { checks, asks } = buildChecks();
    const signal = new AbortController().signal;

    for (const command of [
      "cd app && claude --bg 'fix it'",
      "env -i claude agents",
      "env -u HOME claude --bg",
      "time -p claude daemon",
      "exec -a x claude --bg",
      "timeout 5 claude --bg",
      "nice -n 5 claude agents",
      "sudo -u me claude daemon",
      "xargs -n 1 claude --bg",
      "/bin/zsh -lc 'nohup claude --bg'",
    ]) {
      expect(checks.answer(bash(command), signal)).toMatchObject({ decision: "deny" });
    }
    expect(checks.answer(bash("npm run build"), signal)).toBe(undefined);
    expect(checks.answer({ ...bash("npm test"), eventName: "PostToolUse" }, signal)).toBe(
      undefined,
    );
    expect(checks.answer({ ...bash("npm test"), turnId: "turn-unknown" }, signal)).toBe(undefined);
    expect(checks.answer(patch(["src/kept.ts"]), signal)).toBe(undefined);
    expect(checks.answer(call("mcp__docs__fetch", {}), signal)).toBe(undefined);
    expect(asks).toEqual([]);
  });

  it("holds a call on a revoked subject for its card, and runs or refuses it on the answer", async () => {
    const { checks, asks } = buildChecks();
    const signal = new AbortController().signal;

    const approved = checks.answer(bash("npm test", "call-1"), signal);
    const declined = checks.answer(bash("npm test --watch", "call-2"), signal);
    await expect.poll(() => asks.length).toBe(2);

    expect(asks[0]).toMatchObject({
      sessionId: SESSION_ID,
      runId: RUN_ID,
      requestId: "hook:call-1",
      toolCallId: "call-1",
      action: { kind: "command", command: "npm test" },
      ruleScopes: ["session"],
    });
    expect(
      checks.settle({ runId: RUN_ID as RunId, requestId: "7", response: { decision: "allow" } }),
    ).toBe(false);
    expect(
      checks.settle({
        runId: RUN_ID as RunId,
        requestId: "hook:call-1",
        response: { decision: "allow" },
      }),
    ).toBe(true);
    checks.settle({
      runId: RUN_ID as RunId,
      requestId: "hook:call-2",
      response: { decision: "refuse" },
    });
    await expect(approved).resolves.toEqual({ decision: "pass" });
    await expect(declined).resolves.toEqual({
      decision: "deny",
      reason: "The person declined this call.",
    });
  });

  it("holds a wrapped command, a change touching a revoked file and a revoked tool's call", async () => {
    const { checks, asks } = buildChecks();
    const signal = new AbortController().signal;

    void checks.answer(bash("/bin/zsh -lc 'npm test --watch'", "call-1"), signal);
    void checks.answer(patch(["src/kept.ts", "src/revoked.ts"], "call-2"), signal);
    void checks.answer(call(REVOKED_TOOL, { query: "x" }, "call-3"), signal);
    await expect.poll(() => asks.length).toBe(3);

    expect(asks.map((ask) => ask.action)).toEqual([
      { kind: "command", command: "npm test --watch" },
      { kind: "file_change", paths: ["/work/repo/src/kept.ts", REVOKED_FILE] },
      { kind: "tool", toolName: REVOKED_TOOL },
    ]);
    expect(asks.map((ask) => ask.toolName)).toEqual(["Bash", "apply_patch", REVOKED_TOOL]);
  });

  it("takes the card back when the call stops waiting, and refuses the calls of a closed session", async () => {
    const { checks, asks, withdrawals } = buildChecks();
    const deadline = new AbortController();

    const timedOut = checks.answer(bash("npm test", "call-1"), deadline.signal);
    const closed = checks.answer(bash("npm test", "call-2"), new AbortController().signal);
    await expect.poll(() => asks.length).toBe(2);
    deadline.abort();
    checks.forgetSession(SESSION_ID);

    expect(withdrawals).toEqual([{ sessionId: SESSION_ID, requestId: "hook:call-1" }]);
    await expect(closed).resolves.toEqual({
      decision: "deny",
      reason: "The session closed before anyone answered.",
    });
    expect(
      checks.settle({
        runId: RUN_ID as RunId,
        requestId: "hook:call-1",
        response: { decision: "allow" },
      }),
    ).toBe(false);
    await expect(timedOut).resolves.toEqual({
      decision: "deny",
      reason: CODEX_HOOK_DEADLINE_REASON,
    });
  });
});
