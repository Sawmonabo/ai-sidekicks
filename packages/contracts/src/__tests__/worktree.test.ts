// The worktree contract: the branded ids, the lifecycle state enum, the lifecycle payload, the
// five `worktree.*` session events, and the request/response pairs. The registry stays closed:
// `worktree.failed` is rejected by the union and absent from the event roster and census.
import { describe, expect, it } from "vitest";

import { SESSION_EVENT_CATEGORY_BY_TYPE } from "../event.js";
import { SESSION_EVENT_TYPES } from "../event-registry.js";
import { SessionEventSchema } from "../event.js";
import {
  WorktreeCreatedEventSchema,
  WorktreeDirtyEventSchema,
  WorktreeMergedEventSchema,
  WorktreeReadyEventSchema,
  WorktreeRetiredEventSchema,
} from "../event-declared-variants.js";
import type { SessionEvent } from "../event-variant-types.js";
import * as contracts from "../index.js";
// The aliased import below is worktree.ts's re-export, under a distinct name so the identity
// check compares two surfaces rather than one to itself.
import { ExecutionModeSchema, RepoMountIdSchema } from "../repo.js";
import { FILE_PATH_MAX_LEN } from "../session.js";
import {
  BranchContextIdSchema,
  ExecutionModeSchema as ExecutionModeSchemaFromWorktreeReExport,
  ExecutionModeSelectRequestSchema,
  ExecutionModeSelectResponseSchema,
  ExecutionRootPrepareRequestSchema,
  ExecutionRootPrepareResponseSchema,
  WORKTREE_GIT_REF_MAX_LEN,
  WORKTREE_REUSE_REASON_MAX_LEN,
  WorktreeIdSchema,
  WorktreeLifecyclePayloadSchema,
  WorktreeRetireConflictDetailsSchema,
  WorktreeRetireRequestSchema,
  WorktreeRetireResponseSchema,
  WorktreeReuseCheckRequestSchema,
  WorktreeReuseCheckResponseSchema,
  WorktreeStateSchema,
  WorktreeStatusReadRequestSchema,
  WorktreeStatusReadResponseSchema,
  type BranchContextId,
  type WorktreeId,
  type WorktreeLifecyclePayload,
  type WorktreeRetireResponse,
  type WorktreeState,
  type WorktreeStatusReadResponse,
} from "../worktree.js";

// Real RFC 9562 UUIDs (v4 and v7): the schemas validate the version nibble and variant bits,
// so lookalike strings would not parse.
const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
const REPO_MOUNT_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f10";
const WORKSPACE_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f11";
const WORKTREE_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f12";
const BRANCH_CONTEXT_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f14";
const USER_ID = "660e8400-e29b-41d4-a716-446655440001";
const OCCURRED_AT = "2026-07-26T09:30:00.000Z";
const VERSION = "1.0";

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
    // Case drift and unknown states are refused.
    ["CREATING", false],
    ["retiring", false],
    ["", false],
  ])("parses %s -> %s", (candidate, shouldPass) => {
    expect(WorktreeStateSchema.safeParse(candidate).success).toBe(shouldPass);
  });

  it("enumerates exactly the six canonical states in the ratified CHECK order", () => {
    // Order matters, not just membership: it mirrors the `worktrees.state` CHECK clause in the
    // daemon schema, so a reorder fails here and forces a re-sync. It is not a wire break, since
    // the literal string is what serializes.
    const schemaInternals = WorktreeStateSchema as unknown as { options: readonly string[] };
    expect(schemaInternals.options).toEqual([
      "creating",
      "ready",
      "dirty",
      "merged",
      "retired",
      "failed",
    ]);
  });
});

// Typed structurally: the two schemas have distinct branded output types, so an unannotated
// array would widen `schema` to a union that includes `string` and `.parse` would not resolve.
const BRANDED_ID_SCHEMAS: ReadonlyArray<
  readonly [
    string,
    {
      parse: (candidate: unknown) => string;
      safeParse: (candidate: unknown) => { success: boolean };
    },
    string,
  ]
> = [
  ["WorktreeIdSchema", WorktreeIdSchema, WORKTREE_ID],
  ["BranchContextIdSchema", BranchContextIdSchema, BRANCH_CONTEXT_ID],
];

describe("branded worktree / branch-context ids", () => {
  it.each(BRANDED_ID_SCHEMAS)(
    "%s accepts a canonical UUID and rejects non-UUID input",
    (_label, schema, uuid) => {
      const parsed = schema.parse(uuid);
      // The brand is compile-time only.
      expect(parsed).toBe(uuid);
      expect(schema.safeParse("worktree-1").success).toBe(false);
      expect(schema.safeParse("").success).toBe(false);
      // The version nibble below is `0`, which RFC 9562 does not define.
      expect(schema.safeParse("0190f8a0-7e2d-0c4a-9b1c-1b7c5b3e8f12").success).toBe(false);
    },
  );

  // Compile-time pins, never executed: `tsc -p tsconfig.test.json` fails if a brand decays to
  // a plain string or the two brands collapse into one.
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
});

// The payload factory's own contract is tested in repo.test.ts; this block pins the accept
// boundary of the worktree instantiation.

const buildWorktreePayload = (state: WorktreeState): WorktreeLifecyclePayload => ({
  // Cast on the id field only: the payload type brands `sessionId`, and every parse row below
  // still validates the runtime value.
  sessionId: SESSION_ID as WorktreeLifecyclePayload["sessionId"],
  worktreeId: WORKTREE_ID,
  state,
});

describe("WorktreeLifecyclePayloadSchema (the family shape over this plan's vocabulary)", () => {
  it.each(["creating", "ready", "dirty", "merged", "retired", "failed"])(
    "accepts the worktree vocabulary member %s",
    (state) => {
      // `failed` is representable because the state enum is the row vocabulary; that no
      // `worktree.*` event carries it is the closed-registry test below.
      expect(
        WorktreeLifecyclePayloadSchema.safeParse({ sessionId: SESSION_ID, state }).success,
      ).toBe(true);
    },
  );

  it.each(["attached", "detached", "preparing", "busy", "stale", "archived"])(
    "REJECTS the base-family vocabulary member %s (per-family accept set)",
    (state) => {
      // A worktree payload can never claim a repo or workspace state (`archived` is in both
      // of those vocabularies and in neither of this one).
      expect(
        WorktreeLifecyclePayloadSchema.safeParse({
          sessionId: SESSION_ID,
          worktreeId: WORKTREE_ID,
          state,
        }).success,
      ).toBe(false);
    },
  );

  it("carries the full family field set", () => {
    expect(
      WorktreeLifecyclePayloadSchema.safeParse({
        sessionId: SESSION_ID,
        repoMountId: REPO_MOUNT_ID,
        workspaceId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        state: "ready",
        actor: USER_ID,
      }).success,
    ).toBe(true);
  });

  it("keeps `worktreeId` optional at the SHAPE layer (emitter discipline fills it)", () => {
    // The family shape marks all three subject ids optional; the emitter supplies the right one.
    expect(
      WorktreeLifecyclePayloadSchema.safeParse({ sessionId: SESSION_ID, state: "creating" })
        .success,
    ).toBe(true);
  });

  it("requires `sessionId` and validates `worktreeId` as a canonical UUID", () => {
    expect(WorktreeLifecyclePayloadSchema.safeParse({ state: "ready" }).success).toBe(false);
    expect(
      WorktreeLifecyclePayloadSchema.safeParse({
        sessionId: SESSION_ID,
        worktreeId: "worktree-1",
        state: "ready",
      }).success,
    ).toBe(false);
  });

  it("rejects extraneous keys (.strict() carried through the factory)", () => {
    expect(
      WorktreeLifecyclePayloadSchema.safeParse({
        ...buildWorktreePayload("ready"),
        extra: "leak",
      }).success,
    ).toBe(false);
  });

  it("keeps the wire/replay actor guards (NUL byte rejected; null and omission accepted)", () => {
    expect(
      WorktreeLifecyclePayloadSchema.safeParse({
        ...buildWorktreePayload("ready"),
        actor: `agent${String.fromCharCode(0)}injected`,
      }).success,
    ).toBe(false);
    expect(
      WorktreeLifecyclePayloadSchema.safeParse({ ...buildWorktreePayload("ready"), actor: null })
        .success,
    ).toBe(true);
    // Omission is separate from `null`: `.optional()` and `.nullable()` are independent, so a
    // schema that dropped one would still pass the row above.
    expect(WorktreeLifecyclePayloadSchema.safeParse(buildWorktreePayload("ready")).success).toBe(
      true,
    );
  });
});

// Each event type with the state its emitter writes (row creation is `worktree.created`,
// `creating -> ready` is `worktree.ready`, and so on; `-> failed` has no event). The element
// type is load-bearing: `SessionEvent["type"]` is the registered union's discriminant, so
// dropping an arm from `SessionEventSchema` stops this fixture compiling instead of silently
// thinning the table.
const REGISTERED_WORKTREE_EVENTS: ReadonlyArray<readonly [SessionEvent["type"], WorktreeState]> = [
  ["worktree.created", "creating"],
  ["worktree.ready", "ready"],
  ["worktree.dirty", "dirty"],
  ["worktree.merged", "merged"],
  ["worktree.retired", "retired"],
];

// A worktree event carries the worktree id plus the mount and workspace it serves, so the
// family shape has no "exactly one id" refinement.
const buildWorktreeEvent = (eventType: string, state: string) => ({
  id: "evt-worktree-0001",
  sessionId: SESSION_ID,
  sequence: 11,
  occurredAt: OCCURRED_AT,
  category: "session_lifecycle" as const,
  type: eventType,
  actor: USER_ID,
  version: VERSION,
  payload: {
    sessionId: SESSION_ID,
    repoMountId: REPO_MOUNT_ID,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    state,
  },
});

describe("SessionEventSchema registration of the five variants", () => {
  it.each(REGISTERED_WORKTREE_EVENTS)(
    "%s parses end-to-end through the union carrying state %s",
    (eventType, state) => {
      const parsed = SessionEventSchema.parse(buildWorktreeEvent(eventType, state));
      expect(parsed.type).toBe(eventType);
      expect(parsed.category).toBe("session_lifecycle");
      // The arm's own literal produced the category above, so only the separate registry
      // catches an arm/registry disagreement (`category` is part of the canonical bytes).
      expect(SESSION_EVENT_CATEGORY_BY_TYPE.get(eventType)).toBe("session_lifecycle");
      // No payload key is added, dropped or coerced on the way through the union.
      expect(parsed.payload).toStrictEqual(buildWorktreeEvent(eventType, state).payload);
    },
  );

  it.each(REGISTERED_WORKTREE_EVENTS)(
    "%s round-trips through JSON without loss",
    (eventType, state) => {
      const firstPass = SessionEventSchema.parse(buildWorktreeEvent(eventType, state));
      const secondPass = SessionEventSchema.parse(JSON.parse(JSON.stringify(firstPass)) as unknown);
      expect(secondPass).toStrictEqual(firstPass);
    },
  );

  it.each(REGISTERED_WORKTREE_EVENTS)(
    "%s rejects a category/type mismatch (the canonical-bytes guard)",
    (eventType, state) => {
      const broken = {
        ...buildWorktreeEvent(eventType, state),
        category: "usage_telemetry" as const,
      };
      expect(SessionEventSchema.safeParse(broken).success).toBe(false);
    },
  );

  it("rejects a base-vocabulary state through the union branch (the per-family pin, union level)", () => {
    // A registered `worktree.*` arm must not admit a repo or workspace state.
    expect(
      SessionEventSchema.safeParse(buildWorktreeEvent("worktree.ready", "attached")).success,
    ).toBe(false);
    expect(
      SessionEventSchema.safeParse(buildWorktreeEvent("worktree.created", "preparing")).success,
    ).toBe(false);
  });

  it("rejects an unknown payload key on a worktree variant (.strict() reaches the union branch)", () => {
    const event = buildWorktreeEvent("worktree.created", "creating");
    const broken = { ...event, payload: { ...event.payload, smuggled: "nope" } };
    expect(SessionEventSchema.safeParse(broken).success).toBe(false);
  });

  it("lists all five types in SESSION_EVENT_TYPES (the same-diff roster rule)", () => {
    // The roster is hand-written; its full order is pinned in session-event.test.ts.
    expect(SESSION_EVENT_TYPES).toEqual(
      expect.arrayContaining([
        "worktree.created",
        "worktree.ready",
        "worktree.dirty",
        "worktree.merged",
        "worktree.retired",
      ]),
    );
  });
});

// The emitter validates against the standalone schemas before appending, so they must agree
// with the union arms. Typed structurally to sidestep `z.ZodType` variance.
const STANDALONE_WORKTREE_EVENT_SCHEMAS: ReadonlyArray<
  readonly [
    SessionEvent["type"],
    WorktreeState,
    { safeParse: (candidate: unknown) => { success: boolean } },
  ]
> = [
  ["worktree.created", "creating", WorktreeCreatedEventSchema],
  ["worktree.ready", "ready", WorktreeReadyEventSchema],
  ["worktree.dirty", "dirty", WorktreeDirtyEventSchema],
  ["worktree.merged", "merged", WorktreeMergedEventSchema],
  ["worktree.retired", "retired", WorktreeRetiredEventSchema],
];

describe("standalone worktree event schemas agree with the union arms", () => {
  it.each(STANDALONE_WORKTREE_EVENT_SCHEMAS)(
    "%s standalone accepts what the union accepts (state %s)",
    (eventType, state, standaloneSchema) => {
      const fixture = buildWorktreeEvent(eventType, state);
      expect(standaloneSchema.safeParse(fixture).success).toBe(true);
      expect(SessionEventSchema.safeParse(fixture).success).toBe(true);
    },
  );

  it.each(STANDALONE_WORKTREE_EVENT_SCHEMAS)(
    "%s standalone rejects what the union rejects (base-vocabulary state)",
    (eventType, _state, standaloneSchema) => {
      const broken = buildWorktreeEvent(eventType, "attached");
      expect(standaloneSchema.safeParse(broken).success).toBe(false);
      expect(SessionEventSchema.safeParse(broken).success).toBe(false);
    },
  );

  it.each(STANDALONE_WORKTREE_EVENT_SCHEMAS)(
    "%s standalone refuses a spurious ENVELOPE key and a category mismatch (state %s)",
    (eventType, state, standaloneSchema) => {
      // The outer `.strict()` has no compile-time backstop: an inferred type does not show it,
      // so a standalone schema that dropped it would typecheck and strip the stray key instead
      // of rejecting it. The emitter would then append bytes it never built, and replay would
      // reject them much later.
      const fixture = buildWorktreeEvent(eventType, state);
      const withSpuriousEnvelopeKey = { ...fixture, spuriousEnvelopeKey: "x" };
      expect(standaloneSchema.safeParse(withSpuriousEnvelopeKey).success).toBe(false);
      expect(SessionEventSchema.safeParse(withSpuriousEnvelopeKey).success).toBe(false);
      // `category` is part of the canonical bytes, so the standalone schema pins it too.
      const withMismatchedCategory = { ...fixture, category: "usage_telemetry" as const };
      expect(standaloneSchema.safeParse(withMismatchedCategory).success).toBe(false);
      expect(SessionEventSchema.safeParse(withMismatchedCategory).success).toBe(false);
    },
  );
});

describe("registry stays closed", () => {
  it("rejects `worktree.failed` through the union regardless of payload state", () => {
    // With `state: "ready"` the payload would parse under a family arm, so the rejection is
    // purely the missing type arm. A `-> failed` transition emits no worktree event; the
    // failure is evented as `workspace.stale`.
    expect(
      SessionEventSchema.safeParse(buildWorktreeEvent("worktree.failed", "ready")).success,
    ).toBe(false);
    expect(
      SessionEventSchema.safeParse(buildWorktreeEvent("worktree.failed", "failed")).success,
    ).toBe(false);
  });

  it("keeps `worktree.failed` out of the roster AND out of the census", () => {
    // The lookups are widened because a literal in neither cannot be passed at the declared
    // key type.
    expect(SESSION_EVENT_TYPES as readonly string[]).not.toContain("worktree.failed");
    expect(SESSION_EVENT_CATEGORY_BY_TYPE.has("worktree.failed" as never)).toBe(false);
  });
});

describe("execution-mode taxonomy (import)", () => {
  it("re-exports the canonical schema VALUE by identity, never a fork", () => {
    // A two-member enum redefined in worktree.ts would pass every `.options` assertion; only
    // object identity refuses it.
    expect(ExecutionModeSchemaFromWorktreeReExport).toBe(ExecutionModeSchema);
  });
});

describe("index.ts re-exports contract core", () => {
  it("re-exports every runtime symbol by identity (the barrel-gap regression)", () => {
    expect(contracts.WorktreeIdSchema).toBe(WorktreeIdSchema);
    expect(contracts.BranchContextIdSchema).toBe(BranchContextIdSchema);
    expect(contracts.WorktreeStateSchema).toBe(WorktreeStateSchema);
    expect(contracts.WorktreeLifecyclePayloadSchema).toBe(WorktreeLifecyclePayloadSchema);
    expect(contracts.WorktreeCreatedEventSchema).toBe(WorktreeCreatedEventSchema);
    expect(contracts.WorktreeReadyEventSchema).toBe(WorktreeReadyEventSchema);
    expect(contracts.WorktreeDirtyEventSchema).toBe(WorktreeDirtyEventSchema);
    expect(contracts.WorktreeMergedEventSchema).toBe(WorktreeMergedEventSchema);
    expect(contracts.WorktreeRetiredEventSchema).toBe(WorktreeRetiredEventSchema);
  });

  // Compile-time reachability of the types through the barrel, never executed.
  const barrelTypeSurfacePin = (): void => {
    const worktreeState: contracts.WorktreeState = "merged";
    void worktreeState;
    const executionMode: contracts.ExecutionMode = "provisioned-worktree";
    void executionMode;
    const worktreeId: contracts.WorktreeId = WorktreeIdSchema.parse(WORKTREE_ID);
    void worktreeId;
    const payload: contracts.WorktreeLifecyclePayload = buildWorktreePayload("ready");
    void payload;
  };
  void barrelTypeSurfacePin;
});

// Every `state` field composes the canonical enum object, so a re-spelled literal union fails
// the vocabulary rows below. Execution-root prepare leaves `branchName` optional in the schema
// and the service refuses its absence.
//
// The `.strict()` rows at the end of this file are the only guard on closed shapes: an outer
// `.strict()` leaves no trace in the inferred type, so a dropped one typechecks and silently
// strips the unknown key. They cover the ten exported schemas plus the status-read item schema,
// which is closed independently of its envelope, and each also proves its fixture parses.

const RUN_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f15";
const EXECUTION_ROOT = "/Users/dev/.ai-sidekicks/execution-roots/mount-0190f8a0/worktrees/wt-01";
const BRANCH_NAME = "sidekicks/550e8400/add-worktree-wire-pairs";
const BASE_REF = "main";
const CREATED_AT = "2026-07-26T09:30:00.000Z";
const UPDATED_AT = "2026-07-26T09:31:00.000Z";

// The inputs that separate `wireFreeFormString` from a bare `z.string()`: empty, whitespace
// only, and an embedded NUL byte. A downgrade at one call site is otherwise invisible, since
// the inferred type stays `string`. Fields whose cap row already fails a bare `z.string()`
// (`baseRef`, the reuse response's `branchName`, `reason`) need no row here.
const GUARD_DOWNGRADE_VALUES: readonly string[] = [
  "",
  "   ",
  `sidekicks/550e8400/wire${String.fromCharCode(0)}/etc`,
];

const buildExecutionModeSelectRequest = () => ({
  workspaceId: WORKSPACE_ID,
  executionMode: "provisioned-worktree",
});
const buildExecutionModeSelectResponse = () => ({
  workspaceId: WORKSPACE_ID,
  executionMode: "provisioned-worktree",
  state: "preparing",
});

// The minimal lawful prepare request.
const buildExecutionRootPrepareRequest = () => ({ workspaceId: WORKSPACE_ID });
const buildExecutionRootPrepareResponse = () => ({
  executionRoot: EXECUTION_ROOT,
  state: "ready",
  worktreeId: WORKTREE_ID,
  branchContextId: BRANCH_CONTEXT_ID,
});

const buildWorktreeReuseCheckRequest = () => ({
  repoMountId: REPO_MOUNT_ID,
  branchName: BRANCH_NAME,
});
const buildWorktreeReuseCheckResponse = () => ({
  available: true,
  worktreeId: WORKTREE_ID,
  state: "ready",
  branchName: BRANCH_NAME,
  isClean: true,
  compatible: true,
});

const buildWorktreeRetireRequest = () => ({ worktreeId: WORKTREE_ID, discard: false });
const buildWorktreeRetireResponse = () => ({ worktreeId: WORKTREE_ID, state: "retired" });

// A live, run-created checkout, with the figures its switcher row draws.
const buildWorktreeStatusRecord = () => ({
  worktreeId: WORKTREE_ID,
  repoMountId: REPO_MOUNT_ID,
  name: "1a2b3c4d-fix-login-bug",
  branchName: BRANCH_NAME,
  baseBranchName: "main",
  fsRoot: EXECUTION_ROOT,
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
const buildWorktreeStatusReadRequest = () => ({
  repoMountId: REPO_MOUNT_ID,
  sessionId: SESSION_ID,
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

// Override-parse helpers; field-omission cases still `delete` the key directly.
const parseSelectRequest = (overrides: Record<string, unknown> = {}) =>
  ExecutionModeSelectRequestSchema.safeParse({
    ...buildExecutionModeSelectRequest(),
    ...overrides,
  });
const parseSelectResponse = (overrides: Record<string, unknown> = {}) =>
  ExecutionModeSelectResponseSchema.safeParse({
    ...buildExecutionModeSelectResponse(),
    ...overrides,
  });
const parsePrepareRequest = (overrides: Record<string, unknown> = {}) =>
  ExecutionRootPrepareRequestSchema.safeParse({
    ...buildExecutionRootPrepareRequest(),
    ...overrides,
  });
const parsePrepareResponse = (overrides: Record<string, unknown> = {}) =>
  ExecutionRootPrepareResponseSchema.safeParse({
    ...buildExecutionRootPrepareResponse(),
    ...overrides,
  });
const parseReuseCheckResponse = (overrides: Record<string, unknown> = {}) =>
  WorktreeReuseCheckResponseSchema.safeParse({
    ...buildWorktreeReuseCheckResponse(),
    ...overrides,
  });
// Status-read helpers reach into the array because failures are per record. The record helper
// takes a whole record so omission rows can `delete` a key.
const parseStatusReadWorktreeRecord = (record: Record<string, unknown>) =>
  WorktreeStatusReadResponseSchema.safeParse({
    ...buildWorktreeStatusReadResponse(),
    worktrees: [record],
  });
const parseStatusReadWithWorktree = (overrides: Record<string, unknown> = {}) =>
  parseStatusReadWorktreeRecord({ ...buildWorktreeStatusRecord(), ...overrides });

describe("ExecutionModeSelect request (records the mode)", () => {
  it("accepts a select naming a workspace and an explicit mode", () => {
    expect(parseSelectRequest().success).toBe(true);
  });

  it.each(["bound-root", "provisioned-worktree"])(
    "distinguishes the canonical mode %s",
    (executionMode) => {
      // Both modes are wire-lawful.
      expect(parseSelectRequest({ executionMode }).success).toBe(true);
    },
  );

  it.each([
    // A plausible but absent mode, and the empty string.
    ["detached"],
    [""],
  ])("rejects the out-of-taxonomy executionMode %s", (executionMode) => {
    expect(parseSelectRequest({ executionMode }).success).toBe(false);
  });

  it.each(["workspaceId", "executionMode"])("rejects a select missing %s", (field) => {
    // A default on `executionMode` would make an omitted mode look like a chosen one on the
    // surface that records an explicit switch.
    const broken = { ...buildExecutionModeSelectRequest() } as Record<string, unknown>;
    delete broken[field];
    expect(ExecutionModeSelectRequestSchema.safeParse(broken).success).toBe(false);
  });

  it("requires a canonical-UUID workspaceId", () => {
    expect(parseSelectRequest({ workspaceId: "workspace-1" }).success).toBe(false);
  });
});

describe("ExecutionModeSelect response (records the mode)", () => {
  it.each(["bound-root", "provisioned-worktree"])(
    "echoes back the full two-mode taxonomy — %s",
    (executionMode) => {
      // Every mode the request accepts must be echoable (an unavailable one is refused as
      // `workspace.mode_unsupported`). A narrower enum still typechecks against the wider
      // annotation, so only this row catches it.
      expect(parseSelectResponse({ executionMode }).success).toBe(true);
    },
  );

  it("rejects an out-of-taxonomy executionMode on the response too", () => {
    // Response validation is no laxer than request validation.
    expect(parseSelectResponse({ executionMode: "detached" }).success).toBe(false);
  });

  it.each(["preparing", "ready", "busy", "stale", "archived"])(
    "carries the full WorkspaceState vocabulary, not a two-literal narrowing — %s",
    (state) => {
      // A two-literal enum would silently reject the other three lawful states. The retire
      // response, by contrast, narrows its state to `retired` on purpose.
      expect(parseSelectResponse({ state }).success).toBe(true);
    },
  );

  it.each(["creating", "dirty", "merged", "retired", "failed", "exploded"])(
    "still rejects the non-workspace state %s (non-narrowed is not unvalidated)",
    (state) => {
      // The field composes `WorkspaceStateSchema`, so the worktree vocabulary must not leak in.
      expect(parseSelectResponse({ state }).success).toBe(false);
    },
  );
});

describe("ExecutionRootPrepare request (create or bind)", () => {
  it("accepts the minimal shape — workspaceId alone (schema-optional branch)", () => {
    // `branchName` is optional in the shape; the service refuses its absence with
    // `workspace.branch_name_required`.
    expect(parsePrepareRequest().success).toBe(true);
  });

  it("accepts the full explicit-reuse shape", () => {
    expect(
      parsePrepareRequest({
        branchName: BRANCH_NAME,
        baseRef: BASE_REF,
        reuseWorktreeId: WORKTREE_ID,
        acknowledgeDirtyCandidate: true,
      }).success,
    ).toBe(true);
  });

  it("carries NO wire runId — run provenance is gate-supplied service-side", () => {
    // The run-setup gate calls the service directly and supplies the run id. A wire `runId`
    // would let a caller forge provenance, so `.strict()` refuses the key.
    expect(parsePrepareRequest({ runId: RUN_ID }).success).toBe(false);
  });

  it("requires workspaceId — the one field on this request that is not optional", () => {
    // The other four fields are optional, so if this one became optional too, `{}` would parse
    // and every other row would stay green.
    expect(ExecutionRootPrepareRequestSchema.safeParse({}).success).toBe(false);
    expect(parsePrepareRequest({ workspaceId: "workspace-1" }).success).toBe(false);
  });

  it("requires a canonical-UUID reuseWorktreeId and a boolean acknowledgement", () => {
    expect(parsePrepareRequest({ reuseWorktreeId: "worktree-1" }).success).toBe(false);
    // Consent to bind a dirty candidate is a real boolean, never a coerced string.
    expect(parsePrepareRequest({ acknowledgeDirtyCandidate: "true" }).success).toBe(false);
  });

  it("bounds branchName and baseRef at WORKTREE_GIT_REF_MAX_LEN", () => {
    const atCap = "b".repeat(WORKTREE_GIT_REF_MAX_LEN);
    const overCap = "b".repeat(WORKTREE_GIT_REF_MAX_LEN + 1);
    expect(parsePrepareRequest({ branchName: atCap }).success).toBe(true);
    expect(parsePrepareRequest({ branchName: overCap }).success).toBe(false);
    expect(parsePrepareRequest({ baseRef: atCap }).success).toBe(true);
    expect(parsePrepareRequest({ baseRef: overCap }).success).toBe(false);
    expect(parsePrepareRequest({ branchName: "  " }).success).toBe(false);
  });

  it("does NOT bound the ref fields at the 4096 path cap (the two classes differ)", () => {
    // A ref capped at `FILE_PATH_MAX_LEN` by mistake would accept this value.
    const pathLengthBranch = "b".repeat(FILE_PATH_MAX_LEN);
    expect(parsePrepareRequest({ branchName: pathLengthBranch }).success).toBe(false);
  });
});

// The two response shapes by mode; both carry `branchContextId`. Typed explicitly: an
// unannotated array widens each row to a union including `string`, and the spread below would
// stop typechecking as an object.
const PREPARE_RESPONSE_MODE_SHAPES: ReadonlyArray<readonly [string, Record<string, string>]> = [
  ["provisioned-worktree mode", { worktreeId: WORKTREE_ID, branchContextId: BRANCH_CONTEXT_ID }],
  ["bound-root mode", { branchContextId: BRANCH_CONTEXT_ID }],
];

describe("ExecutionRootPrepare response (a root or a typed refusal, never both)", () => {
  it.each(PREPARE_RESPONSE_MODE_SHAPES)("accepts the %s shape", (_label, idFields) => {
    const response = {
      executionRoot: EXECUTION_ROOT,
      state: "ready",
      ...idFields,
    };
    expect(ExecutionRootPrepareResponseSchema.safeParse(response).success).toBe(true);
  });

  it("rejects a response with no executionRoot — unrepresentable-absent", () => {
    // A failed preparation aborts with a typed error and admits no fallback root.
    const broken = { ...buildExecutionRootPrepareResponse() } as Record<string, unknown>;
    delete broken["executionRoot"];
    expect(ExecutionRootPrepareResponseSchema.safeParse(broken).success).toBe(false);
  });

  it("applies the wireFreeFormString guard to executionRoot", () => {
    for (const hostile of GUARD_DOWNGRADE_VALUES) {
      expect(parsePrepareResponse({ executionRoot: hostile }).success).toBe(false);
    }
  });

  it.each(["preparing", "ready", "busy", "stale", "archived"])(
    "carries the full WorkspaceState vocabulary after the reprovision bracket — %s",
    (state) => {
      // The fixture only uses `ready`; a narrowing to `z.enum(["ready"])` typechecks and would
      // otherwise pass while refusing four lawful states.
      expect(parsePrepareResponse({ state }).success).toBe(true);
    },
  );

  it("rejects a worktree state in the workspace-state slot", () => {
    // The field composes `WorkspaceStateSchema`, so the worktree vocabulary must not leak in.
    expect(parsePrepareResponse({ state: "dirty" }).success).toBe(false);
    expect(parsePrepareResponse({ state: "creating" }).success).toBe(false);
  });

  it("keeps each root id branded to its own vocabulary", () => {
    expect(parsePrepareResponse({ worktreeId: "worktree-1" }).success).toBe(false);
    expect(parsePrepareResponse({ branchContextId: "ctx-1" }).success).toBe(false);
  });
});

describe("WorktreeReuseCheck (branch, cleanliness, compat)", () => {
  it("accepts a mount-scoped check naming a branch", () => {
    const check = buildWorktreeReuseCheckRequest();
    expect(WorktreeReuseCheckRequestSchema.safeParse(check).success).toBe(true);
  });

  it.each(["repoMountId", "branchName"])("rejects a check missing %s", (field) => {
    // `branchName` is required here though prepare leaves it optional: a check with no branch
    // has no key to look its candidate up by.
    const broken = { ...buildWorktreeReuseCheckRequest() } as Record<string, unknown>;
    delete broken[field];
    expect(WorktreeReuseCheckRequestSchema.safeParse(broken).success).toBe(false);
  });

  it("applies the wireFreeFormString guard to the request branchName", () => {
    // This side has no cap row of its own, so a bare `z.string()` would let a blank lookup key
    // through to a query that can only miss.
    for (const hostile of GUARD_DOWNGRADE_VALUES) {
      const probe = { ...buildWorktreeReuseCheckRequest(), branchName: hostile };
      expect(WorktreeReuseCheckRequestSchema.safeParse(probe).success).toBe(false);
    }
  });

  it("accepts the bare negative answer — `available: false` alone", () => {
    // Every other field describes a candidate, so "no live candidate" is complete with one field.
    expect(WorktreeReuseCheckResponseSchema.safeParse({ available: false }).success).toBe(true);
  });

  it("accepts the full candidate report with a populated reason", () => {
    expect(
      parseReuseCheckResponse({
        isClean: false,
        compatible: true,
        reason: "candidate holds uncommitted changes",
      }).success,
    ).toBe(true);
  });

  it("requires `available` — the one field that is not candidate description", () => {
    const broken = { ...buildWorktreeReuseCheckResponse() } as Record<string, unknown>;
    delete broken["available"];
    expect(WorktreeReuseCheckResponseSchema.safeParse(broken).success).toBe(false);
  });

  it.each(["creating", "ready", "dirty", "merged", "retired", "failed"])(
    "carries the full six-state worktree vocabulary — %s",
    (state) => {
      expect(parseReuseCheckResponse({ state }).success).toBe(true);
    },
  );

  it("rejects a workspace state on the candidate (contract half)", () => {
    expect(parseReuseCheckResponse({ state: "preparing" }).success).toBe(false);
    expect(parseReuseCheckResponse({ state: "archived" }).success).toBe(false);
  });

  it("bounds `reason` at the short-human-reason class, not the ref class", () => {
    const atCap = "r".repeat(WORKTREE_REUSE_REASON_MAX_LEN);
    const overCap = "r".repeat(WORKTREE_REUSE_REASON_MAX_LEN + 1);
    expect(parseReuseCheckResponse({ reason: atCap }).success).toBe(true);
    expect(parseReuseCheckResponse({ reason: overCap }).success).toBe(false);
    // The reason and ref caps differ (512 and 256); a reason capped at the ref length would
    // refuse this lawful 300-character explanation.
    expect(parseReuseCheckResponse({ reason: "r".repeat(300) }).success).toBe(true);
    // A `branchName` capped at the reason length would accept one.
    expect(parseReuseCheckResponse({ branchName: "b".repeat(300) }).success).toBe(false);
  });
});

describe("WorktreeRetire (records retirement)", () => {
  it("accepts a retire naming the worktree and requires a canonical UUID", () => {
    expect(WorktreeRetireRequestSchema.safeParse(buildWorktreeRetireRequest()).success).toBe(true);
    expect(WorktreeRetireRequestSchema.safeParse({}).success).toBe(false);
    expect(WorktreeRetireRequestSchema.safeParse({ worktreeId: "worktree-1" }).success).toBe(false);
  });

  it("accepts `retired` and rejects the other five worktree states", () => {
    const response = buildWorktreeRetireResponse();
    expect(WorktreeRetireResponseSchema.safeParse(response).success).toBe(true);
    for (const state of ["creating", "ready", "dirty", "merged", "failed"]) {
      // A failed creation never made a checkout, so `failed` is not a retire outcome, and a
      // retire refused while the root is busy is a `worktree.retire_conflict` error rather than
      // a response with the unchanged state.
      expect(WorktreeRetireResponseSchema.safeParse({ ...response, state }).success).toBe(false);
    }
  });
});

describe("WorktreeStatusRead (the switcher's one read, keyed by the project's folder)", () => {
  it("is keyed by the project's folder, with the asking session optional", () => {
    expect(
      WorktreeStatusReadRequestSchema.safeParse(buildWorktreeStatusReadRequest()).success,
    ).toBe(true);
    expect(WorktreeStatusReadRequestSchema.safeParse({ repoMountId: REPO_MOUNT_ID }).success).toBe(
      true,
    );
    expect(WorktreeStatusReadRequestSchema.safeParse({ sessionId: SESSION_ID }).success).toBe(
      false,
    );
  });

  it("carries the repo-root row, each tree's figures, the fetch age and the form's suggestion", () => {
    expect(
      WorktreeStatusReadResponseSchema.safeParse(buildWorktreeStatusReadResponse()).success,
    ).toBe(true);
  });

  it("answers a project with no trees, no failed fetch and no asking session", () => {
    const bare = {
      repoRoot: { path: "/Users/dev/code/beacon", branchName: "main" },
      worktrees: [],
    };
    expect(WorktreeStatusReadResponseSchema.safeParse(bare).success).toBe(true);
    const { repoRoot: _repoRoot, ...withoutRoot } = bare;
    expect(WorktreeStatusReadResponseSchema.safeParse(withoutRoot).success).toBe(false);
  });

  it("never lists a retired tree", () => {
    expect(parseStatusReadWithWorktree({ state: "retired" }).success).toBe(false);
    expect(parseStatusReadWithWorktree({ state: "failed" }).success).toBe(true);
  });

  it("requires the figures the switcher row and the removal confirm draw", () => {
    for (const field of [
      "name",
      "baseBranchName",
      "uncommittedFileCount",
      "unpushedCommitCount",
      "occupyingSessionIds",
      "runningSessionId",
      "createdBySessionId",
    ]) {
      const broken = { ...buildWorktreeStatusRecord() } as Record<string, unknown>;
      delete broken[field];
      expect(parseStatusReadWorktreeRecord(broken).success).toBe(false);
    }
  });

  it("leaves ahead and behind absent for a branch with no upstream, and refuses a negative figure", () => {
    const { ahead: _ahead, behind: _behind, ...noUpstream } = buildWorktreeStatusRecord();
    expect(parseStatusReadWorktreeRecord(noUpstream).success).toBe(true);
    expect(parseStatusReadWithWorktree({ behind: -1 }).success).toBe(false);
    expect(parseStatusReadWithWorktree({ uncommittedFileCount: 1.5 }).success).toBe(false);
  });

  it("keeps createdByRunId optional but UUID-validated when present", () => {
    const withoutRun = { ...buildWorktreeStatusRecord() } as Record<string, unknown>;
    delete withoutRun["createdByRunId"];
    expect(parseStatusReadWorktreeRecord(withoutRun).success).toBe(true);
    expect(parseStatusReadWithWorktree({ createdByRunId: "run-1" }).success).toBe(false);
  });

  it("keeps a workspace state out of the worktree record", () => {
    expect(parseStatusReadWithWorktree({ state: "preparing" }).success).toBe(false);
  });

  it("applies the wireFreeFormString guard to every path and ref on the record", () => {
    for (const hostile of GUARD_DOWNGRADE_VALUES) {
      expect(parseStatusReadWithWorktree({ branchName: hostile }).success).toBe(false);
      expect(parseStatusReadWithWorktree({ baseBranchName: hostile }).success).toBe(false);
      expect(parseStatusReadWithWorktree({ fsRoot: hostile }).success).toBe(false);
    }
  });
});

// Every shape gets a row, since nothing else catches a dropped outer `.strict()`.

const expectClosedShape = (
  schema: { safeParse: (candidate: unknown) => { success: boolean } },
  fixture: Record<string, unknown>,
): void => {
  // Accepting first proves the fixture is in-shape, so the rejection is due to the stray key.
  expect(schema.safeParse(fixture).success).toBe(true);
  expect(schema.safeParse({ ...fixture, unknownWireKey: "leak" }).success).toBe(false);
};

describe("`.strict()` closes every wire shape (behavioral pin)", () => {
  it("closes all five request schemas", () => {
    expectClosedShape(ExecutionModeSelectRequestSchema, buildExecutionModeSelectRequest());
    expectClosedShape(ExecutionRootPrepareRequestSchema, buildExecutionRootPrepareRequest());
    expectClosedShape(WorktreeReuseCheckRequestSchema, buildWorktreeReuseCheckRequest());
    expectClosedShape(WorktreeRetireRequestSchema, buildWorktreeRetireRequest());
    expectClosedShape(WorktreeStatusReadRequestSchema, buildWorktreeStatusReadRequest());
  });

  it("closes all five response schemas", () => {
    expectClosedShape(ExecutionModeSelectResponseSchema, buildExecutionModeSelectResponse());
    expectClosedShape(ExecutionRootPrepareResponseSchema, buildExecutionRootPrepareResponse());
    expectClosedShape(WorktreeReuseCheckResponseSchema, buildWorktreeReuseCheckResponse());
    expectClosedShape(WorktreeRetireResponseSchema, buildWorktreeRetireResponse());
    expectClosedShape(WorktreeStatusReadResponseSchema, buildWorktreeStatusReadResponse());
  });

  it("closes the status-read item schema independently of its envelope", () => {
    // The envelope's `.strict()` cannot reach inside an array element, so the item needs its
    // own guard.
    expect(parseStatusReadWithWorktree({ unknownWireKey: "leak" }).success).toBe(false);
  });
});

// Compile-time pins, never executed: `tsc -p tsconfig.test.json` fails if a narrowing or a
// required field is weakened.

const extractNarrowingPins = (): void => {
  // @ts-expect-error — WorktreeRetireResponse admits `retired` only.
  const mergedRetireState: WorktreeRetireResponse["state"] = "merged";
  void mergedRetireState;
};
void extractNarrowingPins;

const worktreeStatusRecordProvenancePin = (): void => {
  // @ts-expect-error — a worktree record with no creating-session provenance. Every other
  // field is present, so the missing `createdBySessionId` is the only error consumed.
  const missingCreatedBySessionId: WorktreeStatusReadResponse["worktrees"][number] = {
    worktreeId: WorktreeIdSchema.parse(WORKTREE_ID),
    repoMountId: RepoMountIdSchema.parse(REPO_MOUNT_ID),
    name: "1a2b3c4d-fix-login-bug",
    branchName: BRANCH_NAME,
    baseBranchName: "main",
    fsRoot: EXECUTION_ROOT,
    state: "ready",
    uncommittedFileCount: 0,
    unpushedCommitCount: 0,
    occupyingSessionIds: [],
    runningSessionId: null,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
  };
  void missingCreatedBySessionId;
};
void worktreeStatusRecordProvenancePin;

describe("index.ts re-exports wire surfaces", () => {
  it("re-exports every runtime symbol by identity", () => {
    // These ride the barrel's star export; the check is that they reach the public surface.
    expect(contracts.ExecutionModeSelectRequestSchema).toBe(ExecutionModeSelectRequestSchema);
    expect(contracts.ExecutionModeSelectResponseSchema).toBe(ExecutionModeSelectResponseSchema);
    expect(contracts.ExecutionRootPrepareRequestSchema).toBe(ExecutionRootPrepareRequestSchema);
    expect(contracts.ExecutionRootPrepareResponseSchema).toBe(ExecutionRootPrepareResponseSchema);
    expect(contracts.WorktreeReuseCheckRequestSchema).toBe(WorktreeReuseCheckRequestSchema);
    expect(contracts.WorktreeReuseCheckResponseSchema).toBe(WorktreeReuseCheckResponseSchema);
    expect(contracts.WorktreeRetireRequestSchema).toBe(WorktreeRetireRequestSchema);
    expect(contracts.WorktreeRetireResponseSchema).toBe(WorktreeRetireResponseSchema);
    expect(contracts.WorktreeStatusReadRequestSchema).toBe(WorktreeStatusReadRequestSchema);
    expect(contracts.WorktreeStatusReadResponseSchema).toBe(WorktreeStatusReadResponseSchema);
    expect(contracts.WORKTREE_GIT_REF_MAX_LEN).toBe(WORKTREE_GIT_REF_MAX_LEN);
    expect(contracts.WORKTREE_REUSE_REASON_MAX_LEN).toBe(WORKTREE_REUSE_REASON_MAX_LEN);
  });

  // Compile-time reachability of the types through the barrel.
  const barrelWireTypePin = (): void => {
    const selectRequest: contracts.ExecutionModeSelectRequest =
      ExecutionModeSelectRequestSchema.parse(buildExecutionModeSelectRequest());
    void selectRequest;
    const statusRead: contracts.WorktreeStatusReadResponse = WorktreeStatusReadResponseSchema.parse(
      buildWorktreeStatusReadResponse(),
    );
    void statusRead;
  };
  void barrelWireTypePin;
});

const REMOVED_WORKTREE_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f22";

describe("repo.worktreeRetire: keep or discard, and the refusal when it cannot go", () => {
  it("makes the person choose keep or discard, and names the kept copy", () => {
    expect(
      WorktreeRetireRequestSchema.safeParse({ worktreeId: WORKTREE_ID, discard: true }).success,
    ).toBe(true);
    expect(WorktreeRetireRequestSchema.safeParse({ worktreeId: WORKTREE_ID }).success).toBe(false);
    expect(
      WorktreeRetireResponseSchema.safeParse({
        ...buildWorktreeRetireResponse(),
        kept: { removedWorktreeId: REMOVED_WORKTREE_ID },
      }).success,
    ).toBe(true);
  });

  it("says why the tree cannot go: another chat's root, or work it would lose", () => {
    const risks = {
      uncommittedFileCount: 3,
      ignoredFileCount: 1,
      unpushedCommitCount: 2,
      occupyingSessionIds: [SESSION_ID],
    };
    expect(
      WorktreeRetireConflictDetailsSchema.safeParse({
        reason: "root_busy",
        worktreeId: WORKTREE_ID,
        holdingWorkspaceId: WORKSPACE_ID,
      }).success,
    ).toBe(true);
    expect(
      WorktreeRetireConflictDetailsSchema.safeParse({
        reason: "has_changes",
        worktreeId: WORKTREE_ID,
        risks,
      }).success,
    ).toBe(true);
    expect(
      WorktreeRetireConflictDetailsSchema.safeParse({
        reason: "has_changes",
        worktreeId: WORKTREE_ID,
        holdingWorkspaceId: WORKSPACE_ID,
      }).success,
    ).toBe(false);
    expect(
      WorktreeRetireConflictDetailsSchema.safeParse({
        reason: "locked",
        worktreeId: WORKTREE_ID,
        risks,
      }).success,
    ).toBe(false);
  });
});

describe("repo.executionRootPrepare carrying uncommitted work", () => {
  it("takes the carry switch and nothing else new", () => {
    expect(
      ExecutionRootPrepareRequestSchema.safeParse({
        ...buildExecutionRootPrepareRequest(),
        carryUncommitted: true,
      }).success,
    ).toBe(true);
    expect(
      ExecutionRootPrepareRequestSchema.safeParse({
        ...buildExecutionRootPrepareRequest(),
        carryUncommitted: "yes",
      }).success,
    ).toBe(false);
  });
});
