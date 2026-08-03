// Plan-010 T1.1 — `worktree.ts` contract core: the three branded ids, the
// worktree/clone lifecycle enums, the clone cleanup-policy vocabulary, the
// family-payload instantiation over `WorktreeStateSchema`, and the
// registration of the five `worktree.*` variants into `SessionEventSchema`
// (CP-010-5).
//
// Backstops `Spec-010 §Required Behavior` (the six-state worktree lifecycle:
// `creating`, `ready`, `dirty`, `merged`, `retired`, `failed`) and
// `Spec-010 §Acceptance Criteria` (the execution-mode contract distinguishes
// `read-only` / `branch` / `worktree` / `ephemeral clone`), plus the
// contract-shape halves of the invariants this file carries:
//   • I-010-1 — import, never redefine: the four-mode taxonomy is pinned
//     through worktree.ts's re-export (type AND schema value) against
//     repo.ts's canonical declaration, and the identity checks — direct and
//     through the barrel — prove the re-export resolves to that one
//     declaration rather than forking or shadowing Plan-009 canon.
//   • I-010-2 (contract side) — the enum membership AND declaration order
//     the T1.4 conformance test compares against the migration's `CHECK`
//     clauses are pinned here as an exact ORDERED set; the DDL side lands
//     with T1.3/T1.4.
//   • D-010-11 — the registry stays closed: `worktree.failed` and
//     ephemeral-clone literals stay rejected by the union and absent from
//     the census.
//
// Coverage shape (mirrors repo.test.ts, the Phase-1 sibling):
//   • Every member of every enum parses; out-of-set values are rejected
//     (base-vocabulary states, case drift, plausible "cleanups" of the
//     snake_case cleanup-policy literal), so each pin is a real
//     accept/reject boundary.
//   • Branded ids reject a non-UUID, and the brands are nominal AND mutually
//     nominal at compile time.
//   • `WorktreeLifecyclePayloadSchema` accepts exactly the six-state worktree
//     vocabulary and rejects every base-vocabulary state (the PR #250
//     round-4 per-family accept set), keeps `.strict()`, and keeps the
//     family's field contract.
//   • The five `worktree.*` types parse end-to-end through
//     `SessionEventSchema` with `worktreeId`-bearing payloads, agree with
//     their standalone `*EventSchema` exports on every accept/reject axis
//     (envelope `.strict()` included — the one axis with no compile-time
//     backstop), and survive JSON round-trips; a category/type mismatch and
//     a base-vocabulary state are rejected.
//   • `worktree.failed` is rejected by the union and is NOT a census member
//     (D-010-11's closed registry), and `SESSION_EVENT_TYPES` carries the
//     five registered literals.
//   • The `index.ts` barrel re-exports every symbol this task provides — the
//     barrel-gap regression Plan-001 GitHub PR-#30 round-1 caught.
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
// The canonical DECLARATION, imported from its Plan-009 origin. worktree.ts
// re-exports the same binding (type and value); the aliased import below is
// that re-export, held under a distinct local name so the identity pin can
// compare the two surfaces rather than trivially comparing one to itself.
// `REPO_PATH_MAX_LEN` and `RepoMountIdSchema` ride along for T1.2's cap
// boundaries and its compile-time status-record pin — Plan-009 canon, consumed
// from its origin.
import { ExecutionModeSchema, REPO_PATH_MAX_LEN, RepoMountIdSchema } from "../repo.js";
import {
  BranchContextIdSchema,
  CleanupPolicySchema,
  EphemeralCloneDisposeRequestSchema,
  EphemeralCloneDisposeResponseSchema,
  EphemeralCloneIdSchema,
  EphemeralClonePrepareRequestSchema,
  EphemeralClonePrepareResponseSchema,
  EphemeralCloneStateSchema,
  ExecutionModeSchema as ExecutionModeSchemaFromWorktreeReExport,
  ExecutionModeSelectRequestSchema,
  ExecutionModeSelectResponseSchema,
  ExecutionRootPrepareRequestSchema,
  ExecutionRootPrepareResponseSchema,
  WORKTREE_GIT_REF_MAX_LEN,
  WORKTREE_REUSE_REASON_MAX_LEN,
  WorktreeIdSchema,
  WorktreeLifecyclePayloadSchema,
  WorktreeRetireRequestSchema,
  WorktreeRetireResponseSchema,
  WorktreeReuseCheckRequestSchema,
  WorktreeReuseCheckResponseSchema,
  WorktreeStateSchema,
  WorktreeStatusReadRequestSchema,
  WorktreeStatusReadResponseSchema,
  type BranchContextId,
  type EphemeralCloneDisposeResponse,
  type EphemeralCloneId,
  type EphemeralClonePrepareResponse,
  type ExecutionMode,
  type WorktreeId,
  type WorktreeLifecyclePayload,
  type WorktreeRetireResponse,
  type WorktreeState,
  type WorktreeStatusReadResponse,
} from "../worktree.js";

// Real RFC 9562 UUIDs (mix of v4 and v7) — the same fixture stance as
// repo.test.ts: z.uuid() validates the version nibble + variant bits, so the
// fixtures must be canonically valid, not lookalike strings.
const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
const REPO_MOUNT_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f10";
const WORKSPACE_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f11";
const WORKTREE_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f12";
const EPHEMERAL_CLONE_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f13";
const BRANCH_CONTEXT_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f14";
const PARTICIPANT_ID = "660e8400-e29b-41d4-a716-446655440001";
const OCCURRED_AT = "2026-07-26T09:30:00.000Z";
const VERSION = "1.0";

// --------------------------------------------------------------------------
// Canonical enums.
// --------------------------------------------------------------------------

describe("WorktreeStateSchema (Spec-010 §Required Behavior — the six-state worktree lifecycle)", () => {
  it.each([
    ["creating", true],
    ["ready", true],
    ["dirty", true],
    ["merged", true],
    ["retired", true],
    // `failed` is a ROW state with no `worktree.*` event of its own
    // (I-010-13 / D-010-11) — but it is fully in the state vocabulary.
    ["failed", true],
    // The base-family vocabularies stay out of this plan's accept set
    // (PR #250 round 4 — per-family vocabularies, no shared union).
    ["provisioning", false],
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
    // ORDER, not merely membership — this pin and the two Plan-010 enum
    // pins below are deliberately UNSORTED. Read through the same `.options`
    // internals cast the sibling suites use. Declaration order mirrors the
    // `worktrees.state` CHECK clause in
    // `docs/architecture/schemas/local-sqlite-schema.md §Workspace and Git Tables (Plan-009, Plan-010, Plan-011)`
    // byte-for-byte, which is what gives the T1.4 conformance test a
    // byte-exact target when it closes the I-010-2 lockstep from the DDL
    // side. A reorder fails here and forces a T1.4 re-sync; it is NOT a wire
    // break (RFC 8785 JCS serializes the literal string — the two-level note
    // on worktree.ts's §Canonical enums banner). DELIBERATE ASYMMETRY: the
    // `ExecutionModeSchema` pin at the bottom of this file sorts both sides
    // instead, because that enum is Plan-009 canon with no Plan-010 `CHECK`
    // clause to mirror.
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

describe("EphemeralCloneStateSchema (api-payload-contracts §Plan-010 — the four-state clone lifecycle)", () => {
  it.each([
    ["creating", true],
    ["ready", true],
    ["retired", true],
    ["failed", true],
    // Deliberate absences: clones are disposable per-task roots — merge-back
    // and dirtiness tracking are the worktree vocabulary's concern, and TTL
    // expiry RETIRES a clone rather than minting an `expired` state
    // (D-010-13).
    ["dirty", false],
    ["merged", false],
    ["expired", false],
    ["", false],
  ])("parses %s -> %s", (candidate, shouldPass) => {
    expect(EphemeralCloneStateSchema.safeParse(candidate).success).toBe(shouldPass);
  });

  it("enumerates exactly the four canonical states in the ratified CHECK order", () => {
    const schemaInternals = EphemeralCloneStateSchema as unknown as { options: readonly string[] };
    expect(schemaInternals.options).toEqual(["creating", "ready", "retired", "failed"]);
  });
});

describe("CleanupPolicySchema (ephemeral_clones.cleanup_policy)", () => {
  it.each([
    // The wire spelling is the snake_case ROW literal, verbatim — the
    // plausible "cleanups" below must all stay rejected, or a producer that
    // normalized the literal would diverge from the ratified CHECK bytes
    // (the same stance as `"ephemeral clone"`'s preserved space).
    ["on_run_complete", true],
    ["manual", true],
    ["onRunComplete", false],
    ["on-run-complete", false],
    ["auto", false],
    ["", false],
  ])("parses %s -> %s", (candidate, shouldPass) => {
    expect(CleanupPolicySchema.safeParse(candidate).success).toBe(shouldPass);
  });

  it("enumerates exactly the two canonical policies in the ratified CHECK order", () => {
    const schemaInternals = CleanupPolicySchema as unknown as { options: readonly string[] };
    expect(schemaInternals.options).toEqual(["on_run_complete", "manual"]);
  });
});

// --------------------------------------------------------------------------
// Branded ids.
// --------------------------------------------------------------------------

// Structural element typing, not inference: the three schemas have DISTINCT
// branded output types, so an un-annotated literal array widens `schema` to a
// union that includes `string` and `.parse` stops resolving. The structural
// view keeps one table driving all three (same affordance as
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
  ["EphemeralCloneIdSchema", EphemeralCloneIdSchema, EPHEMERAL_CLONE_ID],
  ["BranchContextIdSchema", BranchContextIdSchema, BRANCH_CONTEXT_ID],
];

describe("branded worktree / ephemeral-clone / branch-context ids", () => {
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
  // three brands collapse into one another (the repo.test.ts idiom).
  const brandNominalityPin = (): void => {
    // @ts-expect-error — a raw string is not a WorktreeId without a parse.
    const unbrandedWorktreeId: WorktreeId = WORKTREE_ID;
    void unbrandedWorktreeId;
    // @ts-expect-error — a raw string is not an EphemeralCloneId without a parse.
    const unbrandedEphemeralCloneId: EphemeralCloneId = EPHEMERAL_CLONE_ID;
    void unbrandedEphemeralCloneId;
    // @ts-expect-error — a raw string is not a BranchContextId without a parse.
    const unbrandedBranchContextId: BranchContextId = BRANCH_CONTEXT_ID;
    void unbrandedBranchContextId;
    // @ts-expect-error — mutually nominal: a parsed WorktreeId is not an
    // EphemeralCloneId.
    const crossBrand: EphemeralCloneId = WorktreeIdSchema.parse(WORKTREE_ID);
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
// arbitrary instantiation; this block pins the SHIPPED Plan-010
// instantiation's accept boundary, which is what CP-010-5 registers.

const buildWorktreePayload = (state: WorktreeState): WorktreeLifecyclePayload => ({
  // Narrow-cast on the ID FIELD only, never the whole payload: the payload
  // type brands `sessionId`, and a fixture literal needs the compile-time
  // bridge while every parse row below still validates the runtime value.
  sessionId: SESSION_ID as WorktreeLifecyclePayload["sessionId"],
  worktreeId: WORKTREE_ID,
  state,
});

describe("WorktreeLifecyclePayloadSchema (CP-010-5 — Plan-009's family shape over this plan's vocabulary)", () => {
  it.each(["creating", "ready", "dirty", "merged", "retired", "failed"])(
    "accepts the worktree vocabulary member %s",
    (state) => {
      // `failed` INCLUDED — representable in the payload type because the
      // state enum is the row vocabulary (I-010-2); what V1 pins is that no
      // `worktree.*` EVENT carries it, which is the closed-registry test
      // below, not a narrowed payload arm.
      expect(
        WorktreeLifecyclePayloadSchema.safeParse({ sessionId: SESSION_ID, state }).success,
      ).toBe(true);
    },
  );

  it.each(["attached", "detached", "provisioning", "busy", "stale", "archived"])(
    "REJECTS the base-family vocabulary member %s (per-family accept set, PR #250 round 4)",
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
        actor: PARTICIPANT_ID,
      }).success,
    ).toBe(true);
  });

  it("keeps `worktreeId` optional at the SHAPE layer (emitter discipline fills it, D-010-12)", () => {
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
// Union registration into SessionEventSchema (CP-010-5).
// --------------------------------------------------------------------------

// Each registered type paired with the state its emitter actually writes —
// the D-010-12 event-transition mapping (row creation → `worktree.created`,
// `creating -> ready` → `worktree.ready`, and so on; `-> failed` maps to NO
// event, which is the closed-registry block below).
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
// (the D-010-12 emitter obligation this suite's fixtures model), plus the
// mount and workspace the worktree serves — legitimately multi-id rows, which
// is why the family shape has no "exactly one id" refinement.
const buildWorktreeEvent = (eventType: string, state: string) => ({
  id: "evt-worktree-0001",
  sessionId: SESSION_ID,
  sequence: 11,
  occurredAt: OCCURRED_AT,
  category: "session_lifecycle" as const,
  type: eventType,
  actor: PARTICIPANT_ID,
  version: VERSION,
  payload: {
    sessionId: SESSION_ID,
    repoMountId: REPO_MOUNT_ID,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    state,
  },
});

describe("SessionEventSchema registration of the five Plan-010 variants (CP-010-5)", () => {
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
      // `worktreeId` (the D-010-12 emitter obligation), so this one
      // assertion covers its survival too.
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
        category: "membership_change" as const,
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
      SessionEventSchema.safeParse(buildWorktreeEvent("worktree.created", "provisioning")).success,
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

// The standalone exports are what Plan-010 Phase 2's emitter validates
// against before append — they must agree with the independently-spelled
// union arms or the two surfaces drift (the repo.test.ts standalone-vs-union
// stance). Structural `safeParse` typing sidesteps `z.ZodType` variance.
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
      // and STRIP the spurious key instead of rejecting. The emitter Plan-010
      // Phase 2 validates through this surface would then append canonical
      // bytes it never built, surfacing much later as a strict-union
      // rejection at replay. The union control on each row is what makes the
      // verdict a parity statement rather than a lone rejection.
      const fixture = buildWorktreeEvent(eventType, state);
      const withSpuriousEnvelopeKey = { ...fixture, spuriousEnvelopeKey: "x" };
      expect(standaloneSchema.safeParse(withSpuriousEnvelopeKey).success).toBe(false);
      expect(SessionEventSchema.safeParse(withSpuriousEnvelopeKey).success).toBe(false);
      // `category` sits in the RFC 8785 canonical bytes backing the hash
      // chain — pinned on the union above, pinned here on the standalone
      // surface (the fourth axis of the repo.test.ts precedent this block
      // mirrors).
      const withMismatchedCategory = { ...fixture, category: "membership_change" as const };
      expect(standaloneSchema.safeParse(withMismatchedCategory).success).toBe(false);
      expect(SessionEventSchema.safeParse(withMismatchedCategory).success).toBe(false);
    },
  );
});

// --------------------------------------------------------------------------
// The registry stays closed (D-010-11).
// --------------------------------------------------------------------------

describe("the Spec-006 registry stays closed (D-010-11)", () => {
  it("rejects `worktree.failed` through the union regardless of payload state", () => {
    // Two rows isolate the axes: with `state: "ready"` the payload WOULD
    // parse under a family arm if one existed, so the rejection is purely
    // the missing type arm; with `state: "failed"` the full would-be shape
    // of the deliberately-unminted event is refused end-to-end. The
    // `-> failed` transition emits no worktree event (I-010-13) — the
    // failure incident is evented as `workspace.stale` by the coupled
    // `failReprovision`.
    expect(
      SessionEventSchema.safeParse(buildWorktreeEvent("worktree.failed", "ready")).success,
    ).toBe(false);
    expect(
      SessionEventSchema.safeParse(buildWorktreeEvent("worktree.failed", "failed")).success,
    ).toBe(false);
  });

  it("keeps `worktree.failed` out of the roster AND out of the census", () => {
    // D-010-11 is stronger than "no payload variant": the plan adds NO rows
    // to the Spec-006 registry, so the literal must be absent from the
    // 156-type census itself, not merely unregistered in the schema union.
    //
    // Both lookups widen deliberately: `SESSION_EVENT_TYPES` is
    // `SessionEvent["type"][]` and the registry is keyed on
    // `SessionEventType`, so a literal that is (correctly) in NEITHER cannot
    // be passed at its declared key type — the `as never` affordance
    // session-event.test.ts uses for its own unregistered-literal probes.
    expect(SESSION_EVENT_TYPES as readonly string[]).not.toContain("worktree.failed");
    expect(SESSION_EVENT_CATEGORY_BY_TYPE.has("worktree.failed" as never)).toBe(false);
  });

  it.each([["clone.prepared"], ["clone.ready"], ["clone.retired"], ["clone.disposed"]])(
    "registers no ephemeral-clone event under the plausible literal %s",
    (cloneLiteral) => {
      // Clone transitions emit no session events at all (D-010-11) — the
      // plausible spellings stay census-absent and union-rejected.
      expect(SESSION_EVENT_CATEGORY_BY_TYPE.has(cloneLiteral as never)).toBe(false);
      const cloneEvent = buildWorktreeEvent(cloneLiteral, "ready");
      expect(SessionEventSchema.safeParse(cloneEvent).success).toBe(false);
    },
  );
});

// --------------------------------------------------------------------------
// Execution-mode taxonomy reachability (Spec-010 §Acceptance Criteria).
// --------------------------------------------------------------------------

// Compile-time exhaustiveness pin over the TYPE half of worktree.ts's
// re-export: `Record<ExecutionMode, true>` fails to compile if a mode is
// missing OR if an extra key is added, so the four-mode taxonomy is provably
// reachable through this module's surface (I-010-1: reached by import, never
// redefinition).
const executionModeTaxonomy: Record<ExecutionMode, true> = {
  "read-only": true,
  branch: true,
  worktree: true,
  "ephemeral clone": true,
};

describe("execution-mode taxonomy (Spec-010 §Acceptance Criteria, via the Plan-009 import)", () => {
  it("distinguishes read-only / branch / worktree / ephemeral clone", () => {
    // Bind the compile-time pin above to the canonical runtime schema: the
    // four keys and the four `.options` are the same set. SORTED both sides,
    // unlike the three Plan-010 enum pins at the top of this file: this enum
    // is Plan-009 canon with no Plan-010 `CHECK` clause to mirror, so
    // membership is the whole of what Plan-010 can pin — the same
    // membership-not-order stance repo.test.ts takes for this schema.
    const schemaInternals = ExecutionModeSchema as unknown as { options: readonly string[] };
    expect([...schemaInternals.options].sort()).toEqual(Object.keys(executionModeTaxonomy).sort());
    expect(schemaInternals.options).toHaveLength(4);
  });

  it("re-exports the canonical schema VALUE by identity, never a fork (I-010-1)", () => {
    // The runtime half of the re-export, pinned directly on worktree.ts's own
    // surface — the binding T1.2's `ExecutionModeSelectRequest` /
    // `ExecutionModeSelectResponse` Zod pairs consume. A four-member enum
    // REDEFINED in worktree.ts would satisfy the exhaustiveness pin above and
    // every `.options` assertion; only object identity against the Plan-009
    // declaration refuses it.
    expect(ExecutionModeSchemaFromWorktreeReExport).toBe(ExecutionModeSchema);
  });

  it("keeps the canonical schema reachable through the barrel by identity", () => {
    // The re-export must COMPOSE Plan-009 canon, never fork it: index.ts
    // star-exports both repo.ts and worktree.ts, so this asserts the barrel
    // still surfaces the one canonical `ExecutionModeSchema` object — a
    // second, redefined execution-mode schema in worktree.ts would fail the
    // identity check here even though both would type-check (I-010-1). This
    // is also the barrel-ambiguity canary now that the VALUE reaches index.ts
    // down two star-export paths: `export *` conflicts only when the paths
    // resolve to DIFFERENT declarations, and a conflicted name resolves to
    // `undefined` — which fails here.
    expect(contracts.ExecutionModeSchema).toBe(ExecutionModeSchema);
  });
});

// --------------------------------------------------------------------------
// Barrel surface.
// --------------------------------------------------------------------------

describe("index.ts re-exports the Plan-010 contract core", () => {
  it("re-exports every runtime symbol by identity (the PR-#30 barrel-gap regression)", () => {
    expect(contracts.WorktreeIdSchema).toBe(WorktreeIdSchema);
    expect(contracts.EphemeralCloneIdSchema).toBe(EphemeralCloneIdSchema);
    expect(contracts.BranchContextIdSchema).toBe(BranchContextIdSchema);
    expect(contracts.WorktreeStateSchema).toBe(WorktreeStateSchema);
    expect(contracts.EphemeralCloneStateSchema).toBe(EphemeralCloneStateSchema);
    expect(contracts.CleanupPolicySchema).toBe(CleanupPolicySchema);
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
    const ephemeralCloneState: contracts.EphemeralCloneState = "retired";
    void ephemeralCloneState;
    const executionMode: contracts.ExecutionMode = "ephemeral clone";
    void executionMode;
    const worktreeId: contracts.WorktreeId = WorktreeIdSchema.parse(WORKTREE_ID);
    void worktreeId;
    const payload: contracts.WorktreeLifecyclePayload = buildWorktreePayload("ready");
    void payload;
  };
  void barrelTypeSurfacePin;
});

// ==========================================================================
// Wire surfaces — the seven `repo.*` request/response pairs (T1.2).
// ==========================================================================
//
// Coverage backstops the seven `Spec-010 §Interfaces And Contracts` bullets,
// one per pair: select distinguishes the four canonical modes and records one;
// prepare creates-or-binds the root and carries explicit reuse; the reuse check
// reports branch, cleanliness, and compatibility; clone prepare reports root,
// lifecycle, and cleanup policy; dispose is an explicit interface; retire
// records retirement independent of disk deletion; the status read exposes
// worktree AND clone records with provenance. It also carries the contract
// half of I-010-2 — every `state` field composes the canonical enum object, so
// a re-spelled literal union that fell outside T1.4's DDL lockstep fails the
// vocabulary rows below — and the D-010-19 requiredness split (clone prepare
// requires `branchName` in the SHAPE; execution-root prepare leaves it
// schema-optional and refuses service-side).
//
// THE `.strict()` PIN IS BEHAVIORAL AND EXHAUSTIVE (the block at the end of
// this file). Outer `.strict()` leaves no trace in a schema's inferred output
// type, so a dropped `.strict()` typechecks green and silently STRIPS the
// unknown key instead of rejecting it — the failure mode that would let a
// caller believe it set a clone TTL. Sixteen shapes are pinned there: the
// fourteen exported schemas plus both status-read ITEM schemas, which are
// closed independently of their envelope. Those rows also carry the
// "parse-accept one in-shape fixture per shape" floor for all fourteen, since
// each pin asserts its fixture parses before adding the stray key.

const RUN_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f15";
const EXECUTION_ROOT = "/Users/dev/.ai-sidekicks/execution-roots/mount-0190f8a0/worktrees/wt-01";
const CLONE_ROOT = "/Users/dev/.ai-sidekicks/execution-roots/mount-0190f8a0/clones/cl-01";
const BRANCH_NAME = "sidekicks/550e8400/add-worktree-wire-pairs";
const BASE_REF = "main";
const CREATED_AT = "2026-07-26T09:30:00.000Z";
const UPDATED_AT = "2026-07-26T09:31:00.000Z";
const EXPIRES_AT = "2026-07-27T09:30:00.000Z";
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

// The select fixture carries the WRITABLE case — no `executionRoot`, because a
// writable select returns while the workspace is still `provisioning`. The
// synchronous `read-only` case is a row of its own below, so the optionality
// is exercised in both directions rather than assumed.
const buildExecutionModeSelectRequest = () => ({
  workspaceId: WORKSPACE_ID,
  executionMode: "worktree",
});
const buildExecutionModeSelectResponse = () => ({
  workspaceId: WORKSPACE_ID,
  executionMode: "worktree",
  state: "provisioning",
});

// The MINIMAL lawful prepare request — `workspaceId` alone. Every other field
// is optional at the shape layer (D-010-19), which is exactly what the
// full-shape row below contrasts against.
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

const buildEphemeralClonePrepareRequest = () => ({
  workspaceId: WORKSPACE_ID,
  branchName: BRANCH_NAME,
});
const buildEphemeralClonePrepareResponse = () => ({
  cloneId: EPHEMERAL_CLONE_ID,
  cloneRoot: CLONE_ROOT,
  state: "ready",
  cleanupPolicy: "on_run_complete",
  branchName: BRANCH_NAME,
  expiresAt: EXPIRES_AT,
});

const buildEphemeralCloneDisposeRequest = () => ({ cloneId: EPHEMERAL_CLONE_ID });
const buildEphemeralCloneDisposeResponse = () => ({
  cloneId: EPHEMERAL_CLONE_ID,
  state: "retired",
});

const buildWorktreeRetireRequest = () => ({ worktreeId: WORKTREE_ID });
const buildWorktreeRetireResponse = () => ({ worktreeId: WORKTREE_ID, state: "retired" });

// The worktree record carries RUN provenance and no cleanup stamp — a live
// run-created checkout. The clone record carries neither a run edge (clones
// have no `created_by_run_id`; the run edge lives in `run_execution_contexts`)
// nor a stamp.
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
const buildEphemeralCloneStatusRecord = () => ({
  cloneId: EPHEMERAL_CLONE_ID,
  workspaceId: WORKSPACE_ID,
  cloneRoot: CLONE_ROOT,
  branchName: BRANCH_NAME,
  state: "ready",
  cleanupPolicy: "on_run_complete",
  expiresAt: EXPIRES_AT,
  createdAt: CREATED_AT,
});
const buildWorktreeStatusReadRequest = () => ({ sessionId: SESSION_ID });
const buildWorktreeStatusReadResponse = () => ({
  worktrees: [buildWorktreeStatusRecord()],
  ephemeralClones: [buildEphemeralCloneStatusRecord()],
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
const parseClonePrepareRequest = (overrides: Record<string, unknown> = {}) =>
  EphemeralClonePrepareRequestSchema.safeParse({
    ...buildEphemeralClonePrepareRequest(),
    ...overrides,
  });
const parseClonePrepareResponse = (overrides: Record<string, unknown> = {}) =>
  EphemeralClonePrepareResponseSchema.safeParse({
    ...buildEphemeralClonePrepareResponse(),
    ...overrides,
  });
// Status-read helpers reach INTO the arrays: every interesting failure mode is
// per-RECORD, and a top-level override could not express one. The two record
// helpers take a whole record (so the field-omission rows can `delete` a key);
// the two override helpers ride them for the common in-shape case.
const parseStatusReadWorktreeRecord = (record: Record<string, unknown>) =>
  WorktreeStatusReadResponseSchema.safeParse({ worktrees: [record], ephemeralClones: [] });
const parseStatusReadCloneRecord = (record: Record<string, unknown>) =>
  WorktreeStatusReadResponseSchema.safeParse({ worktrees: [], ephemeralClones: [record] });
const parseStatusReadWithWorktree = (overrides: Record<string, unknown> = {}) =>
  parseStatusReadWorktreeRecord({ ...buildWorktreeStatusRecord(), ...overrides });
const parseStatusReadWithClone = (overrides: Record<string, unknown> = {}) =>
  parseStatusReadCloneRecord({ ...buildEphemeralCloneStatusRecord(), ...overrides });

describe("ExecutionModeSelect request (Spec-010 §Interfaces And Contracts — records the mode)", () => {
  it("accepts a select naming a workspace and an explicit mode", () => {
    expect(parseSelectRequest().success).toBe(true);
  });

  it.each(["read-only", "branch", "worktree", "ephemeral clone"])(
    "distinguishes the canonical mode %s",
    (executionMode) => {
      // The spec bullet in full: select "must distinguish `read-only`,
      // `branch`, `worktree`, and `ephemeral clone`". Reached through the
      // imported Plan-009 taxonomy (I-010-1), so all four are wire-lawful here.
      expect(parseSelectRequest({ executionMode }).success).toBe(true);
    },
  );

  it.each([
    // Normalizations of the canonical spelling are contract breaks, not
    // tolerated variants — `"ephemeral clone"` keeps its SPACE on the wire.
    ["ephemeral_clone"],
    ["ephemeral-clone"],
    ["ephemeralClone"],
    ["readonly"],
    ["Worktree"],
    // A plausible-but-absent mode, and the empty string.
    ["detached"],
    [""],
  ])("rejects the out-of-taxonomy executionMode %s", (executionMode) => {
    expect(parseSelectRequest({ executionMode }).success).toBe(false);
  });

  it.each(["workspaceId", "executionMode"])("rejects a select missing %s", (field) => {
    // Neither field has a wire default: `executionMode` is deliberately not
    // `.default("read-only")`, because a default would make "caller omitted the
    // mode" indistinguishable from "caller chose read-only" on the one surface
    // whose whole job is recording an explicit switch.
    const broken = { ...buildExecutionModeSelectRequest() } as Record<string, unknown>;
    delete broken[field];
    expect(ExecutionModeSelectRequestSchema.safeParse(broken).success).toBe(false);
  });

  it("requires a canonical-UUID workspaceId", () => {
    expect(parseSelectRequest({ workspaceId: "workspace-1" }).success).toBe(false);
  });
});

describe("ExecutionModeSelect response (D-010-2 — executionRoot iff resolved synchronously)", () => {
  it("accepts the writable answer with NO executionRoot", () => {
    // The `provisioning` case: the mode is recorded, the root does not exist
    // yet, and `repo.executionRootPrepare` will materialize it.
    expect(parseSelectResponse().success).toBe(true);
  });

  it("accepts the synchronous read-only answer carrying executionRoot", () => {
    expect(
      parseSelectResponse({
        executionMode: "read-only",
        state: "ready",
        executionRoot: EXECUTION_ROOT,
      }).success,
    ).toBe(true);
  });

  it("applies the wireFreeFormString guard to executionRoot", () => {
    // GUARD-DOWNGRADE VISIBILITY: re-spelling the field as a bare
    // `z.string().optional()` passes every other row in this block; these
    // three make it fail.
    expect(parseSelectResponse({ executionRoot: "" }).success).toBe(false);
    expect(parseSelectResponse({ executionRoot: "   " }).success).toBe(false);
    const rootWithNulByte = `${EXECUTION_ROOT}${String.fromCharCode(0)}/etc`;
    expect(parseSelectResponse({ executionRoot: rootWithNulByte }).success).toBe(false);
  });

  it.each(["read-only", "branch", "worktree", "ephemeral clone"])(
    "echoes back the full four-mode taxonomy — %s",
    (executionMode) => {
      // The response echo is not a narrower surface than the request: I-010-7
      // makes an unavailable mode a typed `workspace.mode_unsupported` refusal,
      // so every mode the request accepts must be echoable. A narrowing like
      // `z.enum(["worktree", "read-only"])` is assignable to the wider
      // `ExecutionMode` annotation, so it typechecks green and passes every
      // other row here while silently refusing two lawful answers.
      expect(parseSelectResponse({ executionMode }).success).toBe(true);
    },
  );

  it("rejects an out-of-taxonomy executionMode on the response too", () => {
    // Negative control on the row above — response validation is not laxer
    // than request validation (I-009-10 validates both directions).
    expect(parseSelectResponse({ executionMode: "ephemeral_clone" }).success).toBe(false);
    expect(parseSelectResponse({ executionMode: "detached" }).success).toBe(false);
  });

  it.each(["provisioning", "ready", "busy", "stale", "archived"])(
    "carries the full WorkspaceState vocabulary, not a two-literal narrowing — %s",
    (state) => {
      // The ratified block types this field `WorkspaceState` and glosses the
      // two expected values in a comment; a `z.enum(["ready","provisioning"])`
      // would silently reject the other three lawful states while passing
      // every other row here. Contrast the three `Extract`-narrowed `state`
      // fields below, where the ratified block narrows the TYPE.
      expect(parseSelectResponse({ state }).success).toBe(true);
    },
  );

  it.each(["creating", "dirty", "merged", "retired", "failed", "exploded"])(
    "still rejects the non-workspace state %s (non-narrowed is not unvalidated)",
    (state) => {
      // Negative control on the row above — and the I-010-2 contract half: the
      // field composes Plan-009's `WorkspaceStateSchema`, so THIS plan's
      // worktree vocabulary must not leak into a workspace-state slot.
      expect(parseSelectResponse({ state }).success).toBe(false);
    },
  );
});

describe("ExecutionRootPrepare request (Spec-010 §Interfaces And Contracts — create or bind)", () => {
  it("accepts the minimal shape — workspaceId alone (D-010-19 schema-optional branch)", () => {
    // `branchName` stays optional in the SHAPE on purpose: a writable-mode wire
    // prepare without it draws the typed service-side
    // `workspace.branch_name_required` (400) refusal, which the schema cannot
    // raise because the workspace's selected mode is not visible at parse time.
    expect(parsePrepareRequest().success).toBe(true);
  });

  it("accepts the full explicit-reuse shape (D-010-15)", () => {
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
    // D-010-16: the run-setup gate calls the service directly and supplies the
    // run id that populates `worktrees.created_by_run_id`. A wire `runId` would
    // let a caller forge provenance on a row the gate owns, so `.strict()`
    // refuses the key rather than ignoring it.
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
    // `REPO_PATH_MAX_LEN` by a copy-paste would accept this 4096-character
    // value and pass every other row in this block.
    const pathLengthBranch = "b".repeat(REPO_PATH_MAX_LEN);
    expect(parsePrepareRequest({ branchName: pathLengthBranch }).success).toBe(false);
  });
});

// The four mode-discriminated response shapes, keyed by which root id each
// carries. All three WRITABLE modes carry `branchContextId`
// (`Spec-010 §State And Data Implications`); `read-only` carries none of the
// three. The element type is spelled out rather than inferred: an
// un-annotated literal array widens each row to a union that includes
// `string`, and the spread in the test body then stops type-checking as an
// object (the `REGISTERED_WORKTREE_EVENTS` stance above).
const PREPARE_RESPONSE_MODE_SHAPES: ReadonlyArray<readonly [string, Record<string, string>]> = [
  ["worktree mode", { worktreeId: WORKTREE_ID, branchContextId: BRANCH_CONTEXT_ID }],
  [
    "ephemeral clone mode",
    { ephemeralCloneId: EPHEMERAL_CLONE_ID, branchContextId: BRANCH_CONTEXT_ID },
  ],
  ["branch mode", { branchContextId: BRANCH_CONTEXT_ID }],
  ["read-only mode", {}],
];

describe("ExecutionRootPrepare response (I-010-7 — a root or a typed refusal, never both)", () => {
  it.each(PREPARE_RESPONSE_MODE_SHAPES)("accepts the %s shape", (_label, idFields) => {
    const response = {
      executionRoot: EXECUTION_ROOT,
      state: "ready",
      ...idFields,
    };
    expect(ExecutionRootPrepareResponseSchema.safeParse(response).success).toBe(true);
  });

  it("rejects a response with no executionRoot — unrepresentable-absent", () => {
    // Preparation failure ABORTS with a typed error (`worktree.create_failed`
    // / `clone.prepare_failed`); I-010-7 admits no fallback root, so there is
    // no partial success carrying an unresolved one.
    const broken = { ...buildExecutionRootPrepareResponse() } as Record<string, unknown>;
    delete broken["executionRoot"];
    expect(ExecutionRootPrepareResponseSchema.safeParse(broken).success).toBe(false);
  });

  it("applies the wireFreeFormString guard to executionRoot", () => {
    for (const hostile of GUARD_DOWNGRADE_VALUES) {
      expect(parsePrepareResponse({ executionRoot: hostile }).success).toBe(false);
    }
  });

  it.each(["provisioning", "ready", "busy", "stale", "archived"])(
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
    // Negative control, and the I-010-2 contract half: this field composes
    // Plan-009's `WorkspaceStateSchema`, so THIS plan's vocabulary must not
    // leak into it.
    expect(parsePrepareResponse({ state: "dirty" }).success).toBe(false);
    expect(parsePrepareResponse({ state: "creating" }).success).toBe(false);
  });

  it("keeps each root id branded to its own vocabulary", () => {
    expect(parsePrepareResponse({ worktreeId: "worktree-1" }).success).toBe(false);
    expect(parsePrepareResponse({ ephemeralCloneId: "clone-1" }).success).toBe(false);
    expect(parsePrepareResponse({ branchContextId: "ctx-1" }).success).toBe(false);
  });

  it("does NOT refine the mode-discriminated ids against each other", () => {
    // Deliberate, not an omission: which id set is lawful depends on the
    // workspace's selected mode, which the schema cannot see. The structural
    // at-most-one rule lives in the `branch_contexts` CHECK (I-010-5, T1.3) and
    // the mode-conditional `run_execution_contexts` CHECK, where it can be
    // enforced against real row state. A refinement here would also make T2.4's
    // polymorphism tests vacuous.
    expect(
      parsePrepareResponse({
        worktreeId: WORKTREE_ID,
        ephemeralCloneId: EPHEMERAL_CLONE_ID,
      }).success,
    ).toBe(true);
  });
});

describe("WorktreeReuseCheck (Spec-010 §Interfaces And Contracts — branch, cleanliness, compat)", () => {
  it("accepts a mount-scoped check naming a branch", () => {
    const check = buildWorktreeReuseCheckRequest();
    expect(WorktreeReuseCheckRequestSchema.safeParse(check).success).toBe(true);
  });

  it.each(["repoMountId", "branchName"])("rejects a check missing %s", (field) => {
    // `branchName` is REQUIRED here even though the prepare request leaves it
    // optional: a reuse check with no branch has no key to look its singular
    // candidate up by, and D-010-19's derivation-seed argument does not reach
    // a pure read.
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

  it("rejects a workspace state on the candidate (I-010-2 contract half)", () => {
    expect(parseReuseCheckResponse({ state: "provisioning" }).success).toBe(false);
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

describe("EphemeralClonePrepare request (D-010-19 branch required; D-010-2 no wire TTL)", () => {
  it("accepts a prepare with and without an explicit cleanupPolicy", () => {
    expect(parseClonePrepareRequest().success).toBe(true);
    expect(parseClonePrepareRequest({ cleanupPolicy: "manual" }).success).toBe(true);
    expect(parseClonePrepareRequest({ cleanupPolicy: "on_run_complete" }).success).toBe(true);
  });

  it("REJECTS a prepare missing branchName (D-010-19)", () => {
    // The requiredness split this pair exists to pin: a wire clone prepare is
    // pre-run and carries no slug-rule derivation seed, and unlike the
    // execution-root prepare there is no `read-only` arm for which a head
    // branch would be meaningless — so requiredness is expressible in the
    // SHAPE and lives here rather than in a service-side refusal.
    const broken = { ...buildEphemeralClonePrepareRequest() } as Record<string, unknown>;
    delete broken["branchName"];
    expect(EphemeralClonePrepareRequestSchema.safeParse(broken).success).toBe(false);
  });

  it("requires workspaceId — the field the `as unknown as` bridge cannot pin", () => {
    // This is one of the TWO schemas carrying the bridge, and the cast erases
    // all structural checking: re-spell this field `WorkspaceIdSchema.optional()`
    // and typecheck stays green (the annotation is asserted, not derived),
    // while `expectClosedShape`'s fixture supplies the key. These two rows are
    // the only backstop against a workspace-less clone prepare.
    const broken = { ...buildEphemeralClonePrepareRequest() } as Record<string, unknown>;
    delete broken["workspaceId"];
    expect(EphemeralClonePrepareRequestSchema.safeParse(broken).success).toBe(false);
    expect(parseClonePrepareRequest({ workspaceId: "workspace-1" }).success).toBe(false);
  });

  it("applies the wireFreeFormString guard to branchName", () => {
    // Same bridge exposure: the cast means a downgrade to a bare `z.string()`
    // here is invisible to tsc, and a whitespace-only head branch would reach
    // the clone service as if it were a name.
    for (const hostile of GUARD_DOWNGRADE_VALUES) {
      expect(parseClonePrepareRequest({ branchName: hostile }).success).toBe(false);
    }
  });

  it.each(["ttlMs", "ttlSeconds", "expiresAt", "ttl"])(
    "rejects the TTL-like key %s under strict parsing",
    (ttlKey) => {
      // TTL is DAEMON CONFIGURATION (`Spec-010 §Resolved Questions and V1 Scope
      // Decisions`), so no spelling of it is a wire parameter. `.strict()` is
      // what makes this a refusal rather than a silent strip — a caller that
      // believed it set a deadline and had the key dropped would run against
      // an expiry it never chose.
      expect(parseClonePrepareRequest({ [ttlKey]: 3_600_000 }).success).toBe(false);
    },
  );

  it("rejects a normalized cleanupPolicy spelling", () => {
    // The wire literal is the snake_case ROW value, verbatim — a producer that
    // camelCased it would diverge from the ratified CHECK bytes.
    expect(parseClonePrepareRequest({ cleanupPolicy: "onRunComplete" }).success).toBe(false);
    expect(parseClonePrepareRequest({ cleanupPolicy: "auto" }).success).toBe(false);
  });

  it("does not default cleanupPolicy on the wire", () => {
    // `.default()` was refused twice over: it would make "caller omitted" and
    // "caller chose on_run_complete" indistinguishable, and it is a TRANSFORM,
    // so Input would stop equalling Output — a divergence this schema's
    // `as unknown as` double-T bridge would HIDE rather than surface. Omission
    // therefore stays omission through the parse.
    const parsed = EphemeralClonePrepareRequestSchema.parse(buildEphemeralClonePrepareRequest());
    expect("cleanupPolicy" in parsed).toBe(false);
  });
});

describe("EphemeralClonePrepare response (Extract-narrowed state; reports policy + expiry)", () => {
  it.each(["creating", "ready"])("accepts the non-terminal prepare state %s", (state) => {
    expect(parseClonePrepareResponse({ state }).success).toBe(true);
  });

  it.each(["retired", "failed"])(
    "REJECTS the terminal clone state %s (the Extract narrowing, runtime half)",
    (state) => {
      // A prepare that ended `retired` or `failed` did not prepare a clone — it
      // refused with `clone.prepare_failed` (I-010-7). Both literals are lawful
      // members of `EphemeralCloneState`, so only the narrowing rejects them,
      // and outer narrowing has no compile-time trace on a parse of unknown
      // input — hence this runtime row plus the compile-time pin below.
      expect(parseClonePrepareResponse({ state }).success).toBe(false);
    },
  );

  it.each(["cloneId", "cloneRoot", "state", "cleanupPolicy", "branchName", "expiresAt"])(
    "rejects a prepare response missing %s — every field is required",
    (field) => {
      // `branchName` is the row the plan's Tests line names ("clone shapes
      // carry branchName"): the effective head branch is persisted on the clone
      // row (`ephemeral_clones.branch_name` NOT NULL) and reported here, so a
      // clone with no head branch is a state the model never produces.
      const broken = { ...buildEphemeralClonePrepareResponse() } as Record<string, unknown>;
      delete broken[field];
      expect(EphemeralClonePrepareResponseSchema.safeParse(broken).success).toBe(false);
    },
  );

  it.each(["on_run_complete", "manual"])(
    "reports either effective cleanup policy — %s",
    (cleanupPolicy) => {
      // The fixture only ever carries `on_run_complete`. Reporting the
      // EFFECTIVE policy is this field's entire job (D-010-2), so a narrowing
      // to the default value alone would make the `manual` answer — the one a
      // caller explicitly asked for — unrepresentable, while typechecking green
      // against the wider `"on_run_complete" | "manual"` annotation.
      expect(parseClonePrepareResponse({ cleanupPolicy }).success).toBe(true);
    },
  );

  it("rejects a normalized or invented cleanupPolicy on the response", () => {
    expect(parseClonePrepareResponse({ cleanupPolicy: "onRunComplete" }).success).toBe(false);
    expect(parseClonePrepareResponse({ cleanupPolicy: "never" }).success).toBe(false);
  });

  it("applies the wireFreeFormString guard to cloneRoot and branchName", () => {
    for (const hostile of GUARD_DOWNGRADE_VALUES) {
      expect(parseClonePrepareResponse({ cloneRoot: hostile }).success).toBe(false);
      expect(parseClonePrepareResponse({ branchName: hostile }).success).toBe(false);
    }
  });

  it("accepts both ISO-8601 instant forms on expiresAt and rejects non-instants", () => {
    // `{ offset: true }` widens Zod's default Z-only acceptance to numeric
    // RFC 3339 §5.6 offsets — the package-wide datetime convention. The offset
    // row is what proves the option is present: without it that value fails.
    expect(parseClonePrepareResponse({ expiresAt: "2026-07-27T11:30:00.000+02:00" }).success).toBe(
      true,
    );
    expect(parseClonePrepareResponse({ expiresAt: "2026-07-27" }).success).toBe(false);
    expect(parseClonePrepareResponse({ expiresAt: "not-a-timestamp" }).success).toBe(false);
    expect(parseClonePrepareResponse({ expiresAt: 1_800_000_000 }).success).toBe(false);
  });
});

describe("EphemeralCloneDispose (Spec-010 §Interfaces And Contracts — the explicit `manual` arm)", () => {
  it("accepts a dispose naming the clone and requires a canonical UUID", () => {
    const request = buildEphemeralCloneDisposeRequest();
    expect(EphemeralCloneDisposeRequestSchema.safeParse(request).success).toBe(true);
    expect(EphemeralCloneDisposeRequestSchema.safeParse({}).success).toBe(false);
    const nonUuidCloneId = { cloneId: "clone-1" };
    expect(EphemeralCloneDisposeRequestSchema.safeParse(nonUuidCloneId).success).toBe(false);
  });

  it("accepts the one success state and rejects the other three", () => {
    const response = buildEphemeralCloneDisposeResponse();
    expect(EphemeralCloneDisposeResponseSchema.safeParse(response).success).toBe(true);
    for (const state of ["creating", "ready", "failed"]) {
      // `Extract<EphemeralCloneState, "retired">`: dispose RECORDS retirement
      // and disk removal follows asynchronously (I-010-9), so no other state is
      // reachable on this path. All three rejected literals are lawful members
      // of the parent enum — only the narrowing refuses them.
      expect(EphemeralCloneDisposeResponseSchema.safeParse({ ...response, state }).success).toBe(
        false,
      );
    }
  });
});

describe("WorktreeRetire (Spec-010 §Interfaces And Contracts — records retirement)", () => {
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
    // I-010-9's recorded-then-cleaned ordering, pinned on the shape: the stamp
    // belongs to the async sweep and surfaces on the status read.
    const withStamp = { ...buildWorktreeRetireResponse(), cleanedAt: CLEANED_AT };
    expect(WorktreeRetireResponseSchema.safeParse(withStamp).success).toBe(false);
  });
});

describe("WorktreeStatusRead (D-010-17 — worktree + clone records with provenance)", () => {
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

  it("accepts the full projection and two EMPTY arrays alike", () => {
    const fullProjection = buildWorktreeStatusReadResponse();
    expect(WorktreeStatusReadResponseSchema.safeParse(fullProjection).success).toBe(true);
    // A session that has bound no writable root yet is a lawful answer, not a
    // degenerate one — hence no `.min(1)` on either array.
    const emptyProjection = { worktrees: [], ephemeralClones: [] };
    expect(WorktreeStatusReadResponseSchema.safeParse(emptyProjection).success).toBe(true);
  });

  it.each(["worktrees", "ephemeralClones"])("requires the %s array to be present", (arrayField) => {
    const broken = { ...buildWorktreeStatusReadResponse() } as Record<string, unknown>;
    delete broken[arrayField];
    expect(WorktreeStatusReadResponseSchema.safeParse(broken).success).toBe(false);
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
    // `worktrees.created_by_session_id` is NOT NULL and I-010-3 makes
    // creating-session provenance unconditional, so a provenance-less record is
    // unrepresentable rather than merely unusual.
    const broken = { ...buildWorktreeStatusRecord() } as Record<string, unknown>;
    delete broken[field];
    expect(parseStatusReadWorktreeRecord(broken).success).toBe(false);
  });

  it("keeps createdByRunId OPTIONAL but UUID-validated when present", () => {
    // The asymmetry with `createdBySessionId` IS the provenance contract:
    // `created_by_run_id` is nullable because a pre-run explicit prepare
    // creates a worktree with no run to attribute (D-010-5).
    const withoutRun = { ...buildWorktreeStatusRecord() } as Record<string, unknown>;
    delete withoutRun["createdByRunId"];
    expect(parseStatusReadWorktreeRecord(withoutRun).success).toBe(true);
    expect(parseStatusReadWithWorktree({ createdByRunId: "run-1" }).success).toBe(false);
    expect(parseStatusReadWithWorktree({ createdByRunId: RUN_ID }).success).toBe(true);
  });

  it("accepts the async cleanup stamp on either record kind", () => {
    expect(parseStatusReadWithWorktree({ cleanedAt: CLEANED_AT }).success).toBe(true);
    expect(parseStatusReadWithClone({ cleanedAt: CLEANED_AT }).success).toBe(true);
    expect(parseStatusReadWithWorktree({ cleanedAt: "2026-07-26" }).success).toBe(false);
  });

  it.each(["creating", "ready", "dirty", "merged", "retired", "failed"])(
    "never hides a worktree row in state %s (I-010-19)",
    (state) => {
      // Admit-not-eject: the projection returns EVERY row and the Phase 4 views
      // label them. A "live states only" narrowing here would make the
      // contract unrepresentable on the wire.
      expect(parseStatusReadWithWorktree({ state }).success).toBe(true);
    },
  );

  it.each(["creating", "ready", "retired", "failed"])(
    "never hides a clone row in state %s (I-010-19)",
    (state) => {
      expect(parseStatusReadWithClone({ state }).success).toBe(true);
    },
  );

  it("keeps the two state vocabularies disjoint per record kind", () => {
    // A clone has no `dirty` / `merged` position, and a worktree row must not
    // borrow a workspace state — the per-record composition of the canonical
    // enums (I-010-2 contract half) is what enforces both.
    expect(parseStatusReadWithClone({ state: "dirty" }).success).toBe(false);
    expect(parseStatusReadWithClone({ state: "merged" }).success).toBe(false);
    expect(parseStatusReadWithWorktree({ state: "provisioning" }).success).toBe(false);
  });

  it.each([
    "cloneId",
    "workspaceId",
    "cloneRoot",
    "branchName",
    "state",
    "cleanupPolicy",
    "expiresAt",
    "createdAt",
  ])("rejects a clone record missing %s", (field) => {
    // The second half of "clone shapes carry branchName": the status read
    // exposes the head branch for clone records
    // (`Spec-010 §Interfaces And Contracts`), and
    // `ephemeral_clones.branch_name` is NOT NULL.
    const broken = { ...buildEphemeralCloneStatusRecord() } as Record<string, unknown>;
    delete broken[field];
    expect(parseStatusReadCloneRecord(broken).success).toBe(false);
  });

  it.each(["on_run_complete", "manual"])(
    "carries either cleanup policy on a clone record — %s",
    (cleanupPolicy) => {
      // `ephemeral_clones.cleanup_policy` holds whichever the clone was
      // prepared with, so the projection has to round-trip both. The fixture
      // exercises one, which is what makes a narrowing here invisible.
      expect(parseStatusReadWithClone({ cleanupPolicy }).success).toBe(true);
    },
  );

  it("rejects a normalized cleanupPolicy on a clone record", () => {
    expect(parseStatusReadWithClone({ cleanupPolicy: "onRunComplete" }).success).toBe(false);
  });

  it("applies the wireFreeFormString guard to every path and ref on both records", () => {
    // Four fields, none of which has a cap row: a downgrade at any one of them
    // would put a blank or NUL-bearing path into a projection the Phase 4 views
    // render directly.
    for (const hostile of GUARD_DOWNGRADE_VALUES) {
      expect(parseStatusReadWithWorktree({ branchName: hostile }).success).toBe(false);
      expect(parseStatusReadWithWorktree({ fsRoot: hostile }).success).toBe(false);
      expect(parseStatusReadWithClone({ cloneRoot: hostile }).success).toBe(false);
      expect(parseStatusReadWithClone({ branchName: hostile }).success).toBe(false);
    }
  });

  it("does not carry updatedAt on clone records (transcribed as ratified)", () => {
    // `ephemeral_clones.updated_at` exists in the DDL, but the ratified block
    // carries the column on the worktree projection only. Adding it here would
    // be a wire change ahead of the doc, so `.strict()` refuses it.
    expect(parseStatusReadWithClone({ updatedAt: UPDATED_AT }).success).toBe(false);
  });
});

// --------------------------------------------------------------------------
// `.strict()` — the behavioral pin on all sixteen T1.2 shapes.
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
  // per shape, all fourteen exported schemas.
  expect(schema.safeParse(fixture).success).toBe(true);
  expect(schema.safeParse({ ...fixture, unknownWireKey: "leak" }).success).toBe(false);
};

describe("`.strict()` closes every T1.2 wire shape (behavioral pin)", () => {
  it("closes all seven request schemas", () => {
    expectClosedShape(ExecutionModeSelectRequestSchema, buildExecutionModeSelectRequest());
    expectClosedShape(ExecutionRootPrepareRequestSchema, buildExecutionRootPrepareRequest());
    expectClosedShape(WorktreeReuseCheckRequestSchema, buildWorktreeReuseCheckRequest());
    expectClosedShape(EphemeralClonePrepareRequestSchema, buildEphemeralClonePrepareRequest());
    expectClosedShape(EphemeralCloneDisposeRequestSchema, buildEphemeralCloneDisposeRequest());
    expectClosedShape(WorktreeRetireRequestSchema, buildWorktreeRetireRequest());
    expectClosedShape(WorktreeStatusReadRequestSchema, buildWorktreeStatusReadRequest());
  });

  it("closes all seven response schemas", () => {
    expectClosedShape(ExecutionModeSelectResponseSchema, buildExecutionModeSelectResponse());
    expectClosedShape(ExecutionRootPrepareResponseSchema, buildExecutionRootPrepareResponse());
    expectClosedShape(WorktreeReuseCheckResponseSchema, buildWorktreeReuseCheckResponse());
    expectClosedShape(EphemeralClonePrepareResponseSchema, buildEphemeralClonePrepareResponse());
    expectClosedShape(EphemeralCloneDisposeResponseSchema, buildEphemeralCloneDisposeResponse());
    expectClosedShape(WorktreeRetireResponseSchema, buildWorktreeRetireResponse());
    expectClosedShape(WorktreeStatusReadResponseSchema, buildWorktreeStatusReadResponse());
  });

  it("closes BOTH status-read item schemas independently of their envelope", () => {
    // The envelope's own `.strict()` cannot reach inside an array element, so
    // an item-level guard is a separate obligation — the wire shape is closed
    // at both levels (the `workspaceListItemSchema` precedent). These two rows
    // are why the count is sixteen, not fourteen.
    expect(parseStatusReadWithWorktree({ unknownWireKey: "leak" }).success).toBe(false);
    expect(parseStatusReadWithClone({ unknownWireKey: "leak" }).success).toBe(false);
  });
});

// --------------------------------------------------------------------------
// Compile-time pins for the T1.2 shapes.
// --------------------------------------------------------------------------
//
// Never executed; present so `tsc -p tsconfig.test.json` fails if a narrowing
// or a required field is weakened. Each directive self-verifies: relax the
// constraint and TypeScript reports the directive unused (TS2578), turning the
// typecheck leg red rather than silently dropping the pin.

const extractNarrowingPins = (): void => {
  // @ts-expect-error — `retired` is outside EphemeralClonePrepareResponse's
  // `Extract<EphemeralCloneState, "creating" | "ready">`.
  const retiredPrepareState: EphemeralClonePrepareResponse["state"] = "retired";
  void retiredPrepareState;
  // @ts-expect-error — `failed` is outside the same narrowing.
  const failedPrepareState: EphemeralClonePrepareResponse["state"] = "failed";
  void failedPrepareState;
  // @ts-expect-error — EphemeralCloneDisposeResponse admits `retired` only.
  const readyDisposeState: EphemeralCloneDisposeResponse["state"] = "ready";
  void readyDisposeState;
  // @ts-expect-error — WorktreeRetireResponse admits `retired` only.
  const mergedRetireState: WorktreeRetireResponse["state"] = "merged";
  void mergedRetireState;
};
void extractNarrowingPins;

const worktreeStatusRecordProvenancePin = (): void => {
  // @ts-expect-error — a worktree record with no creating-session provenance.
  // Every OTHER field is populated correctly, so the missing
  // `createdBySessionId` is the only error the directive can be consuming: the
  // field is required on the TYPE (I-010-3), not merely at parse time.
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

describe("index.ts re-exports the Plan-010 wire surfaces (T1.2)", () => {
  it("re-exports every T1.2 runtime symbol by identity", () => {
    // The barrel-gap regression Plan-001 GitHub PR-#30 round 1 caught. T1.1
    // added `export * from "./worktree.js"`, so these ride it — the pin is that
    // they actually reach the public surface, star export or not.
    expect(contracts.ExecutionModeSelectRequestSchema).toBe(ExecutionModeSelectRequestSchema);
    expect(contracts.ExecutionModeSelectResponseSchema).toBe(ExecutionModeSelectResponseSchema);
    expect(contracts.ExecutionRootPrepareRequestSchema).toBe(ExecutionRootPrepareRequestSchema);
    expect(contracts.ExecutionRootPrepareResponseSchema).toBe(ExecutionRootPrepareResponseSchema);
    expect(contracts.WorktreeReuseCheckRequestSchema).toBe(WorktreeReuseCheckRequestSchema);
    expect(contracts.WorktreeReuseCheckResponseSchema).toBe(WorktreeReuseCheckResponseSchema);
    expect(contracts.EphemeralClonePrepareRequestSchema).toBe(EphemeralClonePrepareRequestSchema);
    expect(contracts.EphemeralClonePrepareResponseSchema).toBe(EphemeralClonePrepareResponseSchema);
    expect(contracts.EphemeralCloneDisposeRequestSchema).toBe(EphemeralCloneDisposeRequestSchema);
    expect(contracts.EphemeralCloneDisposeResponseSchema).toBe(EphemeralCloneDisposeResponseSchema);
    expect(contracts.WorktreeRetireRequestSchema).toBe(WorktreeRetireRequestSchema);
    expect(contracts.WorktreeRetireResponseSchema).toBe(WorktreeRetireResponseSchema);
    expect(contracts.WorktreeStatusReadRequestSchema).toBe(WorktreeStatusReadRequestSchema);
    expect(contracts.WorktreeStatusReadResponseSchema).toBe(WorktreeStatusReadResponseSchema);
    expect(contracts.WORKTREE_GIT_REF_MAX_LEN).toBe(WORKTREE_GIT_REF_MAX_LEN);
    expect(contracts.WORKTREE_REUSE_REASON_MAX_LEN).toBe(WORKTREE_REUSE_REASON_MAX_LEN);
  });

  // Compile-time reachability of the T1.2 type surface through the barrel.
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
