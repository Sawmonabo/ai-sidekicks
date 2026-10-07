// Worktree states never mix with repo or workspace states, a prepare request cannot forge the run
// provenance the daemon stamps, and the switcher's read never lists a retired tree.
import { describe, expect, it } from "vitest";

import { SESSION_EVENT_CATEGORY_BY_TYPE, SessionEventSchema } from "../../event/session.js";
import {
  ExecutionRootPrepareRequestSchema,
  ExecutionRootPrepareResponseSchema,
  WorktreeIdSchema,
  WorktreeLifecyclePayloadSchema,
  WorktreeRetireRequestSchema,
  WorktreeRetireResponseSchema,
  WorktreeStateSchema,
  WorktreeStatusReadRequestSchema,
  WorktreeStatusReadResponseSchema,
  type BranchContextId,
  type WorktreeId,
} from "../lifecycle.js";
import {
  CREATED_AT,
  REGISTERED_WORKTREE_EVENTS,
  REPO_MOUNT_ID,
  SESSION_ID,
  WORKSPACE_ID,
  WORKTREE_ID,
  buildWorktreeEvent,
} from "./lifecycle.test-support.js";

// Real RFC 9562 UUIDs (v4 and v7): the schemas validate the version nibble and variant bits,
// so lookalike strings would not parse.
const PROJECT_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f13";
const BRANCH_CONTEXT_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f14";
const RUN_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f15";
const EXECUTION_ROOT = "/Users/dev/.ai-sidekicks/worktrees/beacon/1a2b3c4d-fix-login-bug";
const BRANCH_NAME = "sidekicks/550e8400/add-worktree-wire-pairs";
const UPDATED_AT = "2026-07-26T09:31:00.000Z";

describe("WorktreeStateSchema (the six-state worktree lifecycle)", () => {
  it.each([
    ["creating", true],
    ["ready", true],
    ["dirty", true],
    ["merged", true],
    ["retired", true],
    // `failed` is a row state with no `worktree.*` event of its own, but it is in the vocabulary.
    ["failed", true],
    // Repo and workspace states are separate vocabularies, not part of this one.
    ["preparing", false],
    ["attached", false],
    ["detached", false],
    ["busy", false],
    ["stale", false],
    ["archived", false],
    ["CREATING", false],
    ["retiring", false],
    ["", false],
  ])("parses %s -> %s", (candidate, shouldPass) => {
    expect(WorktreeStateSchema.safeParse(candidate).success).toBe(shouldPass);
  });
});

describe("WorktreeLifecyclePayloadSchema (the lifecycle payload over worktree states)", () => {
  it.each(["attached", "detached", "preparing", "busy", "stale", "archived"])(
    "rejects the repo or workspace state %s",
    (state) => {
      // `archived` is in both of the other vocabularies and not in this one.
      expect(
        WorktreeLifecyclePayloadSchema.safeParse({
          sessionId: SESSION_ID,
          worktreeId: WORKTREE_ID,
          state,
        }).success,
      ).toBe(false);
    },
  );
});

describe("SessionEventSchema registration of the five worktree events", () => {
  it.each(REGISTERED_WORKTREE_EVENTS)(
    "%s parses end-to-end through the union carrying state %s",
    (eventType, state) => {
      const parsed = SessionEventSchema.parse(buildWorktreeEvent(eventType, state));
      expect(parsed.type).toBe(eventType);
      expect(parsed.category).toBe("session_lifecycle");
      // The arm's own literal produced the category above, so only the separate registry catches
      // an arm and registry that disagree (`category` is part of the canonical bytes).
      expect(SESSION_EVENT_CATEGORY_BY_TYPE.get(eventType)).toBe("session_lifecycle");
      // No payload key is added, dropped or coerced on the way through the union.
      expect(parsed.payload).toStrictEqual(buildWorktreeEvent(eventType, state).payload);
    },
  );

  it("rejects a repo or workspace state through a worktree event", () => {
    expect(
      SessionEventSchema.safeParse(buildWorktreeEvent("worktree.ready", "attached")).success,
    ).toBe(false);
    expect(
      SessionEventSchema.safeParse(buildWorktreeEvent("worktree.created", "preparing")).success,
    ).toBe(false);
  });

  it("rejects `worktree.failed` whatever its payload state", () => {
    // With `state: "ready"` the payload alone would parse, so the rejection is the missing type
    // arm. A failed creation is evented as `workspace.stale`.
    expect(
      SessionEventSchema.safeParse(buildWorktreeEvent("worktree.failed", "ready")).success,
    ).toBe(false);
    expect(
      SessionEventSchema.safeParse(buildWorktreeEvent("worktree.failed", "failed")).success,
    ).toBe(false);
  });
});

// Compile-time pins, never executed: `tsc -p tsconfig.test.json` fails if a brand decays to a
// plain string or the two brands collapse into one.
const brandNominalityPin = (): void => {
  // @ts-expect-error — a raw string is not a WorktreeId without a parse.
  const unbrandedWorktreeId: WorktreeId = WORKTREE_ID;
  void unbrandedWorktreeId;
  // @ts-expect-error — a raw string is not a BranchContextId without a parse.
  const unbrandedBranchContextId: BranchContextId = BRANCH_CONTEXT_ID;
  void unbrandedBranchContextId;
  // @ts-expect-error — a parsed WorktreeId is not a BranchContextId.
  const crossBrand: BranchContextId = WorktreeIdSchema.parse(WORKTREE_ID);
  void crossBrand;
};
void brandNominalityPin;

const parsePrepareRequest = (overrides: Record<string, unknown> = {}) =>
  ExecutionRootPrepareRequestSchema.safeParse({ workspaceId: WORKSPACE_ID, ...overrides });

describe("ExecutionRootPrepare request (create or bind)", () => {
  it("carries no wire runId, since the daemon supplies run provenance", () => {
    // The run-setup gate calls the service directly and supplies the run id. A wire `runId`
    // would let a caller forge provenance, so `.strict()` refuses the key.
    expect(parsePrepareRequest({ runId: RUN_ID }).success).toBe(false);
  });
});

describe("ExecutionRootPrepare response", () => {
  it.each([
    ["provisioned-worktree mode", { worktreeId: WORKTREE_ID, branchContextId: BRANCH_CONTEXT_ID }],
    ["bound-root mode", { branchContextId: BRANCH_CONTEXT_ID }],
  ] as const)("accepts the %s shape", (_label, idFields) => {
    const response = { executionRoot: EXECUTION_ROOT, state: "ready", ...idFields };
    expect(ExecutionRootPrepareResponseSchema.safeParse(response).success).toBe(true);
  });
});

describe("WorktreeRetire", () => {
  it("accepts a retire naming the worktree, and its retired answer", () => {
    expect(
      WorktreeRetireRequestSchema.safeParse({ worktreeId: WORKTREE_ID, discard: false }).success,
    ).toBe(true);
    expect(
      WorktreeRetireResponseSchema.safeParse({ worktreeId: WORKTREE_ID, state: "retired" }).success,
    ).toBe(true);
  });
});

// A live, run-created checkout, with the figures its switcher row draws.
const buildWorktreeStatusRecord = () => ({
  madeBy: "app",
  worktreeId: WORKTREE_ID,
  repoMountId: REPO_MOUNT_ID,
  name: "1a2b3c4d-fix-login-bug",
  branchName: BRANCH_NAME,
  baseBranchName: "main",
  path: EXECUTION_ROOT,
  state: "ready",
  ahead: 2,
  behind: 1,
  uncommittedFileCount: 3,
  unpushedCommitCount: 2,
  occupyingSessionIds: [SESSION_ID],
  runningSessionId: null,
  createdBySessionId: SESSION_ID,
  createdByRunId: RUN_ID,
  createdAt: CREATED_AT,
  updatedAt: UPDATED_AT,
});
const buildWorktreeStatusReadResponse = () => ({
  repoRoot: { path: "/Users/dev/code/beacon", branchName: "main" },
  worktrees: [buildWorktreeStatusRecord()],
  countsAsOf: CREATED_AT,
  newWorktree: {
    fixedPart: "sidekicks/1a2b3c4d/",
    suggestedTail: "fix-login-bug",
    folderBefore: "~/.ai-sidekicks/worktrees/beacon/1a2b3c4d-",
  },
});
const parseStatusReadWithRow = (row: Record<string, unknown>) =>
  WorktreeStatusReadResponseSchema.safeParse({
    ...buildWorktreeStatusReadResponse(),
    worktrees: [row],
  });
const parseStatusReadWithWorktree = (overrides: Record<string, unknown> = {}) =>
  parseStatusReadWithRow({ ...buildWorktreeStatusRecord(), ...overrides });

describe("WorktreeStatusRead (the switcher's one read, keyed by the project)", () => {
  it("is keyed by the project, with the asking session optional", () => {
    expect(
      WorktreeStatusReadRequestSchema.safeParse({
        projectId: PROJECT_ID,
        sessionId: SESSION_ID,
      }).success,
    ).toBe(true);
    expect(WorktreeStatusReadRequestSchema.safeParse({ projectId: PROJECT_ID }).success).toBe(true);
    expect(WorktreeStatusReadRequestSchema.safeParse({ repoMountId: REPO_MOUNT_ID }).success).toBe(
      false,
    );
  });

  it("accepts a full status read: root row, tree figures, fetch age, suggestion", () => {
    expect(
      WorktreeStatusReadResponseSchema.safeParse(buildWorktreeStatusReadResponse()).success,
    ).toBe(true);
  });

  it("never lists a retired tree", () => {
    expect(parseStatusReadWithWorktree({ state: "retired" }).success).toBe(false);
    expect(parseStatusReadWithWorktree({ state: "failed" }).success).toBe(true);
  });

  it("requires the creator of a tree the app made, and no record on one the person made", () => {
    const { createdBySessionId: _createdBy, ...withoutCreator } = buildWorktreeStatusRecord();
    expect(parseStatusReadWithRow(withoutCreator).success).toBe(false);
    const personMade = {
      madeBy: "person",
      path: "/Users/dev/code/beacon-hotfix",
      name: "beacon-hotfix",
      branchName: "hotfix",
      uncommittedFileCount: 0,
      unpushedCommitCount: 0,
      occupyingSessionIds: [],
      runningSessionId: null,
    };
    expect(parseStatusReadWithRow(personMade).success).toBe(true);
    expect(parseStatusReadWithRow({ ...personMade, worktreeId: WORKTREE_ID }).success).toBe(false);
  });
});
