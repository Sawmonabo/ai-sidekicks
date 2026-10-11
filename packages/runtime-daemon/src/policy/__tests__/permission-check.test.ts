// A workflow start through the permission check, under rules that refuse a start from a run at
// Read-only: every check is evaluated, an identical one too, with the machine's owner and the
// asking run's posture read afresh and handed to the rules, so nothing it decided is served again
// after either changed; a trigger's start, which no run asks for, carries no posture. A start whose
// owner does not resolve, or an agent's whose run has no posture to read, is refused without
// evaluation, never judged as a trigger's.

import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ExecutionPosture } from "@ai-sidekicks/contracts/provider/driver/capabilities";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { UserId } from "@ai-sidekicks/contracts/session/id";
import type { WorkflowDefinitionId } from "@ai-sidekicks/contracts/workflow/definition/document";

import { HOST_OPERATING_SYSTEM } from "../../../tests/helpers/host-operating-system.js";
import { loadAuthorizer, type PolicyRequest } from "../authorizer.js";
import { PermissionCheckService } from "../permission-check.js";

const OWNER = "user-1" as UserId;
const WORKFLOW_ID = "workflow-1" as WorkflowDefinitionId;
const ASKING_RUN = "00000000-0000-7000-8000-0000000000b1" as RunId;
const ENDED_RUN = "00000000-0000-7000-8000-0000000000b2" as RunId;
const BUILT_IN_RULES_FOLDER = fileURLToPath(new URL("../rules/", import.meta.url));

function postureAt(mode: ExecutionPosture["mode"]): ExecutionPosture {
  return { mode, writableRoots: [], credentialPolicyRef: "curated-credentials" };
}

let rulesFolder: string;

beforeEach(async () => {
  rulesFolder = await mkdtemp(path.join(tmpdir(), "permission-check-rules-"));
  for (const fileName of ["schema.cedarschema", "workflow.cedar"]) {
    await copyFile(path.join(BUILT_IN_RULES_FOLDER, fileName), path.join(rulesFolder, fileName));
  }
  await writeFile(
    path.join(rulesFolder, "read-only.cedar"),
    `forbid (principal, action == Action::"workflow::start", resource)
       when { context has posture && context.posture.mode == "readonly" };`,
  );
});

afterEach(async () => {
  await rm(rulesFolder, { recursive: true, force: true });
});

// A check over the built-in rules and the Read-only refusal, recording each evaluation.
async function buildCheck(state: {
  owner: UserId | undefined;
  posture: ExecutionPosture | undefined;
}): Promise<{ check: PermissionCheckService; evaluated: PolicyRequest[] }> {
  const evaluated: PolicyRequest[] = [];
  const authorizer = await loadAuthorizer(rulesFolder);
  const check = new PermissionCheckService({
    authorizer: {
      decide: (request) => {
        evaluated.push(request);
        return authorizer.decide(request);
      },
    },
    approvals: {
      create: () => Promise.reject(new Error("a workflow start raises no card")),
      takeCorrection: () => Promise.resolve(false),
    },
    rules: { findRule: () => undefined },
    agentMemoryFolder: "/data/agent-memory",
    pathRules: HOST_OPERATING_SYSTEM.pathRules,
    readRunAgent: () => "agent-1",
    readOwner: () => state.owner,
    readPosture: (runId) => (runId === ASKING_RUN ? state.posture : undefined),
  });
  return { check, evaluated };
}

describe("PermissionCheckService, a workflow start", () => {
  it("decides each start afresh on the run's posture, a trigger's on none", async () => {
    const state = { owner: OWNER, posture: postureAt("ask") as ExecutionPosture | undefined };
    const { check, evaluated } = await buildCheck(state);
    const start = {
      kind: "workflow_start",
      workflowId: WORKFLOW_ID,
      askingRunId: ASKING_RUN,
    } as const;

    // The same start twice: each is evaluated, none answered from the first.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(await check.check(start)).toEqual({ allowed: true, reason: "policy_allow" });
    }
    state.posture = postureAt("readonly");
    expect(await check.check(start)).toMatchObject({ allowed: false, reason: "denied" });
    expect(
      await check.check({
        kind: "workflow_start",
        workflowId: WORKFLOW_ID,
        askingRunId: undefined,
      }),
    ).toEqual({ allowed: true, reason: "policy_allow" });

    expect(evaluated.map((request) => request.context)).toEqual([
      { posture: postureAt("ask") },
      { posture: postureAt("ask") },
      { posture: postureAt("readonly") },
      {},
    ]);
    expect(evaluated.every((request) => request.principal === OWNER)).toBe(true);
  });

  it("refuses unevaluated a start with no owner, or from a run with no posture", async () => {
    const unowned = await buildCheck({ owner: undefined, posture: postureAt("yolo") });
    expect(
      await unowned.check.check({
        kind: "workflow_start",
        workflowId: WORKFLOW_ID,
        askingRunId: ASKING_RUN,
      }),
    ).toMatchObject({ allowed: false, reason: "denied" });
    expect(unowned.evaluated).toEqual([]);

    // An agent's run past its end has no posture; its start is not judged as a trigger's.
    const owned = await buildCheck({ owner: OWNER, posture: postureAt("yolo") });
    expect(
      await owned.check.check({
        kind: "workflow_start",
        workflowId: WORKFLOW_ID,
        askingRunId: ENDED_RUN,
      }),
    ).toMatchObject({ allowed: false, reason: "denied" });
    expect(owned.evaluated).toEqual([]);
  });
});
