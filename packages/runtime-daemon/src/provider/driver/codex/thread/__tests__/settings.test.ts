// What every Codex conversation is started and forked with: the base instructions on
// each, Codex's own full access at YOLO rather than the legacy sandbox member, and each helper's
// role file, whose instructions reach the helper and never the lead.

import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { parse } from "@decimalturn/toml-patch";
import { describe, expect, it } from "vitest";

import { drainMicrotasks } from "../../../../__fixtures__/drain-microtasks.js";
import {
  BASE_INSTRUCTIONS,
  createHarness,
  createdSession,
  forkedThreadId,
  RUN_ID,
  runConfig,
  SESSION_ID,
  TEST_POSTURE,
  TURN_ID,
  turnCompletedFrame,
} from "../../__fixtures__/app-server-doubles.js";
import { CREATE_PARAMS, RESUME_PARAMS } from "../../__tests__/lifecycle.test-support.js";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

const ASK_SESSION_ID = "66666666-6666-4666-8666-666666666666" as SessionId;

describe("Codex conversation settings", () => {
  it("passes the base instructions again on a restart's fork and a rewind's", async () => {
    // A home whose config sets `instructions` replaces them on a fork that omits them.
    const harness = createHarness();
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    await harness.driver.resumeSession(RESUME_PARAMS);
    await harness.driver.startRun({ runId: RUN_ID, agentConfig: runConfig() });
    harness.server.emitFrame(turnCompletedFrame(TURN_ID, "completed", forkedThreadId(1)));
    await drainMicrotasks();

    await expect(
      harness.driver.moveSessionToFork({ sessionId: SESSION_ID, position: 1, bindingId: "b" }),
    ).resolves.toMatchObject({ status: "applied" });

    const [restartFork, rewindFork] = harness.server.paramsFor("thread/fork");
    expect(restartFork?.["baseInstructions"]).toBe(BASE_INSTRUCTIONS);
    expect(rewindFork).toMatchObject({
      threadId: forkedThreadId(1),
      lastTurnId: TURN_ID,
      baseInstructions: BASE_INSTRUCTIONS,
    });
  });

  it("runs YOLO under Codex's own full access, never the sandbox member", async () => {
    // The legacy member leaves the conversation with no active profile, so no level holds.
    const harness = createHarness();
    await createdSession(harness, { posture: { ...TEST_POSTURE, mode: "yolo" } });
    await createdSession(harness, { sessionId: ASK_SESSION_ID });
    await harness.driver.updatePermissionLevel({ sessionId: ASK_SESSION_ID, level: "yolo" });

    const started = harness.server.paramsFor("thread/start")[0] ?? {};
    const moved = harness.server.paramsFor("thread/settings/update")[0] ?? {};
    for (const params of [started, moved]) {
      expect(params["permissions"]).toBe(":danger-full-access");
      expect(params["approvalPolicy"]).toBe("on-request");
      expect(params).not.toHaveProperty("sandbox");
    }
    const config = started["config"] as Record<string, unknown>;
    expect(config["default_permissions"]).toBe(":danger-full-access");
    expect(config).not.toHaveProperty("sandbox_mode");
  });

  it("hands each helper its instructions in its own role file, and none to the lead", async () => {
    // A file without its instructions, or one with a key Codex does not read, is a role Codex
    // drops; instructions in the lead's config would run the lead as the helper.
    const helperRolesFolder = await mkdtemp(path.join(tmpdir(), "codex-helper-roles-"));
    try {
      const harness = createHarness({ helperRolesFolder });
      const instructions = 'Review like an owner.\nQuote "exact" lines and paths like C:\\temp.';
      await harness.driver.createSession({
        ...CREATE_PARAMS,
        subagentPolicy: {
          enabled: true,
          helpersAtOnce: 2,
          definitions: [
            {
              name: "sidekicks:reviewer",
              description: "Reviews a change for correctness.",
              prompt: instructions,
              model: "gpt-6-luna",
              effort: "high",
              tools: ["Read"],
              maxTurns: 4,
            },
          ],
        },
      });

      const started = harness.server.paramsFor("thread/start")[0] ?? {};
      const config = started["config"] as Record<string, unknown>;
      const roles = config["agents"] as Record<string, Record<string, unknown>>;
      const roleFile = roles["sidekicks:reviewer"]?.["config_file"];
      expect(roles["sidekicks:reviewer"]?.["description"]).toBe(
        "Reviews a change for correctness.",
      );
      expect(typeof roleFile).toBe("string");
      expect(parse(await readFile(roleFile as string, "utf8"))).toEqual({
        name: "sidekicks:reviewer",
        description: "Reviews a change for correctness.",
        developer_instructions: instructions,
        model: "gpt-6-luna",
        model_reasoning_effort: "high",
      });
      const sentToLead = JSON.stringify(started);
      expect(sentToLead).not.toContain("developer_instructions");
      expect(sentToLead).not.toContain("Review like an owner.");

      await harness.driver.purgeSession({ sessionId: SESSION_ID, conversations: [] });
      expect(await readdir(helperRolesFolder)).toEqual([]);
    } finally {
      await rm(helperRolesFolder, { recursive: true, force: true });
    }
  });
});
