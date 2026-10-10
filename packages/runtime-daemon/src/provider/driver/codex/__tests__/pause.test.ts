// A pause held at the daemon's hook: a paused helper's next tool call waits at the socket while
// the session's own calls run, and a call still held as Codex's hook deadline nears is denied,
// since a hook that times out lets the call run.

import { mkdtemp, rm } from "node:fs/promises";
import * as net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { drainMicrotasks } from "../../../__fixtures__/drain-microtasks.js";
import { DARWIN_PROVIDER_OPERATING_SYSTEM } from "../../../operating-system/darwin.js";
import { makeManualScheduler } from "../../../__fixtures__/manual-scheduler.js";
import { RUN_ID, SESSION_ID, THREAD_ID } from "../__fixtures__/app-server-doubles.js";
import { type CodexHookPause, CodexRunPauses } from "../hooks/pause.js";
import { CODEX_HOOK_DEADLINE_REASON, CodexHookServer } from "../hooks/server.js";
import { CODEX_HOOK_TIMEOUT_SECONDS } from "../service/command-line.js";

const HELPER_THREAD_ID = "01a04202-0148-7ae2-8560-child0000001";

/** Sends one hook input the way the hook program does and resolves with the answer line. */
async function callHook(socketPath: string, input: Record<string, unknown>): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    let received = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      received += chunk;
    });
    socket.on("end", () => {
      resolve(JSON.parse(received));
    });
    socket.on("error", reject);
    socket.write(`${JSON.stringify({ input })}\n`);
  });
}

/** A pre-tool hook input; Codex names the session tree's root on every call. */
function preToolUse(agentId: string | undefined): Record<string, unknown> {
  return {
    hook_event_name: "PreToolUse",
    session_id: THREAD_ID,
    ...(agentId === undefined ? {} : { agent_id: agentId, agent_type: "default" }),
    turn_id: "turn-1",
    tool_name: "Bash",
    tool_use_id: "call-1",
    tool_input: { command: "ls" },
  };
}

describe("Codex hook pause", () => {
  let scratch = "";

  beforeEach(async () => {
    scratch = await mkdtemp(path.join(tmpdir(), "codex-pause-"));
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  it("holds a paused helper's call and denies it before Codex's deadline", async () => {
    const socketPath = path.join(scratch, "hooks.sock");
    const scheduler = makeManualScheduler();
    let nowMs = 0;
    const tookEffect: CodexHookPause[] = [];
    const held = Promise.withResolvers<void>();
    const pauses = new CodexRunPauses({
      onTookEffect: (pause) => {
        tookEffect.push(pause);
        held.resolve();
      },
      isRunLive: () => true,
    });
    const server = new CodexHookServer({
      endpoint: socketPath,
      operatingSystem: DARWIN_PROVIDER_OPERATING_SYSTEM,
      answerers: [pauses.answer],
      reportDiagnostic: () => undefined,
      scheduleTimeout: scheduler.schedule,
      now: () => nowMs,
    });
    await server.listen();
    const pause = { sessionId: SESSION_ID, runId: RUN_ID, bindingId: "binding-abc" };
    pauses.pause(HELPER_THREAD_ID, pause);

    // The session's own call names no helper, so the helper's pause leaves it alone.
    await expect(callHook(socketPath, preToolUse(undefined))).resolves.toStrictEqual({
      decision: "pass",
    });

    let answer: unknown = "still held";
    const helperCall = callHook(socketPath, preToolUse(HELPER_THREAD_ID)).then((answered) => {
      answer = answered;
    });
    await held.promise;
    await drainMicrotasks();
    expect(tookEffect).toStrictEqual([pause]);
    expect(answer).toBe("still held");

    nowMs = Number(CODEX_HOOK_TIMEOUT_SECONDS) * 1000;
    scheduler.fireAll();
    await helperCall;
    await drainMicrotasks();

    expect(answer).toStrictEqual({ decision: "deny", reason: CODEX_HOOK_DEADLINE_REASON });
  });
});
