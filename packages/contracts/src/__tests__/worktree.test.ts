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
import { ExecutionModeSchema } from "../repo.js";
import {
  BranchContextIdSchema,
  CleanupPolicySchema,
  EphemeralCloneIdSchema,
  EphemeralCloneStateSchema,
  ExecutionModeSchema as ExecutionModeSchemaFromWorktreeReExport,
  WorktreeIdSchema,
  WorktreeLifecyclePayloadSchema,
  WorktreeStateSchema,
  type BranchContextId,
  type EphemeralCloneId,
  type ExecutionMode,
  type WorktreeId,
  type WorktreeLifecyclePayload,
  type WorktreeState,
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
    // one diff; the full 14-member order pin lives in session-event.test.ts.
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
