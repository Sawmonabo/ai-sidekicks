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
import { NODE_ID_MAX_LEN, NodeIdSchema } from "../node-id.js";
import {
  ExecutionModeSchema,
  REPO_PATH_MAX_LEN,
  RepoAttachRequestSchema,
  RepoAttachResponseSchema,
  RepoDetachRequestSchema,
  RepoDetachResponseSchema,
  RepoMountHealthSchema,
  RepoMountIdSchema,
  RepoMountReadRequestSchema,
  RepoMountReadResponseSchema,
  RepoMountStateSchema,
  RepoWorkspaceLifecyclePayloadSchema,
  VcsTypeSchema,
  WorkspaceIdSchema,
  WorkspaceStateSchema,
  type ExecutionMode,
  type RepoAttachResponse,
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
// Wire surfaces — RepoAttach / RepoMountRead / RepoDetach (T1.2).
// --------------------------------------------------------------------------
//
// The three request/response pairs for the MOUNT half of the six `repo.*`
// methods. Coverage backstops the field requirements the shapes carry:
// `Spec-009 §Interfaces And Contracts` (attach accepts a local path, session
// id, and owning runtime node; mount-read exposes canonical root, VCS
// metadata, and current health) and
// `Spec-009 §Detach Semantics (V1 Definition)` (detach accepts a repo mount id
// and transitions the mount to `detached`).

// A daemon-assigned OPAQUE scalar, deliberately NOT a UUID — the fixture uses
// a non-UUID value on purpose, and a dedicated row below pins that.
const NODE_ID = "node-alpha-01";

// The entered path and the resolved root DIFFER on purpose: attaching from a
// nested subdirectory is the canonical I-009-5 case (`local_path` keeps the
// provenance, `canonical_root` carries the resolver output). A fixture that
// made them equal could not catch a schema that conflated the two fields.
const LOCAL_PATH = "/Users/dev/projects/ai-sidekicks/packages/contracts";
const CANONICAL_ROOT = "/Users/dev/projects/ai-sidekicks";
const ATTACHED_AT = "2026-07-24T19:14:35.000Z";

const buildAttachRequest = () => ({
  sessionId: SESSION_ID,
  localPath: LOCAL_PATH,
  nodeId: NODE_ID,
});

const buildAttachResponse = () => ({
  repoMountId: REPO_MOUNT_ID,
  state: "attached" as const,
  vcsType: "git" as const,
  canonicalRoot: CANONICAL_ROOT,
  defaultWorkspaceId: WORKSPACE_ID,
});

const buildMountReadResponse = () => ({
  id: REPO_MOUNT_ID,
  sessionId: SESSION_ID,
  nodeId: NODE_ID,
  localPath: LOCAL_PATH,
  canonicalRoot: CANONICAL_ROOT,
  vcsType: "git" as const,
  state: "attached" as const,
  health: buildValidHealth(),
  attachedAt: ATTACHED_AT,
});

const buildDetachResponse = () => ({
  repoMountId: REPO_MOUNT_ID,
  state: "detached" as const,
  archivedWorkspaceIds: [WORKSPACE_ID],
});

// Override-parse helpers. The fixtures above stay explicit; these keep the
// assertion lines readable at a glance. The field-omission cases still
// `delete` the key directly, which no override form can express.
const parseAttachRequest = (overrides: Record<string, unknown> = {}) =>
  RepoAttachRequestSchema.safeParse({ ...buildAttachRequest(), ...overrides });
const parseAttachResponse = (overrides: Record<string, unknown> = {}) =>
  RepoAttachResponseSchema.safeParse({ ...buildAttachResponse(), ...overrides });
const parseMountReadResponse = (overrides: Record<string, unknown> = {}) =>
  RepoMountReadResponseSchema.safeParse({ ...buildMountReadResponse(), ...overrides });
const parseDetachResponse = (overrides: Record<string, unknown> = {}) =>
  RepoDetachResponseSchema.safeParse({ ...buildDetachResponse(), ...overrides });

describe("RepoAttachRequestSchema (Spec-009 §Interfaces And Contracts — path, session, owning node)", () => {
  it("accepts a valid attach request", () => {
    expect(parseAttachRequest().success).toBe(true);
  });

  it.each(["sessionId", "localPath", "nodeId"])(
    "rejects an attach request missing the required field %s",
    (field) => {
      const broken = { ...buildAttachRequest() } as Record<string, unknown>;
      delete broken[field];
      expect(RepoAttachRequestSchema.safeParse(broken).success).toBe(false);
    },
  );

  it("types `nodeId` as the daemon-assigned OPAQUE scalar, not a UUID", () => {
    // The contract-consumption pin. `NodeIdSchema` (Plan-003-owned, declared
    // in node-id.ts) deliberately departs from the UUID parser the branded
    // repo ids use, because `runtime_node_attachments.node_id` is TEXT.
    // Composing a UUID-branded schema here by mistake would satisfy every
    // other row in this block — only this one catches it.
    expect(parseAttachRequest({ nodeId: "cli-daemon@host.local" }).success).toBe(true);
    // Opaque is not unvalidated — empty and over-cap are still refused, at the
    // cap the canonical declaration owns.
    expect(parseAttachRequest({ nodeId: "" }).success).toBe(false);
    const overCapNodeId = "n".repeat(NODE_ID_MAX_LEN + 1);
    expect(parseAttachRequest({ nodeId: overCapNodeId }).success).toBe(false);
  });

  it("bounds `localPath` at REPO_PATH_MAX_LEN and refuses blank / NUL-byte forms", () => {
    const atCap = "/".repeat(REPO_PATH_MAX_LEN);
    const overCap = "/".repeat(REPO_PATH_MAX_LEN + 1);
    expect(parseAttachRequest({ localPath: atCap }).success).toBe(true);
    expect(parseAttachRequest({ localPath: overCap }).success).toBe(false);
    expect(parseAttachRequest({ localPath: "" }).success).toBe(false);
    expect(parseAttachRequest({ localPath: "   " }).success).toBe(false);
    // NUL is a truncation vector on a filesystem path, on top of the
    // log-injection vector `wireFreeFormString` documents. Built at runtime
    // rather than written as an escape so ripgrep keeps treating this file as
    // text — the same reason the `actor` pin above constructs it.
    const pathWithNulByte = `/safe/dir${String.fromCharCode(0)}/../../etc`;
    expect(parseAttachRequest({ localPath: pathWithNulByte }).success).toBe(false);
  });

  it.each([
    ["a relative path", "repos/ai-sidekicks"],
    ["a parent-traversal path", "../sibling/repo"],
    ["a Windows absolute path", "C:\\repos\\ai-sidekicks"],
    ["a tilde-prefixed path", "~/projects/repo"],
  ])("admits %s — the resolver canonicalizes, not the schema", (_label, candidate) => {
    // NEGATIVE CONTROL on the guards above. I-009-1 assigns resolution to the
    // daemon resolver (T1.5), so the wire must be able to carry a path it has
    // not seen yet. Every row here would be refused by an absoluteness or
    // traversal check the schema deliberately does not make; without them the
    // guards above would read as "the schema validates paths", which is
    // exactly the wrong impression. The Windows row is the ADR-019 V1-tier
    // case that rules out a `startsWith("/")` test outright.
    expect(parseAttachRequest({ localPath: candidate }).success).toBe(true);
  });

  it("rejects extraneous keys (.strict() guard)", () => {
    expect(parseAttachRequest({ extra: "leak" }).success).toBe(false);
  });
});

describe("RepoAttachResponseSchema (D-009-7 — resolved root + default workspace required)", () => {
  it("accepts a valid attach response", () => {
    expect(parseAttachResponse().success).toBe(true);
  });

  it.each(["canonicalRoot", "defaultWorkspaceId"])(
    "rejects an attach response missing %s — the field is unrepresentable-absent",
    (field) => {
      // `canonicalRoot`: resolution failure ABORTS attach with typed
      // `repo.root_resolution_failed` (I-009-2), so there is no partial
      // success carrying an unresolved root. `defaultWorkspaceId`: attach
      // unconditionally creates the default read-only workspace (D-009-7), so
      // "attached but no workspace" is a state the model never produces.
      const broken = { ...buildAttachResponse() } as Record<string, unknown>;
      delete broken[field];
      expect(RepoAttachResponseSchema.safeParse(broken).success).toBe(false);
    },
  );

  it.each(["attached", "detached", "archived"])(
    "carries the full RepoMountState vocabulary, not an `attached` literal — %s",
    (state) => {
      // The wire doc types this field `RepoMountState` with no narrowing and
      // carries NO per-value gloss on the attach response (unlike the detach
      // row, which does gloss `'detached'`). A `z.literal("attached")` would
      // silently reject the other two lawful states while passing every other
      // row in this block.
      expect(parseAttachResponse({ state }).success).toBe(true);
    },
  );

  it("still rejects a state outside the 3-value mount vocabulary", () => {
    // Negative control on the row above: non-narrowed is not unvalidated.
    expect(parseAttachResponse({ state: "exploded" }).success).toBe(false);
    // `stale` and `provisioning` are WORKSPACE states and must not leak in.
    expect(parseAttachResponse({ state: "stale" }).success).toBe(false);
    expect(parseAttachResponse({ state: "provisioning" }).success).toBe(false);
  });

  it("applies the wireFreeFormString guard to `canonicalRoot`", () => {
    // GUARD-DOWNGRADE VISIBILITY — the response-side twin of the `localPath`
    // bounds row on the request. Re-spelling the resolver output as a bare
    // `z.string()` passes every other row in this block; these make it fail.
    expect(parseAttachResponse({ canonicalRoot: "" }).success).toBe(false);
    expect(parseAttachResponse({ canonicalRoot: "   " }).success).toBe(false);
  });

  it("rejects extraneous keys (.strict() guard)", () => {
    expect(parseAttachResponse({ extra: "leak" }).success).toBe(false);
  });
});

// COMPILE-TIME leg of the `unrepresentable-absent` rows above: `canonicalRoot`
// and `defaultWorkspaceId` are required on the TYPE, not merely at parse time.
// The runtime rows prove the schema refuses the omission; these prove a
// consumer cannot construct one in the first place. Held in a never-invoked
// function so the pin does its whole job under the `tsconfig.test.json`
// typecheck leg, and each directive self-verifies: weaken either field to
// optional and TS reports the directive unused (TS2578), turning the leg red
// rather than silently dropping the pin. Co-located with its subject, the same
// placement as `brandNominalityPin` above.
const attachResponseRequiredFieldPins = (): void => {
  // @ts-expect-error — an attach response with no resolved canonical root.
  const missingCanonicalRoot: RepoAttachResponse = {
    repoMountId: RepoMountIdSchema.parse(REPO_MOUNT_ID),
    state: "attached",
    vcsType: "git",
    defaultWorkspaceId: WorkspaceIdSchema.parse(WORKSPACE_ID),
  };
  // @ts-expect-error — an attach response with no default workspace (D-009-7).
  const missingDefaultWorkspaceId: RepoAttachResponse = {
    repoMountId: RepoMountIdSchema.parse(REPO_MOUNT_ID),
    state: "attached",
    vcsType: "git",
    canonicalRoot: CANONICAL_ROOT,
  };
  void missingCanonicalRoot;
  void missingDefaultWorkspaceId;
};
void attachResponseRequiredFieldPins;

describe("RepoMountReadRequestSchema", () => {
  it("accepts a mount-read request and requires a canonical-UUID `repoMountId`", () => {
    const valid = { repoMountId: REPO_MOUNT_ID };
    expect(RepoMountReadRequestSchema.safeParse(valid).success).toBe(true);
    expect(RepoMountReadRequestSchema.safeParse({}).success).toBe(false);
    expect(RepoMountReadRequestSchema.safeParse({ repoMountId: "nope" }).success).toBe(false);
  });

  it("rejects extraneous keys (.strict() guard)", () => {
    const broken = { repoMountId: REPO_MOUNT_ID, extra: "leak" };
    expect(RepoMountReadRequestSchema.safeParse(broken).success).toBe(false);
  });
});

describe("RepoMountReadResponseSchema (canonical root + VCS metadata + current health)", () => {
  it("accepts a valid mount-read projection", () => {
    expect(parseMountReadResponse().success).toBe(true);
  });

  it("names the mount key `id`, not `repoMountId` — the read-projection convention", () => {
    // The wire doc uses the bare `id` on read projections and the qualified
    // name on mutation responses. Pinned in BOTH directions by one fixture: a
    // renamed projection loses its required `id` AND trips `.strict()` on the
    // unknown `repoMountId`, so a "helpful" rename cannot pass.
    const renamed = { ...buildMountReadResponse() } as Record<string, unknown>;
    delete renamed["id"];
    renamed["repoMountId"] = REPO_MOUNT_ID;
    expect(RepoMountReadResponseSchema.safeParse(renamed).success).toBe(false);
  });

  // All NINE projection fields, enumerated exhaustively rather than by
  // representative: a field quietly turned optional in a later phase would
  // otherwise pass a partial list.
  it.each([
    "id",
    "sessionId",
    "nodeId",
    "localPath",
    "canonicalRoot",
    "vcsType",
    "state",
    "health",
    "attachedAt",
  ])("requires %s", (field) => {
    const broken = { ...buildMountReadResponse() } as Record<string, unknown>;
    delete broken[field];
    expect(RepoMountReadResponseSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects out-of-vocabulary `vcsType` and `state` through the composition", () => {
    // The composed-enum leg, the same argument as the `health.status` rows
    // below: driven through the RESPONSE, these prove the projection composes
    // T1.1's canonical enums instead of re-spelling widened unions of its own.
    // `hg` is the VCS a re-spell would plausibly admit; `provisioning` is a
    // WORKSPACE state — the cross-vocabulary trap the attach block pins with
    // `stale`, and the reason `RepoMountState` and `WorkspaceState` must not be
    // conflated even though both carry an `archived` member.
    expect(parseMountReadResponse({ vcsType: "hg" }).success).toBe(false);
    expect(parseMountReadResponse({ state: "provisioning" }).success).toBe(false);
  });

  it("applies the wireFreeFormString guard to both response-side path fields", () => {
    // GUARD-DOWNGRADE VISIBILITY. Re-spelling either field as a bare
    // `z.string()` passes every other row in this block, because nothing else
    // here feeds these fields a blank value — the helper's non-empty,
    // whitespace-only, and NUL guards would silently disappear. These rows are
    // what make that downgrade fail.
    expect(parseMountReadResponse({ localPath: "" }).success).toBe(false);
    expect(parseMountReadResponse({ canonicalRoot: "" }).success).toBe(false);
  });

  it.each([
    ["healthy", true],
    ["unreachable", true],
    // Outside the 2-value union: `unknown` is the member D-009-2 rejects (the
    // on-read probe floor means every read carries a fresh verdict), and
    // `stale` is the workspace-state overload it chose `unreachable` to avoid.
    ["unknown", false],
    ["stale", false],
  ])("health.status %s -> %s, driven through the composed response", (status, shouldPass) => {
    // Driven through the COMPOSITION rather than through `RepoMountHealthSchema`
    // standalone (already covered above): this is what proves the read response
    // composes the canonical projection instead of re-spelling
    // `{status, checkedAt}` with a widened status of its own.
    const health = { ...buildValidHealth(), status };
    expect(parseMountReadResponse({ health }).success).toBe(shouldPass);
  });

  it("keeps `localPath` and `canonicalRoot` independent (I-009-5)", () => {
    const parsed = RepoMountReadResponseSchema.parse(buildMountReadResponse());
    expect(parsed.localPath).toBe(LOCAL_PATH);
    expect(parsed.canonicalRoot).toBe(CANONICAL_ROOT);
    // Distinct values in the fixture (subdirectory attach), so a schema that
    // read one field into the other fails here rather than passing silently.
    expect(parsed.localPath).not.toBe(parsed.canonicalRoot);
  });

  it("requires `attachedAt` to be an ISO-8601 instant, and admits a numeric offset", () => {
    expect(parseMountReadResponse({ attachedAt: "yesterday" }).success).toBe(false);
    const withOffset = "2026-07-24T14:14:35.000-05:00";
    expect(parseMountReadResponse({ attachedAt: withOffset }).success).toBe(true);
  });

  it("round-trips through JSON without loss", () => {
    const firstPass = RepoMountReadResponseSchema.parse(buildMountReadResponse());
    const secondPass = RepoMountReadResponseSchema.parse(
      JSON.parse(JSON.stringify(firstPass)) as unknown,
    );
    expect(secondPass).toStrictEqual(firstPass);
  });

  it("rejects extraneous keys (.strict() guard)", () => {
    expect(parseMountReadResponse({ extra: "leak" }).success).toBe(false);
  });
});

describe("RepoDetach request/response (Spec-009 §Detach Semantics (V1 Definition))", () => {
  it("accepts a detach request and requires `repoMountId`", () => {
    const valid = { repoMountId: REPO_MOUNT_ID };
    expect(RepoDetachRequestSchema.safeParse(valid).success).toBe(true);
    expect(RepoDetachRequestSchema.safeParse({}).success).toBe(false);
    const broken = { ...valid, extra: "leak" };
    expect(RepoDetachRequestSchema.safeParse(broken).success).toBe(false);
  });

  it("accepts the cascade response", () => {
    expect(parseDetachResponse().success).toBe(true);
  });

  it("accepts an EMPTY archivedWorkspaceIds array — a no-dependent cascade", () => {
    // Not degenerate: a mount whose dependent workspaces were all already
    // `archived` archives none, which is why the schema carries no `.min(1)`
    // even though D-009-7 guarantees attach created one workspace.
    expect(parseDetachResponse({ archivedWorkspaceIds: [] }).success).toBe(true);
  });

  it("accepts one id per dependent workspace the cascade archived", () => {
    const ids = [WORKSPACE_ID, "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f21"];
    expect(parseDetachResponse({ archivedWorkspaceIds: ids }).success).toBe(true);
  });

  it("rejects a non-UUID member of archivedWorkspaceIds", () => {
    const ids = [WORKSPACE_ID, "workspace-2"];
    expect(parseDetachResponse({ archivedWorkspaceIds: ids }).success).toBe(false);
  });

  it("requires archivedWorkspaceIds — an absent list is not an empty one", () => {
    const broken = { ...buildDetachResponse() } as Record<string, unknown>;
    delete broken["archivedWorkspaceIds"];
    expect(RepoDetachResponseSchema.safeParse(broken).success).toBe(false);
  });

  it.each(["attached", "detached", "archived"])(
    "carries the full RepoMountState vocabulary, not a `detached` literal — %s",
    (state) => {
      // Same stance as the attach response: the wire doc's `// 'detached'` is a
      // gloss on the value the daemon writes, not a contract narrowing.
      expect(parseDetachResponse({ state }).success).toBe(true);
    },
  );

  it("rejects extraneous keys on the response (.strict() guard)", () => {
    expect(parseDetachResponse({ extra: "leak" }).success).toBe(false);
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
    // The six T1.2 wire surfaces.
    ["RepoAttachRequestSchema", contracts.RepoAttachRequestSchema],
    ["RepoAttachResponseSchema", contracts.RepoAttachResponseSchema],
    ["RepoMountReadRequestSchema", contracts.RepoMountReadRequestSchema],
    ["RepoMountReadResponseSchema", contracts.RepoMountReadResponseSchema],
    ["RepoDetachRequestSchema", contracts.RepoDetachRequestSchema],
    ["RepoDetachResponseSchema", contracts.RepoDetachResponseSchema],
  ] as const)("re-exports %s with a callable .parse", (_name, schema) => {
    expect(schema).toBeDefined();
    expect(typeof (schema as { parse?: unknown })?.parse).toBe("function");
  });

  it("still resolves the hoisted NodeId symbols through the barrel (re-export seam)", () => {
    // T1.2 moved `NodeId` / `NodeIdSchema` / `NODE_ID_MAX_LEN` out of
    // runtime-node.ts into the dependency-free leaf node-id.ts, to break the
    // `repo.ts` -> `runtime-node.ts` -> `event.ts` -> `repo.ts` cycle that
    // composing `NodeIdSchema` here would otherwise have closed; runtime-node.ts
    // re-exports all three so its public API is unchanged.
    //
    // `__tests__/runtime-node.test.ts` is the untouched control that the DIRECT
    // import path still works. This asserts the BARREL path lands on the very
    // same instance — barrel -> runtime-node re-export -> node-id declaration —
    // so no consumer can end up holding two schemas under one name.
    expect(contracts.NodeIdSchema).toBe(NodeIdSchema);
    expect(contracts.NODE_ID_MAX_LEN).toBe(NODE_ID_MAX_LEN);
    expect(contracts.NodeIdSchema.safeParse(NODE_ID).success).toBe(true);
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
