// A run's posture is refused by the gate every run engine registers, never rewritten, when it
// breaks a rule; a refused posture never reaches the provider; the resolved posture a stamp reads
// is complete and canonical, and gone for a run the gate never passed or that has ended; the
// curated list resolves to canonical paths.

import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ExecutionPosture } from "@ai-sidekicks/contracts/provider/driver/capabilities";

import { captureRejection } from "../../__fixtures__/capture-failure.js";
import {
  makeQueueItem,
  makeRecordingDriver,
  openRunEngineFixture,
  type RunEngineFixture,
} from "../../session/run/__tests__/engine.test-support.js";
import {
  CURATED_CREDENTIAL_ENV_VARS,
  CURATED_CREDENTIAL_POLICY_REF,
  ExecutionPostureRejectedError,
  ExecutionPostureService,
  type ExecutionPostureRejection,
} from "../execution-posture-service.js";

let scratch: string;
// A real folder and a link to it, so canonicalization has a symlink to resolve.
let realRoot: string;
let linkedRoot: string;

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "execution-posture-"));
  realRoot = path.join(scratch, "worktree");
  linkedRoot = path.join(scratch, "worktree-link");
  await mkdir(realRoot);
  await symlink(realRoot, linkedRoot);
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

function posture(overrides: Partial<ExecutionPosture>): ExecutionPosture {
  return {
    mode: "sandboxed",
    writableRoots: [],
    credentialPolicyRef: CURATED_CREDENTIAL_POLICY_REF,
    ...overrides,
  };
}

describe("execution posture service — the run setup gate", () => {
  let fixture: RunEngineFixture;

  beforeEach(async () => {
    fixture = await openRunEngineFixture();
  });

  afterEach(async () => {
    await fixture.close();
  });

  const violations: readonly {
    readonly label: string;
    readonly posture: () => ExecutionPosture;
    readonly reason: ExecutionPostureRejection;
  }[] = [
    {
      label: "a posture with no credential policy",
      posture: () => {
        const { credentialPolicyRef: _omitted, ...withoutPolicy } = posture({});
        return withoutPolicy as ExecutionPosture;
      },
      reason: "unknown_credential_policy",
    },
    {
      label: "a credential policy other than the curated list",
      posture: () => posture({ credentialPolicyRef: "policy://default" }),
      reason: "unknown_credential_policy",
    },
    {
      label: "read-only with a writable root",
      posture: () => posture({ mode: "readonly", writableRoots: [realRoot] }),
      reason: "readonly_writable_roots",
    },
    {
      label: "YOLO supplied with a writable root",
      posture: () => posture({ mode: "yolo", writableRoots: [realRoot] }),
      reason: "yolo_writable_roots",
    },
    {
      label: "a relative writable root",
      posture: () => posture({ mode: "ask", writableRoots: ["worktree"] }),
      reason: "relative_writable_root",
    },
    {
      label: "a writable root that does not exist",
      posture: () => posture({ writableRoots: [path.join(scratch, "missing")] }),
      reason: "unresolvable_writable_root",
    },
  ];

  it.each(violations)(
    "refuses $label: the run fails, the driver is never handed it, nothing is kept",
    async ({ posture: violating, reason }) => {
      const service = fixture.executionPostures;
      const driver = makeRecordingDriver();
      const runId = await fixture.queueRun();

      const error = await captureRejection(
        fixture.engine.startRun({
          runId,
          queueItem: makeQueueItem(),
          provider: "claude",
          driver,
          driverParams: { agentConfig: {} },
          executionPosture: violating(),
        }),
      );

      expect(error).toBeInstanceOf(ExecutionPostureRejectedError);
      expect((error as ExecutionPostureRejectedError).reason).toBe(reason);
      expect(driver.startedRuns).toHaveLength(0);
      expect(fixture.runs.getRun(runId)?.state).toBe("failed");
      expect(service.resolvedPostureFor(runId)).toBeUndefined();
    },
  );

  it("keeps the complete canonical posture for a gated run until it ends", async () => {
    const service = fixture.executionPostures;
    const runId = await fixture.queueRun();
    const neverGated = await fixture.queueRun();

    await fixture.engine.startRun({
      runId,
      queueItem: makeQueueItem(),
      provider: "claude",
      driver: makeRecordingDriver(),
      driverParams: { agentConfig: {} },
      executionPosture: posture({ writableRoots: [linkedRoot] }),
    });

    expect(service.resolvedPostureFor(runId)).toStrictEqual({
      mode: "sandboxed",
      writableRoots: [await realpath(realRoot)],
      credentialPolicyRef: CURATED_CREDENTIAL_POLICY_REF,
    });
    expect(service.resolvedPostureFor(neverGated)).toBeUndefined();

    await fixture.engine.transition({ runId, newState: "interrupted" });

    expect(service.resolvedPostureFor(runId)).toBeUndefined();
  });
});

describe("execution posture service — the curated credential list", () => {
  it("resolves each path against the home, following a link and keeping an absent path", async () => {
    const keysFolder = path.join(scratch, "keys");
    await mkdir(keysFolder);
    await symlink(keysFolder, path.join(scratch, ".ssh"));
    const service = new ExecutionPostureService({ homeDirectory: scratch });

    const policy = await service.resolveCredentialPolicy(CURATED_CREDENTIAL_POLICY_REF);

    expect(policy).toStrictEqual({
      credentialPolicyRef: CURATED_CREDENTIAL_POLICY_REF,
      denyPaths: [await realpath(keysFolder), path.join(scratch, ".aws")],
      denyEnvVars: CURATED_CREDENTIAL_ENV_VARS,
    });
  });

  it("refuses to resolve any list but the curated one", async () => {
    const service = new ExecutionPostureService({ homeDirectory: scratch });

    const error = await captureRejection(service.resolveCredentialPolicy("policy://default"));

    expect(error).toBeInstanceOf(ExecutionPostureRejectedError);
  });
});
