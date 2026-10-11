// The built-in rules let the machine's owning user start a workflow an agent or a trigger asks for,
// with or without the asking run's posture, and a start whose owning user did not resolve is
// denied. The posture reaches the rules: a rule over it decides the start.

import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ExecutionPosture } from "@ai-sidekicks/contracts/provider/driver/capabilities";
import type { UserId } from "@ai-sidekicks/contracts/session/id";
import type { WorkflowDefinitionId } from "@ai-sidekicks/contracts/workflow/definition/document";

import { loadAuthorizer } from "../authorizer.js";
import { checkWorkflowStart } from "../workflow-start.js";

const OWNER = "user-1" as UserId;
const WORKFLOW_ID = "workflow-1" as WorkflowDefinitionId;
const BUILT_IN_RULES_FOLDER = fileURLToPath(new URL("../rules/", import.meta.url));

function postureAt(mode: ExecutionPosture["mode"]): ExecutionPosture {
  return {
    mode,
    writableRoots: mode === "sandboxed" ? ["/work/repo/.git"] : [],
    credentialPolicyRef: "curated-credentials",
  };
}

let rulesFolder: string;

beforeEach(async () => {
  rulesFolder = await mkdtemp(path.join(tmpdir(), "workflow-start-rules-"));
});

afterEach(async () => {
  await rm(rulesFolder, { recursive: true, force: true });
});

describe("checkWorkflowStart", () => {
  it("allows the owning user's start under the built-in rules and denies an unresolved owner", async () => {
    const authorizer = await loadAuthorizer();

    for (const posture of [undefined, postureAt("ask"), postureAt("sandboxed")]) {
      expect(
        checkWorkflowStart(authorizer, { owner: OWNER, workflowId: WORKFLOW_ID, posture }),
      ).toEqual({ decision: "allow" });
    }
    expect(
      checkWorkflowStart(authorizer, {
        owner: undefined,
        workflowId: WORKFLOW_ID,
        posture: postureAt("yolo"),
      }),
    ).toMatchObject({ decision: "deny" });
  });

  it("hands the asking run's posture to the rules, which decide on it", async () => {
    for (const fileName of ["schema.cedarschema", "workflow.cedar"]) {
      await copyFile(path.join(BUILT_IN_RULES_FOLDER, fileName), path.join(rulesFolder, fileName));
    }
    await writeFile(
      path.join(rulesFolder, "read-only.cedar"),
      `forbid (principal, action == Action::"workflow::start", resource)
         when { context has posture && context.posture.mode == "readonly" };`,
    );
    const authorizer = await loadAuthorizer(rulesFolder);

    expect(
      checkWorkflowStart(authorizer, {
        owner: OWNER,
        workflowId: WORKFLOW_ID,
        posture: postureAt("readonly"),
      }),
    ).toEqual({ decision: "deny", errors: [] });
    expect(
      checkWorkflowStart(authorizer, {
        owner: OWNER,
        workflowId: WORKFLOW_ID,
        posture: postureAt("yolo"),
      }),
    ).toEqual({ decision: "allow" });
  });
});
