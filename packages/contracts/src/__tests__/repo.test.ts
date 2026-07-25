// Plan-009 T1.1 — `repo.ts` contract core: branded ids, the four canonical
// repo/workspace enums, the derived `RepoMountHealth` projection, the shared
// lifecycle event payload, and its registration into `SessionEventSchema`.
//
// Backstops `Spec-009 §Required Behavior` (the canonical four-mode execution
// taxonomy git-backed binding must support, per ADR-006) and the invariant
// this contract carries:
//   • I-009-4 — honest non-git classification. `VcsTypeSchema` is the
//     discriminator's contract carrier, so the tests pin it CLOSED at two
//     values: no third member, no tolerant passthrough arm. A widened
//     discriminator is what would let a non-git path be presented as a git
//     mount.
//
// Coverage shape:
//   • Every member of every enum parses, INCLUDING the space-containing
//     `"ephemeral clone"` wire literal; out-of-set values are rejected (a 5th
//     mode, a 6th workspace state, a 4th mount state, a 3rd vcs type), so
//     each pin is a real accept/reject boundary rather than a one-sided
//     smoke test.
//   • Branded ids reject a non-UUID, and the brand is nominal at compile
//     time (a raw string is not a `RepoMountId`).
//   • `RepoMountHealth` rejects a `status` outside its two values, a missing
//     `checkedAt`, a non-ISO `checkedAt`, and an unknown key.
//   • The lifecycle payload matches
//     `Spec-006 §Repo, Workspace, and Worktree Lifecycle (session_lifecycle)`
//     field-for-field: `sessionId` required, the three subject ids optional
//     and independently omittable, `state` drawn from BOTH Plan-009
//     vocabularies, `actor` bounded by the envelope's own cap and its three
//     `wireFreeFormString` guards.
//   • The six Plan-009 types parse end-to-end through `SessionEventSchema`
//     with a category/type mismatch and a payload smuggle rejected, and the
//     not-yet-registered `worktree.*` half of the family is asserted absent
//     (the CP-010-5 forward edge).
//   • The `index.ts` barrel re-exports every symbol this task provides —
//     the barrel-gap regression Plan-001 GitHub PR-#30 round-1 caught.
import { describe, expect, it } from "vitest";

import {
  EVENT_FIELD_MAX_LEN,
  SESSION_EVENT_CATEGORY_BY_TYPE,
  SessionEventSchema,
  type SessionEvent,
} from "../event.js";
import * as contracts from "../index.js";
import {
  ExecutionModeSchema,
  RepoMountHealthSchema,
  RepoMountIdSchema,
  RepoMountStateSchema,
  RepoWorkspaceLifecyclePayloadSchema,
  VcsTypeSchema,
  WorkspaceIdSchema,
  WorkspaceStateSchema,
  type ExecutionMode,
  type RepoMountHealth,
  type RepoMountId,
  type RepoMountState,
  type RepoWorkspaceLifecyclePayload,
  type VcsType,
  type WorkspaceId,
  type WorkspaceState,
} from "../repo.js";

// Real RFC 9562 UUIDs (mix of v4 and v7). z.uuid() validates the version
// nibble + variant bits in canonical positions; mismatch is rejected at the
// branded-id schema layer.
const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
const REPO_MOUNT_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f10";
const WORKSPACE_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f11";
const WORKTREE_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f12";
const PARTICIPANT_ID = "660e8400-e29b-41d4-a716-446655440001";
const CHECKED_AT = "2026-07-24T19:14:35.000Z";
const VERSION = "1.0";

// --------------------------------------------------------------------------
// Canonical enums.
// --------------------------------------------------------------------------

describe("ExecutionModeSchema (Spec-009 §Required Behavior — the ADR-006 four-mode taxonomy)", () => {
  it.each([
    ["read-only", true],
    ["branch", true],
    ["worktree", true],
    // The space is part of the WIRE literal, preserved verbatim from
    // `docs/architecture/contracts/api-payload-contracts.md §Shared Enums`
    // (the same stance as `MembershipRole`'s "runtime contributor"). The
    // three plausible "cleanups" below must all stay rejected, or a producer
    // that normalized the literal would diverge from the canonical bytes.
    ["ephemeral clone", true],
    ["ephemeral_clone", false],
    ["ephemeral-clone", false],
    ["ephemeralClone", false],
    // A fifth mode is a contract change, not a runtime-tolerated value.
    ["submodule", false],
    ["", false],
  ])("parses %s -> %s", (candidate, shouldPass) => {
    expect(ExecutionModeSchema.safeParse(candidate).success).toBe(shouldPass);
  });

  it("enumerates exactly the four canonical modes (no more, no less)", () => {
    // Exact-set pin, read through the same `.options` internals cast the
    // EventCategorySchema pin in session-event.test.ts uses: the schema is
    // annotated `z.ZodType<ExecutionMode>` for `isolatedDeclarations`, which
    // erases the enum construct.
    const schemaInternals = ExecutionModeSchema as unknown as { options: readonly string[] };
    expect([...schemaInternals.options].sort()).toEqual(
      ["branch", "ephemeral clone", "read-only", "worktree"].sort(),
    );
  });
});

describe("WorkspaceStateSchema (the 5-value workspace lifecycle)", () => {
  it.each([
    ["provisioning", true],
    ["ready", true],
    ["busy", true],
    ["stale", true],
    ["archived", true],
    // A sixth state. `detached` belongs to the MOUNT vocabulary and must not
    // leak across; `unreachable` belongs to RepoMountHealth.
    ["detached", false],
    ["unreachable", false],
    ["failed", false],
  ])("parses %s -> %s", (candidate, shouldPass) => {
    expect(WorkspaceStateSchema.safeParse(candidate).success).toBe(shouldPass);
  });
});

describe("RepoMountStateSchema (the 3-value mount lifecycle)", () => {
  it.each([
    ["attached", true],
    ["detached", true],
    ["archived", true],
    // A fourth state. `provisioning` / `stale` are WORKSPACE states and a
    // mount never occupies them.
    ["provisioning", false],
    ["stale", false],
  ])("parses %s -> %s", (candidate, shouldPass) => {
    expect(RepoMountStateSchema.safeParse(candidate).success).toBe(shouldPass);
  });
});

describe("VcsTypeSchema (I-009-4 — honest non-git classification)", () => {
  it.each([
    ["git", true],
    ["none", true],
    // I-009-4's whole content is that the discriminator stays CLOSED at two
    // values. Each rejection below is a shape a widened union would admit:
    // an "unknown"/"pending" third state (which would let a resolver defer
    // the verdict), a sibling VCS (which would be presented as git-adjacent
    // without git capabilities), and the empty string.
    ["unknown", false],
    ["pending", false],
    ["hg", false],
    ["", false],
  ])("parses %s -> %s", (candidate, shouldPass) => {
    expect(VcsTypeSchema.safeParse(candidate).success).toBe(shouldPass);
  });

  it("admits exactly two members — no third value, no passthrough", () => {
    const schemaInternals = VcsTypeSchema as unknown as { options: readonly string[] };
    expect([...schemaInternals.options].sort()).toEqual(["git", "none"]);
    // Negative control on the pin above: a tolerant arm would make an
    // arbitrary string parse. It must not.
    expect(VcsTypeSchema.safeParse("anything-else").success).toBe(false);
  });
});

// --------------------------------------------------------------------------
// Branded ids.
// --------------------------------------------------------------------------

describe("RepoMountIdSchema / WorkspaceIdSchema (branded UUID scalars)", () => {
  it.each([
    ["RepoMountIdSchema", RepoMountIdSchema],
    ["WorkspaceIdSchema", WorkspaceIdSchema],
  ] as const)("%s accepts a canonical UUID and rejects a non-UUID", (_label, schema) => {
    expect(schema.safeParse(REPO_MOUNT_ID).success).toBe(true);
    expect(schema.safeParse("not-a-uuid").success).toBe(false);
    expect(schema.safeParse("").success).toBe(false);
    // A UUID-shaped string with a zero version nibble. `z.string().uuid()`
    // validates the version + variant nibbles, so this is not merely a
    // length-and-hyphens check.
    expect(schema.safeParse("0190f8a0-7e2d-0c4a-9b1c-1b7c5b3e8f10").success).toBe(false);
  });
});

// COMPILE-TIME pin on the brand's nominality, validated by the
// `tsconfig.test.json` typecheck leg. Held in a never-invoked function so the
// pin does its whole job at compile time. The directive self-verifies: if the
// brand is ever weakened to a bare `string`, TS reports the directive unused
// (TS2578) and the leg goes red rather than silently losing the pin.
const brandNominalityPin = (): void => {
  // @ts-expect-error — a raw string is not a RepoMountId without a parse.
  const unbranded: RepoMountId = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f10";
  void unbranded;
};
void brandNominalityPin;

// --------------------------------------------------------------------------
// RepoMountHealth — the derived projection (D-009-2).
// --------------------------------------------------------------------------

const buildValidHealth = () => ({
  status: "healthy" as const,
  checkedAt: CHECKED_AT,
});

describe("RepoMountHealthSchema (D-009-2 — derived projection, never persisted)", () => {
  it.each([
    ["healthy", true],
    ["unreachable", true],
    // Outside the two-value union. `unknown` is the shape D-009-2 explicitly
    // rejects (the on-read probe floor means every read carries a fresh
    // verdict), and `stale` is the WORKSPACE-state overload D-009-2 chose
    // `unreachable` to avoid.
    ["unknown", false],
    ["stale", false],
    ["degraded", false],
  ])("status %s -> %s", (status, shouldPass) => {
    expect(RepoMountHealthSchema.safeParse({ ...buildValidHealth(), status }).success).toBe(
      shouldPass,
    );
  });

  it("requires `checkedAt` — a verdict with no probe provenance is unauditable", () => {
    const broken = { ...buildValidHealth() } as Record<string, unknown>;
    delete broken["checkedAt"];
    expect(RepoMountHealthSchema.safeParse(broken).success).toBe(false);
  });

  it("requires `checkedAt` to be an ISO-8601 instant, and admits a numeric offset", () => {
    expect(
      RepoMountHealthSchema.safeParse({ ...buildValidHealth(), checkedAt: "yesterday" }).success,
    ).toBe(false);
    // `{ offset: true }` — the package-wide datetime convention (RFC 3339
    // §5.6 numeric offsets, not just Z-suffixed UTC).
    expect(
      RepoMountHealthSchema.safeParse({
        ...buildValidHealth(),
        checkedAt: "2026-07-24T14:14:35.000-05:00",
      }).success,
    ).toBe(true);
  });

  it("rejects extraneous keys (.strict() guard)", () => {
    expect(RepoMountHealthSchema.safeParse({ ...buildValidHealth(), extra: "leak" }).success).toBe(
      false,
    );
  });
});

// --------------------------------------------------------------------------
// RepoWorkspaceLifecyclePayload — the family-shared payload (CP-009-4).
// --------------------------------------------------------------------------

const buildMountPayload = () => ({
  sessionId: SESSION_ID,
  repoMountId: REPO_MOUNT_ID,
  state: "attached" as const,
  actor: PARTICIPANT_ID,
});

const buildWorkspacePayload = () => ({
  sessionId: SESSION_ID,
  repoMountId: REPO_MOUNT_ID,
  workspaceId: WORKSPACE_ID,
  state: "ready" as const,
  actor: null,
});

describe("RepoWorkspaceLifecyclePayloadSchema (Spec-006 §Repo, Workspace, and Worktree Lifecycle)", () => {
  it("accepts the minimum shape — sessionId + state only", () => {
    // Every subject id is optional per the Spec-006 family shape, so the two
    // required members are the whole floor.
    expect(
      RepoWorkspaceLifecyclePayloadSchema.safeParse({
        sessionId: SESSION_ID,
        state: "attached",
      }).success,
    ).toBe(true);
  });

  it("accepts every subject id together — the detach cascade names more than one", () => {
    // No "exactly one id" refinement exists, deliberately: a
    // `workspace.archived` emitted by the detach cascade names both the
    // mount that caused it and the workspace it archived.
    expect(
      RepoWorkspaceLifecyclePayloadSchema.safeParse({
        sessionId: SESSION_ID,
        repoMountId: REPO_MOUNT_ID,
        workspaceId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        state: "archived",
        actor: PARTICIPANT_ID,
      }).success,
    ).toBe(true);
  });

  it("requires `sessionId` — Spec-006 spells the family base without a `?`", () => {
    const broken = { ...buildMountPayload() } as Record<string, unknown>;
    delete broken["sessionId"];
    expect(RepoWorkspaceLifecyclePayloadSchema.safeParse(broken).success).toBe(false);
    expect(
      RepoWorkspaceLifecyclePayloadSchema.safeParse({ ...buildMountPayload(), sessionId: "nope" })
        .success,
    ).toBe(false);
  });

  it("requires `state`", () => {
    const broken = { ...buildMountPayload() } as Record<string, unknown>;
    delete broken["state"];
    expect(RepoWorkspaceLifecyclePayloadSchema.safeParse(broken).success).toBe(false);
  });

  it.each([
    // BOTH Plan-009 vocabularies are in the union: mount states for `repo.*`
    // rows, workspace states for `workspace.*` rows.
    ["attached (mount)", "attached", true],
    ["detached (mount)", "detached", true],
    ["archived (shared by both vocabularies)", "archived", true],
    ["provisioning (workspace)", "provisioning", true],
    ["ready (workspace)", "ready", true],
    ["busy (workspace)", "busy", true],
    ["stale (workspace)", "stale", true],
    ["an invented state", "exploded", false],
  ])("state: %s", (_label, state, shouldPass) => {
    expect(
      RepoWorkspaceLifecyclePayloadSchema.safeParse({ sessionId: SESSION_ID, state }).success,
    ).toBe(shouldPass);
  });

  it.each([["creating"], ["dirty"], ["merged"], ["retired"]])(
    "rejects the Plan-010-owned worktree state %s (today's boundary, not a permanent one)",
    (worktreeState) => {
      // EXPECTED TO FLIP. `WorktreeState` is Plan-010-owned, so the union
      // carries only the two Plan-009 vocabularies today. CP-010-5's
      // registration adds `WorktreeStateSchema` as a third arm — an additive
      // widening under `ADR-018 §Decision` #8 — and these rows move to the
      // accept table in that diff. They exist now so the widening is a
      // visible, reviewed edit rather than a silent one.
      expect(
        RepoWorkspaceLifecyclePayloadSchema.safeParse({
          sessionId: SESSION_ID,
          worktreeId: WORKTREE_ID,
          state: worktreeState,
        }).success,
      ).toBe(false);
    },
  );

  it("types `worktreeId` as a canonical UUID string (unbranded, Plan-010 narrows it later)", () => {
    expect(
      RepoWorkspaceLifecyclePayloadSchema.safeParse({
        sessionId: SESSION_ID,
        worktreeId: WORKTREE_ID,
        state: "ready",
      }).success,
    ).toBe(true);
    // Unbranded does NOT mean unvalidated — the runtime accept-set is the
    // same `z.string().uuid()` the branded ids compose.
    expect(
      RepoWorkspaceLifecyclePayloadSchema.safeParse({
        sessionId: SESSION_ID,
        worktreeId: "worktree-1",
        state: "ready",
      }).success,
    ).toBe(false);
  });

  it("rejects extraneous keys (.strict() guard)", () => {
    expect(
      RepoWorkspaceLifecyclePayloadSchema.safeParse({ ...buildMountPayload(), extra: "leak" })
        .success,
    ).toBe(false);
  });

  it("accepts `actor: null` and an omitted `actor`, but not an empty or blank one", () => {
    // Same trust-boundary stance as `EventEnvelope.actor`: a system-emitted
    // event uses `null` or omits the key; a present-but-empty actor is a
    // producer bug.
    expect(RepoWorkspaceLifecyclePayloadSchema.safeParse(buildWorkspacePayload()).success).toBe(
      true,
    );
    expect(
      RepoWorkspaceLifecyclePayloadSchema.safeParse({ sessionId: SESSION_ID, state: "ready" })
        .success,
    ).toBe(true);
    expect(
      RepoWorkspaceLifecyclePayloadSchema.safeParse({ ...buildMountPayload(), actor: "" }).success,
    ).toBe(false);
    expect(
      RepoWorkspaceLifecyclePayloadSchema.safeParse({ ...buildMountPayload(), actor: "\t \n" })
        .success,
    ).toBe(false);
    // Interior whitespace is FINE — `wireFreeFormString` rejects
    // whitespace-ONLY, not any whitespace. Without this control the two
    // rejections above would read as an over-broad guard.
    expect(
      RepoWorkspaceLifecyclePayloadSchema.safeParse({
        ...buildMountPayload(),
        actor: "agent alpha",
      }).success,
    ).toBe(true);
  });

  it("rejects a NUL byte in `actor` — the third wireFreeFormString guard", () => {
    // Every other helper-composed field in the package carries this pin
    // explicitly (session-event.test.ts pins the envelope's own `actor` the
    // same way): an embedded NUL is a truncation vector at the wire/replay
    // trust boundary, so it must not survive into the log.
    //
    // The byte is BUILT at runtime rather than written as a unicode escape,
    // which is the one deviation from the sibling suites' spelling. A raw NUL
    // in the source makes ripgrep classify the file as binary and skip its
    // content matches, which silently breaks the repo's cite-and-grep
    // tooling; constructing it here keeps the assertion identical and the
    // file text-clean.
    const actorWithNulByte = `agent${String.fromCharCode(0)}injected`;
    expect(
      RepoWorkspaceLifecyclePayloadSchema.safeParse({
        ...buildMountPayload(),
        actor: actorWithNulByte,
      }).success,
    ).toBe(false);
  });

  it("bounds `actor` at the envelope's own cap (EVENT_FIELD_MAX_LEN)", () => {
    // repo.ts restates the cap locally rather than importing it, because
    // importing from event.ts would close a module cycle (event.ts imports
    // the payload schema from repo.ts). A comment alone would be an
    // unenforced pin, so the equality is asserted HERE against the real
    // constant: at the cap it parses, one character over it does not. If the
    // envelope cap ever moves, this fails until repo.ts follows.
    const atCap = "a".repeat(EVENT_FIELD_MAX_LEN);
    const overCap = "a".repeat(EVENT_FIELD_MAX_LEN + 1);
    expect(
      RepoWorkspaceLifecyclePayloadSchema.safeParse({ ...buildMountPayload(), actor: atCap })
        .success,
    ).toBe(true);
    expect(
      RepoWorkspaceLifecyclePayloadSchema.safeParse({ ...buildMountPayload(), actor: overCap })
        .success,
    ).toBe(false);
  });

  it("round-trips through JSON without loss", () => {
    const firstPass = RepoWorkspaceLifecyclePayloadSchema.parse(buildWorkspacePayload());
    const secondPass = RepoWorkspaceLifecyclePayloadSchema.parse(
      JSON.parse(JSON.stringify(firstPass)) as unknown,
    );
    expect(secondPass).toStrictEqual(firstPass);
  });
});

// --------------------------------------------------------------------------
// Union registration into SessionEventSchema (CP-009-4).
// --------------------------------------------------------------------------

// Each registered type paired with the state its emitter actually writes —
// mount states for the `repo.*` pair, workspace states for the four
// `workspace.*` rows.
//
// The element type is load-bearing, not decoration (same stance as
// session-event.test.ts's `B18_MINTED_TYPES`). `SessionEvent["type"]` is the
// REGISTERED union's discriminant, narrower than the 156-literal census
// `SessionEventType`: if a later edit drops one of these six arms from
// `SessionEventSchema`, this fixture stops compiling under
// `tsc -p tsconfig.test.json` rather than silently thinning to a five-case
// runtime table. The state half binds to the payload union the same way.
const REGISTERED_REPO_EVENTS: ReadonlyArray<
  readonly [SessionEvent["type"], RepoMountState | WorkspaceState]
> = [
  ["repo.attached", "attached"],
  ["repo.detached", "detached"],
  ["workspace.provisioning", "provisioning"],
  ["workspace.ready", "ready"],
  ["workspace.stale", "stale"],
  ["workspace.archived", "archived"],
];

// `workspaces.repo_mount_id` is NOT NULL (D-009-4, mount-first single
// funnel), so every workspace row names its mount: the workspace fixtures
// carry BOTH ids and the mount fixtures carry only `repoMountId`.
const buildRepoEvent = (eventType: string, state: string) => ({
  id: "evt-repo-0001",
  sessionId: SESSION_ID,
  sequence: 7,
  occurredAt: "2026-07-24T19:14:35.000Z",
  category: "session_lifecycle" as const,
  type: eventType,
  actor: PARTICIPANT_ID,
  version: VERSION,
  payload: {
    sessionId: SESSION_ID,
    repoMountId: REPO_MOUNT_ID,
    ...(eventType.startsWith("workspace.") ? { workspaceId: WORKSPACE_ID } : {}),
    state,
  },
});

describe("SessionEventSchema registration of the six Plan-009 variants (CP-009-4)", () => {
  it.each(REGISTERED_REPO_EVENTS)(
    "%s parses end-to-end through the union carrying state %s",
    (eventType, state) => {
      const parsed = SessionEventSchema.parse(buildRepoEvent(eventType, state));
      expect(parsed.type).toBe(eventType);
      expect(parsed.category).toBe("session_lifecycle");
      // The line above is self-referential on its own — the arm's own
      // `category: z.literal(...)` produced the value it checks, so it cannot
      // catch an arm literal that disagrees with the census. Cross-check
      // against the independent registry, which is what
      // `SESSION_EVENT_CATEGORY_BY_TYPE` exists for: `category` sits in the
      // RFC 8785 canonical bytes backing the hash chain, so an arm/census
      // disagreement would diverge at replay. Same leg the sibling suites
      // close for their own variants.
      expect(SESSION_EVENT_CATEGORY_BY_TYPE.get(eventType)).toBe("session_lifecycle");
      // The payload survives the union branch unchanged — no key added,
      // dropped, or coerced on the way through.
      expect(parsed.payload).toStrictEqual(buildRepoEvent(eventType, state).payload);
    },
  );

  it.each(REGISTERED_REPO_EVENTS)(
    "%s round-trips through JSON without loss",
    (eventType, state) => {
      const firstPass = SessionEventSchema.parse(buildRepoEvent(eventType, state));
      const secondPass = SessionEventSchema.parse(JSON.parse(JSON.stringify(firstPass)) as unknown);
      expect(secondPass).toStrictEqual(firstPass);
    },
  );

  it.each(REGISTERED_REPO_EVENTS)(
    "%s rejects a category/type mismatch (the canonical-bytes guard)",
    (eventType, state) => {
      // The per-variant `category: z.literal(...)` forbids cross-namespace
      // smuggling: `category` sits in the canonical bytes that back the hash
      // chain, so a mismatch hashed under the wrong category would diverge at
      // replay.
      const broken = {
        ...buildRepoEvent(eventType, state),
        category: "membership_change" as const,
      };
      expect(SessionEventSchema.safeParse(broken).success).toBe(false);
    },
  );

  it("rejects a foreign payload smuggled onto a repo variant", () => {
    const broken = {
      ...buildRepoEvent("repo.attached", "attached"),
      payload: { channelId: WORKSPACE_ID, name: "main" },
    };
    expect(SessionEventSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects an unknown payload key on a repo variant (.strict() reaches the union branch)", () => {
    const event = buildRepoEvent("repo.attached", "attached");
    const broken = { ...event, payload: { ...event.payload, smuggled: "nope" } };
    expect(SessionEventSchema.safeParse(broken).success).toBe(false);
  });

  it.each([
    ["worktree.created"],
    ["worktree.ready"],
    ["worktree.dirty"],
    ["worktree.merged"],
    ["worktree.retired"],
  ])("does not yet register the Plan-010 family member %s", (worktreeType) => {
    // The other five members of the Spec-006 family. Census-registered by
    // Plan-006 T1.2, but their payload variants land with CP-010-5 — until
    // then the strict layer must refuse to interpret them (the tolerant
    // `EventEnvelopeSchema` carrier still accepts them, which is
    // session-event.test.ts's layering pin). Expected to flip when Plan-010
    // Phase 1 lands.
    //
    // Every row carries `state: "ready"` — a state the union ALREADY accepts —
    // deliberately: it isolates the type-registration axis. Pairing these
    // types with their D-010-12 states (`creating` / `dirty` / `merged` /
    // `retired`) would let a row keep rejecting for the WRONG reason if
    // CP-010-5 registered the arms but forgot the state widening. The state
    // boundary has its own dedicated pin above; with `"ready"` here, all five
    // rows flip visibly the moment the arms land.
    expect(SessionEventSchema.safeParse(buildRepoEvent(worktreeType, "ready")).success).toBe(false);
  });
});

// --------------------------------------------------------------------------
// Compile-time pins.
// --------------------------------------------------------------------------
//
// Annotation-only assignments, validated by the `tsconfig.test.json`
// typecheck leg rather than by a runtime assertion.

// The payload MUST stay assignable to `Record<string, unknown>` — that is
// what lets the six variant interfaces in event.ts narrow
// `EventEnvelope.payload`. It holds because `RepoWorkspaceLifecyclePayload`
// is a TYPE ALIAS: TypeScript grants an object type alias an implicit index
// signature but grants an interface none. Re-declaring it as an interface
// would fail HERE with a clear message, ahead of the more obscure failure at
// the `extends EventEnvelope` site.
//
// The right-hand side is a PARSE RESULT, not an object literal: a literal
// would carry its own implicit index signature and satisfy the annotation
// whatever the alias is declared as, making the pin vacuous. `.parse()`
// returns a value typed exactly `RepoWorkspaceLifecyclePayload`, so the
// assignment tests the DECLARED type.
const parsedLifecyclePayload: RepoWorkspaceLifecyclePayload =
  RepoWorkspaceLifecyclePayloadSchema.parse({
    sessionId: SESSION_ID,
    state: "attached",
  });
const payloadNarrowsTheEnvelope: Record<string, unknown> = parsedLifecyclePayload;
void payloadNarrowsTheEnvelope;

// The T1.1 acceptance criterion: all six Spec-009 wire surfaces can type
// their Plan-009-owned fields from this module alone. One representative
// field per surface, spelled with only this module's exported types —
// `RepoAttachResponse.state` / `.vcsType` / `.defaultWorkspaceId`,
// `RepoMountReadResponse.health`, `RepoDetachResponse.archivedWorkspaceIds`,
// `WorkspaceBindRequest.executionMode`,
// `WorkspaceExecutionModeCapabilitiesReadResponse.availableModes` /
// `.restrictions`, and `WorkspaceListResponse.workspaces[].state`. T1.2/T1.3
// assemble the full request/response shapes; this pin proves the vocabulary
// is complete before they do.
const sixWireSurfacesTypeFromThisModuleAlone: {
  attachState: RepoMountState;
  attachVcsType: VcsType;
  attachDefaultWorkspaceId: WorkspaceId;
  mountReadHealth: RepoMountHealth;
  detachArchivedWorkspaceIds: WorkspaceId[];
  bindExecutionMode: ExecutionMode;
  capabilitiesAvailableModes: ExecutionMode[];
  capabilitiesRestrictions: Partial<Record<ExecutionMode, string>>;
  listWorkspaceState: WorkspaceState;
} = {
  attachState: RepoMountStateSchema.parse("attached"),
  attachVcsType: VcsTypeSchema.parse("none"),
  attachDefaultWorkspaceId: WorkspaceIdSchema.parse(WORKSPACE_ID),
  mountReadHealth: RepoMountHealthSchema.parse(buildValidHealth()),
  detachArchivedWorkspaceIds: [WorkspaceIdSchema.parse(WORKSPACE_ID)],
  bindExecutionMode: ExecutionModeSchema.parse("ephemeral clone"),
  capabilitiesAvailableModes: [ExecutionModeSchema.parse("read-only")],
  capabilitiesRestrictions: { worktree: "no git repository at the mount root" },
  listWorkspaceState: WorkspaceStateSchema.parse("stale"),
};
void sixWireSurfacesTypeFromThisModuleAlone;

// --------------------------------------------------------------------------
// Barrel re-export regression guard.
// --------------------------------------------------------------------------

describe("index.ts re-exports the Plan-009 contract core", () => {
  // The barrel-gap regression Plan-001 GitHub PR-#30 round-1 caught: a module
  // can be complete and still invisible to consumers if the
  // `export * from "./repo.js"` line is missing or dropped in a later
  // refactor. Importing through `../index.js` (not `../repo.js`) is what
  // makes this exercise the re-export layer — the same reason
  // anti-leakage.test.ts imports through the barrel.
  it.each([
    ["RepoMountIdSchema", contracts.RepoMountIdSchema],
    ["WorkspaceIdSchema", contracts.WorkspaceIdSchema],
    ["ExecutionModeSchema", contracts.ExecutionModeSchema],
    ["WorkspaceStateSchema", contracts.WorkspaceStateSchema],
    ["RepoMountStateSchema", contracts.RepoMountStateSchema],
    ["VcsTypeSchema", contracts.VcsTypeSchema],
    ["RepoMountHealthSchema", contracts.RepoMountHealthSchema],
    ["RepoWorkspaceLifecyclePayloadSchema", contracts.RepoWorkspaceLifecyclePayloadSchema],
  ] as const)("re-exports %s with a callable .parse", (_name, schema) => {
    expect(schema).toBeDefined();
    expect(typeof (schema as { parse?: unknown })?.parse).toBe("function");
  });

  it("resolves the same schema through the barrel and the module (no shadow copy)", () => {
    // Identity, not just presence: a re-export that resolved to a different
    // instance would mean two schemas sharing one name.
    expect(contracts.ExecutionModeSchema).toBe(ExecutionModeSchema);
    expect(contracts.RepoWorkspaceLifecyclePayloadSchema).toBe(RepoWorkspaceLifecyclePayloadSchema);
  });

  it("re-exports the six event-variant schemas registered into the union", () => {
    for (const schema of [
      contracts.RepoAttachedEventSchema,
      contracts.RepoDetachedEventSchema,
      contracts.WorkspaceProvisioningEventSchema,
      contracts.WorkspaceReadyEventSchema,
      contracts.WorkspaceStaleEventSchema,
      contracts.WorkspaceArchivedEventSchema,
    ]) {
      expect(typeof (schema as { parse?: unknown })?.parse).toBe("function");
    }
  });
});
