// `worktree.ts` contract core: the two branded ids, the worktree lifecycle
// enum, the family-payload instantiation over `WorktreeStateSchema`, and the
// registration of the five `worktree.*` variants into `SessionEventSchema`.
//
// Backstops and plus the contract-shape halves of the invariants this file
// carries:
//   • Import, never redefine: an identity check proves worktree.ts's
//     re-export of the execution-mode schema is repo.ts's one declaration
//     rather than a fork.
//   • The registry stays closed: `worktree.failed` stays rejected by the
//     union and absent from the census.
//
// Coverage shape (mirrors repo.test.ts, the Phase-1 sibling):
//   • Every member of every enum parses; out-of-set values are rejected
//     (base-vocabulary states, case drift), so each pin is a real
//     accept/reject boundary.
//   • Branded ids reject a non-UUID, and the brands are nominal AND mutually
//     nominal at compile time.
//   • `WorktreeLifecyclePayloadSchema` accepts exactly the six-state worktree
//     vocabulary and rejects every base-vocabulary state (the per-family
//     accept set), keeps `.strict()`, and keeps the
//     family's field contract.
//   • The five `worktree.*` types parse end-to-end through
//     `SessionEventSchema` with `worktreeId`-bearing payloads, agree with
//     their standalone `*EventSchema` exports on every accept/reject axis
//     (envelope `.strict()` included — the one axis with no compile-time
//     backstop), and survive JSON round-trips; a category/type mismatch and
//     a base-vocabulary state are rejected.
//   • The `index.ts` barrel re-exports every symbol this task provides — the
//     barrel-gap regression.
import { describe, expect, it } from "vitest";

import {
  SESSION_EVENT_CATEGORY_BY_TYPE,
  SESSION_EVENT_TYPES,
  SessionEventSchema,
  WorktreeCreatedEventSchema,
  WorktreeDirtyEventSchema,
  WorktreeMergedEventSchema,
  WorktreeReadyEventSchema,
  WorktreeRetiredEventSchema,
  type SessionEvent,
} from "../event.js";
import * as contracts from "../index.js";
// The canonical DECLARATION, imported from its origin. worktree.ts re-exports
// the same binding (type and value); the aliased import below is that
// re-export, held under a distinct local name so the identity pin can compare
// the two surfaces rather than trivially comparing one to itself.
// `RepoMountIdSchema` rides along for its compile-time status-record pin —
// canon, consumed from its origin.
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

// Real RFC 9562 UUIDs (mix of v4 and v7) — the same fixture stance as
// repo.test.ts: `RFC_9562_TEXT_FORM` validates the version nibble + variant bits, so the
// fixtures must be canonically valid, not lookalike strings.
const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
const REPO_MOUNT_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f10";
const WORKSPACE_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f11";
const WORKTREE_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f12";
const BRANCH_CONTEXT_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f14";
const USER_ID = "660e8400-e29b-41d4-a716-446655440001";
const OCCURRED_AT = "2026-07-26T09:30:00.000Z";
const VERSION = "1.0";

// --------------------------------------------------------------------------
// Canonical enums.
// --------------------------------------------------------------------------

describe("WorktreeStateSchema (the six-state worktree lifecycle)", () => {
  it.each([
    ["creating", true],
    ["ready", true],
    ["dirty", true],
    ["merged", true],
    ["retired", true],
    // `failed` is a ROW state with no `worktree.*` event of its own —
    // but it is fully in the state vocabulary.
    ["failed", true],
    // The base-family vocabularies stay out of this plan's accept set
    // (per-family vocabularies, no shared union).
    ["preparing", false],
    ["attached", false],
    ["detached", false],
    ["busy", false],
    ["stale", false],
    ["archived", false],
    // Case drift and inventions are contract breaks, not tolerated values.
    ["CREATING", false],
    ["retiring", false],
    ["", false],
  ])("parses %s -> %s", (candidate, shouldPass) => {
    expect(WorktreeStateSchema.safeParse(candidate).success).toBe(shouldPass);
  });

  it("enumerates exactly the six canonical states in the ratified CHECK order", () => {
    // ORDER, not merely membership — this pin and the two enum pins below are
    // deliberately UNSORTED. Read through the same `.options` internals cast the sibling
    // suites use. Declaration order mirrors the `worktrees.state` CHECK clause
    // byte-for-byte, which is what gives conformance test a byte-exact target when it
    // closes lockstep from the DDL side. A reorder fails here and forces a re-sync; it
    // is NOT a wire break (RFC 8785 JCS serializes the literal string — the two-level
    // note on worktree.ts's). DELIBERATE ASYMMETRY: the `ExecutionModeSchema` pin at the
    // bottom of this file sorts both sides instead, because that enum is canon with no
    // `CHECK` clause to mirror.
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

// --------------------------------------------------------------------------
// Branded ids.
// --------------------------------------------------------------------------

// Structural element typing, not inference: the two schemas have DISTINCT
// branded output types, so an un-annotated literal array widens `schema` to a
// union that includes `string` and `.parse` stops resolving. The structural
// view keeps one table driving both (same affordance as
// `STANDALONE_WORKTREE_EVENT_SCHEMAS` below).
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
      // The brand is compile-time only — the runtime value is the input
      // string.
      expect(parsed).toBe(uuid);
      expect(schema.safeParse("worktree-1").success).toBe(false);
      expect(schema.safeParse("").success).toBe(false);
      // Version/variant nibbles are validated in canonical positions: the
      // version nibble below is `0`, which RFC 9562 does not define.
      expect(schema.safeParse("0190f8a0-7e2d-0c4a-9b1c-1b7c5b3e8f12").success).toBe(false);
    },
  );

  // Compile-time nominality pins — never executed; present so `tsc -p
  // tsconfig.test.json` fails if a brand decays to a plain string or the
  // two brands collapse into one another (the repo.test.ts idiom).
  const brandNominalityPin = (): void => {
    // @ts-expect-error — a raw string is not a WorktreeId without a parse.
    const unbrandedWorktreeId: WorktreeId = WORKTREE_ID;
    void unbrandedWorktreeId;
    // @ts-expect-error — a raw string is not a BranchContextId without a parse.
    const unbrandedBranchContextId: BranchContextId = BRANCH_CONTEXT_ID;
    void unbrandedBranchContextId;
    // @ts-expect-error — mutually nominal: a parsed WorktreeId is not a
    // BranchContextId.
    const crossBrand: BranchContextId = WorktreeIdSchema.parse(WORKTREE_ID);
    void crossBrand;
  };
  void brandNominalityPin;
});

// --------------------------------------------------------------------------
// WorktreeLifecyclePayloadSchema — the family factory over WorktreeStateSchema.
// --------------------------------------------------------------------------
//
// The factory's own contract (cap propagation, `.strict()` transmission,
// field-for-field family behavior) is proven in repo.test.ts against an
// arbitrary instantiation; this block pins the SHIPPED instantiation's
// accept boundary, which is what registers.

const buildWorktreePayload = (state: WorktreeState): WorktreeLifecyclePayload => ({
  // Narrow-cast on the ID FIELD only, never the whole payload: the payload
  // type brands `sessionId`, and a fixture literal needs the compile-time
  // bridge while every parse row below still validates the runtime value.
  sessionId: SESSION_ID as WorktreeLifecyclePayload["sessionId"],
  worktreeId: WORKTREE_ID,
  state,
});

describe("WorktreeLifecyclePayloadSchema (the family shape over this plan's vocabulary)", () => {
  it.each(["creating", "ready", "dirty", "merged", "retired", "failed"])(
    "accepts the worktree vocabulary member %s",
    (state) => {
      // `failed` INCLUDED — representable in the payload type because the
      // state enum is the row vocabulary; what V1 pins is that no
      // `worktree.*` EVENT carries it, which is the closed-registry test
      // below, not a narrowed payload arm.
      expect(
        WorktreeLifecyclePayloadSchema.safeParse({ sessionId: SESSION_ID, state }).success,
      ).toBe(true);
    },
  );

  it.each(["attached", "detached", "preparing", "busy", "stale", "archived"])(
    "REJECTS the base-family vocabulary member %s (per-family accept set)",
    (state) => {
      // The exact-vocabulary pin: the factory parameterization exists so a
      // worktree payload can never claim a repo/workspace state (`archived`
      // sits in BOTH base vocabularies and in neither of this plan's).
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
    // Subject-id presence is per-type emitter discipline enforced at the
    // `.parse()` emission seam in Phase 2 — the family shape marks all three
    // subject ids optional, so a payload without `worktreeId` still parses.
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
    // Omission is the third guard the test name promises and a separate axis
    // from `null`: `.optional()` and `.nullable()` are independent, so a
    // family schema that dropped one would still pass the row above. The
    // fixture carries no `actor` key at all.
    expect(WorktreeLifecyclePayloadSchema.safeParse(buildWorktreePayload("ready")).success).toBe(
      true,
    );
  });
});

// --------------------------------------------------------------------------
// Union registration into SessionEventSchema.
// --------------------------------------------------------------------------

// Each registered type paired with the state its emitter actually writes —
// event-transition mapping (row creation → `worktree.created`, `creating ->
// ready` → `worktree.ready`, and so on; `-> failed` maps to NO event, which
// is the closed-registry block below).
//
// The element type is load-bearing (same stance as repo.test.ts's
// `REGISTERED_REPO_EVENTS`): `SessionEvent["type"]` is the REGISTERED
// union's discriminant, so if a later edit drops one of the five arms from
// `SessionEventSchema`, this fixture stops compiling rather than silently
// thinning the runtime table. The state half binds to `WorktreeState` the
// same way.
const REGISTERED_WORKTREE_EVENTS: ReadonlyArray<readonly [SessionEvent["type"], WorktreeState]> = [
  ["worktree.created", "creating"],
  ["worktree.ready", "ready"],
  ["worktree.dirty", "dirty"],
  ["worktree.merged", "merged"],
  ["worktree.retired", "retired"],
];

// Worktree events carry the full subject context: the worktree id ALWAYS
// (emitter obligation this suite's fixtures model), plus the mount and
// workspace the worktree serves — legitimately multi-id rows, which is why
// the family shape has no "exactly one id" refinement.
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
      // Cross-check against the independent census registry — the arm's own
      // `category: z.literal(...)` produced the value above, so only the
      // registry catches an arm/census disagreement (`category` sits in the
      // RFC 8785 canonical bytes backing the hash chain).
      expect(SESSION_EVENT_CATEGORY_BY_TYPE.get(eventType)).toBe("session_lifecycle");
      // The payload survives the union branch unchanged — no key added,
      // dropped, or coerced on the way through. The fixture carries
      // `worktreeId` (emitter obligation), so this one assertion covers
      // its survival too.
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
    // The reciprocal of repo.test.ts's disjointness rows: a registered
    // `worktree.*` arm must not admit a repo/workspace state, or the
    // parameterized-payload design has silently regressed to a shared union.
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
    // The roster is hand-written, so registration and roster must move in
    // one diff; the full roster order pin lives in session-event.test.ts.
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

// The standalone exports are what the emitter validates against before
// append — they must agree with the independently-spelled union arms or the
// two surfaces drift (the repo.test.ts standalone-vs-union stance).
// Structural `safeParse` typing sidesteps `z.ZodType` variance.
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
      // Outer `.strict()` is the one axis of this parity with NO compile-time
      // backstop. A widened `type` or `category` literal fails against the
      // `z.ZodType<Worktree*Event>` annotation, and payload strictness cannot
      // diverge because both surfaces reference the same
      // `WorktreeLifecyclePayloadSchema` object — but a schema's inferred
      // output type does not reflect outer `.strict()`, so a copy-paste slip
      // that dropped it from one of the five exports would typecheck green
      // and STRIP the spurious key instead of rejecting. The emitter
      // validates through this surface would then append canonical bytes it
      // never built, surfacing much later as a strict-union rejection at
      // replay. The union control on each row is what makes the verdict a
      // parity statement rather than a lone rejection.
      const fixture = buildWorktreeEvent(eventType, state);
      const withSpuriousEnvelopeKey = { ...fixture, spuriousEnvelopeKey: "x" };
      expect(standaloneSchema.safeParse(withSpuriousEnvelopeKey).success).toBe(false);
      expect(SessionEventSchema.safeParse(withSpuriousEnvelopeKey).success).toBe(false);
      // `category` sits in the RFC 8785 canonical bytes backing the hash
      // chain — pinned on the union above, pinned here on the standalone
      // surface (the fourth axis of the repo.test.ts precedent this block
      // mirrors).
      const withMismatchedCategory = { ...fixture, category: "usage_telemetry" as const };
      expect(standaloneSchema.safeParse(withMismatchedCategory).success).toBe(false);
      expect(SessionEventSchema.safeParse(withMismatchedCategory).success).toBe(false);
    },
  );
});

// --------------------------------------------------------------------------
// The registry stays closed.
// --------------------------------------------------------------------------

describe("registry stays closed", () => {
  it("rejects `worktree.failed` through the union regardless of payload state", () => {
    // Two rows isolate the axes: with `state: "ready"` the payload WOULD
    // parse under a family arm if one existed, so the rejection is purely
    // the missing type arm; with `state: "failed"` the full would-be shape
    // of the deliberately-unminted event is refused end-to-end. The `->
    // failed` transition emits no worktree event — the failure incident is
    // evented as `workspace.stale` by the coupled `failRootPreparation`.
    expect(
      SessionEventSchema.safeParse(buildWorktreeEvent("worktree.failed", "ready")).success,
    ).toBe(false);
    expect(
      SessionEventSchema.safeParse(buildWorktreeEvent("worktree.failed", "failed")).success,
    ).toBe(false);
  });

  it("keeps `worktree.failed` out of the roster AND out of the census", () => {
    //
    // Both lookups widen deliberately: `SESSION_EVENT_TYPES` is
    // `SessionEvent["type"][]` and the registry is keyed on
    // `SessionEventType`, so a literal that is (correctly) in NEITHER cannot
    // be passed at its declared key type — the `as never` affordance
    // session-event.test.ts uses for its own unregistered-literal probes.
    expect(SESSION_EVENT_TYPES as readonly string[]).not.toContain("worktree.failed");
    expect(SESSION_EVENT_CATEGORY_BY_TYPE.has("worktree.failed" as never)).toBe(false);
  });
});

// --------------------------------------------------------------------------
// --------------------------------------------------------------------------

describe("execution-mode taxonomy (import)", () => {
  it("re-exports the canonical schema VALUE by identity, never a fork", () => {
    // The runtime half of the re-export, pinned directly on worktree.ts's own
    // surface — the binding the `ExecutionModeSelectRequest` /
    // `ExecutionModeSelectResponse` Zod pairs consume. A two-member enum
    // REDEFINED in worktree.ts would pass every `.options` assertion; only
    // object identity refuses it.
    expect(ExecutionModeSchemaFromWorktreeReExport).toBe(ExecutionModeSchema);
  });
});

// --------------------------------------------------------------------------
// Barrel surface.
// --------------------------------------------------------------------------

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

  // Compile-time reachability of the type surface through the barrel —
  // never executed, present for `tsc -p tsconfig.test.json`.
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

// ==========================================================================
// Wire surfaces — the five `repo.*` request/response pairs.
// ==========================================================================
//
// Coverage, one per pair: select distinguishes the two canonical modes and
// records one; prepare creates-or-binds the root and carries explicit reuse;
// the reuse check reports branch, cleanliness, and compatibility; retire
// records retirement independent of disk deletion; the status read exposes
// worktree records with provenance. Every `state` field composes the canonical
// enum object, so a re-spelled literal union that fell outside the DDL
// lockstep fails the vocabulary rows below; execution-root prepare leaves
// `branchName` schema-optional and refuses service-side.
//
// THE `.strict()` PIN IS BEHAVIORAL AND EXHAUSTIVE (the block at the end of
// this file). Outer `.strict()` leaves no trace in a schema's inferred output
// type, so a dropped `.strict()` typechecks green and silently STRIPS the
// unknown key instead of rejecting it. Eleven shapes are pinned there: the ten
// exported schemas plus the status-read ITEM schema, which is closed
// independently of its envelope. Those rows also carry the "parse-accept one
// in-shape fixture per shape" floor for all ten, since each pin asserts its
// fixture parses before adding the stray key.

const RUN_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f15";
const EXECUTION_ROOT = "/Users/dev/.ai-sidekicks/execution-roots/mount-0190f8a0/worktrees/wt-01";
const BRANCH_NAME = "sidekicks/550e8400/add-worktree-wire-pairs";
const BASE_REF = "main";
const CREATED_AT = "2026-07-26T09:30:00.000Z";
const UPDATED_AT = "2026-07-26T09:31:00.000Z";
const CLEANED_AT = "2026-07-26T10:00:00.000Z";

// The three inputs that separate `wireFreeFormString` from a bare `z.string()`:
// empty, whitespace-only, and an embedded NUL byte. A guard downgrade at any
// single call site is otherwise INVISIBLE — the inferred type stays `string`,
// so tsc stays green, and every other row in this suite still passes. Fields
// whose cap row already fails against a bare `z.string()` (`baseRef`, the reuse
// response's `branchName`, `reason`) do not need a row here.
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

// The MINIMAL lawful prepare request — `workspaceId` alone.
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

// The worktree record carries RUN provenance and no cleanup stamp — a live
// run-created checkout.
const buildWorktreeStatusRecord = () => ({
  worktreeId: WORKTREE_ID,
  repoMountId: REPO_MOUNT_ID,
  branchName: BRANCH_NAME,
  fsRoot: EXECUTION_ROOT,
  state: "ready",
  createdBySessionId: SESSION_ID,
  createdByRunId: RUN_ID,
  createdAt: CREATED_AT,
  updatedAt: UPDATED_AT,
});
const buildWorktreeStatusReadRequest = () => ({ sessionId: SESSION_ID });
const buildWorktreeStatusReadResponse = () => ({
  worktrees: [buildWorktreeStatusRecord()],
});

// Override-parse helpers, the repo.test.ts affordance: the fixtures above stay
// explicit while the assertion lines below read at a glance. Field-OMISSION
// cases still `delete` the key directly, which no override form can express.
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
// Status-read helpers reach INTO the array: every interesting failure mode is
// per-RECORD, and a top-level override could not express one. The record
// helper takes a whole record (so the field-omission rows can `delete` a key);
// the override helper rides it for the common in-shape case.
const parseStatusReadWorktreeRecord = (record: Record<string, unknown>) =>
  WorktreeStatusReadResponseSchema.safeParse({ worktrees: [record] });
const parseStatusReadWithWorktree = (overrides: Record<string, unknown> = {}) =>
  parseStatusReadWorktreeRecord({ ...buildWorktreeStatusRecord(), ...overrides });

describe("ExecutionModeSelect request (records the mode)", () => {
  it("accepts a select naming a workspace and an explicit mode", () => {
    expect(parseSelectRequest().success).toBe(true);
  });

  it.each(["bound-root", "provisioned-worktree"])(
    "distinguishes the canonical mode %s",
    (executionMode) => {
      // Reached through the imported taxonomy, so both are wire-lawful here.
      expect(parseSelectRequest({ executionMode }).success).toBe(true);
    },
  );

  it.each([
    // A plausible-but-absent mode, and the empty string.
    ["detached"],
    [""],
  ])("rejects the out-of-taxonomy executionMode %s", (executionMode) => {
    expect(parseSelectRequest({ executionMode }).success).toBe(false);
  });

  it.each(["workspaceId", "executionMode"])("rejects a select missing %s", (field) => {
    // Neither field has a wire default: a default on `executionMode` would make
    // "caller omitted the mode" indistinguishable from "caller chose that mode"
    // on the one surface whose whole job is recording an explicit switch.
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
      // The response echo is not a narrower surface than the request: makes an
      // unavailable mode a typed `workspace.mode_unsupported` refusal, so every
      // mode the request accepts must be echoable. A narrowing like
      // `z.enum(["provisioned-worktree"])` is assignable to the wider
      // `ExecutionMode` annotation, so it typechecks green and passes every
      // other row here while silently refusing a lawful answer.
      expect(parseSelectResponse({ executionMode }).success).toBe(true);
    },
  );

  it("rejects an out-of-taxonomy executionMode on the response too", () => {
    // Negative control on the row above — response validation is not laxer
    // than request validation (validates both directions).
    expect(parseSelectResponse({ executionMode: "detached" }).success).toBe(false);
  });

  it.each(["preparing", "ready", "busy", "stale", "archived"])(
    "carries the full WorkspaceState vocabulary, not a two-literal narrowing — %s",
    (state) => {
      // The ratified block types this field `WorkspaceState` and glosses the
      // two expected values in a comment; a `z.enum(["ready","preparing"])`
      // would silently reject the other three lawful states while passing
      // every other row here. Contrast the `Extract`-narrowed retire `state`
      // below, where the ratified block narrows the TYPE.
      expect(parseSelectResponse({ state }).success).toBe(true);
    },
  );

  it.each(["creating", "dirty", "merged", "retired", "failed", "exploded"])(
    "still rejects the non-workspace state %s (non-narrowed is not unvalidated)",
    (state) => {
      // Negative control on the row above — and contract half: the field
      // composes the `WorkspaceStateSchema`, so THIS plan's worktree
      // vocabulary must not leak into a workspace-state slot.
      expect(parseSelectResponse({ state }).success).toBe(false);
    },
  );
});

describe("ExecutionRootPrepare request (create or bind)", () => {
  it("accepts the minimal shape — workspaceId alone (schema-optional branch)", () => {
    // `branchName` is optional in the SHAPE: a wire prepare without it draws
    // the typed service-side `workspace.branch_name_required` (400) refusal.
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
    // The run-setup gate calls the service directly and supplies the run id
    // that populates `worktrees.created_by_run_id`. A wire `runId` would let a
    // caller forge provenance on a row the gate owns, so `.strict()` refuses
    // the key rather than ignoring it.
    expect(parsePrepareRequest({ runId: RUN_ID }).success).toBe(false);
  });

  it("requires workspaceId — the one field on this request that is not optional", () => {
    // Worth its own row precisely BECAUSE the other four are optional: the
    // minimal-shape row above passes a lone `workspaceId`, so if that field
    // ever became optional the schema would accept `{}` and every existing row
    // here would still be green.
    expect(ExecutionRootPrepareRequestSchema.safeParse({}).success).toBe(false);
    expect(parsePrepareRequest({ workspaceId: "workspace-1" }).success).toBe(false);
  });

  it("requires a canonical-UUID reuseWorktreeId and a boolean acknowledgement", () => {
    expect(parsePrepareRequest({ reuseWorktreeId: "worktree-1" }).success).toBe(false);
    // A string "true" is the classic HTML-form coercion bug; consent to bind a
    // dirty candidate is affirmative and typed, never coerced.
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
    // NEGATIVE CONTROL on the cap choice: a ref name capped at
    // `FILE_PATH_MAX_LEN` by a copy-paste would accept this 4096-character
    // value and pass every other row in this block.
    const pathLengthBranch = "b".repeat(FILE_PATH_MAX_LEN);
    expect(parsePrepareRequest({ branchName: pathLengthBranch }).success).toBe(false);
  });
});

// The two mode-discriminated response shapes, keyed by which root id each
// carries. Both modes carry `branchContextId`. The element type is spelled out rather than
// inferred: an un-annotated literal array widens each row to a union that
// includes `string`, and the spread in the test body then stops
// type-checking as an object (the `REGISTERED_WORKTREE_EVENTS` stance
// above).
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
    // Preparation failure ABORTS with a typed error (`worktree.create_failed`)
    // and admits no fallback root, so there is no
    // partial success carrying an unresolved one.
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
      // The fixture only ever exercises `ready`, so without this row a
      // narrowing to `z.enum(["ready"])` — assignable to the wider
      // `WorkspaceState` annotation, therefore green under tsc — would pass the
      // whole block while refusing four lawful positions.
      expect(parsePrepareResponse({ state }).success).toBe(true);
    },
  );

  it("rejects a worktree state in the workspace-state slot", () => {
    // Negative control, and contract half: this field composes the
    // `WorkspaceStateSchema`, so THIS plan's vocabulary must not leak into
    // it.
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
    // `branchName` is REQUIRED here even though the prepare request leaves it
    // optional: a reuse check with no branch has no key to look its singular
    // candidate up by, and the derivation-seed argument does not reach a pure
    // read.
    const broken = { ...buildWorktreeReuseCheckRequest() } as Record<string, unknown>;
    delete broken[field];
    expect(WorktreeReuseCheckRequestSchema.safeParse(broken).success).toBe(false);
  });

  it("applies the wireFreeFormString guard to the request branchName", () => {
    // The request half has no cap row of its own (the response half carries
    // one), so a downgrade to a bare `z.string()` here would let a blank
    // lookup key through to a query that can only ever miss.
    for (const hostile of GUARD_DOWNGRADE_VALUES) {
      const probe = { ...buildWorktreeReuseCheckRequest(), branchName: hostile };
      expect(WorktreeReuseCheckRequestSchema.safeParse(probe).success).toBe(false);
    }
  });

  it("accepts the bare negative answer — `available: false` alone", () => {
    // Not a degenerate shape: every other field DESCRIBES a candidate, so
    // "no live candidate" is complete with one field. The absence of a
    // cross-field refinement is what makes it parse.
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
    // The two caps are DIFFERENT classes (512 vs 256), and this row is what
    // catches a swap: a `reason` capped at the ref length would refuse this
    // perfectly lawful 300-character explanation.
    expect(parseReuseCheckResponse({ reason: "r".repeat(300) }).success).toBe(true);
    // ... while a `branchName` capped at the reason length would accept one.
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
      // `Extract<WorktreeState, "retired">`. `failed` is the pointed exclusion:
      // a failed CREATION never materialized a checkout, so it is not a retire
      // outcome — and a retire refused while the root is busy is the typed
      // `worktree.retire_conflict` error, not a response carrying the
      // unchanged state.
      expect(WorktreeRetireResponseSchema.safeParse({ ...response, state }).success).toBe(false);
    }
  });

  it("carries no cleanedAt — nothing has been cleaned when it is produced", () => {
    // The recorded-then-cleaned ordering, pinned on the shape: the stamp
    // belongs to the async sweep and surfaces on the status read.
    const withStamp = { ...buildWorktreeRetireResponse(), cleanedAt: CLEANED_AT };
    expect(WorktreeRetireResponseSchema.safeParse(withStamp).success).toBe(false);
  });
});

describe("WorktreeStatusRead (worktree records with provenance)", () => {
  it("accepts a session-scoped read with and without the mount filter", () => {
    const sessionScoped = buildWorktreeStatusReadRequest();
    expect(WorktreeStatusReadRequestSchema.safeParse(sessionScoped).success).toBe(true);
    const mountFiltered = { sessionId: SESSION_ID, repoMountId: REPO_MOUNT_ID };
    expect(WorktreeStatusReadRequestSchema.safeParse(mountFiltered).success).toBe(true);
    // `sessionId` is not optional: the mount id is a FILTER, and the read is
    // the session's whole root roster when it is absent.
    const sessionless = { repoMountId: REPO_MOUNT_ID };
    expect(WorktreeStatusReadRequestSchema.safeParse(sessionless).success).toBe(false);
  });

  it("accepts the full projection and an EMPTY array alike", () => {
    const fullProjection = buildWorktreeStatusReadResponse();
    expect(WorktreeStatusReadResponseSchema.safeParse(fullProjection).success).toBe(true);
    // A session that has bound no worktree yet is a lawful answer, not a
    // degenerate one — hence no `.min(1)` on the array.
    const emptyProjection = { worktrees: [] };
    expect(WorktreeStatusReadResponseSchema.safeParse(emptyProjection).success).toBe(true);
  });

  it("requires the worktrees array to be present", () => {
    expect(WorktreeStatusReadResponseSchema.safeParse({}).success).toBe(false);
  });

  it.each([
    "worktreeId",
    "repoMountId",
    "branchName",
    "fsRoot",
    "state",
    "createdBySessionId",
    "createdAt",
    "updatedAt",
  ])("rejects a worktree record missing %s", (field) => {
    // `createdBySessionId` is the row the plan's Tests line names:
    // `worktrees.created_by_session_id` is NOT NULL and makes creating-session
    // provenance unconditional, so a provenance-less record is unrepresentable
    // rather than merely unusual.
    const broken = { ...buildWorktreeStatusRecord() } as Record<string, unknown>;
    delete broken[field];
    expect(parseStatusReadWorktreeRecord(broken).success).toBe(false);
  });

  it("keeps createdByRunId OPTIONAL but UUID-validated when present", () => {
    // The asymmetry with `createdBySessionId` IS the provenance contract:
    // `created_by_run_id` is nullable because a pre-run explicit prepare
    // creates a worktree with no run to attribute.
    const withoutRun = { ...buildWorktreeStatusRecord() } as Record<string, unknown>;
    delete withoutRun["createdByRunId"];
    expect(parseStatusReadWorktreeRecord(withoutRun).success).toBe(true);
    expect(parseStatusReadWithWorktree({ createdByRunId: "run-1" }).success).toBe(false);
    expect(parseStatusReadWithWorktree({ createdByRunId: RUN_ID }).success).toBe(true);
  });

  it("accepts the async cleanup stamp on a worktree record", () => {
    expect(parseStatusReadWithWorktree({ cleanedAt: CLEANED_AT }).success).toBe(true);
    expect(parseStatusReadWithWorktree({ cleanedAt: "2026-07-26" }).success).toBe(false);
  });

  it.each(["creating", "ready", "dirty", "merged", "retired", "failed"])(
    "never hides a worktree row in state %s",
    (state) => {
      // Admit-not-eject: the projection returns EVERY row and the Phase 4 views
      // label them. A "live states only" narrowing here would make the
      // contract unrepresentable on the wire.
      expect(parseStatusReadWithWorktree({ state }).success).toBe(true);
    },
  );

  it("keeps a workspace state out of the worktree record", () => {
    // The per-record composition of the canonical enum (contract half) keeps a
    // worktree row from borrowing a workspace state.
    expect(parseStatusReadWithWorktree({ state: "preparing" }).success).toBe(false);
  });

  it("applies the wireFreeFormString guard to every path and ref on the record", () => {
    // Two fields, neither of which has a cap row: a downgrade at either of them
    // would put a blank or NUL-bearing path into a projection the Phase 4 views
    // render directly.
    for (const hostile of GUARD_DOWNGRADE_VALUES) {
      expect(parseStatusReadWithWorktree({ branchName: hostile }).success).toBe(false);
      expect(parseStatusReadWithWorktree({ fsRoot: hostile }).success).toBe(false);
    }
  });
});

// --------------------------------------------------------------------------
// `.strict()` — the behavioral pin on all eleven shapes.
// --------------------------------------------------------------------------
//
// Outer `.strict()` is TYPE-INVISIBLE: a schema's inferred output does not
// reflect it, so a dropped `.strict()` compiles green and silently STRIPS the
// unknown key. Nothing else in this suite would catch that — which is why
// every shape gets a row here rather than a sampled few.

const expectClosedShape = (
  schema: { safeParse: (candidate: unknown) => { success: boolean } },
  fixture: Record<string, unknown>,
): void => {
  // Accept THEN reject: the accept leg proves the fixture is in-shape, so the
  // rejection is attributable to the stray key alone and not to a fixture that
  // never parsed. It also carries this block's second job — one parse-accept
  // per shape, all ten exported schemas.
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
    // The envelope's own `.strict()` cannot reach inside an array element, so
    // an item-level guard is a separate obligation — the wire shape is closed
    // at both levels (the `workspaceListItemSchema` precedent). This row is why
    // the count is eleven, not ten.
    expect(parseStatusReadWithWorktree({ unknownWireKey: "leak" }).success).toBe(false);
  });
});

// --------------------------------------------------------------------------
// Compile-time pins for shapes.
// --------------------------------------------------------------------------
//
// Never executed; present so `tsc -p tsconfig.test.json` fails if a narrowing
// or a required field is weakened. Each directive self-verifies: relax the
// constraint and TypeScript reports the directive unused (TS2578), turning the
// typecheck leg red rather than silently dropping the pin.

const extractNarrowingPins = (): void => {
  // @ts-expect-error — WorktreeRetireResponse admits `retired` only.
  const mergedRetireState: WorktreeRetireResponse["state"] = "merged";
  void mergedRetireState;
};
void extractNarrowingPins;

const worktreeStatusRecordProvenancePin = (): void => {
  // @ts-expect-error — a worktree record with no creating-session provenance.
  // Every OTHER field is populated correctly, so the missing
  // `createdBySessionId` is the only error the directive can be consuming: the
  // field is required on the TYPE, not merely at parse time.
  const missingCreatedBySessionId: WorktreeStatusReadResponse["worktrees"][number] = {
    worktreeId: WorktreeIdSchema.parse(WORKTREE_ID),
    repoMountId: RepoMountIdSchema.parse(REPO_MOUNT_ID),
    branchName: BRANCH_NAME,
    fsRoot: EXECUTION_ROOT,
    state: "ready",
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
  };
  void missingCreatedBySessionId;
};
void worktreeStatusRecordProvenancePin;

describe("index.ts re-exports wire surfaces", () => {
  it("re-exports every runtime symbol by identity", () => {
    // The barrel-gap regression. This module added `export *
    // from "./worktree.js"`, so these ride it — the pin is that they actually
    // reach the public surface, star export or not.
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

  // Compile-time reachability of type surface through the barrel.
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

// --------------------------------------------------------------------------
// Removing a worktree: keep or discard, and carrying uncommitted work.
// --------------------------------------------------------------------------

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
